"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REQUIRED_DISABLED_FLAGS,
  createPhase1eReadinessReport,
  exactHttpsOrigin,
  exactFalse,
  positiveUsdAmount,
} = require("../src/goals-coach/phase1e-readiness");

function safeEnvironment(overrides = {}) {
  return {
    GOALS_COACH_ALPHA_ENABLED: "false",
    GOALS_COACH_AI_ENABLED: "false",
    GOALS_COACH_VOICE_INPUT_ENABLED: "false",
    GOALS_COACH_TRANSCRIPTION_ENABLED: "false",
    GOALS_COACH_SPEECH_OUTPUT_ENABLED: "false",
    GOALS_COACH_PHASE1D_SAFETY_ENABLED: "false",
    GOALS_COACH_ALPHA_CONSENT_VERSION: "GC-ALPHA-CONSENT-1.0",
    ...overrides,
  };
}

function completeOwnerInputs(overrides = {}) {
  return {
    approvedAlphaOrigin: "https://alpha.example.test",
    approvedOwnerSubject: "user_owner_only",
    approvedMonthlyBudgetUsd: "25.00",
    approvedDailyWarningUsd: "2.00",
    protectedReviewDestination: "owner-review-inbox",
    backupReviewDestination: "owner-review-backup",
    ...overrides,
  };
}

test("Phase 1E readiness is disabled by default and never authorizes activation", () => {
  const report = createPhase1eReadinessReport({ environment: {}, ownerInputs: {} });
  assert.equal(report.status, "not_ready");
  assert.equal(report.activationPermitted, false);
  assert.equal(report.externalCallsPermitted, false);
  assert.ok(report.blockers.includes("approved_alpha_consent_version_required"));
  assert.ok(report.blockers.includes("owner_input_required:approvedAlphaOrigin"));
});

test("Phase 1E readiness rejects every enabled feature flag", () => {
  for (const flag of REQUIRED_DISABLED_FLAGS) {
    const report = createPhase1eReadinessReport({
      environment: safeEnvironment({ [flag]: "true" }),
      ownerInputs: completeOwnerInputs(),
    });
    assert.equal(report.status, "not_ready");
    assert.ok(report.blockers.includes(`feature_flag_must_remain_disabled:${flag}`));
  }
});

test("Phase 1E readiness reports configuration-review readiness without enabling anything", () => {
  const report = createPhase1eReadinessReport({
    environment: safeEnvironment(),
    ownerInputs: completeOwnerInputs(),
  });
  assert.equal(report.status, "ready_for_configuration_review");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.activationPermitted, false);
  assert.equal(report.externalCallsPermitted, false);
});

test("only an exact false value satisfies an off switch", () => {
  assert.equal(exactFalse(undefined), true);
  for (const value of [null, "", "true", "1", true, 1]) {
    assert.equal(exactFalse(value), false, `unexpected off value: ${String(value)}`);
  }
  assert.equal(exactFalse("false"), true);
});

test("owner configuration requires one exact HTTPS origin", () => {
  assert.equal(exactHttpsOrigin("https://alpha.example.test"), true);
  for (const value of ["http://alpha.example.test", "https://alpha.example.test/", "https://*.example.test", "https://alpha.example.test/path"]) {
    assert.equal(exactHttpsOrigin(value), false, value);
  }
  const report = createPhase1eReadinessReport({
    environment: safeEnvironment(),
    ownerInputs: completeOwnerInputs({ approvedAlphaOrigin: "https://alpha.example.test/" }),
  });
  assert.ok(report.blockers.includes("approved_alpha_origin_must_be_one_exact_https_origin"));
});

test("spending controls require positive amounts and an earlier daily warning", () => {
  assert.equal(positiveUsdAmount("25.00"), 25);
  assert.equal(positiveUsdAmount("0"), null);
  assert.equal(positiveUsdAmount("two"), null);
  const report = createPhase1eReadinessReport({
    environment: safeEnvironment(),
    ownerInputs: completeOwnerInputs({ approvedMonthlyBudgetUsd: "2.00", approvedDailyWarningUsd: "2.00" }),
  });
  assert.ok(report.blockers.includes("daily_warning_must_be_lower_than_monthly_budget"));
});
