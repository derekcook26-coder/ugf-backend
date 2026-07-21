"use strict";

// This layer is deliberately deterministic and provider-free.  It is evaluated
// before ordinary coaching and can only preserve or increase protection.
const SAFETY_RULE_VERSION = "GC-SAFETY-1D-1";

const URGENT_RESPONSE =
  "Stop exercising now. This may require immediate medical attention. Call emergency services or ask someone nearby to help you. Goals Coach is not emergency care.";

const CHEST_PAIN_URGENT_RESPONSE =
  "Stop exercising now. Chest pain during activity can require immediate medical attention. Call emergency services or ask someone nearby to help you. Goals Coach is not emergency care.";

const REVIEW_RESPONSE =
  "Stop that movement for today. I do not want to guess about this. I saved your question for human review, and ongoing or severe symptoms should be evaluated by a qualified healthcare professional.";

const HUMAN_REQUEST_RESPONSE =
  "Yes. I saved your question for human review. You can stop that movement for now.";

function normalizedText(value) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

function has(text, expression) {
  return expression.test(text);
}

function isQuotedOrHypothetical(text) {
  return has(text, /\b(movie|show|song|book|quote|quoted|example|hypothetical|what if|if someone|someone says|another person|my friend|they said)\b/);
}

function isHistoricalOrResolved(text) {
  return has(text, /\b(last (week|month|year)|years? ago|used to|previously|in the past|was diagnosed|is gone now|went away|not now)\b/);
}

function explicitlyNegated(text) {
  return has(text, /\b(no|not|never|without|don't|do not)\s+(having |feel(?:ing)? )?(chest pain|trouble breathing|shortness of breath|faint(?:ed|ing)?|numbness|weakness)\b/);
}

function currentSelfReport(text) {
  return has(text, /\b(i(?:'m| am| have| feel| felt| want| can't| cannot| passed out| fainted)|my|me)\b/);
}

function currentDirectMatch(text, expression, options = {}) {
  // A past or quoted clause must never erase a separate current disclosure in
  // the same message. Evaluate short natural-language clauses independently.
  const clauses = text.split(/[.!?;,]|\b(?:and|but)\b/).map((clause) => clause.trim());
  return clauses.some((clause) => {
    if (!clause || isQuotedOrHypothetical(clause) || isHistoricalOrResolved(clause)) return false;
    if (options.requireSelf !== false && !currentSelfReport(clause)) return false;
    if (options.allowNegation !== true && explicitlyNegated(clause)) return false;
    return has(clause, expression);
  });
}

function urgent(reasonCode, category) {
  return Object.freeze({
    decision: "urgent",
    priority: "urgent",
    category,
    stopNormalCoaching: true,
    reviewRequired: true,
    ruleVersion: SAFETY_RULE_VERSION,
    reasonCode,
    memberResponse: reasonCode === "acute_medical_language"
      ? CHEST_PAIN_URGENT_RESPONSE
      : URGENT_RESPONSE,
  });
}

function review(reasonCode, category, priority, memberResponse = REVIEW_RESPONSE) {
  return Object.freeze({
    decision: "review",
    priority,
    category,
    stopNormalCoaching: false,
    reviewRequired: true,
    ruleVersion: SAFETY_RULE_VERSION,
    reasonCode,
    memberResponse,
  });
}

const CONTINUE = Object.freeze({
  decision: "continue",
  priority: null,
  category: null,
  stopNormalCoaching: false,
  reviewRequired: false,
  ruleVersion: SAFETY_RULE_VERSION,
  reasonCode: null,
  memberResponse: null,
});

function evaluateSafetyMessage(content) {
  const text = normalizedText(content);
  if (!text) return CONTINUE;

  if (currentDirectMatch(text, /\b(kill myself|suicide|suicidal|overdose|hurt myself|end my life)\b/)) {
    return urgent("self_harm_language", "safety");
  }
  if (currentDirectMatch(text, /\b(chest (pain|hurts?|is hurting)|pressure in (my )?chest|can't breathe|cannot breathe|severe (shortness of breath|trouble breathing)|trouble breathing|passed out|fainted|face (is )?drooping|sudden (one[- ]sided )?weakness)\b/)) {
    return urgent("acute_medical_language", "safety");
  }
  if (currentDirectMatch(text, /\b(i('| a)m going to|i will) (kill|hurt|shoot|stab|attack) (him|her|them|someone|you)\b/)) {
    return urgent("immediate_threat_language", "safety");
  }
  if (currentDirectMatch(text, /\b(severe|sudden|rapidly worsening)\b.*\b(pain|injury|bleeding|head injury)\b|\b(uncontrolled bleeding|severe head injury)\b/)) {
    return urgent("severe_injury_language", "safety");
  }

  if (has(text, /\b(i want my coach|send this to a person|human (coach|review|help)|can derek review|i don't trust this answer)\b/)) {
    return review("member_requested_human", "member_request", "routine", HUMAN_REQUEST_RESPONSE);
  }
  if (currentDirectMatch(text, /\b(persistent|worsening|recurring)\b.*\b(pain|dizz(?:y|iness)|shortness of breath)\b|\b(possible injury|doesn't feel right|does not feel right|unexplained dizziness)\b/, { requireSelf: false })) {
    return review("concerning_nonurgent_symptom", "pain_or_injury", "priority");
  }

  return CONTINUE;
}

module.exports = {
  CONTINUE,
  CHEST_PAIN_URGENT_RESPONSE,
  HUMAN_REQUEST_RESPONSE,
  REVIEW_RESPONSE,
  SAFETY_RULE_VERSION,
  URGENT_RESPONSE,
  evaluateSafetyMessage,
  currentDirectMatch,
};
