const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CoachingProviderError,
  PHASE_1B_PROMPT_CONTRACT,
  createCoachingEngine,
} = require("../src/goals-coach/coaching-engine");
const {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  loadCoachingConfiguration,
} = require("../src/goals-coach/coaching-config");

function readyConfiguration(overrides = {}) {
  return Object.freeze({
    aiEnabled: true,
    generationReady: true,
    providerIdentifier: "synthetic-mock-provider",
    modelIdentifier: "synthetic-model-v1",
    promptVersion: "GC-PROMPT-1B-1.0",
    structuredOutputVersion: "GC-OUTPUT-1B-1.0",
    safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B",
    providerTimeoutMs: 250,
    ...overrides,
  });
}

function validOutput(overrides = {}) {
  const base = {
    reply: "Start with five minutes of comfortable walking. Tell me when you are moving.",
    mode: "start_today",
    nextAction: { type: "warmup", label: "Comfortable walking", target: "5 minutes" },
    conversationState: { workoutActive: true, awaitingMemberCompletion: true },
    stateTransition: { type: "start_session", expectedVersion: null, changes: {} },
    review: { required: false, priority: null, category: null, reason: null },
    safety: { stopNormalCoaching: false, severity: "none" },
    uncertainty: { missingContext: false, reason: null },
    promptVersion: "GC-PROMPT-1B-1.0",
    schemaVersion: "GC-OUTPUT-1B-1.0",
  };
  return { ...base, ...overrides };
}

test("configuration defaults fail closed without a provider or model fallback", () => {
  const configuration = loadCoachingConfiguration({});
  assert.equal(configuration.aiEnabled, false);
  assert.equal(configuration.generationReady, false);
  assert.equal(configuration.providerIdentifier, "");
  assert.equal(configuration.modelIdentifier, "");
  assert.equal(configuration.promptVersion, "");
  assert.equal(configuration.structuredOutputVersion, "");
  assert.equal(configuration.safetyRuleVersion, "phase-1b-placeholder");
  assert.equal(configuration.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS);
  assert.equal(Object.isFrozen(configuration), true);
});

test("configuration becomes ready only with explicit enablement and versioned identifiers", () => {
  const incomplete = loadCoachingConfiguration({
    GOALS_COACH_AI_ENABLED: "true",
    GOALS_COACH_AI_PROVIDER: "synthetic-provider",
    GOALS_COACH_OPENAI_MODEL: "synthetic-model",
  });
  assert.equal(incomplete.generationReady, false);

  const ready = loadCoachingConfiguration({
    GOALS_COACH_AI_ENABLED: " TRUE ",
    GOALS_COACH_AI_PROVIDER: " synthetic-provider ",
    GOALS_COACH_OPENAI_MODEL: " synthetic-model ",
    GOALS_COACH_PROMPT_VERSION: " GC-PROMPT-1B-1.0 ",
    GOALS_COACH_STRUCTURED_OUTPUT_VERSION: " GC-OUTPUT-1B-1.0 ",
    GOALS_COACH_SAFETY_RULE_VERSION: " GC-SAFETY-PLACEHOLDER-1B ",
    GOALS_COACH_PROVIDER_TIMEOUT_MS: "321",
  });
  assert.equal(ready.generationReady, true);
  assert.equal(ready.providerIdentifier, "synthetic-provider");
  assert.equal(ready.modelIdentifier, "synthetic-model");
  assert.equal(ready.providerTimeoutMs, 321);
});

test("coaching engine forwards the configured contract and validates provider output", async () => {
  const configuration = readyConfiguration();
  let captured;
  const engine = createCoachingEngine({
    configuration,
    provider: {
      async generate(input) {
        captured = input;
        return {
          output: validOutput(),
          providerReference: "synthetic-provider-result",
        };
      },
    },
  });

  const generated = await engine.generateTurn({
    context: { synthetic: true },
    memberMessage: "Where do I start today?",
    requestId: "synthetic-request",
  });

  assert.equal(captured.model, configuration.modelIdentifier);
  assert.equal(captured.promptVersion, configuration.promptVersion);
  assert.equal(captured.schemaVersion, configuration.structuredOutputVersion);
  assert.equal(captured.promptContract, PHASE_1B_PROMPT_CONTRACT);
  assert.deepEqual(captured.context, { synthetic: true });
  assert.equal(captured.memberMessage, "Where do I start today?");
  assert.equal(captured.requestId, "synthetic-request");
  assert.equal(captured.signal instanceof AbortSignal, true);
  assert.equal(generated.output.mode, "start_today");
  assert.equal(generated.providerReference, "synthetic-provider-result");
});

test("malformed provider results and invalid structured output fail closed", async () => {
  const configuration = readyConfiguration();
  const malformed = createCoachingEngine({
    configuration,
    provider: { async generate() { return { unexpected: true }; } },
  });
  await assert.rejects(
    malformed.generateTurn({ context: {}, memberMessage: "Synthetic", requestId: "malformed" }),
    (error) => error instanceof CoachingProviderError
      && error.failureCategory === "malformed_provider_response"
  );

  const invalid = createCoachingEngine({
    configuration,
    provider: {
      async generate() {
        return { output: validOutput({ schemaVersion: "unsupported-schema" }) };
      },
    },
  });
  await assert.rejects(
    invalid.generateTurn({ context: {}, memberMessage: "Synthetic", requestId: "invalid" }),
    (error) => error.failureCategory === "invalid_structured_output"
  );
});

test("provider errors and provider timeouts receive minimized failure categories", async () => {
  const providerFailure = createCoachingEngine({
    configuration: readyConfiguration(),
    provider: { async generate() { throw new Error("synthetic provider detail"); } },
  });
  await assert.rejects(
    providerFailure.generateTurn({ context: {}, memberMessage: "Synthetic", requestId: "error" }),
    (error) => error instanceof CoachingProviderError
      && error.message === "Coaching provider failed"
      && error.failureCategory === "provider_error"
  );

  let observedSignal;
  const timedOut = createCoachingEngine({
    configuration: readyConfiguration({ providerTimeoutMs: 15 }),
    provider: {
      async generate(input) {
        observedSignal = input.signal;
        return new Promise(() => {});
      },
    },
  });
  await assert.rejects(
    timedOut.generateTurn({ context: {}, memberMessage: "Synthetic", requestId: "timeout" }),
    (error) => error instanceof CoachingProviderError
      && error.failureCategory === "provider_timeout"
  );
  assert.equal(observedSignal.aborted, true);
});
