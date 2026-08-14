"use strict";

const rateLimit = require("express-rate-limit");
const { memberAccessDependencyUnavailable } = require("./gymmaster-gatekeeper-membership");

const PRIVATE_SCREEN_BODY = Object.freeze({
  status: "COACHING_UNAVAILABLE",
  message: "You’re signed in. Goals Coach isn’t available yet.",
  nextAction: "CHECK_BACK_LATER",
  activationPermitted: false,
  externalCallsPermitted: false,
});
const UNAUTHORIZED_BODY = Object.freeze({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
const UNAVAILABLE_BODY = Object.freeze({
  error: "MEMBER_ACCESS_TEMPORARILY_UNAVAILABLE",
  message: "We can’t verify your access right now. Please try again later.",
  nextAction: "TRY_AGAIN_LATER",
});

function createPrivateScreenRateLimit(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    max: options.max || 120,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => `member:${String(req.alphaMemberIdentity.authSubject)}`,
    handler: (_req, res) => res.status(401).json(UNAUTHORIZED_BODY),
  });
}

function privateResponseHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}

function createGymMasterMemberPrivateScreenHandler(options = {}) {
  const authenticateSession = options.authenticateSession;
  const authorizeIdentity = options.authorizeIdentity;
  const rateLimiter = options.rateLimiter || createPrivateScreenRateLimit();
  if (typeof authenticateSession !== "function" || typeof authorizeIdentity !== "function") {
    throw new Error("Member private screen requires session and access authorization");
  }

  async function authorize(req, res) {
    let access;
    try {
      access = await authorizeIdentity(req.alphaMemberIdentity);
    } catch (_) {
      return res.status(503).json(UNAVAILABLE_BODY);
    }
    if (access && access.active === true) return res.status(200).json(PRIVATE_SCREEN_BODY);
    return res.status(memberAccessDependencyUnavailable(access) ? 503 : 401).json(
      memberAccessDependencyUnavailable(access) ? UNAVAILABLE_BODY : UNAUTHORIZED_BODY
    );
  }

  if (typeof rateLimiter !== "function") {
    throw new Error("Member private screen requires a rate limiter");
  }

  return [privateResponseHeaders, authenticateSession, rateLimiter, authorize];
}

module.exports = {
  PRIVATE_SCREEN_BODY,
  UNAUTHORIZED_BODY,
  UNAVAILABLE_BODY,
  createPrivateScreenRateLimit,
  createGymMasterMemberPrivateScreenHandler,
  privateResponseHeaders,
};
