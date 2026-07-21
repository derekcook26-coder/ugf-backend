"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REQUIRED_FIELDS,
  createUnsignedPrivateAlphaApprovalRecord,
} = require("../src/goals-coach/phase1e-approval-record");

function completeRecord(overrides = {}) {
  return {
    approvedIdentity: "owner-only subject",
    releaseIdentifier: "candidate-release",
    frontendVersion: "not-deployed",
    backendCommit: "candidate-commit",
    migrationVersion: "migration-006",
    aiModel: "not-enabled",
    promptVersion: "not-enabled",
    safetyRuleVersion: "GC-PHASE1D-SAFETY-1",
    approvedOrigin: "https://alpha.example.test",
    enabledFeatures: ["none"],
    disabledFeatures: ["alpha", "ai", "voice", "speech", "safety-routing"],
    testEvidence: ["offline readiness tests"],
    knownLimitations: ["No external services are configured"],
    rollbackProcedure: "Keep all feature flags disabled.",
    spendingLimit: "No provider spending is authorized.",
    ...overrides,
  };
}

test("an incomplete Phase 1E approval record remains unsigned and blocked", () => {
  const result = createUnsignedPrivateAlphaApprovalRecord();
  assert.equal(result.state, "unsigned");
  assert.equal(result.complete, false);
  assert.equal(result.deploymentAuthorized, false);
  assert.equal(result.activationAuthorized, false);
  assert.deepEqual(result.missing, REQUIRED_FIELDS);
});

test("a complete Phase 1E record is still only an unsigned draft", () => {
  const result = createUnsignedPrivateAlphaApprovalRecord(completeRecord());
  assert.equal(result.complete, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.state, "unsigned");
  assert.equal(result.ownerApprovalRecorded, false);
  assert.equal(result.deploymentAuthorized, false);
  assert.equal(result.activationAuthorized, false);
  assert.deepEqual(result.record.disabledFeatures, ["alpha", "ai", "voice", "speech", "safety-routing"]);
});

test("the draft copies evidence arrays instead of retaining caller-owned arrays", () => {
  const evidence = ["offline report"];
  const result = createUnsignedPrivateAlphaApprovalRecord(completeRecord({ testEvidence: evidence }));
  evidence.push("later mutation");
  assert.deepEqual(result.record.testEvidence, ["offline report"]);
});
