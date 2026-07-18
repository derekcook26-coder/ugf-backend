const { loadCoachingConfiguration } = require("./coaching-config");
const { createCoachingEngine } = require("./coaching-engine");

function result(status, configuration, engine = null) {
  return Object.freeze({ status, configuration, engine });
}

function createPhase1bStartup(options = {}) {
  const configuration = options.configuration
    || loadCoachingConfiguration(options.environment || process.env);

  if (!configuration.aiEnabled) {
    return result("disabled", configuration);
  }
  if (!configuration.generationReady) {
    return result("invalid_configuration", configuration);
  }

  let provider = options.provider || null;
  if (!provider && typeof options.createProvider === "function") {
    try {
      provider = options.createProvider(configuration);
    } catch (_) {
      return result("provider_initialization_failed", configuration);
    }
  }
  if (!provider || typeof provider.generate !== "function") {
    return result("provider_unavailable", configuration);
  }

  try {
    return result(
      "ready",
      configuration,
      createCoachingEngine({ configuration, provider })
    );
  } catch (_) {
    return result("provider_initialization_failed", configuration);
  }
}

module.exports = { createPhase1bStartup };
