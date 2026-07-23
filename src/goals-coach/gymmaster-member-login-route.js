"use strict";

const { memberAccessFailureStage } = require("./gymmaster-gatekeeper-membership");
const { buildGymMasterSessionCookie } = require("./gymmaster-member-session");

const OWNER_LOGIN_STAGE_DIAGNOSTIC_FLAG = "GOALS_COACH_OWNER_LOGIN_STAGE_DIAGNOSTIC";
const OWNER_LOGIN_STAGES = Object.freeze(new Set([
  "member_portal",
  "local_mapping",
  "gatekeeper",
  "owner_authorization",
]));

function ownerLoginStageDiagnosticEnabled(value) {
  return value === "true";
}

function exactHttpsOrigin(value) {
  if (typeof value !== "string" || !value || value.includes("*")) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.origin !== value
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) return null;
    return value;
  } catch (_) {
    return null;
  }
}

function createGymMasterMemberLoginHandler(options = {}) {
  const enabled = options.enabled === true;
  const expectedOrigin = exactHttpsOrigin(options.origin);
  const loginService = options.loginService;
  const sessionService = options.sessionService;
  const authorizeIdentity = options.authorizeIdentity;
  const authorizeOwner = options.authorizeOwner === undefined ? null : options.authorizeOwner;
  const attemptLimiter = options.attemptLimiter;
  const diagnosticEnabled = ownerLoginStageDiagnosticEnabled(options.ownerLoginStageDiagnostic);
  const diagnosticSink = typeof options.diagnosticSink === "function"
    ? options.diagnosticSink
    : console.log;

  function reportFailureStage(stage) {
    if (diagnosticEnabled && OWNER_LOGIN_STAGES.has(stage)) {
      try {
        diagnosticSink(`[UGF] goals_coach_owner_login_stage=${stage}`);
      } catch (_) {
        // Diagnostics must never alter the public login failure.
      }
    }
  }

  return async function loginGymMasterMember(req, res) {
    if (!enabled) return res.status(404).json({ error: "MEMBER_LOGIN_NOT_AVAILABLE" });
    if (
      !expectedOrigin
      || !loginService
      || typeof loginService.authenticate !== "function"
      || !sessionService
      || typeof sessionService.issue !== "function"
      || typeof authorizeIdentity !== "function"
      || (authorizeOwner !== null && typeof authorizeOwner !== "function")
      || !attemptLimiter
      || typeof attemptLimiter.allow !== "function"
    ) {
      return res.status(503).json({ error: "MEMBER_LOGIN_NOT_AVAILABLE" });
    }
    if (!req || typeof req.get !== "function" || req.get("Origin") !== expectedOrigin) {
      return res.status(403).json({ error: "MEMBER_LOGIN_ORIGIN_NOT_ALLOWED" });
    }
    if (!attemptLimiter.allow(req.ip)) {
      return res.status(429).json({ error: "MEMBER_LOGIN_RATE_LIMITED" });
    }

    let failureStage = "member_portal";
    try {
      const identity = await loginService.authenticate(req.body);
      failureStage = "local_mapping";
      const activeMember = await authorizeIdentity(identity);
      if (!activeMember || activeMember.active !== true) {
        reportFailureStage(
          OWNER_LOGIN_STAGES.has(memberAccessFailureStage(activeMember))
            ? memberAccessFailureStage(activeMember)
            : "local_mapping"
        );
        return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
      }
      failureStage = "owner_authorization";
      if (authorizeOwner !== null && await authorizeOwner(identity) !== true) {
        reportFailureStage("owner_authorization");
        return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
      }
      const session = sessionService.issue(identity);
      res.setHeader("Set-Cookie", buildGymMasterSessionCookie(session));
      return res.status(204).send();
    } catch (_) {
      reportFailureStage(failureStage);
      return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
    }
  };
}

module.exports = {
  OWNER_LOGIN_STAGE_DIAGNOSTIC_FLAG,
  createGymMasterMemberLoginHandler,
  exactHttpsOrigin,
  ownerLoginStageDiagnosticEnabled,
};
