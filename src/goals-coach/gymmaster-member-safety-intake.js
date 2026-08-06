"use strict";

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  createGymMasterMemberAuthorization,
  validGymMasterIdentity,
} = require("./gymmaster-member-authorization");

const MEMBER_SAFETY_INTAKE_FLAG =
  "GOALS_COACH_MEMBER_SAFETY_INTAKE_ALPHA_ENABLED";
const MEMBER_SAFETY_INTAKE_NOTICE_VERSION_CONFIGURATION =
  "GOALS_COACH_MEMBER_SAFETY_INTAKE_NOTICE_VERSION";
const MEMBER_SAFETY_INTAKE_RULE_VERSION = "GC-MEMBER-SAFETY-INTAKE-1";
const MAXIMUM_SAFETY_INTAKE_JSON_BYTES = 4096;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATABASE_ID = /^[1-9]\d{0,18}$/;
const ANSWER_FIELDS = Object.freeze([
  "currentPainOrConcerningSymptoms",
  "currentInjuryConcern",
  "recentSurgery",
  "medicalOrExerciseRestriction",
  "otherTrainingSafetyConcern",
]);

function memberSafetyIntakeEnabled(value) {
  return value === "true";
}

function approvedNoticeVersion(value) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length < 1
    || value.length > 100
    || /[^\x20-\x7e]/.test(value)
  ) {
    return null;
  }
  return value;
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
    answers: {
      currentPainOrConcerningSymptoms:
        input.answers.currentPainOrConcerningSymptoms,
      currentInjuryConcern: input.answers.currentInjuryConcern,
      recentSurgery: input.answers.recentSurgery,
      medicalOrExerciseRestriction:
        input.answers.medicalOrExerciseRestriction,
      otherTrainingSafetyConcern:
        input.answers.otherTrainingSafetyConcern,
    },
  };
}

function safetyIntakeRequestHash(input) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalSafetyIntakeRequest(input)), "utf8")
    .digest("hex");
}

function submissionSafetyStop(answers) {
  return ANSWER_FIELDS.some((field) => answers[field] === true);
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

async function aggregateEffectiveState(client, memberId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS submission_count,
            COALESCE(BOOL_OR(safety_stop), FALSE) AS safety_stop
     FROM goals_coach_member_safety_intake_submissions
     WHERE member_id = $1`,
    [memberId]
  );
  const row = result.rows[0];
  if (Number(row.submission_count) === 0) {
    return { status: "not_submitted", safetyStop: null };
  }
  const safetyStop = row.safety_stop === true;
  return {
    status: safetyStop ? "handoff_required" : "screen_complete",
    safetyStop,
  };
}

async function readEffectiveSafetyIntake(db, memberId, noticeVersion) {
  if (!DATABASE_ID.test(String(memberId))) throw memberAuthenticationError();
  const effective = await aggregateEffectiveState(db, String(memberId));
  return {
    noticeVersion,
    status: effective.status,
    safetyStop: effective.safetyStop,
  };
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
       FROM goals_coach_member_safety_intake_submissions
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
      const safetyStop = submissionSafetyStop(input.answers);
      await client.query(
        `INSERT INTO goals_coach_member_safety_intake_submissions
          (auth_mapping_id, member_id, client_request_id, client_request_hash,
           notice_version, current_pain_or_concerning_symptoms,
           current_injury_concern, recent_surgery,
           medical_or_exercise_restriction, other_training_safety_concern,
           outcome, safety_stop, rule_version)
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
         )`,
        [
          mappingId,
          memberId,
          input.clientRequestId,
          hash,
          input.noticeVersion,
          input.answers.currentPainOrConcerningSymptoms,
          input.answers.currentInjuryConcern,
          input.answers.recentSurgery,
          input.answers.medicalOrExerciseRestriction,
          input.answers.otherTrainingSafetyConcern,
          safetyStop ? "handoff_required" : "screen_complete",
          safetyStop,
          MEMBER_SAFETY_INTAKE_RULE_VERSION,
        ]
      );
      created = true;
    }
    const effective = await aggregateEffectiveState(client, memberId);
    return {
      created,
      safetyIntake: {
        noticeVersion: input.noticeVersion,
        status: effective.status,
        safetyStop: effective.safetyStop,
      },
    };
  });
}

function createRateLimits() {
  const shared = {
    windowMs: 15 * 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
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
  const mappingAuthorization = options.mappingAuthorization
    || createGymMasterMemberAuthorization({ db });
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
      const authorization = await mappingAuthorization.authorizeIdentity(
        req.alphaMemberIdentity
      );
      if (!authorization.active) {
        return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      }
      req.memberSafetyIntakeAuthorization = authorization;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  const protectedMember = [protectMember, authorizeActiveMapping];

  router.get(
    "/safety-intake",
    ...protectedMember,
    rateLimits.read,
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
    "/safety-intake",
    ...protectedMember,
    rateLimits.mutation,
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
  MEMBER_SAFETY_INTAKE_NOTICE_VERSION_CONFIGURATION,
  MEMBER_SAFETY_INTAKE_RULE_VERSION,
  approvedNoticeVersion,
  canonicalSafetyIntakeRequest,
  createGymMasterMemberSafetyIntakeRouter,
  memberSafetyIntakeEnabled,
  parseSafetyIntake,
  readEffectiveSafetyIntake,
  safetyIntakeRequestHash,
  submitSafetyIntake,
};
