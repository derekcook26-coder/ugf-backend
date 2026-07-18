const assert = require("node:assert/strict");
const test = require("node:test");
const { createCoachingEngine } = require("../src/goals-coach/coaching-engine");
const { loadCoachingConfiguration } = require("../src/goals-coach/coaching-config");
const {
  buildCoachingContext,
  digestContext,
  extractAvailableMinutes,
  timeZoneDateKey,
} = require("../src/goals-coach/coaching-context");
const { runMigration: runPhase1bMigration } = require("../migrate_004");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
  seedStaff,
} = require("./helpers/disposable-db");

const fixedNow = new Date("2026-07-17T15:00:00.000Z");

async function createFixture(suffix) {
  const disposable = await createDisposableDatabase({ phase1a: true });
  await runPhase1bMigration({ pool: disposable.pool });
  const seeded = await seedMemberAndPlan(disposable.pool, suffix);
  await disposable.pool.query(
    `UPDATE coach_plans
     SET profile_json = $1,
         plan_markdown = $2
     WHERE id = $3`,
    [{
      primaryGoal: "Build a steady synthetic workout habit",
      approvedLimitations: ["Synthetic profile limitation"],
      equipment: ["dumbbells"],
      timeZone: "America/Denver",
      billingSecret: "BILLING-MUST-NOT-ENTER-CONTEXT",
      unrelatedHealthDetail: "UNRELATED-HEALTH-MUST-NOT-ENTER-CONTEXT",
    }, "Synthetic approved full-body plan", seeded.plan.id]
  );
  const staff = await seedStaff(disposable.pool, `context_${suffix}`, "coach", true);
  const conversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id, assigned_staff_user_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [seeded.member.id, seeded.plan.id, staff.id]
  )).rows[0];
  const exercise = (await disposable.pool.query(
    `INSERT INTO coach_plan_exercises
      (plan_id, plan_item_key, workout_label, sequence_number, exercise_name,
       movement_pattern, equipment_json, limitation_considerations_json,
       prescription_json, intent_source, intent_validation_status)
     VALUES ($1, 'warmup-walk', 'Full Body', 1, 'Comfortable walking',
       'locomotion', '[]'::jsonb, '["pain-free range"]'::jsonb,
       '{"sets":2,"durationSeconds":300}'::jsonb, 'staff_review', 'validated')
     RETURNING *`,
    [seeded.plan.id]
  )).rows[0];
  const memberMessage = (await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'I have 20 minutes today') RETURNING *`,
    [conversation.id, seeded.member.id]
  )).rows[0];
  await disposable.pool.query(
    `INSERT INTO coaching_messages
      (conversation_id, member_id, sender_type, sender_staff_user_id, content)
     VALUES ($1, $2, 'staff', $3, 'Use the pain-free walking option first')`,
    [conversation.id, seeded.member.id, staff.id]
  );
  await disposable.pool.query(
    `INSERT INTO weekly_checkins
      (member_id, week_start, responses_json, trainer_summary, status)
     VALUES ($1, '2026-07-13', $2, 'Synthetic staff-approved check-in summary', 'green')`,
    [seeded.member.id, { privateRawResponse: "RAW-CHECKIN-MUST-NOT-ENTER-CONTEXT" }]
  );
  await disposable.pool.query(
    `INSERT INTO coaching_observations
      (member_id, category, observation_text, status, confidence, source_type,
       source_conversation_id, source_staff_user_id)
     VALUES ($1, 'movement_limitation', 'Use a synthetic pain-free range',
       'confirmed', 'staff_confirmed', 'staff', $2, $3)`,
    [seeded.member.id, conversation.id, staff.id]
  );
  await disposable.pool.query(
    `INSERT INTO goals_coach_workout_sessions
      (member_id, conversation_id, plan_id, workout_session_key, workout_day_key,
       current_plan_exercise_id, current_exercise_index, current_exercise_key,
       current_exercise_name, current_set, target_sets, target_duration_seconds)
     VALUES ($1, $2, $3, '2026-07-17:synthetic', '2026-07-17',
       $4, 0, 'warmup-walk', 'Comfortable walking', 1, 2, 300)`,
    [seeded.member.id, conversation.id, seeded.plan.id, exercise.id]
  );

  const concern = (await disposable.pool.query(
    `INSERT INTO coaching_concerns
      (member_id, conversation_id, source_message_id, plan_id, concern_category,
       safety_level, concerning_signals_json, member_description)
     VALUES ($1, $2, $3, $4, 'other', 'routine', '[]'::jsonb, 'Synthetic')
     RETURNING *`,
    [seeded.member.id, conversation.id, memberMessage.id, seeded.plan.id]
  )).rows[0];
  const review = (await disposable.pool.query(
    `INSERT INTO coaching_reviews
      (concern_id, member_id, conversation_id, plan_id, priority, review_category)
     VALUES ($1, $2, $3, $4, 'routine', 'technical_failure')
     RETURNING *`,
    [concern.id, seeded.member.id, conversation.id, seeded.plan.id]
  )).rows[0];
  await disposable.pool.query(
    `INSERT INTO coaching_review_events
      (review_id, member_id, actor_staff_user_id, event_type, event_details_json)
     VALUES ($1, $2, $3, 'created', $4)`,
    [review.id, seeded.member.id, staff.id, { internalNote: "INTERNAL-NOTE-MUST-NOT-ENTER-CONTEXT" }]
  );

  const other = await seedMemberAndPlan(disposable.pool, `${suffix}_other`);
  const otherConversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [other.member.id, other.plan.id]
  )).rows[0];
  await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'OTHER-MEMBER-MUST-NOT-ENTER-CONTEXT')`,
    [otherConversation.id, other.member.id]
  );

  return {
    disposable,
    seeded,
    staff,
    conversation,
    exercise,
    other,
    otherConversation,
  };
}

function memberIdentity(fixture) {
  return { memberId: String(fixture.seeded.member.id) };
}

test("context builder shapes only approved, current, server-resolved coaching context", async (t) => {
  const fixture = await createFixture("shape");
  t.after(() => fixture.disposable.close());
  const built = await buildCoachingContext({
    client: fixture.disposable.pool,
    member: memberIdentity(fixture),
    conversationId: fixture.conversation.id,
    memberMessage: "I have 20 minutes today",
    now: fixedNow,
  });

  assert.deepEqual(built.context.precedence, [
    "safety_restrictions",
    "human_approved_instructions",
    "latest_approved_plan",
    "current_member_statement",
    "recent_checkin_context",
    "older_profile_context",
    "general_coaching_knowledge",
  ]);
  assert.equal(built.context.member.preferredName, fixture.seeded.member.first_name);
  assert.equal(built.context.member.primaryGoal, "Build a steady synthetic workout habit");
  assert.equal(built.context.member.timeZone, "America/Denver");
  assert.equal(built.context.plan.id, String(fixture.seeded.plan.id));
  assert.equal(built.context.plan.exercises.length, 1);
  assert.equal(built.context.plan.exercises[0].intentValidationStatus, "validated");
  assert.equal(built.context.availableMinutes, 20);
  assert.equal(built.context.recentCheckin.staffSummary, "Synthetic staff-approved check-in summary");
  assert.equal(built.context.humanApprovedInstructions.length, 1);
  assert.equal(built.context.workoutSession.currentExerciseName, "Comfortable walking");
  assert.equal(built.context.workoutSession.stateVersion, 1);
  assert.deepEqual(built.context.equipment, ["dumbbells"]);
  assert.equal(built.context.date, "2026-07-17");
  assert.match(built.digest, /^[a-f0-9]{64}$/);
  assert.equal(built.digest, digestContext(built.context));
});

test("unknown or incomplete context remains explicit instead of being fabricated", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  await runPhase1bMigration({ pool: disposable.pool });
  const seeded = await seedMemberAndPlan(disposable.pool, "unknown");
  const conversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];

  const built = await buildCoachingContext({
    client: disposable.pool,
    member: { memberId: String(seeded.member.id) },
    conversationId: conversation.id,
    memberMessage: "Where do I start today?",
    now: fixedNow,
  });

  assert.equal(built.context.member.primaryGoal, null);
  assert.equal(built.context.member.timeZone, "UTC");
  assert.deepEqual(built.context.plan.exercises, []);
  assert.deepEqual(built.context.safetyRestrictions, []);
  assert.deepEqual(built.context.humanApprovedInstructions, []);
  assert.equal(built.context.availableMinutes, null);
  assert.equal(built.context.recentCheckin, null);
  assert.deepEqual(built.context.currentConversation, []);
  assert.equal(built.context.workoutSession, null);
  assert.deepEqual(built.context.equipment, []);
  assert.deepEqual(built.context.conflicts, []);
});

test("context excludes cross-member, billing, raw check-in, and internal-review data", async (t) => {
  const fixture = await createFixture("isolation");
  t.after(() => fixture.disposable.close());
  const built = await buildCoachingContext({
    client: fixture.disposable.pool,
    member: memberIdentity(fixture),
    conversationId: fixture.conversation.id,
    memberMessage: "I have 20 minutes today",
    now: fixedNow,
  });
  const serialized = JSON.stringify(built.context);
  for (const prohibited of [
    "OTHER-MEMBER-MUST-NOT-ENTER-CONTEXT",
    "BILLING-MUST-NOT-ENTER-CONTEXT",
    "UNRELATED-HEALTH-MUST-NOT-ENTER-CONTEXT",
    "RAW-CHECKIN-MUST-NOT-ENTER-CONTEXT",
    "INTERNAL-NOTE-MUST-NOT-ENTER-CONTEXT",
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }

  await assert.rejects(
    buildCoachingContext({
      client: fixture.disposable.pool,
      member: memberIdentity(fixture),
      conversationId: fixture.otherConversation.id,
      memberMessage: "Synthetic unauthorized request",
      now: fixedNow,
    }),
    (error) => error.code === "CONVERSATION_NOT_FOUND" && error.statusCode === 404
  );
});

test("archived conversations and superseded plans fail closed", async (t) => {
  const archived = await createFixture("archived");
  t.after(() => archived.disposable.close());
  await archived.disposable.pool.query(
    `UPDATE coaching_conversations
     SET status = 'archived', archived_at = NOW()
     WHERE id = $1`,
    [archived.conversation.id]
  );
  await assert.rejects(
    buildCoachingContext({
      client: archived.disposable.pool,
      member: memberIdentity(archived),
      conversationId: archived.conversation.id,
      memberMessage: "Synthetic",
      now: fixedNow,
    }),
    (error) => error.code === "CONVERSATION_CLOSED" && error.statusCode === 409
  );

  const superseded = await createFixture("superseded");
  t.after(() => superseded.disposable.close());
  await superseded.disposable.pool.query(
    `INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown)
     VALUES ($1, '{}'::jsonb, '[]'::jsonb, 'Synthetic replacement plan')`,
    [superseded.seeded.member.id]
  );
  await assert.rejects(
    buildCoachingContext({
      client: superseded.disposable.pool,
      member: memberIdentity(superseded),
      conversationId: superseded.conversation.id,
      memberMessage: "Synthetic",
      now: fixedNow,
    }),
    (error) => error.code === "WORKOUT_PLAN_SUPERSEDED" && error.statusCode === 409
  );
});

test("context is compatible with configured engine input and structured-output validation", async (t) => {
  const fixture = await createFixture("integration");
  t.after(() => fixture.disposable.close());
  const built = await buildCoachingContext({
    client: fixture.disposable.pool,
    member: memberIdentity(fixture),
    conversationId: fixture.conversation.id,
    memberMessage: "I have 20 minutes today",
    now: fixedNow,
  });
  const configuration = loadCoachingConfiguration({
    GOALS_COACH_AI_ENABLED: "true",
    GOALS_COACH_AI_PROVIDER: "synthetic-provider",
    GOALS_COACH_OPENAI_MODEL: "synthetic-model",
    GOALS_COACH_PROMPT_VERSION: "GC-PROMPT-1B-1.0",
    GOALS_COACH_STRUCTURED_OUTPUT_VERSION: "GC-OUTPUT-1B-1.0",
    GOALS_COACH_SAFETY_RULE_VERSION: "GC-SAFETY-PLACEHOLDER-1B",
  });
  let capturedContext;
  const engine = createCoachingEngine({
    configuration,
    provider: {
      async generate(input) {
        capturedContext = input.context;
        return {
          output: {
            reply: "Start with five minutes of comfortable walking.",
            mode: "start_today",
            nextAction: { type: "warmup", label: "Comfortable walking", target: "5 minutes" },
            conversationState: { workoutActive: true, awaitingMemberCompletion: true },
            stateTransition: { type: "no_change", expectedVersion: null, changes: {} },
            review: { required: false, priority: null, category: null, reason: null },
            safety: { stopNormalCoaching: false, severity: "none" },
            uncertainty: { missingContext: false, reason: null },
            promptVersion: configuration.promptVersion,
            schemaVersion: configuration.structuredOutputVersion,
          },
        };
      },
    },
  });
  const generated = await engine.generateTurn({
    context: built.context,
    memberMessage: "I have 20 minutes today",
    requestId: "synthetic-context-integration",
  });
  assert.equal(capturedContext, built.context);
  assert.equal(generated.output.mode, "start_today");
  assert.equal(generated.output.schemaVersion, configuration.structuredOutputVersion);
  assert.equal(extractAvailableMinutes("about 10 min"), 10);
  assert.equal(extractAvailableMinutes("unknown duration"), null);
  assert.equal(timeZoneDateKey(fixedNow, "America/Denver"), "2026-07-17");
});
