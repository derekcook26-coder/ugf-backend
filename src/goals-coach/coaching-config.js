const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;

function enabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadCoachingConfiguration(environment = process.env) {
  const configuration = {
    aiEnabled: enabled(environment.GOALS_COACH_AI_ENABLED),
    providerIdentifier: String(environment.GOALS_COACH_AI_PROVIDER || "").trim(),
    modelIdentifier: String(environment.GOALS_COACH_OPENAI_MODEL || "").trim(),
    promptVersion: String(environment.GOALS_COACH_PROMPT_VERSION || "").trim(),
    structuredOutputVersion: String(
      environment.GOALS_COACH_STRUCTURED_OUTPUT_VERSION || ""
    ).trim(),
    safetyRuleVersion: String(
      environment.GOALS_COACH_SAFETY_RULE_VERSION || "phase-1b-placeholder"
    ).trim(),
    providerTimeoutMs: positiveInteger(
      environment.GOALS_COACH_PROVIDER_TIMEOUT_MS,
      DEFAULT_PROVIDER_TIMEOUT_MS
    ),
  };

  configuration.generationReady = Boolean(
    configuration.aiEnabled
      && configuration.providerIdentifier
      && configuration.modelIdentifier
      && configuration.promptVersion
      && configuration.structuredOutputVersion
      && configuration.safetyRuleVersion
  );

  return Object.freeze(configuration);
}

module.exports = { DEFAULT_PROVIDER_TIMEOUT_MS, loadCoachingConfiguration };
