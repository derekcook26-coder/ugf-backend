"use strict";

const { memberAccessFailureStage } = require("./gymmaster-gatekeeper-membership");
const { buildGymMasterSessionCookie } = require("./gymmaster-member-session");

const OWNER_LOGIN_STAGE_DIAGNOSTIC_FLAG = "GOALS_COACH_OWNER_LOGIN_STAGE_DIAGNOSTIC";
const OWNER_LOGIN_STAGES = Object.freeze(new Set([
  "member_portal_request_failure",
  "member_portal_non_success_response",
  "member_portal_provider_failure",
  "member_portal_invalid_envelope_result",
  "member_portal_invalid_envelope_token",
  "member_portal_invalid_envelope_expires",
  "member_portal_invalid_envelope_memberid",
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
  const completePendingEnrollment = options.completePendingEnrollment === undefined
    ? null
    : options.completePendingEnrollment;
  const attemptLimiter = options.attemptLimiter;
  const diagnosticEnabled = ownerLoginStageDiagnosticEnabled(options.ownerLoginStageDiagnostic);
  const diagnosticSink = typeof options.diagnosticSink === "function"
    ? options.diagnosticSink
    : console.log;
  const buildSessionCookie = typeof options.buildSessionCookie === "function" ? options.buildSessionCookie : buildGymMasterSessionCookie;
  const createSessionOperationContext = typeof options.createSessionOperationContext === "function" ? options.createSessionOperationContext : null;

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
      || (
        completePendingEnrollment !== null
        && typeof completePendingEnrollment !== "function"
      )
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

    let failureStage = "member_portal_request_failure";
    const sessionOperation = createSessionOperationContext ? createSessionOperationContext(req, res) : null;
    try {
      if (sessionOperation && sessionOperation.terminalState.isTerminal()) return undefined;
      const identity = await loginService.authenticate(req.body);
      if (sessionOperation && sessionOperation.terminalState.isTerminal()) return undefined;
      failureStage = "local_mapping";
      let activeMember = await authorizeIdentity(identity);
      if (sessionOperation && sessionOperation.terminalState.isTerminal()) return undefined;
      const accessFailureStage = memberAccessFailureStage(activeMember);
      if (
        (!activeMember || activeMember.active !== true)
        && completePendingEnrollment !== null
        && accessFailureStage === "local_mapping"
      ) {
        activeMember = await completePendingEnrollment(identity);
        if (sessionOperation && sessionOperation.terminalState.isTerminal()) return undefined;
      }
      if (!activeMember || activeMember.active !== true) {
        reportFailureStage(
          OWNER_LOGIN_STAGES.has(accessFailureStage)
            ? accessFailureStage
            : "local_mapping"
        );
        return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
      }
      failureStage = "owner_authorization";
      const ownerAuthorized = authorizeOwner === null ? true : await authorizeOwner(identity);
      if (sessionOperation && sessionOperation.terminalState.isTerminal()) return undefined;
      if (ownerAuthorized !== true) {
        reportFailureStage("owner_authorization");
        return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
      }
      const session = await sessionService.issue(identity, activeMember, sessionOperation);
      if (sessionOperation && sessionOperation.terminalState.isTerminal()) { if (!sessionOperation.responseAllowed()) return undefined; throw new Error("Member session issuance crossed its terminal deadline"); }
      res.setHeader("Set-Cookie", buildSessionCookie(session));
      return res.status(204).send();
    } catch (error) {
      if (sessionOperation && !sessionOperation.responseAllowed()) return undefined;
      reportFailureStage(
        OWNER_LOGIN_STAGES.has(error && error.memberPortalFailureStage)
          ? error.memberPortalFailureStage
          : failureStage
      );
      return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
    } finally { if (sessionOperation) sessionOperation.cleanup(); }
  };
}

module.exports = {
  OWNER_LOGIN_STAGE_DIAGNOSTIC_FLAG,
  createGymMasterMemberLoginHandler,
  exactHttpsOrigin,
  ownerLoginStageDiagnosticEnabled,
};
