"use strict";

const { currentDirectMatch, evaluateSafetyMessage, SAFETY_RULE_VERSION } = require("./safety-rules");
const {
  MEMBER_CONVERSATION_SAFETY_RULE_VERSION,
  MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION,
} = require("./member-conversation-turn-contract");

// This rule set is intentionally versioned separately from GC-SAFETY-1D-1.
// It adds the member-turn contract's conservative current pain, instability,
// neurological-symptom, restriction, and ambiguous-discomfort stop boundary
// without changing the shared safety behavior used by existing consumers.
const MEMBER_TURN_CONCERN = /\b(pain|hurts?|sharp|sore(?:ness)?|discomfort|aches?|aching|dizz(?:y|iness)|breathless|shortness\s+of\s+breath|swell(?:ing)?|swollen|unstable|instability|numb(?:ness)?|tingl(?:e|ing)|pins|needles|weak(?:ness)?|restricted|restriction)\b/;

function unavailableSafety() {
  return Object.freeze({
    ruleVersion: MEMBER_CONVERSATION_SAFETY_RULE_VERSION,
    sourceRuleVersion: MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION,
    classification: "unavailable",
    action: "unavailable",
  });
}

function classifyMemberConversationTurnSafety(request) {
  let result;
  try { result = evaluateSafetyMessage(request.memberText); }
  catch { return unavailableSafety(); }
  if (!result || result.ruleVersion !== SAFETY_RULE_VERSION) return unavailableSafety();
  if (result.decision === "continue" && result.reviewRequired === false && result.stopNormalCoaching === false
    && currentDirectMatch(request.memberText.toLowerCase(), MEMBER_TURN_CONCERN)) {
    return Object.freeze({
      ruleVersion: MEMBER_CONVERSATION_SAFETY_RULE_VERSION,
      sourceRuleVersion: MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION,
      classification: "pain_or_instability",
      action: "stop",
    });
  }
  if (result.decision === "continue" && result.reviewRequired === false && result.stopNormalCoaching === false) {
    return Object.freeze({
      ruleVersion: MEMBER_CONVERSATION_SAFETY_RULE_VERSION,
      sourceRuleVersion: MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION,
      classification: "clear",
      action: "allow_provider_processing",
    });
  }
  if (["review", "urgent"].includes(result.decision) && result.reviewRequired === true) {
    return Object.freeze({
      ruleVersion: MEMBER_CONVERSATION_SAFETY_RULE_VERSION,
      sourceRuleVersion: MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION,
      classification: result.category === "pain_or_injury" ? "pain_or_instability" : "concerning_symptoms",
      action: "stop",
    });
  }
  return unavailableSafety();
}

function createMemberConversationTurnSafetyClassifier() {
  return Object.freeze({
    contractVersion: MEMBER_CONVERSATION_SAFETY_RULE_VERSION,
    sourceRuleVersion: MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION,
    baseRuleVersion: SAFETY_RULE_VERSION,
    deterministic: true,
    providerFree: true,
    async classify({ request }) { return classifyMemberConversationTurnSafety(request); },
  });
}

function validMemberConversationTurnSafetyClassifier(value) {
  return Boolean(value
    && value.contractVersion === MEMBER_CONVERSATION_SAFETY_RULE_VERSION
    && value.sourceRuleVersion === MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION
    && value.baseRuleVersion === SAFETY_RULE_VERSION
    && value.deterministic === true
    && value.providerFree === true
    && typeof value.classify === "function");
}

module.exports = {
  classifyMemberConversationTurnSafety,
  createMemberConversationTurnSafetyClassifier,
  unavailableSafety,
  validMemberConversationTurnSafetyClassifier,
};
