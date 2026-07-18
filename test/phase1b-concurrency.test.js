const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { APPROVED_ALPHA_CONSENT_VERSION } = require("../src/goals-coach/alpha-config");
const { createCoachingEngine } = require("../src/goals-coach/coaching-engine");
const { createPhase1bCoachingService } = require("../src/goals-coach/phase1b-service");
const {
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "embedded PostgreSQL refuses to run as root; run this suite as an unprivileged user"
  : false;

const applicationConfiguration = Object.freeze({
  valid: true,
  consentVersion: APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnvironment: "test",
});

const coachingConfiguration = Object.freeze({
  aiEnabled: true,
  generationReady: true,
  providerIdentifier: "synthetic-concurrency-provider",
  modelIdentifier: "synthetic-concurrency-model",
  promptVersion: "GC-PROMPT-1B-1.0",
  structuredOutputVersion: "GC-OUTPUT-1B-1.0",
  safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B",
  providerTimeoutMs: 1000,
});

function output() {
  return {
    reply: "Start with five minutes of comfortable walking.",
    mode: "start_today",
    nextAction: { type: "warmup", label: "Comfortable walking", target: "5 minutes" },
    conversationState: { workoutActive: true, awaitingMemberCompletion: true },
    stateTransition: { type: "start_session", expectedVersion: null, changes: {} },
    review: { required: false, priority: null, category: null, reason: null },
    safety: { stopNormalCoaching: false, severity: "none" },
    uncertainty: { missingContext: false, reason: null },
    promptVersion: coachingConfiguration.promptVersion,
    schemaVersion: coachingConfiguration.structuredOutputVersion,
  };
}

async function seedFixture(pool) {
  const seeded = await seedMemberAndPlan(pool, "phase1b-real-concurrency");
  await pool.query(
    `INSERT INTO coach_plan_exercises
      (plan_id, plan_item_key, workout_label, sequence_number, exercise_name,
       prescription_json, intent_source, intent_validation_status)
     VALUES ($1, 'synthetic-concurrent-walk', 'Full Body', 1, 'Comfortable walking',
       '{"sets":2,"durationSeconds":300}'::jsonb, 'staff_review', 'validated')`,
    [seeded.plan.id]
  );
  const mapping = await seedAlphaMapping(pool, seeded.member, "phase1b-real-concurrency", true);
  await pool.query(
    `INSERT INTO goals_coach_alpha_consents
      (member_id, auth_mapping_id, consent_version, environment, status, accepted_at)
     VALUES ($1, $2, $3, 'test', 'accepted', NOW())`,
    [seeded.member.id, mapping.id, APPROVED_ALPHA_CONSENT_VERSION]
  );
  const conversation = (await pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  const member = {
    mappingId: String(mapping.id),
    memberId: String(seeded.member.id),
    authProvider: mapping.auth_provider,
    authSubject: mapping.auth_subject,
  };
  return { seeded, mapping, conversation, member };
}

test("concurrent duplicate Phase 1B requests share one provider call and one logical turn", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  const version = await disposable.pool.query("SHOW server_version");
  assert.match(version.rows[0].server_version, /^16\./);
  const fixture = await seedFixture(disposable.pool);

  let releaseProvider;
  let enteredProvider;
  const providerEntered = new Promise((resolve) => { enteredProvider = resolve; });
  const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
  let providerCalls = 0;
  const engine = createCoachingEngine({
    configuration: coachingConfiguration,
    provider: {
      async generate() {
        providerCalls += 1;
        enteredProvider();
        await providerReleased;
        return { output: output() };
      },
    },
  });
  const service = createPhase1bCoachingService({
    db: disposable.pool,
    engine,
    applicationConfiguration,
    pendingPollIntervalMs: 5,
    pendingWaitTimeoutMs: 1500,
  });
  const input = {
    content: "Where do I start today?",
    clientMessageId: crypto.randomUUID(),
  };

  const firstPromise = service.sendMessage(fixture.member, fixture.conversation.id, input);
  await providerEntered;
  const secondPromise = service.sendMessage(fixture.member, fixture.conversation.id, input);
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseProvider();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(providerCalls, 1);
  assert.equal(first.memberMessageId, second.memberMessageId);
  assert.equal(first.response.id, second.response.id);
  assert.deepEqual([first.idempotentReplay, second.idempotentReplay].sort(), [false, true]);
  const counts = (await disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'member') AS member_messages,
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'goals_coach') AS coach_messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions WHERE status = 'active') AS active_sessions,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS events`
  )).rows[0];
  assert.deepEqual(counts, {
    member_messages: 1,
    coach_messages: 1,
    turns: 1,
    active_sessions: 1,
    events: 1,
  });
  const event = (await disposable.pool.query(
    `SELECT idempotency_key, triggering_message_id, resulting_state_version
     FROM goals_coach_workout_state_events`
  )).rows[0];
  assert.equal(event.idempotency_key, input.clientMessageId);
  assert.equal(String(event.triggering_message_id), first.memberMessageId);
  assert.equal(Number(event.resulting_state_version), 1);
});
