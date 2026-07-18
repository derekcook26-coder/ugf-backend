const rateLimit = require("express-rate-limit");

function alphaLimiter(options) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `alpha:${String(req.alphaMember.mappingId)}`,
    message: { error: "RATE_LIMITED", message: options.message },
  });
}

function createAlphaRateLimits(overrides = {}) {
  return {
    consent: alphaLimiter({
      windowMs: 60 * 60 * 1000,
      max: overrides.consentMax || 20,
      message: "Please wait before changing private-alpha consent again.",
    }),
    session: alphaLimiter({
      windowMs: 60 * 60 * 1000,
      max: overrides.sessionMax || 10,
      message: "Please wait before starting another private-alpha conversation.",
    }),
    read: alphaLimiter({
      windowMs: 15 * 60 * 1000,
      max: overrides.readMax || 180,
      message: "Please wait before loading more private-alpha information.",
    }),
    message: alphaLimiter({
      windowMs: 60 * 60 * 1000,
      max: overrides.messageMax || 60,
      message: "Please wait before sending another private-alpha test message.",
    }),
    mutation: alphaLimiter({
      windowMs: 60 * 60 * 1000,
      max: overrides.mutationMax || 30,
      message: "Please wait before making another private-alpha change.",
    }),
  };
}

module.exports = { createAlphaRateLimits };
