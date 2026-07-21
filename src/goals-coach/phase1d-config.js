"use strict";

const APPROVED_PHASE1D_SAFETY_CONSENT_VERSION = "GC-PHASE1D-SAFETY-1";

function exactTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function loadPhase1dConfiguration(environment = process.env) {
  const consentVersion = String(environment.GOALS_COACH_PHASE1D_SAFETY_CONSENT_VERSION || "").trim();
  return Object.freeze({
    safetyEnabled: exactTrue(environment.GOALS_COACH_PHASE1D_SAFETY_ENABLED),
    consentVersion,
    consentApproved: consentVersion === APPROVED_PHASE1D_SAFETY_CONSENT_VERSION,
    environment: String(environment.NODE_ENV || "development"),
  });
}

module.exports = {
  APPROVED_PHASE1D_SAFETY_CONSENT_VERSION,
  exactTrue,
  loadPhase1dConfiguration,
};
