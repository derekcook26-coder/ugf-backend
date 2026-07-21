"use strict";

const { createCoachingCapability } = require("./phase1b-contracts");
const { loadPhase1dConfiguration } = require("./phase1d-config");

function startupResult(status, reason, configuration, safetyService = null, reviewRouting = null) {
  return Object.freeze({ status, reason, configuration, safetyService, reviewRouting });
}

function createPhase1dStartup(options = {}) {
  const configuration = options.configuration || loadPhase1dConfiguration(options.environment || process.env);
  if (!configuration.safetyEnabled) return startupResult("disabled", "safety_disabled", configuration);
  if (createCoachingCapability(options.phase1bStartup).status !== "ready") {
    return startupResult("unavailable", "phase_1b_not_ready", configuration);
  }
  if (!configuration.consentApproved) {
    return startupResult("unavailable", "consent_update_required", configuration);
  }
  if (!options.safetyService || typeof options.safetyService.assess !== "function") {
    return startupResult("unavailable", "safety_service_unavailable", configuration);
  }
  if (!options.reviewRouting || typeof options.reviewRouting.route !== "function") {
    return startupResult("unavailable", "protected_review_route_unavailable", configuration);
  }
  return startupResult("ready", null, configuration, options.safetyService, options.reviewRouting);
}

module.exports = { createPhase1dStartup };
