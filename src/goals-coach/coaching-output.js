const COACHING_MODES = Object.freeze([
  "start_today",
  "exercise_help",
  "substitution",
  "workout_step",
  "recovery_modification",
  "motivation_restart",
  "human_review",
  "safety_stop",
]);

const TRANSITION_TYPES = Object.freeze([
  "no_change",
  "request_information",
  "start_session",
  "advance",
  "modify",
  "complete",
]);

const TRANSITIONS_BY_MODE = Object.freeze({
  start_today: ["no_change", "request_information", "start_session"],
  exercise_help: ["no_change", "request_information"],
  substitution: ["no_change", "request_information", "modify"],
  workout_step: ["no_change", "request_information", "advance", "modify", "complete"],
  recovery_modification: ["no_change", "request_information", "modify", "complete"],
  motivation_restart: ["no_change", "request_information", "start_session", "modify"],
  human_review: ["no_change", "request_information"],
  safety_stop: ["no_change", "request_information"],
});

class CoachingOutputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoachingOutputValidationError";
    this.failureCategory = "invalid_structured_output";
  }
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoachingOutputValidationError(`${name} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new CoachingOutputValidationError(`${name} contains unsupported fields`);
  }
}

function text(value, name, maximum, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new CoachingOutputValidationError(`${name} must be non-empty text no longer than ${maximum}`);
  }
  return value.trim();
}

function optionalText(value, name, maximum) {
  return value === null || value === undefined ? null : text(value, name, maximum);
}

function boolean(value, name) {
  if (typeof value !== "boolean") {
    throw new CoachingOutputValidationError(`${name} must be boolean`);
  }
  return value;
}

function enumValue(value, name, allowed, nullable = false) {
  if (nullable && value === null) return null;
  if (!allowed.includes(value)) {
    throw new CoachingOutputValidationError(`${name} is unsupported`);
  }
  return value;
}

function validateChanges(value) {
  const changes = object(value || {}, "stateTransition.changes");
  exactKeys(changes, [
    "targetSets",
    "targetRepetitions",
    "targetDurationSeconds",
    "selectedModification",
    "reportedEffort",
    "reportedDiscomfort",
  ], "stateTransition.changes");

  if (changes.targetSets !== undefined
    && (!Number.isInteger(changes.targetSets) || changes.targetSets < 1 || changes.targetSets > 20)) {
    throw new CoachingOutputValidationError("targetSets is invalid");
  }
  if (changes.targetRepetitions !== undefined) {
    changes.targetRepetitions = text(changes.targetRepetitions, "targetRepetitions", 80);
  }
  if (changes.targetDurationSeconds !== undefined
    && (!Number.isInteger(changes.targetDurationSeconds)
      || changes.targetDurationSeconds < 1
      || changes.targetDurationSeconds > 14400)) {
    throw new CoachingOutputValidationError("targetDurationSeconds is invalid");
  }
  if (changes.selectedModification !== undefined) {
    changes.selectedModification = object(changes.selectedModification, "selectedModification");
    exactKeys(
      changes.selectedModification,
      ["type", "label", "target", "replacesExerciseKey"],
      "selectedModification"
    );
    enumValue(changes.selectedModification.type, "selectedModification.type", [
      "fewer_repetitions",
      "fewer_sets",
      "lighter_resistance",
      "longer_rest",
      "simpler_variation",
      "shorter_session",
      "similar_substitution",
    ]);
    changes.selectedModification.label = text(
      changes.selectedModification.label,
      "selectedModification.label",
      300
    );
    if (changes.selectedModification.target !== undefined) {
      changes.selectedModification.target = text(
        changes.selectedModification.target,
        "selectedModification.target",
        200
      );
    }
    if (changes.selectedModification.replacesExerciseKey !== undefined) {
      changes.selectedModification.replacesExerciseKey = text(
        changes.selectedModification.replacesExerciseKey,
        "selectedModification.replacesExerciseKey",
        200
      );
    }
    if (JSON.stringify(changes.selectedModification).length > 2000) {
      throw new CoachingOutputValidationError("selectedModification is too large");
    }
  }
  if (changes.reportedEffort !== undefined) {
    changes.reportedEffort = text(changes.reportedEffort, "reportedEffort", 100);
  }
  if (changes.reportedDiscomfort !== undefined) {
    changes.reportedDiscomfort = object(changes.reportedDiscomfort, "reportedDiscomfort");
    if (JSON.stringify(changes.reportedDiscomfort).length > 2000) {
      throw new CoachingOutputValidationError("reportedDiscomfort is too large");
    }
  }
  return changes;
}

function validateStructuredCoachingOutput(raw, configuration) {
  const output = object(raw, "structured output");
  exactKeys(output, [
    "reply",
    "mode",
    "nextAction",
    "conversationState",
    "stateTransition",
    "review",
    "safety",
    "uncertainty",
    "promptVersion",
    "schemaVersion",
  ], "structured output");

  const nextAction = output.nextAction === null ? null : object(output.nextAction, "nextAction");
  if (nextAction) exactKeys(nextAction, ["type", "label", "target"], "nextAction");
  const conversationState = object(output.conversationState, "conversationState");
  exactKeys(conversationState, ["workoutActive", "awaitingMemberCompletion"], "conversationState");
  const transition = object(output.stateTransition, "stateTransition");
  exactKeys(transition, ["type", "expectedVersion", "changes"], "stateTransition");
  const review = object(output.review, "review");
  exactKeys(review, ["required", "priority", "category", "reason"], "review");
  const safety = object(output.safety, "safety");
  exactKeys(safety, ["stopNormalCoaching", "severity"], "safety");
  const uncertainty = object(output.uncertainty, "uncertainty");
  exactKeys(uncertainty, ["missingContext", "reason"], "uncertainty");

  const mode = enumValue(output.mode, "mode", COACHING_MODES);
  const transitionType = enumValue(transition.type, "stateTransition.type", TRANSITION_TYPES);
  if (!TRANSITIONS_BY_MODE[mode].includes(transitionType)) {
    throw new CoachingOutputValidationError("coaching mode cannot propose that state transition");
  }

  const expectedVersion = transition.expectedVersion;
  if (expectedVersion !== null
    && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw new CoachingOutputValidationError("stateTransition.expectedVersion is invalid");
  }
  const versionedTransition = ["advance", "modify", "complete"].includes(transitionType);
  const stateMutatingTransition = ["start_session", "advance", "modify", "complete"].includes(transitionType);
  if (versionedTransition && expectedVersion === null) {
    throw new CoachingOutputValidationError("state-changing transitions require an expected version");
  }
  if (!versionedTransition && expectedVersion !== null) {
    throw new CoachingOutputValidationError("non-versioned transitions cannot declare an expected version");
  }
  const changes = validateChanges(transition.changes);
  if (transitionType === "modify" && Object.keys(changes).length === 0) {
    throw new CoachingOutputValidationError("modify transitions require an approved change");
  }
  if (transitionType !== "modify" && Object.keys(changes).length > 0) {
    throw new CoachingOutputValidationError("only modify transitions may include state changes");
  }

  const reviewRequired = boolean(review.required, "review.required");
  const reviewPriority = enumValue(
    review.priority,
    "review.priority",
    ["routine", "priority", "urgent"],
    true
  );
  const reviewCategory = optionalText(review.category, "review.category", 100);
  const reviewReason = optionalText(review.reason, "review.reason", 500);
  if (reviewRequired && (!reviewPriority || !reviewCategory || !reviewReason)) {
    throw new CoachingOutputValidationError("required review metadata is incomplete");
  }
  if (!reviewRequired && (reviewPriority || reviewCategory || reviewReason)) {
    throw new CoachingOutputValidationError("review metadata must be null when review is not required");
  }
  if (reviewRequired && stateMutatingTransition) {
    throw new CoachingOutputValidationError("review-required output cannot mutate workout state");
  }

  const safetySeverity = enumValue(
    safety.severity,
    "safety.severity",
    ["none", "modify", "prompt_review", "urgent"]
  );
  const stopNormalCoaching = boolean(safety.stopNormalCoaching, "safety.stopNormalCoaching");
  const nonMutatingTransition = ["no_change", "request_information"].includes(transitionType);
  if (mode === "safety_stop"
    && (!stopNormalCoaching
      || safetySeverity !== "urgent"
      || !reviewRequired
      || !nonMutatingTransition)) {
    throw new CoachingOutputValidationError(
      "safety_stop mode requires urgent safety, required review, and a non-mutating transition"
    );
  }
  if (stopNormalCoaching && (mode !== "safety_stop" || safetySeverity !== "urgent")) {
    throw new CoachingOutputValidationError(
      "stopped coaching requires urgent safety_stop mode"
    );
  }
  if (safetySeverity === "urgent"
    && (mode !== "safety_stop" || !stopNormalCoaching || !reviewRequired)) {
    throw new CoachingOutputValidationError(
      "urgent safety requires stopped safety_stop mode and required review"
    );
  }
  if (mode === "human_review"
    && (!reviewRequired || !nonMutatingTransition || stopNormalCoaching)) {
    throw new CoachingOutputValidationError(
      "human_review mode requires review, a non-mutating transition, and active normal safety handling"
    );
  }
  if (["prompt_review", "urgent"].includes(safetySeverity) && !reviewRequired) {
    throw new CoachingOutputValidationError("review-level safety output requires a review recommendation");
  }
  if (["human_review", "safety_stop"].includes(mode) && !nonMutatingTransition) {
    throw new CoachingOutputValidationError("review and safety-stop modes cannot mutate workout state");
  }

  const missingContext = boolean(uncertainty.missingContext, "uncertainty.missingContext");
  const uncertaintyReason = optionalText(uncertainty.reason, "uncertainty.reason", 500);
  if (missingContext !== Boolean(uncertaintyReason)) {
    throw new CoachingOutputValidationError("uncertainty reason must match missing-context status");
  }

  if (output.promptVersion !== configuration.promptVersion) {
    throw new CoachingOutputValidationError("prompt version does not match configuration");
  }
  if (output.schemaVersion !== configuration.structuredOutputVersion) {
    throw new CoachingOutputValidationError("structured-output version is unsupported");
  }

  const workoutActive = boolean(conversationState.workoutActive, "conversationState.workoutActive");
  const awaitingMemberCompletion = boolean(
    conversationState.awaitingMemberCompletion,
    "conversationState.awaitingMemberCompletion"
  );
  if (["start_session", "advance", "modify"].includes(transitionType) && !workoutActive) {
    throw new CoachingOutputValidationError("active workout transitions require active conversation state");
  }
  if ((transitionType === "complete" || mode === "safety_stop") && workoutActive) {
    throw new CoachingOutputValidationError("completed or stopped coaching cannot report an active workout");
  }
  if ((transitionType === "complete" || mode === "safety_stop") && awaitingMemberCompletion) {
    throw new CoachingOutputValidationError("completed or stopped coaching cannot await workout completion");
  }

  return {
    reply: text(output.reply, "reply", 2000),
    mode,
    nextAction: nextAction ? {
      type: text(nextAction.type, "nextAction.type", 100),
      label: text(nextAction.label, "nextAction.label", 300),
      target: optionalText(nextAction.target, "nextAction.target", 200),
    } : null,
    conversationState: { workoutActive, awaitingMemberCompletion },
    stateTransition: { type: transitionType, expectedVersion, changes },
    review: {
      required: reviewRequired,
      priority: reviewPriority,
      category: reviewCategory,
      reason: reviewReason,
    },
    safety: { stopNormalCoaching, severity: safetySeverity },
    uncertainty: { missingContext, reason: uncertaintyReason },
    promptVersion: configuration.promptVersion,
    schemaVersion: configuration.structuredOutputVersion,
  };
}

module.exports = {
  COACHING_MODES,
  CoachingOutputValidationError,
  TRANSITION_TYPES,
  validateStructuredCoachingOutput,
};
