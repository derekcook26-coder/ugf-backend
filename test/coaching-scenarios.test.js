const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { APPROVED_ALPHA_CONSENT_VERSION } = require("../src/goals-coach/alpha-config");
const { createPhase1bCoachingService } = require("../src/goals-coach/phase1b-service");
const { createPhase1bStartup } = require("../src/goals-coach/phase1b-startup");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");

const applicationConfiguration = Object.freeze({
  valid: true,
  consentVersion: APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnvironment: "test",
});

function coachingConfiguration(overrides = {}) {
  return Object.freeze({
    aiEnabled: true,
    generationReady: true,
    providerIdentifier: "synthetic-scenario-provider",
    modelIdentifier: "synthetic-scenario-model",
    promptVersion: "GC-PROMPT-1B-1.0",
    structuredOutputVersion: "GC-OUTPUT-1B-1.0",
    safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B",
    providerTimeoutMs: 100,
    ...overrides,
  });
}

function output(configuration, overrides = {}) {
  const base = {
    reply: "Take one clear synthetic coaching step.",
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

async function createScenario(t, suffix, providerFactory, options = {}) {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, suffix);
  await disposable.pool.query(
    "UPDATE coach_plans SET profile_json = $1, plan_markdown = $2 WHERE id = $3",
    [
      options.profile || {
        primaryGoal: "Build a consistent synthetic training habit",
        timeZone: "America/Denver",
        equipment: ["dumbbell"],
      },
      "Synthetic approved two-exercise workout",
      seeded.plan.id,
    ]
  );
  if (options.exercises !== false) {
    await disposable.pool.query(
      `INSERT INTO coach_plan_exercises
        (plan_id, plan_item_key, workout_label, sequence_number, exercise_name,
         prescription_json, intent_source, intent_validation_status)
       VALUES
        ($1, 'scenario-walk', 'Full Body', 1, 'Comfortable walking',
         '{"sets":2,"durationSeconds":300}'::jsonb, 'staff_review', 'validated'),
        ($1, 'scenario-squat', 'Full Body', 2, 'Goblet squat',
         '{"sets":1,"repetitions":"8"}'::jsonb, 'staff_review', 'validated')`,
      [seeded.plan.id]
    );
  }
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, suffix, true);
  await disposable.pool.query(
    `INSERT INTO goals_coach_alpha_consents
      (member_id, auth_mapping_id, consent_version, environment, status, accepted_at)
     VALUES ($1, $2, $3, 'test', 'accepted', NOW())`,
    [seeded.member.id, mapping.id, APPROVED_ALPHA_CONSENT_VERSION]
  );
  const conversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  const configuration = coachingConfiguration(options.configuration);
  const provider = providerFactory(configuration);
  const startup = createPhase1bStartup({ configuration, provider });
  assert.equal(startup.status, "ready");
  const service = createPhase1bCoachingService({
    db: disposable.pool,
    engine: startup.engine,
    applicationConfiguration,
    pendingPollIntervalMs: 2,
    pendingWaitTimeoutMs: 500,
  });
  return {
    disposable,
    seeded,
    conversation,
    configuration,
    provider,
    service,
    member: {
      mappingId: String(mapping.id),
      memberId: String(seeded.member.id),
      authProvider: mapping.auth_provider,
      authSubject: mapping.auth_subject,
    },
  };
}

function send(scenario, content, clientMessageId = crypto.randomUUID()) {
  return scenario.service.sendMessage(
    scenario.member,
    String(scenario.conversation.id),
    { content, clientMessageId }
  );
}

test("realistic coaching progression preserves state, provenance, and idempotency", async (t) => {
  let providerCalls = 0;
  const scenario = await createScenario(t, "scenario-progression", (configuration) => ({
    async generate(input) {
      providerCalls += 1;
      const session = input.context.workoutSession;
      if (!session) {
        return { output: output(configuration, { reply: "Start with comfortable walking." }) };
      }
      if (input.memberMessage === "Workout complete") {
        return {
          output: output(configuration, {
            reply: "Workout complete. Nice work today.",
            mode: "workout_step",
            nextAction: { type: "recovery", label: "Recover", target: null },
            conversationState: { workoutActive: false, awaitingMemberCompletion: false },
            stateTransition: { type: "complete", expectedVersion: session.stateVersion },
          }),
        };
      }
      return {
        output: output(configuration, {
          reply: "Good. Move to the next approved step.",
          mode: "workout_step",
          nextAction: { type: "exercise", label: "Next approved step", target: null },
          stateTransition: { type: "advance", expectedVersion: session.stateVersion },
        }),
      };
    },
  }));

  const firstId = crypto.randomUUID();
  const started = await send(scenario, "Where do I start today?", firstId);
  const replay = await send(scenario, "Where do I start today?", firstId);
  assert.equal(started.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.response.id, started.response.id);
  assert.equal(started.workoutState.currentExerciseKey, "scenario-walk");
  assert.equal(started.workoutState.stateVersion, 1);

  const secondSet = await send(scenario, "Done with the first walking set");
  assert.equal(secondSet.workoutState.currentExerciseKey, "scenario-walk");
  assert.equal(secondSet.workoutState.currentSet, 2);
  assert.equal(secondSet.workoutState.stateVersion, 2);

  const squat = await send(scenario, "Done walking");
  assert.equal(squat.workoutState.currentExerciseKey, "scenario-squat");
  assert.equal(squat.workoutState.stateVersion, 3);

  const completed = await send(scenario, "Workout complete");
  assert.equal(completed.workoutState.status, "completed");
  assert.equal(completed.workoutState.stateVersion, 4);
  assert.equal(providerCalls, 4);

  const counts = (await scenario.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages) AS messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events`
  )).rows[0];
  assert.deepEqual(counts, { messages: 8, turns: 4, sessions: 1, events: 4 });
});

test("unknown and incomplete coaching inputs remain explicit without invented workout state", async (t) => {
  let capturedContext;
  const scenario = await createScenario(t, "scenario-unknown", (configuration) => ({
    async generate(input) {
      capturedContext = input.context;
      return {
        output: output(configuration, {
          reply: "I do not have a validated workout step yet. Please request plan review.",
          mode: "start_today",
          nextAction: { type: "request_information", label: "Request plan review", target: null },
          conversationState: { workoutActive: false, awaitingMemberCompletion: false },
          stateTransition: { type: "request_information", expectedVersion: null },
          uncertainty: {
            missingContext: true,
            reason: "No validated plan exercises are available",
          },
        }),
      };
    },
  }), { exercises: false, profile: {} });

  const result = await send(scenario, "Where do I start today?");
  assert.equal(capturedContext.member.primaryGoal, null);
  assert.deepEqual(capturedContext.plan.exercises, []);
  assert.equal(capturedContext.workoutSession, null);
  assert.equal(result.response.structuredResponse.uncertainty.missingContext, true);
  assert.equal(result.response.structuredResponse.stateTransition.type, "request_information");
  assert.equal(result.workoutState, null);
  assert.equal((await scenario.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_sessions"
  )).rows[0].count, 0);
});

test("human-review and urgent-safety scenarios stop state mutation", async (t) => {
  const scenario = await createScenario(t, "scenario-review-safety", (configuration) => ({
    async generate(input) {
      if (input.memberMessage === "I want a human") {
        return {
          output: output(configuration, {
            reply: "I will preserve this as a request for human review.",
            mode: "human_review",
            nextAction: null,
            conversationState: { workoutActive: false, awaitingMemberCompletion: false },
            stateTransition: { type: "no_change", expectedVersion: null },
            review: {
              required: true,
              priority: "routine",
              category: "member_request",
              reason: "Member requested human review",
            },
          }),
        };
      }
      return {
        output: output(configuration, {
          reply: "Stop exercising now and seek immediate emergency help.",
          mode: "safety_stop",
          nextAction: { type: "emergency", label: "Stop and seek help", target: null },
          conversationState: { workoutActive: false, awaitingMemberCompletion: false },
          stateTransition: { type: "no_change", expectedVersion: null },
          review: {
            required: true,
            priority: "urgent",
            category: "safety",
            reason: "Synthetic urgent safety scenario",
          },
          safety: { stopNormalCoaching: true, severity: "urgent" },
        }),
      };
    },
  }));

  const review = await send(scenario, "I want a human");
  const safety = await send(scenario, "Synthetic chest pain during exercise");
  assert.equal(review.response.structuredResponse.review.required, true);
  assert.equal(safety.response.structuredResponse.mode, "safety_stop");
  assert.equal(safety.response.structuredResponse.safety.stopNormalCoaching, true);
  assert.equal((await scenario.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_sessions"
  )).rows[0].count, 0);
  assert.equal((await scenario.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_state_events"
  )).rows[0].count, 0);
});

test("scenario-level malformed output and timeout remain terminal and fail closed", async (t) => {
  const scenario = await createScenario(t, "scenario-provider-failure", () => ({
    async generate(input) {
      if (input.memberMessage === "Timeout scenario") return new Promise(() => {});
      return { unexpected: true };
    },
  }), { configuration: { providerTimeoutMs: 20 } });

  await assert.rejects(
    send(scenario, "Timeout scenario"),
    (error) => error.code === "COACHING_TEMPORARILY_UNAVAILABLE"
      && error.failureCategory === "provider_timeout"
  );
  await assert.rejects(
    send(scenario, "Malformed scenario"),
    (error) => error.code === "COACHING_TEMPORARILY_UNAVAILABLE"
      && error.failureCategory === "malformed_provider_response"
  );
  const counts = (await scenario.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'member') AS member_messages,
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'goals_coach') AS coach_messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns WHERE provider_status = 'failed') AS failed,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS sessions`
  )).rows[0];
  assert.deepEqual(counts, { member_messages: 2, coach_messages: 0, failed: 2, sessions: 0 });
});
