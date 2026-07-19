const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const { createAlphaGoalsCoachRouter } = require("../src/goals-coach/alpha-routes");
const { createAlphaGoalsCoachService } = require("../src/goals-coach/alpha-service");
const { createVoiceCapability } = require("../src/goals-coach/phase1c-contracts");
const { loadPhase1cConfiguration } = require("../src/goals-coach/phase1c-config");
const { createPhase1cStartup } = require("../src/goals-coach/phase1c-startup");
const {
  createDeterministicPhase1cReadinessStub,
} = require("./helpers/deterministic-phase1c-readiness-stub");
const { jsonRequest, startApp } = require("./helpers/http-app");

const applicationConfiguration = Object.freeze({
  valid: true,
  consentVersion: "GC-ALPHA-CONSENT-1.0",
  alphaEnvironment: "test",
});
const member = Object.freeze({
  mappingId: "10",
  memberId: "20",
  authProvider: "clerk",
  authSubject: "user_phase1c_session",
});

function noOp(req, res, next) {
  return next();
}

function rateLimits() {
  return {
    consent: noOp,
    session: noOp,
    read: noOp,
    message: noOp,
    mutation: noOp,
  };
}

function fakeDatabase() {
  const conversation = {
    id: 30,
    member_id: 20,
    plan_id: 40,
    assigned_staff_user_id: null,
    status: "active",
    opened_at: "2026-07-18T00:00:00.000Z",
    archived_at: null,
    updated_at: "2026-07-18T00:00:00.000Z",
  };
  const client = {
    async query(sql) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("FROM goals_coach_member_auth_mappings")) {
        return { rows: [{ id: 10, member_id: 20, active: true }] };
      }
      if (sql.includes("SELECT id, created_at FROM coach_plans")) {
        return { rows: [{ id: 40, created_at: "2026-07-17T00:00:00.000Z" }] };
      }
      if (sql.includes("FROM member_coach_assignments")) return { rows: [] };
      if (sql.includes("INSERT INTO coaching_conversations")) return { rows: [conversation] };
      if (sql.includes("to_regclass")) {
        return { rows: [{ workout_sessions: null, coaching_turns: null }] };
      }
      throw new Error(`Unexpected synthetic query: ${sql}`);
    },
    release() {},
  };
  return { async connect() { return client; } };
}

function readyPhase1b() {
  const configuration = Object.freeze({ aiEnabled: true, generationReady: true });
  return Object.freeze({
    status: "ready",
    configuration,
    engine: Object.freeze({ configuration, async generateTurn() {} }),
  });
}

function readyPhase1cStartup() {
  const consentVersion = "GC-ALPHA-CONSENT-PHASE1C-TEST";
  const configuration = loadPhase1cConfiguration({
    GOALS_COACH_VOICE_INPUT_ENABLED: "true",
    GOALS_COACH_TRANSCRIPTION_ENABLED: "true",
    GOALS_COACH_PHASE1C_CONSENT_VERSION: consentVersion,
    GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD: "1.00",
    GOALS_COACH_TRANSCRIPTION_BINDING_KEY: "synthetic-test-binding-key",
  }, { approvedConsentVersion: consentVersion });
  const stub = createDeterministicPhase1cReadinessStub();
  return {
    startup: createPhase1cStartup({
      configuration,
      phase1bStartup: readyPhase1b(),
      transcriptionAdapter: stub.adapter,
    }),
    stub,
  };
}

async function createSessionApp(phase1cStartup) {
  const service = createAlphaGoalsCoachService({
    db: fakeDatabase(),
    applicationConfiguration,
    voiceCapability: createVoiceCapability(phase1cStartup),
  });
  const app = express();
  app.use(express.json());
  app.use("/alpha/goals-coach", (req, res, next) => {
    req.alphaMember = member;
    next();
  }, createAlphaGoalsCoachRouter({
    db: fakeDatabase(),
    applicationConfiguration,
    requireCurrentConsent: noOp,
    service,
    phase1cStartup,
    rateLimits: rateLimits(),
  }));
  return startApp(app);
}

test("authenticated session adds disabled voice capability without changing existing fields", async (t) => {
  const running = await createSessionApp(null);
  t.after(() => running.close());
  const result = await jsonRequest(running.url, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(result.response.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), [
    "coach",
    "coachingCapability",
    "coachingMode",
    "conversation",
    "plan",
    "voiceCapability",
    "workoutState",
  ]);
  assert.equal(result.body.coachingMode, "phase_1a_test_only");
  assert.equal(result.body.coachingCapability.status, "disabled");
  assert.equal(result.body.workoutState, null);
  assert.deepEqual(result.body.voiceCapability, {
    phase: "phase_1c",
    status: "disabled",
    reason: "voice_disabled",
    transcriptionAvailable: false,
    transcriptReviewRequired: true,
    maxRecordingSeconds: 30,
    warningAtSeconds: 25,
    maxAudioBytes: 1048576,
    supportedMediaTypes: [
      "audio/webm;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
    ],
  });
});

test("direct test composition can report ready without invoking the readiness stub", async (t) => {
  const ready = readyPhase1cStartup();
  const running = await createSessionApp(ready.startup);
  t.after(() => running.close());
  const result = await jsonRequest(running.url, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.voiceCapability.status, "ready");
  assert.equal(result.body.voiceCapability.reason, null);
  assert.equal(result.body.voiceCapability.transcriptionAvailable, true);
  assert.equal(ready.stub.calls, 0);
});

test("Slice 1 exposes no transcription route and accepts no audio body", async (t) => {
  const running = await createSessionApp(null);
  t.after(() => running.close());
  const response = await fetch(`${running.url}/alpha/goals-coach/transcriptions`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm;codecs=opus" },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  });
  assert.equal(response.status, 404);
});
