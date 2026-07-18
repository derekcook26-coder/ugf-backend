const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const express = require("express");
const { createAlphaMemberAuthorization } = require("../src/auth/alpha-member-authorization");
const { createAlphaOriginGuard } = require("../src/auth/clerk-alpha-member-auth");
const {
  APPROVED_ALPHA_CONSENT_VERSION,
  createAlphaFeatureGate,
} = require("../src/goals-coach/alpha-config");
const { createAlphaGoalsCoachRouter } = require("../src/goals-coach/alpha-routes");
const { createCoachingCapability } = require("../src/goals-coach/phase1b-contracts");
const { createPhase1bStartup } = require("../src/goals-coach/phase1b-startup");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");

const testOrigin = "https://phase1b-contracts.example.test";
const applicationConfiguration = Object.freeze({
  valid: true,
  consentVersion: APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnvironment: "test",
});

function coachingConfiguration(overrides = {}) {
  return Object.freeze({
    aiEnabled: true,
    generationReady: true,
    providerIdentifier: "synthetic-contract-provider",
    modelIdentifier: "synthetic-contract-model",
    promptVersion: "GC-PROMPT-1B-1.0",
    structuredOutputVersion: "GC-OUTPUT-1B-1.0",
    safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B",
    providerTimeoutMs: 100,
    ...overrides,
  });
}

function structuredOutput(configuration, overrides = {}) {
  const base = {
    reply: "Start with five minutes of comfortable walking.",
    mode: "start_today",
    nextAction: { type: "warmup", label: "Comfortable walking", target: "5 minutes" },
    conversationState: { workoutActive: true, awaitingMemberCompletion: true },
    stateTransition: { type: "start_session", expectedVersion: null, changes: {} },
    review: { required: false, priority: null, category: null, reason: null },
    safety: { stopNormalCoaching: false, severity: "none" },
    uncertainty: { missingContext: false, reason: null },
    promptVersion: configuration.promptVersion,
    schemaVersion: configuration.structuredOutputVersion,
  };
  return {
    ...base,
    ...overrides,
    nextAction: overrides.nextAction === null
      ? null
      : { ...base.nextAction, ...(overrides.nextAction || {}) },
    conversationState: { ...base.conversationState, ...(overrides.conversationState || {}) },
    stateTransition: {
      ...base.stateTransition,
      ...(overrides.stateTransition || {}),
      changes: {
        ...base.stateTransition.changes,
        ...((overrides.stateTransition && overrides.stateTransition.changes) || {}),
      },
    },
    review: { ...base.review, ...(overrides.review || {}) },
    safety: { ...base.safety, ...(overrides.safety || {}) },
    uncertainty: { ...base.uncertainty, ...(overrides.uncertainty || {}) },
  };
}

async function seedExercise(pool, planId, suffix) {
  return (await pool.query(
    `INSERT INTO coach_plan_exercises
      (plan_id, plan_item_key, workout_label, sequence_number, exercise_name,
       prescription_json, intent_source, intent_validation_status)
     VALUES ($1, $2, 'Full Body', 1, 'Comfortable walking',
       '{"sets":2,"durationSeconds":300}'::jsonb, 'staff_review', 'validated')
     RETURNING *`,
    [planId, `contract-${suffix}`]
  )).rows[0];
}

async function seedIdentity(pool, suffix) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  await pool.query(
    "UPDATE coach_plans SET profile_json = $1 WHERE id = $2",
    [{ primaryGoal: "Synthetic consistency", timeZone: "America/Denver" }, seeded.plan.id]
  );
  await seedExercise(pool, seeded.plan.id, suffix);
  const mapping = await seedAlphaMapping(pool, seeded.member, suffix, true);
  return { ...seeded, mapping };
}

function readyStartup(provider, configuration = coachingConfiguration()) {
  return createPhase1bStartup({ configuration, provider });
}

async function createContractApp(pool, mapping, startup) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/alpha/goals-coach", createAlphaOriginGuard({ authorizedParties: [testOrigin] }));
  const authorization = createAlphaMemberAuthorization({
    db: pool,
    applicationConfiguration,
  });
  app.use(
    "/alpha/goals-coach",
    createAlphaFeatureGate({ enabled: true }),
    (req, res, next) => {
      req.alphaMemberIdentity = {
        authProvider: "clerk",
        authSubject: mapping.auth_subject,
        sessionId: "synthetic-contract-session",
      };
      next();
    },
    authorization.loadActiveAlphaMember,
    createAlphaGoalsCoachRouter({
      db: pool,
      applicationConfiguration,
      requireCurrentConsent: authorization.requireCurrentAlphaConsent,
      coachingEngine: startup.engine,
      phase1bStartup: startup,
      phase1bServiceOptions: {
        pendingPollIntervalMs: 2,
        pendingWaitTimeoutMs: 500,
      },
    })
  );
  app.use(goalsCoachErrorHandler);
  return startApp(app);
}

function request(running, path, options = {}) {
  return jsonRequest(running.url, path, {
    ...options,
    headers: { Origin: testOrigin, ...(options.headers || {}) },
  });
}

async function acceptConsent(running) {
  const result = await request(running, "/alpha/goals-coach/consent", {
    method: "POST",
    body: { action: "accept" },
  });
  assert.equal(result.response.status, 200);
}

function messagePath(session) {
  return `/alpha/goals-coach/conversations/${session.conversation.id}/messages`;
}

function turnPath(session, clientMessageId) {
  return `${messagePath(session).replace(/\/messages$/, "")}/turns/${clientMessageId}`;
}

test("session returns null then restores only the mapped member's authoritative active workout", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const first = await seedIdentity(disposable.pool, "contract-restore-a");
  const second = await seedIdentity(disposable.pool, "contract-restore-b");
  const configuration = coachingConfiguration();
  const startup = readyStartup({
    async generate() { return { output: structuredOutput(configuration) }; },
  }, configuration);
  const firstApp = await createContractApp(disposable.pool, first.mapping, startup);
  const secondApp = await createContractApp(disposable.pool, second.mapping, startup);
  t.after(() => firstApp.close());
  t.after(() => secondApp.close());
  await acceptConsent(firstApp);
  await acceptConsent(secondApp);

  const initial = await request(firstApp, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.workoutState, null);
  assert.equal(initial.body.coachingMode, "phase_1a_test_only");
  assert.deepEqual(initial.body.coachingCapability, {
    phase: "phase_1b",
    status: "ready",
    reason: null,
    structuredResponses: true,
    workoutStateRead: true,
    turnStatusRead: true,
  });

  const clientMessageId = crypto.randomUUID();
  const started = await request(firstApp, messagePath(initial.body), {
    method: "POST",
    body: { content: "Where do I start today?", clientMessageId },
  });
  assert.equal(started.response.status, 201);
  assert.equal(started.body.workoutState.stateVersion, 1);

  const beforeRead = (await disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns`
  )).rows[0];
  const restored = await request(firstApp, "/alpha/goals-coach/session", {
    method: "POST",
    body: {
      memberId: second.member.id,
      planId: second.plan.id,
      conversationId: "999999",
    },
  });
  assert.deepEqual(restored.body.workoutState, started.body.workoutState);
  const afterRead = (await disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns`
  )).rows[0];
  assert.deepEqual(afterRead, beforeRead);

  const otherSession = await request(secondApp, "/alpha/goals-coach/session", {
    method: "POST",
    body: { memberId: first.member.id, conversationId: initial.body.conversation.id },
  });
  assert.equal(otherSession.response.status, 200);
  assert.equal(otherSession.body.workoutState, null);
  assert.notEqual(otherSession.body.conversation.id, initial.body.conversation.id);
});

test("withdrawn and outdated consent block session restoration", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const withdrawnIdentity = await seedIdentity(disposable.pool, "contract-withdrawn");
  const outdatedIdentity = await seedIdentity(disposable.pool, "contract-outdated");
  const startup = createPhase1bStartup({ environment: {} });
  const withdrawnApp = await createContractApp(disposable.pool, withdrawnIdentity.mapping, startup);
  const outdatedApp = await createContractApp(disposable.pool, outdatedIdentity.mapping, startup);
  t.after(() => withdrawnApp.close());
  t.after(() => outdatedApp.close());
  await acceptConsent(withdrawnApp);
  await request(withdrawnApp, "/alpha/goals-coach/consent", {
    method: "POST",
    body: { action: "withdraw" },
  });
  await disposable.pool.query(
    `INSERT INTO goals_coach_alpha_consents
      (member_id, auth_mapping_id, consent_version, environment, status, accepted_at)
     VALUES ($1, $2, 'GC-ALPHA-CONSENT-0.9', 'test', 'accepted', NOW())`,
    [outdatedIdentity.member.id, outdatedIdentity.mapping.id]
  );

  for (const running of [withdrawnApp, outdatedApp]) {
    const result = await request(running, "/alpha/goals-coach/session", { method: "POST" });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error, "ALPHA_CONSENT_REQUIRED");
  }
});

test("session capability distinguishes disabled, unavailable, and valid ready composition", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const identity = await seedIdentity(disposable.pool, "contract-capability");
  const disabledStartup = createPhase1bStartup({ environment: {} });
  const unavailableStartup = createPhase1bStartup({ configuration: coachingConfiguration() });
  const malformedReady = createCoachingCapability({
    status: "ready",
    configuration: coachingConfiguration(),
    engine: null,
  });
  assert.equal(malformedReady.status, "unavailable");
  assert.equal(malformedReady.reason, "provider_unavailable");

  const disabledApp = await createContractApp(disposable.pool, identity.mapping, disabledStartup);
  const unavailableApp = await createContractApp(disposable.pool, identity.mapping, unavailableStartup);
  t.after(() => disabledApp.close());
  t.after(() => unavailableApp.close());
  await acceptConsent(disabledApp);
  const disabled = await request(disabledApp, "/alpha/goals-coach/session", { method: "POST" });
  const unavailable = await request(unavailableApp, "/alpha/goals-coach/session", { method: "POST" });
  assert.deepEqual(
    { status: disabled.body.coachingCapability.status, reason: disabled.body.coachingCapability.reason },
    { status: "disabled", reason: "ai_disabled" }
  );
  assert.deepEqual(
    {
      status: unavailable.body.coachingCapability.status,
      reason: unavailable.body.coachingCapability.reason,
    },
    { status: "unavailable", reason: "provider_unavailable" }
  );
});

test("turn read exposes processing then completed result and history without mutation", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const identity = await seedIdentity(disposable.pool, "contract-processing");
  const configuration = coachingConfiguration({ providerTimeoutMs: 1000 });
  let enteredProvider;
  let releaseProvider;
  const entered = new Promise((resolve) => { enteredProvider = resolve; });
  const released = new Promise((resolve) => { releaseProvider = resolve; });
  const startup = readyStartup({
    async generate() {
      enteredProvider();
      await released;
      return { output: structuredOutput(configuration) };
    },
  }, configuration);
  const running = await createContractApp(disposable.pool, identity.mapping, startup);
  t.after(() => running.close());
  await acceptConsent(running);
  const session = (await request(running, "/alpha/goals-coach/session", { method: "POST" })).body;
  const clientMessageId = crypto.randomUUID();
  const postPromise = request(running, messagePath(session), {
    method: "POST",
    body: { content: "Where do I start today?", clientMessageId },
  });
  await entered;

  const processing = await request(running, turnPath(session, clientMessageId));
  assert.equal(processing.response.status, 200);
  assert.equal(processing.body.status, "processing");
  assert.equal(processing.body.messageSaved, true);
  assert.equal(processing.body.retrySafe, false);
  assert.equal(processing.body.result, null);
  assert.equal(processing.body.attemptNumber, 1);
  const processingHistory = await request(running, messagePath(session));
  const pendingMessage = processingHistory.body.messages.find(
    (message) => message.senderType === "member"
  );
  assert.equal(pendingMessage.clientMessageId, clientMessageId);
  assert.deepEqual(
    {
      status: pendingMessage.turn.status,
      retrySafe: pendingMessage.turn.retrySafe,
      attemptNumber: pendingMessage.turn.attemptNumber,
    },
    { status: "processing", retrySafe: false, attemptNumber: 1 }
  );

  releaseProvider();
  const completedPost = await postPromise;
  assert.equal(completedPost.response.status, 201);
  const countsBeforeReads = (await disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages) AS messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events`
  )).rows[0];

  const completed = await request(running, turnPath(session, clientMessageId));
  assert.equal(completed.body.status, "completed");
  assert.equal(completed.body.retrySafe, false);
  assert.equal(completed.body.result.idempotentReplay, true);
  assert.equal(completed.body.result.response.id, completedPost.body.response.id);
  assert.deepEqual(
    completed.body.result.response.structuredResponse,
    completedPost.body.response.structuredResponse
  );
  const history = await request(running, messagePath(session));
  const memberMessage = history.body.messages.find((message) => message.senderType === "member");
  const coachMessage = history.body.messages.find((message) => message.senderType === "goals_coach");
  assert.equal(memberMessage.clientMessageId, clientMessageId);
  assert.deepEqual(
    {
      status: memberMessage.turn.status,
      retrySafe: memberMessage.turn.retrySafe,
      attemptNumber: memberMessage.turn.attemptNumber,
    },
    { status: "completed", retrySafe: false, attemptNumber: 1 }
  );
  assert.deepEqual(coachMessage.structuredResponse, completedPost.body.response.structuredResponse);
  const countsAfterReads = (await disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages) AS messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events`
  )).rows[0];
  assert.deepEqual(countsAfterReads, countsBeforeReads);
});

test("retryable failure reconciles, rejects mismatched content, and retries one saved message", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const identity = await seedIdentity(disposable.pool, "contract-retryable");
  const configuration = coachingConfiguration();
  let providerCalls = 0;
  const startup = readyStartup({
    async generate() {
      providerCalls += 1;
      if (providerCalls === 1) {
        const error = new Error("synthetic provider timeout");
        error.failureCategory = "provider_timeout";
        throw error;
      }
      return { output: structuredOutput(configuration) };
    },
  }, configuration);
  const running = await createContractApp(disposable.pool, identity.mapping, startup);
  t.after(() => running.close());
  await acceptConsent(running);
  const session = (await request(running, "/alpha/goals-coach/session", { method: "POST" })).body;
  const clientMessageId = crypto.randomUUID();
  const body = { content: "Where do I start today?", clientMessageId };
  const failedPost = await request(running, messagePath(session), { method: "POST", body });
  assert.equal(failedPost.response.status, 503);
  assert.equal(failedPost.body.messageSaved, true);
  assert.equal(failedPost.body.retrySafe, true);

  const failedTurn = await request(running, turnPath(session, clientMessageId));
  assert.equal(failedTurn.body.status, "retryable_failure");
  assert.equal(failedTurn.body.messageSaved, true);
  assert.equal(failedTurn.body.retrySafe, true);
  assert.equal(failedTurn.body.result, null);
  const failedHistory = await request(running, messagePath(session));
  assert.equal(failedHistory.body.messages[0].turn.status, "retryable_failure");

  const mismatch = await request(running, messagePath(session), {
    method: "POST",
    body: { content: "Different content", clientMessageId },
  });
  assert.equal(mismatch.response.status, 409);
  assert.equal(mismatch.body.error, "CLIENT_MESSAGE_ID_CONFLICT");

  const retry = await request(running, messagePath(session), { method: "POST", body });
  assert.equal(retry.response.status, 201);
  assert.equal(retry.body.turn.attemptNumber, 2);
  const reconciled = await request(running, turnPath(session, clientMessageId));
  assert.equal(reconciled.body.status, "completed");
  assert.equal(reconciled.body.attemptNumber, 2);
  const counts = (await disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'member') AS member_messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events`
  )).rows[0];
  assert.deepEqual(counts, { member_messages: 1, turns: 2, sessions: 1, events: 1 });
});

test("terminal failures are not retry-safe and turn resources remain concealed", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const first = await seedIdentity(disposable.pool, "contract-terminal-a");
  const second = await seedIdentity(disposable.pool, "contract-terminal-b");
  const configuration = coachingConfiguration();
  const startup = readyStartup({
    async generate(input) {
      if (input.memberMessage === "Start") {
        return { output: structuredOutput(configuration) };
      }
      return {
        output: structuredOutput(configuration, {
          mode: "workout_step",
          stateTransition: { type: "advance", expectedVersion: 99 },
        }),
      };
    },
  }, configuration);
  const firstApp = await createContractApp(disposable.pool, first.mapping, startup);
  const secondApp = await createContractApp(disposable.pool, second.mapping, startup);
  t.after(() => firstApp.close());
  t.after(() => secondApp.close());
  await acceptConsent(firstApp);
  await acceptConsent(secondApp);
  const firstSession = (await request(firstApp, "/alpha/goals-coach/session", { method: "POST" })).body;
  await request(secondApp, "/alpha/goals-coach/session", { method: "POST" });
  await request(firstApp, messagePath(firstSession), {
    method: "POST",
    body: { content: "Start", clientMessageId: crypto.randomUUID() },
  });
  const clientMessageId = crypto.randomUUID();
  const failed = await request(firstApp, messagePath(firstSession), {
    method: "POST",
    body: { content: "Use a stale state", clientMessageId },
  });
  assert.equal(failed.response.status, 409);
  assert.equal(failed.body.error, "WORKOUT_STATE_CHANGED");
  const terminal = await request(firstApp, turnPath(firstSession, clientMessageId));
  assert.equal(terminal.body.status, "failed");
  assert.equal(terminal.body.messageSaved, true);
  assert.equal(terminal.body.retrySafe, false);
  assert.equal(terminal.body.result, null);

  const crossMember = await request(secondApp, turnPath(firstSession, clientMessageId));
  assert.equal(crossMember.response.status, 404);
  assert.equal(crossMember.body.error, "COACHING_TURN_NOT_FOUND");
  const unknown = await request(firstApp, turnPath(firstSession, crypto.randomUUID()));
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error, "COACHING_TURN_NOT_FOUND");
  const invalid = await request(firstApp, turnPath(firstSession, "not-a-uuid"));
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, "INVALID_REQUEST");
});

test("review-required and safety-stop turns do not mutate authoritative workout state", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const identity = await seedIdentity(disposable.pool, "contract-review-safety");
  const configuration = coachingConfiguration();
  const startup = readyStartup({
    async generate(input) {
      if (input.memberMessage === "Start") {
        return { output: structuredOutput(configuration) };
      }
      if (input.memberMessage === "Human review") {
        return {
          output: structuredOutput(configuration, {
            reply: "A human review is required before changing the plan.",
            mode: "human_review",
            nextAction: null,
            stateTransition: { type: "no_change", expectedVersion: null },
            review: {
              required: true,
              priority: "routine",
              category: "member_request",
              reason: "Synthetic review requirement",
            },
          }),
        };
      }
      return {
        output: structuredOutput(configuration, {
          reply: "Stop normal coaching and seek immediate help.",
          mode: "safety_stop",
          nextAction: null,
          conversationState: { workoutActive: false, awaitingMemberCompletion: false },
          stateTransition: { type: "no_change", expectedVersion: null },
          review: {
            required: true,
            priority: "urgent",
            category: "safety",
            reason: "Synthetic urgent safety condition",
          },
          safety: { stopNormalCoaching: true, severity: "urgent" },
        }),
      };
    },
  }, configuration);
  const running = await createContractApp(disposable.pool, identity.mapping, startup);
  t.after(() => running.close());
  await acceptConsent(running);
  const session = (await request(running, "/alpha/goals-coach/session", { method: "POST" })).body;
  await request(running, messagePath(session), {
    method: "POST",
    body: { content: "Start", clientMessageId: crypto.randomUUID() },
  });
  const stateBefore = (await disposable.pool.query(
    "SELECT state_version, current_set FROM goals_coach_workout_sessions"
  )).rows[0];
  const eventsBefore = (await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_state_events"
  )).rows[0].count;

  const review = await request(running, messagePath(session), {
    method: "POST",
    body: { content: "Human review", clientMessageId: crypto.randomUUID() },
  });
  const safety = await request(running, messagePath(session), {
    method: "POST",
    body: { content: "Safety stop", clientMessageId: crypto.randomUUID() },
  });
  assert.equal(review.body.response.structuredResponse.review.required, true);
  assert.equal(review.body.response.structuredResponse.stateTransition.type, "no_change");
  assert.equal(safety.body.response.structuredResponse.mode, "safety_stop");
  assert.equal(safety.body.response.structuredResponse.safety.stopNormalCoaching, true);
  const stateAfter = (await disposable.pool.query(
    "SELECT state_version, current_set FROM goals_coach_workout_sessions"
  )).rows[0];
  const eventsAfter = (await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_state_events"
  )).rows[0].count;
  assert.deepEqual(stateAfter, stateBefore);
  assert.equal(eventsAfter, eventsBefore);
});
