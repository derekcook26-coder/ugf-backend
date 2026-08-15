"use strict";

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { validGymMasterIdentity } = require("./gymmaster-member-authorization");
const { memberAccessDependencyUnavailable } = require("./gymmaster-gatekeeper-membership");

const MEMBER_COACHING_CONSENT_FLAG = "GOALS_COACH_MEMBER_COACHING_CONSENT_ENABLED";
const MEMBER_COACHING_CONSENT_NOTICE_VERSION = "GC-MEMBER-COACHING-CONSENT-1";
const MEMBER_COACHING_CONSENT_NOTICE = "Goals Coach may use your approved membership context, current safety result, current Goals Coach plan, and answers you deliberately submit to personalize coaching. Goals Coach does not replace medical care or medical advice, and safety rules may pause or limit coaching. An AI service may be used only when separately approved, gated, and available. You may decline or later withdraw consent; that prevents personalized coaching but does not affect your gym membership. Coaching, AI-provider access, plans, voice, and human review are not activated by this consent.";
const MAXIMUM_COACHING_CONSENT_JSON_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATABASE_ID = /^[1-9]\d{0,18}$/;
const NOTICE_VERSION = /^GC-MEMBER-COACHING-CONSENT-[1-9][0-9]*$/;

function memberCoachingConsentEnabled(value) { return value === "true"; }
function consentError(statusCode, code, message) {
  const error = new Error(message); error.statusCode = statusCode; error.code = code; error.exposeMessage = true; return error;
}
function exactObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function rejectUnknownKeys(value, allowed) {
  if (!exactObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw consentError(400, "COACHING_CONSENT_INVALID", "Invalid coaching consent request.");
}
function parseCoachingConsent(body, expectedNoticeVersion) {
  rejectUnknownKeys(body, ["clientRequestId", "noticeVersion", "action"]);
  if (typeof body.clientRequestId !== "string" || !UUID.test(body.clientRequestId)
      || !["accept", "decline", "withdraw"].includes(body.action)) {
    throw consentError(400, "COACHING_CONSENT_INVALID", "Invalid coaching consent request.");
  }
  if (typeof body.noticeVersion !== "string" || !NOTICE_VERSION.test(body.noticeVersion)) throw consentError(400, "COACHING_CONSENT_NOTICE_VERSION_INVALID", "The coaching consent notice version is invalid.");
  const input = { clientRequestId: body.clientRequestId, noticeVersion: body.noticeVersion, action: body.action };
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAXIMUM_COACHING_CONSENT_JSON_BYTES) throw consentError(413, "COACHING_CONSENT_BODY_TOO_LARGE", "The coaching consent request is too large.");
  return input;
}
function coachingConsentRequestHash(input) {
  return crypto.createHash("sha256").update(JSON.stringify({ noticeVersion: input.noticeVersion, action: input.action }), "utf8").digest("hex");
}
function validAuthorization(value) {
  return Boolean(value && value.active === true && DATABASE_ID.test(String(value.mappingId)) && DATABASE_ID.test(String(value.memberId)));
}
function authenticationError() { return consentError(401, "MEMBER_AUTHENTICATION_REQUIRED", "Member authentication is required."); }
function publicConsent(row, noticeVersion) {
  const current = Boolean(row && row.notice_version === noticeVersion && row.status === "accepted");
  return { noticeVersion, status: row && row.notice_version === noticeVersion ? row.status : "not_recorded", acceptedForCurrentNotice: current, activationPermitted: false };
}
async function readCoachingConsent(db, memberId, noticeVersion) {
  if (!DATABASE_ID.test(String(memberId))) throw authenticationError();
  const result = await db.query("SELECT notice_version, status FROM goals_coach_member_coaching_consents WHERE member_id = $1", [String(memberId)]);
  return publicConsent(result.rows[0], noticeVersion);
}
async function withTransaction(db, action) {
  const client = await db.connect();
  try { await client.query("BEGIN"); const value = await action(client); await client.query("COMMIT"); return value; }
  catch (error) { try { await client.query("ROLLBACK"); } catch (_) {} throw error; }
  finally { client.release(); }
}
async function submitCoachingConsent(db, identity, authorization, input, requiredNoticeVersion = MEMBER_COACHING_CONSENT_NOTICE_VERSION) {
  if (!validGymMasterIdentity(identity) || !validAuthorization(authorization)) throw authenticationError();
  const memberId = String(authorization.memberId); const mappingId = String(authorization.mappingId); const hash = coachingConsentRequestHash(input);
  return withTransaction(db, async (client) => {
    const mapping = await client.query("SELECT id FROM goals_coach_member_auth_mappings WHERE id=$1 AND member_id=$2 AND auth_provider=$3 AND auth_subject=$4 AND active=TRUE FOR UPDATE", [mappingId, memberId, identity.authProvider, identity.authSubject]);
    if (!mapping.rows.length) throw authenticationError();
    const replay = await client.query("SELECT client_request_hash,result_notice_version,result_status FROM goals_coach_member_coaching_consent_events WHERE member_id=$1 AND client_request_id=$2", [memberId, input.clientRequestId]);
    if (replay.rows.length) {
      if (replay.rows[0].client_request_hash !== hash) throw consentError(409, "COACHING_CONSENT_IDEMPOTENCY_CONFLICT", "The clientRequestId was already used for a different coaching consent request.");
      return { created: false, consent: publicConsent({ notice_version: replay.rows[0].result_notice_version, status: replay.rows[0].result_status }, replay.rows[0].result_notice_version) };
    }
    if (input.noticeVersion !== requiredNoticeVersion) throw consentError(400, "COACHING_CONSENT_NOTICE_VERSION_INVALID", "The coaching consent notice version is invalid.");
    const currentResult = await client.query("SELECT notice_version,status,accepted_at FROM goals_coach_member_coaching_consents WHERE member_id=$1 FOR UPDATE", [memberId]);
    const current = currentResult.rows[0]; const eventType = `${input.action}${input.action === "accept" ? "ed" : input.action === "decline" ? "d" : "n"}`;
    if (input.action === "decline" && current && current.notice_version === input.noticeVersion && current.status === "accepted") throw consentError(409, "COACHING_CONSENT_WITHDRAW_REQUIRED", "Withdraw accepted coaching consent before recording another choice.");
    if (input.action === "withdraw" && (!current || current.notice_version !== input.noticeVersion || current.status !== "accepted")) throw consentError(409, "COACHING_CONSENT_WITHDRAWAL_NOT_ALLOWED", "Current accepted coaching consent is required to withdraw.");
    const timestampColumn = `${eventType}_at`;
    if (input.action === "withdraw") {
      await client.query(`UPDATE goals_coach_member_coaching_consents SET auth_mapping_id=$1,status='withdrawn',withdrawn_at=NOW(),updated_at=NOW() WHERE member_id=$2`, [mappingId, memberId]);
    } else {
      await client.query(`INSERT INTO goals_coach_member_coaching_consents (member_id,auth_mapping_id,notice_version,status,${timestampColumn},updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW()) ON CONFLICT (member_id) DO UPDATE SET auth_mapping_id=EXCLUDED.auth_mapping_id,notice_version=EXCLUDED.notice_version,status=EXCLUDED.status,accepted_at=EXCLUDED.accepted_at,declined_at=EXCLUDED.declined_at,withdrawn_at=NULL,updated_at=EXCLUDED.updated_at`, [memberId, mappingId, input.noticeVersion, eventType]);
    }
    await client.query("INSERT INTO goals_coach_member_coaching_consent_events (member_id,auth_mapping_id,auth_provider,auth_subject,notice_version,event_type,client_request_id,client_request_hash,result_notice_version,result_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5,$6)", [memberId, mappingId, identity.authProvider, identity.authSubject, input.noticeVersion, eventType, input.clientRequestId, hash]);
    const state = await client.query("SELECT notice_version,status FROM goals_coach_member_coaching_consents WHERE member_id=$1", [memberId]);
    return { created: true, consent: publicConsent(state.rows[0], input.noticeVersion) };
  });
}
function createRateLimits() {
  const shared = { windowMs: 15 * 60 * 1000, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `member:${String(req.alphaMemberIdentity.authSubject)}`, handler: (_req, res) => res.status(429).json({ error: "RATE_LIMITED" }) };
  return { read: rateLimit({ ...shared, max: 120 }), mutation: rateLimit({ ...shared, max: 10 }) };
}
function createGymMasterMemberCoachingConsentRouter(options = {}) {
  const { db, authenticateSession, authorizeIdentity, origin } = options; const noticeVersion = options.noticeVersion === MEMBER_COACHING_CONSENT_NOTICE_VERSION ? options.noticeVersion : null;
  if (!db || typeof db.query !== "function" || typeof db.connect !== "function") throw new Error("Member coaching consent requires a transactional database");
  if (typeof authenticateSession !== "function" || typeof authorizeIdentity !== "function" || !origin || !noticeVersion) throw new Error("Member coaching consent dependencies are incomplete");
  const limits = options.rateLimits || createRateLimits(); const router = express.Router();
  const parseRawJson = express.json({ inflate: false, limit: MAXIMUM_COACHING_CONSENT_JSON_BYTES, strict: true });
  function protect(req, res, next) { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); if (req.headers.origin !== origin) return res.status(403).json({ error: "MEMBER_ORIGIN_NOT_ALLOWED" }); return authenticateSession(req, res, next); }
  async function authorize(req, res, next) {
    try {
      if (!validGymMasterIdentity(req.alphaMemberIdentity)) return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      const result = await authorizeIdentity(req.alphaMemberIdentity);
      if (memberAccessDependencyUnavailable(result)) return res.status(503).json({ error: "MEMBER_ACCESS_TEMPORARILY_UNAVAILABLE", message: "We can’t verify your access right now. Please try again later.", nextAction: "TRY_AGAIN_LATER" });
      if (!result.active) return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      req.memberCoachingConsentAuthorization = result; return next();
    } catch (_) { return res.status(503).json({ error: "MEMBER_ACCESS_TEMPORARILY_UNAVAILABLE", message: "We can’t verify your access right now. Please try again later.", nextAction: "TRY_AGAIN_LATER" }); }
  }
  router.get("/", protect, limits.read, authorize, async (req, res, next) => { try { rejectUnknownKeys(req.query, []); const consent = await readCoachingConsent(db, req.memberCoachingConsentAuthorization.memberId, noticeVersion); return res.status(200).json({ notice: MEMBER_COACHING_CONSENT_NOTICE, consent }); } catch (error) { return next(error); } });
  router.post("/", protect, limits.mutation, (req, res, next) => {
    try { rejectUnknownKeys(req.query, []); if (!req.is("application/json")) throw consentError(415, "COACHING_CONSENT_MEDIA_TYPE_UNSUPPORTED", "Coaching consent requires application/json."); return parseRawJson(req, res, next); } catch (error) { return next(error); }
  }, authorize, async (req, res, next) => { try { const input = parseCoachingConsent(req.body, noticeVersion); const result = await submitCoachingConsent(db, req.alphaMemberIdentity, req.memberCoachingConsentAuthorization, input, noticeVersion); return res.status(result.created ? 201 : 200).json({ consent: result.consent, idempotentReplay: !result.created }); } catch (error) { return next(error); } });
  return router;
}
module.exports = { MAXIMUM_COACHING_CONSENT_JSON_BYTES, MEMBER_COACHING_CONSENT_FLAG, MEMBER_COACHING_CONSENT_NOTICE, MEMBER_COACHING_CONSENT_NOTICE_VERSION, coachingConsentRequestHash, createGymMasterMemberCoachingConsentRouter, memberCoachingConsentEnabled, parseCoachingConsent, readCoachingConsent, submitCoachingConsent };
