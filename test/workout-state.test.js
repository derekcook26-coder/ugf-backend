const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { runMigration: runPhase1bMigration } = require("../migrate_004");
const { validateStructuredCoachingOutput } = require("../src/goals-coach/coaching-output");
const { withTransaction } = require("../src/goals-coach/repository");
const { applyWorkoutTransition } = require("../src/goals-coach/workout-state");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");

const validationConfiguration = Object.freeze({
  promptVersion: "GC-PROMPT-1B-1.0",
  structuredOutputVersion: "GC-OUTPUT-1B-1.0",
});

async function createFixture(suffix, exerciseCount = 2) {
  const disposable = await createDisposableDatabase({ phase1a: true });
  await runPhase1bMigration({ pool: disposable.pool });
  const seeded = await seedMemberAndPlan(disposable.pool, suffix);
  const conversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  const exercises = [];
  if (exerciseCount >= 1) {
    exercises.push((await disposable.pool.query(
      `INSERT INTO coach_plan_exercises
        (plan_id, plan_item_key, workout_label, sequence_number, exercise_name,
         prescription_json, intent_source, intent_validation_status)
       VALUES ($1, 'synthetic-walk', 'Full Body', 1, 'Comfortable walking',
         '{"sets":2,"durationSeconds":300}'::jsonb, 'staff_review', 'validated')
       RETURNING *`,
      [seeded.plan.id]
    )).rows[0]);
  }
  if (exerciseCount >= 2) {
    exercises.push((await disposable.pool.query(
      `INSERT INTO coach_plan_exercises
        (plan_id, plan_item_key, workout_label, sequence_number, exercise_name,
         prescription_json, intent_source, intent_validation_status)
       VALUES ($1, 'synthetic-squat', 'Full Body', 2, 'Goblet squat',
         '{"sets":1,"repetitions":"8"}'::jsonb, 'staff_review', 'validated')
       RETURNING *`,
      [seeded.plan.id]
    )).rows[0]);
  }
  const coachingContext = {
    date: "2026-07-17",
    plan: {
      id: String(seeded.plan.id),
      exercises: exercises.map((row) => ({
        id: String(row.id),
        key: row.plan_item_key,
        name: row.exercise_name,
        prescription: row.prescription_json || {},
      })),
    },
    workoutSession: null,
  };
  return { disposable, seeded, conversation, exercises, coachingContext };
}

async function addMemberMessage(fixture, content) {
  return (await fixture.disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', $3) RETURNING *`,
    [fixture.conversation.id, fixture.seeded.member.id, content]
  )).rows[0];
}

function transitionInput(fixture, message, type, expectedVersion = null, changes = {}) {
  return {
    memberId: String(fixture.seeded.member.id),
    conversationId: String(fixture.conversation.id),
    planId: String(fixture.seeded.plan.id),
    coachingContext: fixture.coachingContext,
    memberMessageId: String(message.id),
    idempotencyKey: crypto.randomUUID(),
    output: {
      stateTransition: { type, expectedVersion, changes },
    },
  };
}

async function apply(fixture, input) {
  return withTransaction(
    fixture.disposable.pool,
    (client) => applyWorkoutTransition(client, input)
  );
}

function completeStructuredOutput(overrides = {}) {
  const base = {
    reply: "Start with one synthetic step.",
    mode: "start_today",
    nextAction: { type: "warmup", label: "Comfortable walking", target: "5 minutes" },
    conversationState: { workoutActive: true, awaitingMemberCompletion: true },
    stateTransition: { type: "start_session", expectedVersion: null, changes: {} },
    review: { required: false, priority: null, category: null, reason: null },
    safety: { stopNormalCoaching: false, severity: "none" },
    uncertainty: { missingContext: false, reason: null },
    promptVersion: validationConfiguration.promptVersion,
    schemaVersion: validationConfiguration.structuredOutputVersion,
  };
  return {
    ...base,
    ...overrides,
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
  };
}

test("session start is idempotent and records one authoritative provenance event", async (t) => {
  const fixture = await createFixture("start-idempotent", 1);
  t.after(() => fixture.disposable.close());
  const message = await addMemberMessage(fixture, "Where do I start today?");
  const input = transitionInput(fixture, message, "start_session");
  const first = await apply(fixture, input);
  const replay = await apply(fixture, input);

  assert.equal(String(replay.id), String(first.id));
  assert.equal(first.current_exercise_key, "synthetic-walk");
  assert.equal(first.current_set, 1);
  assert.equal(Number(first.state_version), 1);
  assert.equal((await fixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_sessions"
  )).rows[0].count, 1);
  const events = await fixture.disposable.pool.query(
    `SELECT event_type, previous_state_version, resulting_state_version,
            triggering_message_id, actor_type, idempotency_key,
            previous_state_json, resulting_state_json
     FROM goals_coach_workout_state_events`
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0].event_type, "session_started");
  assert.equal(events.rows[0].previous_state_version, null);
  assert.equal(Number(events.rows[0].resulting_state_version), 1);
  assert.equal(String(events.rows[0].triggering_message_id), String(message.id));
  assert.equal(events.rows[0].actor_type, "goals_coach");
  assert.equal(events.rows[0].idempotency_key, input.idempotencyKey);
  assert.deepEqual(events.rows[0].previous_state_json, {});
  assert.equal(events.rows[0].resulting_state_json.currentExerciseKey, "synthetic-walk");
});

test("valid lifecycle advances sets and exercises exactly once before completion", async (t) => {
  const fixture = await createFixture("lifecycle");
  t.after(() => fixture.disposable.close());
  const startMessage = await addMemberMessage(fixture, "Start");
  let session = await apply(fixture, transitionInput(fixture, startMessage, "start_session"));
  assert.equal(session.current_set, 1);

  const setDone = await addMemberMessage(fixture, "Done with set one");
  session = await apply(fixture, transitionInput(fixture, setDone, "advance", 1));
  assert.equal(session.current_exercise_key, "synthetic-walk");
  assert.equal(session.current_set, 2);
  assert.equal(Number(session.state_version), 2);

  const exerciseDone = await addMemberMessage(fixture, "Done walking");
  session = await apply(fixture, transitionInput(fixture, exerciseDone, "advance", 2));
  assert.equal(session.current_exercise_key, "synthetic-squat");
  assert.equal(session.current_set, 1);
  assert.equal(Number(session.state_version), 3);
  assert.deepEqual(session.completed_exercises_json, ["synthetic-walk"]);

  const finalDone = await addMemberMessage(fixture, "Done with the workout");
  session = await apply(fixture, transitionInput(fixture, finalDone, "complete", 3));
  assert.equal(session.status, "completed");
  assert.equal(Number(session.state_version), 4);
  assert.ok(session.completed_at);
  assert.deepEqual(session.completed_exercises_json, ["synthetic-walk", "synthetic-squat"]);

  const events = await fixture.disposable.pool.query(
    `SELECT event_type, resulting_state_version
     FROM goals_coach_workout_state_events ORDER BY id`
  );
  assert.deepEqual(
    events.rows.map((row) => [row.event_type, Number(row.resulting_state_version)]),
    [
      ["session_started", 1],
      ["step_advanced", 2],
      ["step_advanced", 3],
      ["session_completed", 4],
    ]
  );
});

test("stale and expanding modifications fail closed without changing state", async (t) => {
  const fixture = await createFixture("invalid-transition", 1);
  t.after(() => fixture.disposable.close());
  const startMessage = await addMemberMessage(fixture, "Start");
  await apply(fixture, transitionInput(fixture, startMessage, "start_session"));

  const staleMessage = await addMemberMessage(fixture, "Stale Done");
  await assert.rejects(
    apply(fixture, transitionInput(fixture, staleMessage, "advance", 99)),
    (error) => error.code === "WORKOUT_STATE_CHANGED" && error.statusCode === 409
  );
  const expandingMessage = await addMemberMessage(fixture, "Add more sets");
  await assert.rejects(
    apply(fixture, transitionInput(
      fixture,
      expandingMessage,
      "modify",
      1,
      { targetSets: 3 }
    )),
    (error) => error.code === "WORKOUT_MODIFICATION_EXPANDS_SESSION"
  );

  const state = (await fixture.disposable.pool.query(
    "SELECT current_set, target_sets, state_version FROM goals_coach_workout_sessions"
  )).rows[0];
  assert.equal(state.current_set, 1);
  assert.equal(state.target_sets, 2);
  assert.equal(Number(state.state_version), 1);
  assert.equal((await fixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_state_events"
  )).rows[0].count, 1);
});

test("member and conversation ownership prevent cross-member state access", async (t) => {
  const fixture = await createFixture("ownership", 1);
  t.after(() => fixture.disposable.close());
  const startMessage = await addMemberMessage(fixture, "Start");
  await apply(fixture, transitionInput(fixture, startMessage, "start_session"));

  const other = await seedMemberAndPlan(fixture.disposable.pool, "ownership-other");
  const otherConversation = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [other.member.id, other.plan.id]
  )).rows[0];
  const otherMessage = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Synthetic cross-member attempt') RETURNING *`,
    [otherConversation.id, other.member.id]
  )).rows[0];
  const unauthorized = {
    ...transitionInput(fixture, otherMessage, "advance", 1),
    memberId: String(other.member.id),
  };
  await assert.rejects(
    apply(fixture, unauthorized),
    (error) => error.code === "WORKOUT_SESSION_NOT_ACTIVE" && error.statusCode === 409
  );
  assert.equal((await fixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_sessions WHERE member_id = $1",
    [other.member.id]
  )).rows[0].count, 0);
  const ownerState = (await fixture.disposable.pool.query(
    "SELECT state_version FROM goals_coach_workout_sessions WHERE member_id = $1",
    [fixture.seeded.member.id]
  )).rows[0];
  assert.equal(Number(ownerState.state_version), 1);
});

test("review-required output and incomplete plans cannot create workout state", async (t) => {
  const reviewFixture = await createFixture("review-block", 1);
  t.after(() => reviewFixture.disposable.close());
  const reviewOutput = completeStructuredOutput({
    review: {
      required: true,
      priority: "routine",
      category: "plan_change",
      reason: "Synthetic review required",
    },
  });
  assert.throws(
    () => validateStructuredCoachingOutput(reviewOutput, validationConfiguration),
    (error) => error.failureCategory === "invalid_structured_output"
  );
  assert.equal((await reviewFixture.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_sessions"
  )).rows[0].count, 0);

  const incomplete = await createFixture("unknown-workout", 0);
  t.after(() => incomplete.disposable.close());
  const unknownMessage = await addMemberMessage(incomplete, "Where do I start?");
  const noChange = await apply(
    incomplete,
    transitionInput(incomplete, unknownMessage, "no_change")
  );
  assert.equal(noChange, null);
  const notStarted = await apply(
    incomplete,
    transitionInput(incomplete, unknownMessage, "start_session")
  );
  assert.equal(notStarted, null);
  assert.equal((await incomplete.disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_workout_state_events"
  )).rows[0].count, 0);
});

test("Migration 004 preserves linked turn and append-only state provenance", async (t) => {
  const fixture = await createFixture("provenance", 1);
  t.after(() => fixture.disposable.close());
  const memberMessage = await addMemberMessage(fixture, "Start with provenance");
  const startInput = transitionInput(fixture, memberMessage, "start_session");
  const session = await apply(fixture, startInput);

  const turn = (await fixture.disposable.pool.query(
    `INSERT INTO goals_coach_coaching_turns
      (member_id, conversation_id, plan_id, workout_session_id,
       member_message_id, provider_identifier, model_identifier,
       prompt_version, structured_output_version, safety_rule_version,
       request_id, attempt_number, input_method, context_digest)
     VALUES ($1, $2, $3, $4, $5, 'synthetic-provider', 'synthetic-model',
       'GC-PROMPT-1B-1.0', 'GC-OUTPUT-1B-1.0', 'GC-SAFETY-PLACEHOLDER-1B',
       $6, 1, 'text', $7)
     RETURNING *`,
    [
      fixture.seeded.member.id,
      fixture.conversation.id,
      fixture.seeded.plan.id,
      session.id,
      memberMessage.id,
      crypto.randomUUID(),
      "a".repeat(64),
    ]
  )).rows[0];
  const coachMessage = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_messages
      (conversation_id, member_id, sender_type, content, structured_response_json)
     VALUES ($1, $2, 'goals_coach', 'Synthetic validated response', $3)
     RETURNING *`,
    [fixture.conversation.id, fixture.seeded.member.id, completeStructuredOutput()]
  )).rows[0];
  await fixture.disposable.pool.query(
    `UPDATE goals_coach_coaching_turns
     SET coach_message_id = $1,
         coach_message_sender_type = 'goals_coach',
         provider_status = 'completed',
         structured_output_json = $2,
         proposed_state_transition_json = $3,
         provider_completed_at = NOW()
     WHERE id = $4`,
    [
      coachMessage.id,
      completeStructuredOutput(),
      { type: "start_session", expectedVersion: null, changes: {} },
      turn.id,
    ]
  );
  const preserved = (await fixture.disposable.pool.query(
    `SELECT member_message_id, coach_message_id, workout_session_id,
            provider_status, model_identifier, prompt_version,
            structured_output_version, safety_rule_version, context_digest
     FROM goals_coach_coaching_turns WHERE id = $1`,
    [turn.id]
  )).rows[0];
  assert.equal(String(preserved.member_message_id), String(memberMessage.id));
  assert.equal(String(preserved.coach_message_id), String(coachMessage.id));
  assert.equal(String(preserved.workout_session_id), String(session.id));
  assert.equal(preserved.provider_status, "completed");
  assert.equal(preserved.context_digest, "a".repeat(64));

  await assert.rejects(
    fixture.disposable.pool.query(
      "UPDATE goals_coach_coaching_turns SET failure_category = 'changed' WHERE id = $1",
      [turn.id]
    ),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_coaching_turns_final_immutable"
  );
  await assert.rejects(
    fixture.disposable.pool.query(
      "UPDATE goals_coach_workout_state_events SET actor_type = 'system' WHERE workout_session_id = $1",
      [session.id]
    ),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_workout_state_events_append_only"
  );
});
