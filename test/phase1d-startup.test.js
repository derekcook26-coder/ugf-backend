"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPhase1dStartup } = require("../src/goals-coach/phase1d-startup");
const {
  APPROVED_PHASE1D_SAFETY_CONSENT_VERSION,
  loadPhase1dConfiguration,
} = require("../src/goals-coach/phase1d-config");

const phase1bConfiguration = { aiEnabled: true, generationReady: true };
const phase1bReady = {
  status: "ready",
  configuration: phase1bConfiguration,
  engine: { configuration: phase1bConfiguration, async generateTurn() {} },
};

test("Phase 1D defaults disabled and requires an explicit consented safety composition", () => {
  assert.equal(loadPhase1dConfiguration({}).safetyEnabled, false);
  assert.equal(createPhase1dStartup({ phase1bStartup: phase1bReady }).status, "disabled");
  const configuration = loadPhase1dConfiguration({
    GOALS_COACH_PHASE1D_SAFETY_ENABLED: "true",
    GOALS_COACH_PHASE1D_SAFETY_CONSENT_VERSION: APPROVED_PHASE1D_SAFETY_CONSENT_VERSION,
    NODE_ENV: "test",
  });
  assert.equal(createPhase1dStartup({ configuration, phase1bStartup: phase1bReady }).reason, "safety_service_unavailable");
  const safetyService = { async assess() {} };
  assert.equal(createPhase1dStartup({ configuration, phase1bStartup: phase1bReady, safetyService }).reason, "protected_review_route_unavailable");
  const ready = createPhase1dStartup({
    configuration,
    phase1bStartup: phase1bReady,
    safetyService,
    reviewRouting: { async route() {} },
  });
  assert.equal(ready.status, "ready");
});
