const { createCoachingCapability } = require("./phase1b-contracts");
const { loadPhase1cConfiguration } = require("./phase1c-config");

function phase1bIsReady(startup) {
  return createCoachingCapability(startup).status === "ready";
}

function startupResult(status, reason, configuration, adapter = null) {
  return Object.freeze({ status, reason, configuration, adapter });
}

function createPhase1cStartup(options = {}) {
  const configuration = options.configuration
    || loadPhase1cConfiguration(options.environment || process.env);

  if (!configuration.voiceInputEnabled) {
    return startupResult("disabled", "voice_disabled", configuration);
  }
  if (!phase1bIsReady(options.phase1bStartup)) {
    return startupResult("unavailable", "phase_1b_not_ready", configuration);
  }
  if (!configuration.transcriptionEnabled) {
    return startupResult("unavailable", "transcription_disabled", configuration);
  }
  if (!configuration.consentApproved) {
    return startupResult("unavailable", "consent_update_required", configuration);
  }
  if (
    !configuration.numericConfigurationValid
    || !configuration.bindingKeyConfigured
    || !(configuration.transcriptionDailyBudgetUsd > 0)
  ) {
    return startupResult("unavailable", "invalid_configuration", configuration);
  }

  const adapter = options.transcriptionAdapter || null;
  if (!adapter || typeof adapter.transcribe !== "function") {
    return startupResult(
      "unavailable",
      "transcription_provider_unavailable",
      configuration
    );
  }

  return startupResult("ready", null, configuration, adapter);
}

module.exports = { createPhase1cStartup, phase1bIsReady };
