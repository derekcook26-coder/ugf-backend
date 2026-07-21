"use strict";

const REQUIRED_FIELDS = Object.freeze([
  "approvedIdentity",
  "releaseIdentifier",
  "frontendVersion",
  "backendCommit",
  "migrationVersion",
  "aiModel",
  "promptVersion",
  "safetyRuleVersion",
  "approvedOrigin",
  "enabledFeatures",
  "disabledFeatures",
  "testEvidence",
  "knownLimitations",
  "rollbackProcedure",
  "spendingLimit",
]);

function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function createUnsignedPrivateAlphaApprovalRecord(input = {}) {
  const missing = REQUIRED_FIELDS.filter((name) => !present(input[name]));

  return Object.freeze({
    state: "unsigned",
    ownerApprovalRecorded: false,
    deploymentAuthorized: false,
    activationAuthorized: false,
    complete: missing.length === 0,
    missing: Object.freeze(missing),
    record: Object.freeze({
      approvedIdentity: input.approvedIdentity || null,
      releaseIdentifier: input.releaseIdentifier || null,
      frontendVersion: input.frontendVersion || null,
      backendCommit: input.backendCommit || null,
      migrationVersion: input.migrationVersion || null,
      aiModel: input.aiModel || null,
      promptVersion: input.promptVersion || null,
      safetyRuleVersion: input.safetyRuleVersion || null,
      approvedOrigin: input.approvedOrigin || null,
      enabledFeatures: Array.isArray(input.enabledFeatures) ? Object.freeze([...input.enabledFeatures]) : [],
      disabledFeatures: Array.isArray(input.disabledFeatures) ? Object.freeze([...input.disabledFeatures]) : [],
      testEvidence: Array.isArray(input.testEvidence) ? Object.freeze([...input.testEvidence]) : [],
      knownLimitations: Array.isArray(input.knownLimitations) ? Object.freeze([...input.knownLimitations]) : [],
      rollbackProcedure: input.rollbackProcedure || null,
      spendingLimit: input.spendingLimit || null,
    }),
  });
}

module.exports = { REQUIRED_FIELDS, createUnsignedPrivateAlphaApprovalRecord };
