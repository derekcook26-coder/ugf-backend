const APPROVED_ALPHA_CONSENT_VERSION = "GC-ALPHA-CONSENT-1.0";

function alphaEnabled(value = process.env.GOALS_COACH_ALPHA_ENABLED) {
  return String(value || "").trim().toLowerCase() === "true";
}

function createAlphaFeatureGate(options = {}) {
  const enabled = options.enabled === undefined ? alphaEnabled() : Boolean(options.enabled);
  return function requireAlphaEnabled(req, res, next) {
    if (!enabled) return res.status(404).json({ error: "ALPHA_NOT_AVAILABLE" });
    return next();
  };
}

function loadAlphaApplicationConfiguration(environment = process.env.NODE_ENV || "development") {
  const consentVersion = process.env.GOALS_COACH_ALPHA_CONSENT_VERSION || "";
  const alphaEnvironment = process.env.GOALS_COACH_ALPHA_ENVIRONMENT || "";
  return {
    environment,
    alphaEnvironment,
    consentVersion,
    valid: consentVersion === APPROVED_ALPHA_CONSENT_VERSION
      && ["test", "development", "staging", "private_alpha"].includes(alphaEnvironment),
  };
}

module.exports = {
  APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnabled,
  createAlphaFeatureGate,
  loadAlphaApplicationConfiguration,
};
