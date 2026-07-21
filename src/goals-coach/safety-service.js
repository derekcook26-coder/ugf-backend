"use strict";

const {
  evaluateSafetyMessage,
  REVIEW_RESPONSE,
  SAFETY_RULE_VERSION,
  URGENT_RESPONSE,
} = require("./safety-rules");

const RANK = Object.freeze({ continue: 0, review: 1, urgent: 2 });
const PRIORITY_RANK = Object.freeze({ routine: 0, priority: 1, urgent: 2 });
const PERSISTABLE_CONCERN_CATEGORIES = new Set([
  "pain", "pressure", "muscle_fatigue", "instability", "fear",
  "technique_confusion", "equipment", "schedule", "recovery", "other",
  "member_request", "plan_change", "substitution_uncertainty",
  "technique_uncertainty", "pain_or_injury", "safety",
  "disputed_information", "ai_uncertainty", "technical_failure",
]);

function normalizedClassifierDecision(value) {
  if (!value || typeof value !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(RANK, value.decision)) return null;
  if (
    typeof value.category !== "string"
    || !PERSISTABLE_CONCERN_CATEGORIES.has(value.category)
  ) {
    return null;
  }
  return {
    decision: value.decision,
    priority: value.decision === "urgent" ? "urgent" : value.priority === "priority" ? "priority" : "routine",
    category: value.category,
    reasonCode: typeof value.reasonCode === "string" ? value.reasonCode.slice(0, 100) : "classifier_result",
    version: typeof value.version === "string" ? value.version.slice(0, 100) : null,
  };
}

function classifierFailureDecision() {
  return Object.freeze({
    decision: "review",
    priority: "priority",
    category: "technical_failure",
    stopNormalCoaching: true,
    reviewRequired: true,
    ruleVersion: SAFETY_RULE_VERSION,
    classifierVersion: null,
    reasonCode: "safety_classifier_unavailable",
    memberResponse:
      "I cannot safely continue coaching right now. Stop the current movement and have this reviewed before continuing.",
    classifierStatus: "failed",
  });
}

function merge(deterministic, classifier) {
  const classifierWins = RANK[classifier.decision] > RANK[deterministic.decision]
    || (
      RANK[classifier.decision] === RANK[deterministic.decision]
      && PRIORITY_RANK[classifier.priority] > PRIORITY_RANK[deterministic.priority]
    );
  const chosen = classifierWins ? classifier : deterministic;
  if (chosen === deterministic) {
    return Object.freeze({
      ...deterministic,
      classifierVersion: classifier.version || null,
      classifierStatus: classifier.classifierStatus || "completed",
    });
  }
  return Object.freeze({
    decision: classifier.decision,
    priority: classifier.priority,
    category: classifier.category,
    stopNormalCoaching: classifier.stopNormalCoaching === true || classifier.decision === "urgent",
    reviewRequired: classifier.decision !== "continue",
    ruleVersion: deterministic.ruleVersion,
    classifierVersion: classifier.version,
    reasonCode: classifier.reasonCode,
    memberResponse: classifier.memberResponse
      || (classifier.decision === "urgent" ? URGENT_RESPONSE : REVIEW_RESPONSE),
    classifierStatus: classifier.classifierStatus || "completed",
  });
}

function createSafetyService(options = {}) {
  const classify = options.classify || null;

  async function assess(content, context = {}) {
    const deterministic = evaluateSafetyMessage(content);
    if (typeof classify !== "function") {
      return Object.freeze({ ...deterministic, classifierVersion: null, classifierStatus: "not_configured" });
    }
    let classified;
    try {
      classified = normalizedClassifierDecision(await classify({ content, context }));
    } catch (_) {
      return merge(deterministic, classifierFailureDecision());
    }
    if (!classified) return merge(deterministic, classifierFailureDecision());
    return merge(deterministic, classified);
  }

  return Object.freeze({ assess });
}

module.exports = {
  SAFETY_RULE_VERSION,
  classifierFailureDecision,
  createSafetyService,
  merge,
  normalizedClassifierDecision,
};
