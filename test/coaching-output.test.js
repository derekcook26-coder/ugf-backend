const assert = require("node:assert/strict");
const test = require("node:test");
const {
  COACHING_MODES,
  CoachingOutputValidationError,
  validateStructuredCoachingOutput,
} = require("../src/goals-coach/coaching-output");

const configuration = Object.freeze({
  promptVersion: "GC-PROMPT-1B-1.0",
  structuredOutputVersion: "GC-OUTPUT-1B-1.0",
});

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
    promptVersion: configuration.promptVersion,
    schemaVersion: configuration.structuredOutputVersion,
  };
  return {
    ...base,
    ...overrides,
    nextAction: overrides.nextAction === null
      ? null
      : { ...base.nextAction, ...(overrides.nextAction || {}) },
    conversationState: { ...base.conversationState, ...(overrides.conversationState || {}) },
    stateTransition: {
      ...base.stateTransition,
      ...(overrides.stateTransition || {}),
      changes: {
        ...base.stateTransition.changes,
        ...((overrides.stateTransition && overrides.stateTransition.changes) || {}),
      },
    },
    review: { ...base.review, ...(overrides.review || {}) },
    safety: { ...base.safety, ...(overrides.safety || {}) },
    uncertainty: { ...base.uncertainty, ...(overrides.uncertainty || {}) },
  };
}

function rejectsEvery(values) {
  for (const value of values) {
    assert.throws(
      () => validateStructuredCoachingOutput(value, configuration),
      CoachingOutputValidationError
    );
  }
}

test("all approved Phase 1B modes validate with versioned structured output", () => {
  for (const mode of COACHING_MODES) {
    const urgent = mode === "safety_stop";
    const reviewRequired = mode === "human_review" || urgent;
    const output = validOutput({
      mode,
      stateTransition: { type: "no_change", expectedVersion: null },
      conversationState: urgent
        ? { workoutActive: false, awaitingMemberCompletion: false }
        : undefined,
      review: reviewRequired ? {
        required: true,
        priority: urgent ? "urgent" : "routine",
        category: urgent ? "safety" : "member_request",
        reason: "Synthetic review recommendation",
      } : undefined,
      safety: urgent ? { stopNormalCoaching: true, severity: "urgent" } : undefined,
    });
    const validated = validateStructuredCoachingOutput(output, configuration);
    assert.equal(validated.mode, mode);
    assert.equal(validated.schemaVersion, configuration.structuredOutputVersion);
  }
});

test("approved no-change, start, advance, modify, and complete transitions validate", () => {
  const cases = [
    validOutput({ mode: "exercise_help", stateTransition: { type: "no_change" } }),
    validOutput(),
    validOutput({ mode: "workout_step", stateTransition: { type: "advance", expectedVersion: 2 } }),
    validOutput({
      mode: "recovery_modification",
      stateTransition: {
        type: "modify",
        expectedVersion: 2,
        changes: {
          targetSets: 1,
          selectedModification: {
            type: "shorter_session",
            label: "One-set synthetic session",
            target: "1 set",
          },
        },
      },
    }),
    validOutput({
      mode: "workout_step",
      conversationState: { workoutActive: false, awaitingMemberCompletion: false },
      stateTransition: { type: "complete", expectedVersion: 3 },
    }),
  ];
  for (const value of cases) {
    assert.doesNotThrow(() => validateStructuredCoachingOutput(value, configuration));
  }
});

test("missing, unexpected, oversized, and version-mismatched output fails closed", () => {
  const missingReply = validOutput();
  delete missingReply.reply;
  rejectsEvery([
    missingReply,
    { ...validOutput(), unsupported: true },
    validOutput({ reply: "x".repeat(2001) }),
    validOutput({ mode: "unsupported_mode" }),
    validOutput({ promptVersion: "wrong-prompt" }),
    validOutput({ schemaVersion: "unsupported-schema" }),
  ]);
});

test("invalid, ambiguous, or ignored state proposals fail closed", () => {
  rejectsEvery([
    validOutput({ stateTransition: { type: "advance", expectedVersion: null } }),
    validOutput({ stateTransition: { type: "start_session", expectedVersion: 1 } }),
    validOutput({ mode: "start_today", stateTransition: { type: "advance", expectedVersion: 1 } }),
    validOutput({ stateTransition: { type: "start_session", changes: { targetSets: 1 } } }),
    validOutput({ stateTransition: { type: "modify", expectedVersion: 1, changes: {} } }),
    validOutput({ stateTransition: { type: "modify", expectedVersion: 1, changes: { targetSets: 0 } } }),
    validOutput({
      mode: "substitution",
      stateTransition: {
        type: "modify",
        expectedVersion: 1,
        changes: { selectedModification: { type: "unsupported", label: "Synthetic" } },
      },
    }),
  ]);
});

test("review-required and safety output cannot silently mutate workout state", () => {
  rejectsEvery([
    validOutput({ review: { required: true, priority: null, category: null, reason: null } }),
    validOutput({
      mode: "start_today",
      review: {
        required: true,
        priority: "routine",
        category: "plan_change",
        reason: "Synthetic review required",
      },
    }),
    validOutput({ safety: { stopNormalCoaching: false, severity: "prompt_review" } }),
    validOutput({ safety: { stopNormalCoaching: false, severity: "urgent" } }),
    validOutput({
      mode: "safety_stop",
      safety: { stopNormalCoaching: true, severity: "urgent" },
      conversationState: { workoutActive: false, awaitingMemberCompletion: false },
      stateTransition: { type: "advance", expectedVersion: 1 },
      review: {
        required: true,
        priority: "urgent",
        category: "safety",
        reason: "Synthetic urgent safety review",
      },
    }),
  ]);
});

test("safety_stop rejects incomplete, inverse, and non-urgent safety combinations", () => {
  const review = {
    required: true,
    priority: "urgent",
    category: "safety",
    reason: "Synthetic urgent safety review",
  };
  const stoppedConversation = { workoutActive: false, awaitingMemberCompletion: false };
  rejectsEvery([
    validOutput({
      mode: "safety_stop",
      conversationState: stoppedConversation,
      stateTransition: { type: "no_change" },
      review,
      safety: { stopNormalCoaching: false, severity: "urgent" },
    }),
    validOutput({
      mode: "safety_stop",
      conversationState: stoppedConversation,
      stateTransition: { type: "no_change" },
      review,
      safety: { stopNormalCoaching: false, severity: "none" },
    }),
    validOutput({
      mode: "safety_stop",
      conversationState: stoppedConversation,
      stateTransition: { type: "no_change" },
      review,
      safety: { stopNormalCoaching: false, severity: "modify" },
    }),
    validOutput({
      mode: "safety_stop",
      conversationState: stoppedConversation,
      stateTransition: { type: "no_change" },
      safety: { stopNormalCoaching: true, severity: "urgent" },
    }),
    validOutput({
      mode: "exercise_help",
      stateTransition: { type: "no_change" },
      review,
      safety: { stopNormalCoaching: true, severity: "urgent" },
    }),
    validOutput({
      mode: "exercise_help",
      stateTransition: { type: "no_change" },
      review,
      safety: { stopNormalCoaching: false, severity: "urgent" },
    }),
  ]);
});

test("human_review requires complete review metadata and cannot stop normal coaching", () => {
  rejectsEvery([
    validOutput({
      mode: "human_review",
      stateTransition: { type: "no_change" },
    }),
    validOutput({
      mode: "human_review",
      stateTransition: { type: "no_change" },
      review: {
        required: true,
        priority: "routine",
        category: "member_request",
        reason: "Synthetic review recommendation",
      },
      safety: { stopNormalCoaching: true, severity: "urgent" },
    }),
    validOutput({
      mode: "human_review",
      stateTransition: { type: "advance", expectedVersion: 1 },
      review: {
        required: true,
        priority: "routine",
        category: "member_request",
        reason: "Synthetic review recommendation",
      },
    }),
  ]);
});

test("valid urgent safety, human review, and prompt-review safety remain supported", () => {
  const cases = [
    validOutput({
      mode: "safety_stop",
      conversationState: { workoutActive: false, awaitingMemberCompletion: false },
      stateTransition: { type: "no_change" },
      review: {
        required: true,
        priority: "urgent",
        category: "safety",
        reason: "Synthetic urgent safety review",
      },
      safety: { stopNormalCoaching: true, severity: "urgent" },
    }),
    validOutput({
      mode: "human_review",
      stateTransition: { type: "request_information" },
      review: {
        required: true,
        priority: "routine",
        category: "member_request",
        reason: "Synthetic human review recommendation",
      },
      safety: { stopNormalCoaching: false, severity: "none" },
    }),
    validOutput({
      mode: "exercise_help",
      stateTransition: { type: "no_change" },
      review: {
        required: true,
        priority: "priority",
        category: "pain_or_injury",
        reason: "Synthetic prompt-review recommendation",
      },
      safety: { stopNormalCoaching: false, severity: "prompt_review" },
    }),
  ];
  for (const value of cases) {
    assert.doesNotThrow(() => validateStructuredCoachingOutput(value, configuration));
  }
});

test("uncertainty and completed or stopped conversation state must be internally consistent", () => {
  rejectsEvery([
    validOutput({ uncertainty: { missingContext: true, reason: null } }),
    validOutput({ uncertainty: { missingContext: false, reason: "Unexpected reason" } }),
    validOutput({
      mode: "workout_step",
      conversationState: { workoutActive: true, awaitingMemberCompletion: false },
      stateTransition: { type: "complete", expectedVersion: 1 },
    }),
    validOutput({
      mode: "workout_step",
      conversationState: { workoutActive: false, awaitingMemberCompletion: true },
      stateTransition: { type: "complete", expectedVersion: 1 },
    }),
  ]);
});
