const rateLimit = require("express-rate-limit");

function limiter(options) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: options.keyGenerator,
    message: { error: "RATE_LIMITED", message: options.message },
  });
}

function createGoalsCoachRateLimits(overrides = {}) {
  const memberKey = (req) => `member:${String(req.memberClaims.sub)}`;
  const staffKey = (req) => `staff:${String(req.staffUser.id)}`;
  return {
    memberSession: limiter({
      windowMs: 60 * 60 * 1000,
      max: overrides.memberSessionMax || 10,
      keyGenerator: memberKey,
      message: "Please wait before starting another coaching conversation.",
    }),
    memberRead: limiter({
      windowMs: 15 * 60 * 1000,
      max: overrides.memberReadMax || 180,
      keyGenerator: memberKey,
      message: "Please wait before loading more coaching history.",
    }),
    memberMessage: limiter({
      windowMs: 60 * 60 * 1000,
      max: overrides.memberMessageMax || 60,
      keyGenerator: memberKey,
      message: "Please wait before sending another coaching message.",
    }),
    memberClose: limiter({
      windowMs: 60 * 60 * 1000,
      max: overrides.memberCloseMax || 10,
      keyGenerator: memberKey,
      message: "Please wait before closing another coaching conversation.",
    }),
    staffRead: limiter({
      windowMs: 15 * 60 * 1000,
      max: overrides.staffReadMax || 300,
      keyGenerator: staffKey,
      message: "Please wait before loading more Coaching Reviews.",
    }),
    staffMutation: limiter({
      windowMs: 15 * 60 * 1000,
      max: overrides.staffMutationMax || 120,
      keyGenerator: staffKey,
      message: "Please wait before making another Coaching Review change.",
    }),
  };
}

module.exports = { createGoalsCoachRateLimits };
