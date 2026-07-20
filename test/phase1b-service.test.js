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
const { loadCoachingConfiguration } = require("../src/goals-coach/coaching-config");
const { createCoachingEngine } = require("../src/goals-coach/coaching-engine");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");

const testOrigin = "https://phase1b.example.test";
const applicationConfiguration = Object.freeze({
  valid: true,
  consentVersion: APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnvironment: "test",
});

function readyConfiguration(overrides = {}) {
  return Object.freeze({
    aiEnabled: true,
    generationReady: true,
    providerIdentifier: "synthetic-phase1b-provider",
    modelIdentifier: "synthetic-phase1b-model",
    promptVersion: "GC-PROMPT-1B-1.0",
    structuredOutputVersion: "GC-OUTPUT-1B-1.0",
    safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B",
    providerTimeoutMs: 50,
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

async function seedExercise(pool, planId, suffix = "walk") {
  return (await pool.query(
    `INSERT INTO coach_plan_exercises
      (plan_id, plan_item_key, workout_label, sequence_number, exercise_name,
       prescription_json, intent_source, intent_validation_status)
     VALUES ($1, $2, 'Full Body', 1, 'Comfortable walking',
       '{"sets":2,"durationSeconds":300}'::jsonb, 'staff_review', 'validated')
     RETURNING *`,
    [planId, `synthetic-${suffix}`]
  )).rows[0];
}

async function createPhase1bApp(pool, mapping, provider, configuration = readyConfiguration()) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/alpha/goals-coach", createAlphaOriginGuard({ authorizedParties: [testOrigin] }));
  const authorization = createAlphaMemberAuthorization({
    db: pool,
    applicationConfiguration,
  });
  const engine = createCoachingEngine({ configuration, provider });
  app.use(
    "/alpha/goals-coach",
    createAlphaFeatureGate({ enabled: true }),
    (req, res, next) => {
      req.alphaMemberIdentity = {
        authProvider: "clerk",
        authSubject: mapping.auth_subject,
        sessionId: "synthetic-phase1b-session",
      };
      next();
    },
    authorization.loadActiveAlphaMember,
    createAlphaGoalsCoachRouter({
      db: pool,
      applicationConfiguration,
      requireCurrentConsent: authorization.requireCurrentAlphaConsent,
      coachingEngine: engine,
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

async function createFixture(t, suffix, providerFactory, configuration = readyConfiguration()) {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, suffix);
  await disposable.pool.query(
    "UPDATE coach_plans SET profile_json = $1 WHERE id = $2",
    [{ primaryGoal: "Synthetic consistency", timeZone: "America/Denver" }, seeded.plan.id]
  );
  await seedExercise(disposable.pool, seeded.plan.id, suffix);
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, suffix, true);
  const provider = providerFactory(configuration);
  const running = await createPhase1bApp(disposable.pool, mapping, provider, configuration);
  t.after(() => running.close());
  const consent = await request(running, "/alpha/goals-coach/consent", {
    method: "POST",
    body: { action: "accept" },
  });
  assert.equal(consent.response.status, 200);
  const session = await request(running, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(session.response.status, 200);
  return { disposable, seeded, mapping, provider, running, session: session.body };
}

function messagePath(fixture, conversationId = fixture.session.conversation.id) {
  return `/alpha/goals-coach/conversations/${conversationId}/messages`;
}

test("Phase 1B route returns validated structured output and replays one logical turn", async (t) => {
  let providerCalls = 0;
  const fixture = await createFixture(t, "phase1b-route", (configuration) => ({
    async generate() {
      providerCalls += 1;
      return { output: structuredOutput(configuration), providerReference: "synthetic-result" };
    },
  }));
  const other = await seedMemberAndPlan(fixture.disposable.pool, "phase1b-route-other");
  const otherConversation = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [other.member.id, other.plan.id]
  )).rows[0];

  const clientMessageId = crypto.randomUUID();
  const rejected = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: "Where do I start today?",
      clientMessageId,
      memberId: other.member.id,
      planId: other.plan.id,
      workoutStateId: "999999",
    },
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.error, "INVALID_REQUEST");
  assert.deepEqual((await fixture.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE member_id = $1) AS messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns WHERE member_id = $1) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions WHERE member_id = $1) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events WHERE member_id = $1) AS events`,
    [fixture.seeded.member.id]
  )).rows[0], { messages: 0, turns: 0, sessions: 0, events: 0 });
  assert.equal(providerCalls, 0);

  const body = {
    content: "Where do I start today?",
    clientMessageId,
  };
  const first = await request(fixture.running, messagePath(fixture), { method: "POST", body });
  const replay = await request(fixture.running, messagePath(fixture), { method: "POST", body });

  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 201);
  assert.equal(first.body.idempotentReplay, false);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.memberMessageId, first.body.memberMessageId);
  assert.equal(replay.body.response.id, first.body.response.id);
  assert.deepEqual(replay.body.response.structuredResponse, first.body.response.structuredResponse);
  assert.equal(first.body.response.structuredResponse.mode, "start_today");
  assert.equal(first.body.response.structuredResponse.schemaVersion, "GC-OUTPUT-1B-1.0");
  assert.equal(first.body.workoutState.planId, String(fixture.seeded.plan.id));
  assert.equal(providerCalls, 1);

  const history = await request(fixture.running, messagePath(fixture));
  assert.equal(history.response.status, 200);
  assert.equal(history.body.messages.length, 2);
  const storedCoachMessage = history.body.messages.find(
    (message) => message.senderType === "goals_coach"
  );
  assert.equal(storedCoachMessage.structuredResponse.mode, "start_today");

  const concealed = await request(
    fixture.running,
    messagePath(fixture, otherConversation.id),
    { method: "POST", body: { ...body, clientMessageId: crypto.randomUUID() } }
  );
  assert.equal(concealed.response.status, 404);
  assert.equal(concealed.body.error, "CONVERSATION_NOT_FOUND");

  const counts = await fixture.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE member_id = $1) AS messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns WHERE member_id = $1) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions WHERE member_id = $1) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events WHERE member_id = $1) AS events`,
    [fixture.seeded.member.id]
  );
  assert.deepEqual(counts.rows[0], { messages: 2, turns: 1, sessions: 1, events: 1 });
  assert.equal((await fixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_sessions WHERE member_id = $1",
    [other.member.id]
  )).rows[0].count, 0);
});

test("concurrent duplicate requests share one pending attempt in a disposable database", async (t) => {
  let providerCalls = 0;
  let releaseProvider;
  let enteredProvider;
  const providerEntered = new Promise((resolve) => { enteredProvider = resolve; });
  const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
  const fixture = await createFixture(t, "phase1b-disposable-concurrency", (configuration) => ({
    async generate() {
      providerCalls += 1;
      enteredProvider();
      await providerReleased;
      return { output: structuredOutput(configuration) };
    },
  }));
  const body = {
    content: "One concurrent coaching turn",
    clientMessageId: crypto.randomUUID(),
  };
  const firstPromise = request(fixture.running, messagePath(fixture), { method: "POST", body });
  await providerEntered;
  const secondPromise = request(fixture.running, messagePath(fixture), { method: "POST", body });
  await new Promise((resolve) => setTimeout(resolve, 25));
  releaseProvider();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.equal(providerCalls, 1);
  assert.equal(first.body.memberMessageId, second.body.memberMessageId);
  assert.equal(first.body.response.id, second.body.response.id);
  assert.deepEqual(
    [first.body.idempotentReplay, second.body.idempotentReplay].sort(),
    [false, true]
  );
  const counts = (await fixture.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'member') AS member_messages,
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'goals_coach') AS coach_messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events`
  )).rows[0];
  assert.deepEqual(counts, {
    member_messages: 1,
    coach_messages: 1,
    turns: 1,
    sessions: 1,
    events: 1,
  });
});

test("repeated start-session outputs preserve one workout state and one start event", async (t) => {
  const fixture = await createFixture(t, "phase1b-repeat-start", (configuration) => ({
    async generate() {
      return { output: structuredOutput(configuration) };
    },
  }));
  for (const content of ["Start my workout", "Start again"] ) {
    const result = await request(fixture.running, messagePath(fixture), {
      method: "POST",
      body: { content, clientMessageId: crypto.randomUUID() },
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.workoutState.stateVersion, 1);
  }
  assert.equal((await fixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_sessions"
  )).rows[0].count, 1);
  assert.equal((await fixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_state_events"
  )).rows[0].count, 1);
  assert.equal((await fixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns WHERE provider_status = 'completed'"
  )).rows[0].count, 2);
});

test("stale transitions fail closed and review-required output cannot mutate workout state", async (t) => {
  const fixture = await createFixture(t, "phase1b-stale-review", (configuration) => ({
    async generate(input) {
      if (input.memberMessage === "Start") return { output: structuredOutput(configuration) };
      if (input.memberMessage === "Stale Done") {
        return {
          output: structuredOutput(configuration, {
            mode: "workout_step",
            stateTransition: { type: "advance", expectedVersion: 99 },
          }),
        };
      }
      return {
        output: structuredOutput(configuration, {
          mode: "human_review",
          nextAction: null,
          stateTransition: { type: "no_change", expectedVersion: null },
          review: {
            required: true,
            priority: "routine",
            category: "member_request",
            reason: "Synthetic human review request",
          },
        }),
      };
    },
  }));
  const start = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Start", clientMessageId: crypto.randomUUID() },
  });
  assert.equal(start.response.status, 201);

  const stale = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Stale Done", clientMessageId: crypto.randomUUID() },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error, "WORKOUT_STATE_CHANGED");

  const review = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Send this to a person", clientMessageId: crypto.randomUUID() },
  });
  assert.equal(review.response.status, 201);
  assert.equal(review.body.response.structuredResponse.review.required, true);
  assert.equal(review.body.response.structuredResponse.stateTransition.type, "no_change");

  const state = (await fixture.disposable.pool.query(
    "SELECT state_version, current_set FROM goals_coach_workout_sessions"
  )).rows[0];
  assert.equal(Number(state.state_version), 1);
  assert.equal(state.current_set, 1);
  assert.equal((await fixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_state_events"
  )).rows[0].count, 1);
  const statuses = await fixture.disposable.pool.query(
    `SELECT provider_status, failure_category
     FROM goals_coach_coaching_turns ORDER BY id`
  );
  assert.deepEqual(statuses.rows.map((row) => row.provider_status), ["completed", "failed", "completed"]);
  assert.equal(statuses.rows[1].failure_category, "WORKOUT_STATE_CHANGED");
});

test("provider timeout and malformed results preserve only terminal failure provenance", async (t) => {
  const configuration = readyConfiguration({ providerTimeoutMs: 20 });
  const fixture = await createFixture(t, "phase1b-provider-failure", () => ({
    async generate(input) {
      if (input.memberMessage === "Timeout") return new Promise(() => {});
      return { unexpected: true };
    },
  }), configuration);

  const timeout = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Timeout", clientMessageId: crypto.randomUUID() },
  });
  const malformed = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Malformed", clientMessageId: crypto.randomUUID() },
  });
  for (const result of [timeout, malformed]) {
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error, "COACHING_TEMPORARILY_UNAVAILABLE");
    assert.equal(result.body.messageSaved, true);
    assert.equal(result.body.retrySafe, true);
  }

  const counts = (await fixture.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'member') AS member_messages,
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'goals_coach') AS coach_messages,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns WHERE provider_status = 'pending') AS pending,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns WHERE provider_status = 'failed') AS failed`
  )).rows[0];
  assert.deepEqual(counts, {
    member_messages: 2,
    coach_messages: 0,
    sessions: 0,
    events: 0,
    pending: 0,
    failed: 2,
  });
  const categories = await fixture.disposable.pool.query(
    "SELECT failure_category FROM goals_coach_coaching_turns ORDER BY id"
  );
  assert.deepEqual(
    categories.rows.map((row) => row.failure_category),
    ["provider_timeout", "malformed_provider_response"]
  );
});

test("finalization rollback removes partial state and leaves one terminal failed attempt", async (t) => {
  const fixture = await createFixture(t, "phase1b-rollback", (configuration) => ({
    async generate() {
      return { output: structuredOutput(configuration) };
    },
  }));
  await fixture.disposable.pool.query(`
    CREATE OR REPLACE FUNCTION reject_synthetic_phase1b_coach_message()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.sender_type = 'goals_coach' THEN
        RAISE EXCEPTION 'synthetic finalization failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_reject_synthetic_phase1b_coach_message
    BEFORE INSERT ON coaching_messages
    FOR EACH ROW EXECUTE FUNCTION reject_synthetic_phase1b_coach_message();
  `);

  const failed = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Trigger rollback", clientMessageId: crypto.randomUUID() },
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.error, "GOALS_COACH_ERROR");

  const counts = (await fixture.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'member') AS member_messages,
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'goals_coach') AS coach_messages,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns WHERE provider_status = 'pending') AS pending,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns WHERE provider_status = 'failed') AS failed`
  )).rows[0];
  assert.deepEqual(counts, {
    member_messages: 1,
    coach_messages: 0,
    sessions: 0,
    events: 0,
    pending: 0,
    failed: 1,
  });
});

test("Phase 1B service configuration remains explicitly fail closed", () => {
  const disabled = loadCoachingConfiguration({});
  assert.equal(disabled.aiEnabled, false);
  assert.equal(disabled.generationReady, false);
});
