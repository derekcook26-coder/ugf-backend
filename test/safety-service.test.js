"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSafetyService } = require("../src/goals-coach/safety-service");

test("classifier results can only increase protection over deterministic urgent safety", async () => {
  const service = createSafetyService({
    classify: async () => ({ decision: "continue", category: "safety", version: "synthetic-1" }),
  });
  const result = await service.assess("My chest hurts while exercising");
  assert.equal(result.decision, "urgent");
  assert.equal(result.stopNormalCoaching, true);
  assert.equal(result.classifierStatus, "completed");
});

test("an unknown classifier category fails closed before it can reach persistence", async () => {
  const service = createSafetyService({
    classify: async () => ({ decision: "review", category: "unrecognized_classifier_category" }),
  });
  const result = await service.assess("Please tell me the next step");
  assert.equal(result.decision, "review");
  assert.equal(result.stopNormalCoaching, true);
  assert.equal(result.category, "technical_failure");
  assert.equal(result.classifierStatus, "failed");
});

test("classifier urgent output protects a message with no deterministic urgent match", async () => {
  const service = createSafetyService({
    classify: async () => ({
      decision: "urgent",
      priority: "urgent",
      category: "safety",
      reasonCode: "synthetic_urgent",
      version: "synthetic-1",
    }),
  });
  const result = await service.assess("I feel strange after that set");
  assert.equal(result.decision, "urgent");
  assert.equal(result.reviewRequired, true);
  assert.equal(result.stopNormalCoaching, true);
});

test("classifier failure fails closed and never returns an ordinary coaching decision", async () => {
  const service = createSafetyService({ classify: async () => { throw new Error("synthetic timeout"); } });
  const result = await service.assess("Please tell me the next step");
  assert.equal(result.decision, "review");
  assert.equal(result.stopNormalCoaching, true);
  assert.equal(result.category, "technical_failure");
  assert.equal(result.classifierStatus, "failed");
});

test("classifier failure cannot soften a deterministic urgent decision", async () => {
  const service = createSafetyService({
    async classify() { throw new Error("synthetic classifier outage"); },
  });
  const result = await service.assess("I have chest pain while exercising");
  assert.equal(result.decision, "urgent");
  assert.equal(result.stopNormalCoaching, true);
  assert.equal(result.classifierStatus, "failed");
});

test("no classifier is explicit and preserves the deterministic decision", async () => {
  const service = createSafetyService();
  const result = await service.assess("I want my coach");
  assert.equal(result.decision, "review");
  assert.equal(result.classifierStatus, "not_configured");
});
