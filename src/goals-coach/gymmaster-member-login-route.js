"use strict";

const { buildGymMasterSessionCookie } = require("./gymmaster-member-session");

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

    try {
      const identity = await loginService.authenticate(req.body);
      const activeMember = await authorizeIdentity(identity);
      if (!activeMember || activeMember.active !== true) {
        return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
      }
      if (authorizeOwner !== null && await authorizeOwner(identity) !== true) {
        return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
      }
      const session = sessionService.issue(identity);
      res.setHeader("Set-Cookie", buildGymMasterSessionCookie(session));
      return res.status(204).send();
    } catch (_) {
      return res.status(401).json({ error: "MEMBER_LOGIN_FAILED" });
    }
  };
}

module.exports = {
  createGymMasterMemberLoginHandler,
  exactHttpsOrigin,
};
