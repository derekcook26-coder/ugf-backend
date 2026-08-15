"use strict";

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  validGymMasterIdentity,
} = require("./gymmaster-member-authorization");
const { memberAccessDependencyUnavailable } = require("./gymmaster-gatekeeper-membership");

const MEMBER_SAFETY_INTAKE_FLAG =
  "GOALS_COACH_MEMBER_SAFETY_INTAKE_ALPHA_ENABLED";
const MEMBER_SAFETY_NOTICE_VERSION = "GC-MEMBER-SAFETY-NOTICE-2";
const MEMBER_SAFETY_NOTICE = "Goals Coach uses the information you choose to provide, including fitness goals, workout feedback, and safety-related responses, to personalize your coaching experience. It does not replace medical advice. Your information is kept private and used only to provide and safely operate Goals Coach. You may stop using Goals Coach at any time.";
const MEMBER_SAFETY_INTAKE_RULE_VERSION = "GC-MEMBER-SAFETY-INTAKE-2";
const ASSESSMENT_VALID_MILLISECONDS = (12 * 60 * 60 - 60) * 1000;
const MAXIMUM_SAFETY_INTAKE_JSON_BYTES = 4096;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATABASE_ID = /^[1-9]\d{0,18}$/;
const ANSWER_FIELDS = Object.freeze([
  "urgentWarningSigns", "painOrStiffness", "familiar", "mild", "severe",
  "sharp", "newOrWorsening", "movementLimited", "injuryOrInstability",
  "recentSurgery", "surgeryCleared", "medicalOrExerciseRestriction",
  "restrictionCanBeHonored", "neurologicalSymptoms", "otherUnsafeConcern",
]);

function memberSafetyIntakeEnabled(value) {
  return value === "true";
}

function approvedNoticeVersion(value) {
  return value === MEMBER_SAFETY_NOTICE_VERSION ? value : null;
}

function readinessFor(effective) {
  if (effective.status === "not_submitted") {
    return { status: "SETUP_REQUIRED", nextAction: "COMPLETE_SAFETY_SETUP" };
  }
  return { status: effective.status, nextAction: effective.nextAction };
}

function publicAssessment(effective) {
  const messages = {
    not_submitted: "Complete a fresh safety check before this session.",
    SCREEN_COMPLETE: "No safety concern was identified in this check.",
    MODIFICATION_REQUIRED: "Use comfortable, pain-free movement; reduce intensity or range, and stop if symptoms increase.",
    MEDICAL_REVIEW_REQUIRED: "Stop this session and contact an appropriate qualified healthcare professional.",
    URGENT_STOP: "Stop now and seek immediate emergency help.",
  };
  const ready = readinessFor(effective);
  return {
    status: effective.status,
    message: messages[effective.status],
    nextAction: ready.nextAction,
    validUntil: effective.validUntil || null,
    activationPermitted: false,
    externalCallsPermitted: false,
  };
}

function intakeError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.exposeMessage = true;
  return error;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, name) {
  if (!exactObject(value)) {
    throw intakeError(400, "SAFETY_INTAKE_INVALID", `Invalid ${name}.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw intakeError(400, "SAFETY_INTAKE_INVALID", `Invalid ${name}.`);
  }
}

function parseClientRequestId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw intakeError(
      400,
      "SAFETY_INTAKE_INVALID",
      "Invalid safety intake request."
    );
  }
  return value;
}

function parseSafetyIntake(body, expectedNoticeVersion) {
  rejectUnknownKeys(
    body,
    ["clientRequestId", "noticeVersion", "answers"],
    "safety intake request"
  );
  if (body.noticeVersion !== expectedNoticeVersion) {
    throw intakeError(
      400,
      "SAFETY_INTAKE_NOTICE_VERSION_INVALID",
      "The safety intake notice version is invalid."
    );
  }
  rejectUnknownKeys(body.answers, ANSWER_FIELDS, "safety intake answers");
  const answers = {};
  for (const field of ANSWER_FIELDS) {
    if (typeof body.answers[field] !== "boolean") {
      throw intakeError(
        400,
        "SAFETY_INTAKE_INVALID",
        "Invalid safety intake answers."
      );
    }
    answers[field] = body.answers[field];
  }
  const parsed = {
    clientRequestId: parseClientRequestId(body.clientRequestId),
    noticeVersion: expectedNoticeVersion,
    answers,
  };
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAXIMUM_SAFETY_INTAKE_JSON_BYTES) {
    throw intakeError(
      413,
      "SAFETY_INTAKE_BODY_TOO_LARGE",
      "The safety intake request is too large."
    );
  }
  return parsed;
}

function canonicalSafetyIntakeRequest(input) {
  return {
    noticeVersion: input.noticeVersion,
    answers: Object.fromEntries(ANSWER_FIELDS.map((field) => [field, input.answers[field]])),
  };
}

function safetyIntakeRequestHash(input) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalSafetyIntakeRequest(input)), "utf8")
    .digest("hex");
}

function classifySafetyIntake(answers) {
  if (answers.urgentWarningSigns === true) return "URGENT_STOP";
  const painDetails = ["familiar", "mild", "severe", "sharp", "newOrWorsening"];
  if ((!answers.painOrStiffness && painDetails.some((field) => answers[field]))
      || (answers.mild && answers.severe)
      || (answers.recentSurgery === false && answers.surgeryCleared)
      || (!answers.medicalOrExerciseRestriction && answers.restrictionCanBeHonored)) {
    throw intakeError(400, "SAFETY_INTAKE_INVALID", "Invalid safety intake answers.");
  }
  if (answers.neurologicalSymptoms || answers.movementLimited
      || answers.injuryOrInstability || (answers.recentSurgery && !answers.surgeryCleared)
      || (answers.medicalOrExerciseRestriction && !answers.restrictionCanBeHonored)
      || answers.otherUnsafeConcern || answers.severe || answers.sharp
      || answers.newOrWorsening || (answers.painOrStiffness && (!answers.familiar || !answers.mild))) {
    return "MEDICAL_REVIEW_REQUIRED";
  }
  if (answers.painOrStiffness) return "MODIFICATION_REQUIRED";
  return "SCREEN_COMPLETE";
}

function validAuthorization(authorization) {
  return Boolean(
    authorization
    && authorization.active === true
    && DATABASE_ID.test(String(authorization.mappingId))
    && DATABASE_ID.test(String(authorization.memberId))
  );
}

function memberAuthenticationError() {
  return intakeError(
    401,
    "MEMBER_AUTHENTICATION_REQUIRED",
    "Member authentication is required."
  );
}

async function withTransaction(db, action) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function aggregateEffectiveState(client, memberId, noticeVersion) {
  const result = await client.query(
    `SELECT outcome, valid_until
     FROM goals_coach_member_safety_intake_v2_assessments
     WHERE member_id = $1 AND notice_version = $2
       AND valid_until > NOW()
     ORDER BY submitted_at DESC, id DESC LIMIT 1`,
    [memberId, noticeVersion]
  );
  if (!result.rows.length) return { status: "not_submitted", nextAction: "COMPLETE_SAFETY_SETUP" };
  const row = result.rows[0];
  const actions = {
    SCREEN_COMPLETE: "CONTINUE_WHEN_COACHING_IS_AVAILABLE",
    MODIFICATION_REQUIRED: "USE_COMFORTABLE_PAIN_FREE_MOVEMENT",
    MEDICAL_REVIEW_REQUIRED: "CONTACT_A_QUALIFIED_HEALTHCARE_PROFESSIONAL",
    URGENT_STOP: "SEEK_IMMEDIATE_EMERGENCY_HELP",
  };
  return { status: row.outcome, nextAction: actions[row.outcome], validUntil: row.valid_until };
}

async function readEffectiveSafetyIntake(db, memberId, noticeVersion) {
  if (!DATABASE_ID.test(String(memberId))) throw memberAuthenticationError();
  const effective = await aggregateEffectiveState(db, String(memberId), noticeVersion);
  return publicAssessment(effective);
}

async function submitSafetyIntake(db, authorization, input) {
  if (!validAuthorization(authorization)) throw memberAuthenticationError();
  const memberId = String(authorization.memberId);
  const mappingId = String(authorization.mappingId);
  const hash = safetyIntakeRequestHash(input);
  return withTransaction(db, async (client) => {
    const member = await client.query(
      `SELECT id
       FROM coach_members
       WHERE id = $1
       FOR UPDATE`,
      [memberId]
    );
    if (!member.rows.length) throw memberAuthenticationError();

    const currentMapping = await client.query(
      `SELECT id
       FROM goals_coach_member_auth_mappings
       WHERE id = $1 AND member_id = $2 AND active = TRUE
       FOR UPDATE`,
      [mappingId, memberId]
    );
    if (!currentMapping.rows.length) throw memberAuthenticationError();

    const existing = await client.query(
      `SELECT client_request_hash
       FROM goals_coach_member_safety_intake_v2_assessments
       WHERE member_id = $1 AND client_request_id = $2`,
      [memberId, input.clientRequestId]
    );
    let created = false;
    if (existing.rows.length) {
      if (existing.rows[0].client_request_hash !== hash) {
        throw intakeError(
          409,
          "SAFETY_INTAKE_IDEMPOTENCY_CONFLICT",
          "The clientRequestId was already used for different safety answers."
        );
      }
    } else {
      const outcome = classifySafetyIntake(input.answers);
      const validUntil = new Date(Date.now() + ASSESSMENT_VALID_MILLISECONDS);
      await client.query(
        `INSERT INTO goals_coach_member_safety_intake_v2_assessments
          (auth_mapping_id, member_id, client_request_id, client_request_hash,
           notice_version, outcome, rule_version, valid_until)
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8
         )`,
        [
          mappingId,
          memberId,
          input.clientRequestId,
          hash,
          input.noticeVersion,
          outcome,
          MEMBER_SAFETY_INTAKE_RULE_VERSION,
          validUntil,
        ]
      );
      created = true;
    }
    const effective = await aggregateEffectiveState(client, memberId, input.noticeVersion);
    return {
      created,
      safetyIntake: publicAssessment(effective),
    };
  });
}

function createRateLimits() {
  const shared = {
    windowMs: 15 * 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `member:${String(req.alphaMemberIdentity.authSubject)}`,
    handler: (_req, res) => res.status(429).json({ error: "RATE_LIMITED" }),
  };
  return {
    read: rateLimit({ ...shared, max: 120 }),
    mutation: rateLimit({ ...shared, max: 10 }),
  };
}

function createGymMasterMemberSafetyIntakeRouter(options = {}) {
  const db = options.db;
  const authenticateSession = options.authenticateSession;
  const expectedOrigin = options.origin;
  const noticeVersion = approvedNoticeVersion(options.noticeVersion);
  if (!db || typeof db.query !== "function" || typeof db.connect !== "function") {
    throw new Error("Member safety intake requires a transactional database");
  }
  if (typeof authenticateSession !== "function") {
    throw new Error("Member safety intake requires member session authentication");
  }
  if (typeof expectedOrigin !== "string" || !expectedOrigin) {
    throw new Error("Member safety intake requires one exact origin");
  }
  if (!noticeVersion) {
    throw new Error("Member safety intake requires an approved notice version");
  }
  const authorizeIdentity = options.authorizeIdentity;
  if (typeof authorizeIdentity !== "function") {
    throw new Error("Member safety intake requires current member access authorization");
  }
  const rateLimits = options.rateLimits || createRateLimits();
  const router = express.Router();

  function protectMember(req, res, next) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.headers.origin !== expectedOrigin) {
      return res.status(403).json({ error: "MEMBER_ORIGIN_NOT_ALLOWED" });
    }
    return authenticateSession(req, res, next);
  }

  async function authorizeActiveMapping(req, res, next) {
    try {
      if (!validGymMasterIdentity(req.alphaMemberIdentity)) {
        return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      }
      const authorization = await authorizeIdentity(req.alphaMemberIdentity);
      if (memberAccessDependencyUnavailable(authorization)) {
        return res.status(503).json({
          error: "MEMBER_ACCESS_TEMPORARILY_UNAVAILABLE",
          message: "We can’t verify your access right now. Please try again later.",
          nextAction: "TRY_AGAIN_LATER",
        });
      }
      if (!authorization.active) {
        return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      }
      req.memberSafetyIntakeAuthorization = authorization;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  router.get(
    "/",
    protectMember,
    rateLimits.read,
    authorizeActiveMapping,
    async (req, res, next) => {
      try {
        rejectUnknownKeys(req.query, [], "safety intake query");
        const result = await readEffectiveSafetyIntake(
          db,
          req.memberSafetyIntakeAuthorization.memberId,
          noticeVersion
        );
        return res.status(200).json({ safetyIntake: result });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.post(
    "/",
    protectMember,
    rateLimits.mutation,
    authorizeActiveMapping,
    async (req, res, next) => {
      try {
        rejectUnknownKeys(req.query, [], "safety intake query");
        if (!req.is("application/json")) {
          throw intakeError(
            415,
            "SAFETY_INTAKE_MEDIA_TYPE_UNSUPPORTED",
            "Safety intake requires application/json."
          );
        }
        const input = parseSafetyIntake(req.body, noticeVersion);
        const result = await submitSafetyIntake(
          db,
          req.memberSafetyIntakeAuthorization,
          input
        );
        return res.status(result.created ? 201 : 200).json({
          safetyIntake: result.safetyIntake,
          idempotentReplay: !result.created,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}

module.exports = {
  ANSWER_FIELDS,
  MAXIMUM_SAFETY_INTAKE_JSON_BYTES,
  MEMBER_SAFETY_INTAKE_FLAG,
  MEMBER_SAFETY_NOTICE,
  MEMBER_SAFETY_NOTICE_VERSION,
  MEMBER_SAFETY_INTAKE_RULE_VERSION,
  approvedNoticeVersion,
  canonicalSafetyIntakeRequest,
  createGymMasterMemberSafetyIntakeRouter,
  memberSafetyIntakeEnabled,
  parseSafetyIntake,
  readEffectiveSafetyIntake,
  safetyIntakeRequestHash,
  classifySafetyIntake,
  submitSafetyIntake,
};
