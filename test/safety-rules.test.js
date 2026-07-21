"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SAFETY_RULE_VERSION,
  CHEST_PAIN_URGENT_RESPONSE,
  URGENT_RESPONSE,
  evaluateSafetyMessage,
} = require("../src/goals-coach/safety-rules");

function assertDecision(message, expected) {
  const actual = evaluateSafetyMessage(message);
  assert.equal(actual.decision, expected.decision, message);
  assert.equal(actual.priority, expected.priority, message);
  assert.equal(actual.category, expected.category, message);
  assert.equal(actual.stopNormalCoaching, expected.stopNormalCoaching, message);
  assert.equal(actual.reviewRequired, expected.reviewRequired, message);
  assert.equal(actual.ruleVersion, SAFETY_RULE_VERSION, message);
}

test("deterministic safety rules use the urgent approved response for current direct danger", () => {
  const urgentCases = [
    "My chest hurts while I am exercising",
    "I can't breathe normally after this set",
    "I passed out at the gym just now",
    "I want to kill myself",
    "I am going to hurt someone tonight",
    "I have severe rapidly worsening knee pain",
  ];
  for (const message of urgentCases) {
    const actual = evaluateSafetyMessage(message);
    assertDecision(message, { decision: "urgent", priority: "urgent", category: actual.category, stopNormalCoaching: true, reviewRequired: true });
    assert.equal(
      actual.memberResponse,
      actual.reasonCode === "acute_medical_language" ? CHEST_PAIN_URGENT_RESPONSE : URGENT_RESPONSE
    );
  }
});

test("deterministic safety rules do not turn negations, quotations, hypotheticals, or history into an emergency", () => {
  const nonUrgentCases = [
    "I do not have chest pain, I only need help counting reps",
    "The movie quote says I have chest pain",
    "What if someone has chest pain during exercise?",
    "My friend fainted years ago",
    "I had chest soreness from a previous workout but it is gone now",
  ];
  for (const message of nonUrgentCases) {
    assert.notEqual(evaluateSafetyMessage(message).decision, "urgent", message);
  }
});

test("a historical or quoted clause cannot suppress a separate current urgent disclosure", () => {
  const mixedCases = [
    "I was diagnosed last year, and I have chest pain now.",
    "My friend fainted years ago, but I can't breathe after this set.",
    "That movie quote mentioned chest pain; I have chest pain while exercising now.",
  ];
  for (const message of mixedCases) {
    assert.equal(evaluateSafetyMessage(message).decision, "urgent", message);
  }
});

test("member requests and nonurgent concerning symptoms are routed for review without pretending delivery occurred", () => {
  assertDecision("Can Derek review this?", {
    decision: "review", priority: "routine", category: "member_request", stopNormalCoaching: false, reviewRequired: true,
  });
  assertDecision("This exercise doesn't feel right and my knee pain is worsening", {
    decision: "review", priority: "priority", category: "pain_or_injury", stopNormalCoaching: false, reviewRequired: true,
  });
  const reply = evaluateSafetyMessage("Can Derek review this?").memberResponse;
  assert.match(reply, /saved your question for human review/i);
  assert.doesNotMatch(reply, /sent this to your coach|someone is watching/i);
});
