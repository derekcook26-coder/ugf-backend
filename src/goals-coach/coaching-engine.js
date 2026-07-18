const { validateStructuredCoachingOutput } = require("./coaching-output");

const PHASE_1B_PROMPT_CONTRACT = Object.freeze({
  purpose: "Return one safe, plan-aware Goals Coach action as versioned structured JSON.",
  precedence: [
    "safety_restrictions",
    "human_approved_instructions",
    "latest_approved_plan",
    "current_member_statement",
    "recent_checkin_context",
    "older_profile_context",
    "general_coaching_knowledge",
  ],
  responseRules: [
    "answer_first",
    "one_immediate_action",
    "plain_language",
    "brief_during_active_workout",
    "admit_missing_information",
    "never_claim_to_see_form",
    "never_diagnose_or_claim_medical_clearance",
  ],
});

class CoachingProviderError extends Error {
  constructor(message, failureCategory = "provider_error") {
    super(message);
    this.name = "CoachingProviderError";
    this.failureCategory = failureCategory;
  }
}

function createCoachingEngine(options) {
  const provider = options && options.provider;
  const configuration = options && options.configuration;

  if (!provider || typeof provider.generate !== "function") {
    throw new Error("A Phase 1B coaching provider adapter is required");
  }
  if (!configuration || !configuration.generationReady) {
    throw new Error("Phase 1B coaching configuration is not generation-ready");
  }

  async function generateTurn(input) {
    const controller = new AbortController();
    let timeout;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new CoachingProviderError("Coaching provider timed out", "provider_timeout"));
      }, configuration.providerTimeoutMs);
    });

    let providerResult;
    try {
      providerResult = await Promise.race([
        provider.generate({
          model: configuration.modelIdentifier,
          promptVersion: configuration.promptVersion,
          schemaVersion: configuration.structuredOutputVersion,
          promptContract: PHASE_1B_PROMPT_CONTRACT,
          context: input.context,
          memberMessage: input.memberMessage,
          requestId: input.requestId,
          signal: controller.signal,
        }),
        timedOut,
      ]);
    } catch (error) {
      if (error && error.failureCategory) throw error;
      throw new CoachingProviderError("Coaching provider failed", "provider_error");
    } finally {
      clearTimeout(timeout);
    }

    if (!providerResult || typeof providerResult !== "object" || !("output" in providerResult)) {
      throw new CoachingProviderError(
        "Coaching provider returned a malformed result",
        "malformed_provider_response"
      );
    }

    const output = validateStructuredCoachingOutput(providerResult.output, configuration);
    return {
      output,
      providerReference: typeof providerResult.providerReference === "string"
        ? providerResult.providerReference.slice(0, 200)
        : null,
    };
  }

  return Object.freeze({ configuration, generateTurn });
}

module.exports = {
  CoachingProviderError,
  PHASE_1B_PROMPT_CONTRACT,
  createCoachingEngine,
};
