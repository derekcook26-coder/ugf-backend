const assert = require("node:assert/strict");
const test = require("node:test");
const { runMigration } = require("../migrate_002");
const { runRollback } = require("../rollback_002");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
  seedStaff,
} = require("./helpers/disposable-db");

test("migration 002 is additive, checksummed, idempotent, and reversible", async (t) => {
  const disposable = await createDisposableDatabase({ phase2: false });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "existing");
  await disposable.pool.query(
    `INSERT INTO weekly_checkins (member_id, week_start, responses_json)
     VALUES ($1, CURRENT_DATE, '{}'::jsonb)`,
    [seeded.member.id]
  );

  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  const reapplied = await runMigration({ pool: disposable.pool });
  assert.equal(reapplied.status, "already_applied");
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_members")).rows[0].count, 1);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_plans")).rows[0].count, 1);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM weekly_checkins")).rows[0].count, 1);

  const rolledBack = await runRollback({ pool: disposable.pool, skipConfirmation: true });
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal((await disposable.pool.query("SELECT to_regclass('public.staff_users') AS name")).rows[0].name, null);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_plans")).rows[0].count, 1);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM weekly_checkins")).rows[0].count, 1);
});

test("PostgreSQL rejects cross-member plan, conversation, message, concern, and proposal links", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const first = await seedMemberAndPlan(disposable.pool, "ownership-a");
  const second = await seedMemberAndPlan(disposable.pool, "ownership-b");

  await assert.rejects(
    disposable.pool.query(
      "INSERT INTO coaching_conversations (member_id, plan_id) VALUES ($1, $2)",
      [first.member.id, second.plan.id]
    ),
    (error) => error.code === "23503"
  );

  const conversation = await disposable.pool.query(
    "INSERT INTO coaching_conversations (member_id, plan_id) VALUES ($1, $2) RETURNING *",
    [first.member.id, first.plan.id]
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
       VALUES ($1, $2, 'member', 'cross-member')`,
      [conversation.rows[0].id, second.member.id]
    ),
    (error) => error.code === "23503"
  );

  const memberMessage = await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'member concern') RETURNING *`,
    [conversation.rows[0].id, first.member.id]
  );
  const coachMessage = await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'goals_coach', 'coach reply') RETURNING *`,
    [conversation.rows[0].id, first.member.id]
  );

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO coaching_concerns
        (member_id, conversation_id, source_message_id, plan_id, concern_category, safety_level)
       VALUES ($1, $2, $3, $4, 'pain', 'priority')`,
      [first.member.id, conversation.rows[0].id, coachMessage.rows[0].id, first.plan.id]
    ),
    (error) => error.code === "23503"
  );

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO coaching_plan_change_proposals
        (member_id, conversation_id, request_message_id, source_plan_id,
         proposed_change_json, coaching_intent_json)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb)`,
      [first.member.id, conversation.rows[0].id, coachMessage.rows[0].id, first.plan.id]
    ),
    (error) => error.code === "23503"
  );

  const proposal = await disposable.pool.query(
    `INSERT INTO coaching_plan_change_proposals
      (member_id, conversation_id, request_message_id, source_plan_id,
       proposed_change_json, coaching_intent_json)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [first.member.id, conversation.rows[0].id, memberMessage.rows[0].id, first.plan.id]
  );
  assert.ok(proposal.rows[0].id);
});

test("observation and milestone provenance is explicit, exclusive, and same-member", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const first = await seedMemberAndPlan(disposable.pool, "source-a");
  const second = await seedMemberAndPlan(disposable.pool, "source-b");
  const staff = await seedStaff(disposable.pool, "source", "coach", true);
  const conversation = await disposable.pool.query(
    "INSERT INTO coaching_conversations (member_id, plan_id) VALUES ($1, $2) RETURNING *",
    [first.member.id, first.plan.id]
  );
  const message = await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'I prefer rowing') RETURNING *`,
    [conversation.rows[0].id, first.member.id]
  );
  const checkin = await disposable.pool.query(
    `INSERT INTO weekly_checkins (member_id, week_start, responses_json)
     VALUES ($1, CURRENT_DATE, '{}'::jsonb) RETURNING *`,
    [first.member.id]
  );

  const observation = await disposable.pool.query(
    `INSERT INTO coaching_observations
      (member_id, category, observation_text, source_type, source_message_id,
       source_conversation_id, source_message_sender_type)
     VALUES ($1, 'exercise_preference', 'Prefers rowing', 'member_message', $2, $3, 'member')
     RETURNING id`,
    [first.member.id, message.rows[0].id, conversation.rows[0].id]
  );
  assert.ok(observation.rows[0].id);

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO coaching_observations
        (member_id, category, observation_text, source_type,
         source_message_id, source_conversation_id, source_message_sender_type,
         source_weekly_checkin_id)
       VALUES ($1, 'other', 'Invalid mixed source', 'member_message', $2, $3, 'member', $4)`,
      [first.member.id, message.rows[0].id, conversation.rows[0].id, checkin.rows[0].id]
    ),
    (error) => error.code === "23514"
  );

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO coaching_milestones
        (member_id, milestone_type, milestone_text, source_type, source_weekly_checkin_id)
       VALUES ($1, 'consistency', 'First consistent week', 'weekly_checkin', $2)`,
      [second.member.id, checkin.rows[0].id]
    ),
    (error) => error.code === "23503"
  );

  const staffMilestone = await disposable.pool.query(
    `INSERT INTO coaching_milestones
      (member_id, milestone_type, milestone_text, source_type,
       source_conversation_id, source_staff_user_id)
     VALUES ($1, 'confidence', 'Staff-confirmed confidence gain', 'staff', $2, $3)
     RETURNING id`,
    [first.member.id, conversation.rows[0].id, staff.id]
  );
  assert.ok(staffMilestone.rows[0].id);

  const coachMessage = await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'goals_coach', 'coach response') RETURNING *`,
    [conversation.rows[0].id, first.member.id]
  );
  const staffMessage = await disposable.pool.query(
    `INSERT INTO coaching_messages
      (conversation_id, member_id, sender_type, sender_staff_user_id, content)
     VALUES ($1, $2, 'staff', $3, 'staff response') RETURNING *`,
    [conversation.rows[0].id, first.member.id, staff.id]
  );
  for (const source of [coachMessage.rows[0], staffMessage.rows[0]]) {
    await assert.rejects(
      disposable.pool.query(
        `INSERT INTO coaching_observations
          (member_id, category, observation_text, source_type, source_message_id,
           source_conversation_id, source_message_sender_type)
         VALUES ($1, 'other', 'invalid source', 'member_message', $2, $3, 'member')`,
        [first.member.id, source.id, conversation.rows[0].id]
      ),
      (error) => error.code === "23503"
    );
    await assert.rejects(
      disposable.pool.query(
        `INSERT INTO coaching_milestones
          (member_id, milestone_type, milestone_text, source_type, source_message_id,
           source_conversation_id, source_message_sender_type)
         VALUES ($1, 'consistency', 'invalid source', 'member_message', $2, $3, 'member')`,
        [first.member.id, source.id, conversation.rows[0].id]
      ),
      (error) => error.code === "23503"
    );
  }
});

test("ending an assignment requires its open reviews to be reassigned or resolved", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "assignment");
  const admin = await seedStaff(disposable.pool, "admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "coach", "coach", true);
  const assignment = await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $3) RETURNING *`,
    [seeded.member.id, coach.id, admin.id]
  );
  const conversation = await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id, assigned_staff_user_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [seeded.member.id, seeded.plan.id, coach.id]
  );
  const message = await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'sharp pain') RETURNING *`,
    [conversation.rows[0].id, seeded.member.id]
  );
  const concern = await disposable.pool.query(
    `INSERT INTO coaching_concerns
      (member_id, conversation_id, source_message_id, plan_id, concern_category, safety_level)
     VALUES ($1, $2, $3, $4, 'pain', 'priority') RETURNING *`,
    [seeded.member.id, conversation.rows[0].id, message.rows[0].id, seeded.plan.id]
  );
  const review = await disposable.pool.query(
    `INSERT INTO coaching_reviews
      (concern_id, member_id, conversation_id, plan_id, priority,
       review_category, status, assigned_staff_user_id)
     VALUES ($1, $2, $3, $4, 'priority', 'pain', 'assigned', $5)
     RETURNING *`,
    [concern.rows[0].id, seeded.member.id, conversation.rows[0].id, seeded.plan.id, coach.id]
  );

  await assert.rejects(
    disposable.pool.query(
      `UPDATE member_coach_assignments
       SET status = 'ended', ends_at = NOW(), ended_by_staff_user_id = $1
       WHERE id = $2`,
      [admin.id, assignment.rows[0].id]
    ),
    (error) => error.code === "23514"
  );

  await disposable.pool.query(
    "UPDATE coaching_reviews SET status = 'resolved', resolved_at = NOW() WHERE id = $1",
    [review.rows[0].id]
  );
  const ended = await disposable.pool.query(
    `UPDATE member_coach_assignments
     SET status = 'ended', ends_at = NOW(), ended_by_staff_user_id = $1
     WHERE id = $2 RETURNING status`,
    [admin.id, assignment.rows[0].id]
  );
  assert.equal(ended.rows[0].status, "ended");
  await assert.rejects(
    disposable.pool.query("DELETE FROM member_coach_assignments WHERE id = $1", [assignment.rows[0].id]),
    (error) => error.code === "23514"
  );
});

test("exercise intent and safety/follow-up fields use explicit unknown and incomplete states", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "intent-safety");
  const exercise = await disposable.pool.query(
    `INSERT INTO coach_plan_exercises
      (plan_id, plan_item_key, sequence_number, exercise_name)
     VALUES ($1, 'day1-squat', 1, 'Goblet Squat') RETURNING *`,
    [seeded.plan.id]
  );
  assert.equal(exercise.rows[0].intent_source, "unknown");
  assert.equal(exercise.rows[0].intent_validation_status, "unknown");
  assert.deepEqual(exercise.rows[0].limitation_considerations_json, []);
  assert.deepEqual(exercise.rows[0].program_balance_tags_json, []);
  assert.deepEqual(exercise.rows[0].prescription_json, {});
  assert.deepEqual(exercise.rows[0].intent_evidence_json, {});

  const conversation = await disposable.pool.query(
    "INSERT INTO coaching_conversations (member_id, plan_id) VALUES ($1, $2) RETURNING *",
    [seeded.member.id, seeded.plan.id]
  );
  const message = await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'This feels unstable') RETURNING *`,
    [conversation.rows[0].id, seeded.member.id]
  );
  const concern = await disposable.pool.query(
    `INSERT INTO coaching_concerns
      (member_id, conversation_id, source_message_id, plan_id, plan_exercise_id,
       concern_category, safety_level, concerning_signals_json, stop_exercise,
       member_follow_up_required, member_follow_up_status)
     VALUES ($1, $2, $3, $4, $5, 'instability', 'caution', '["instability"]'::jsonb,
       TRUE, TRUE, 'pending') RETURNING *`,
    [seeded.member.id, conversation.rows[0].id, message.rows[0].id, seeded.plan.id, exercise.rows[0].id]
  );
  assert.equal(concern.rows[0].safety_level, "caution");
  assert.equal(concern.rows[0].stop_exercise, true);
  await assert.rejects(
    disposable.pool.query(
      "UPDATE coaching_concerns SET status = 'resolved', resolved_at = NOW() WHERE id = $1",
      [concern.rows[0].id]
    ),
    (error) => error.code === "23514"
  );
  await assert.rejects(
    disposable.pool.query(
      `UPDATE coaching_concerns
       SET member_follow_up_status = 'completed', member_follow_up_completed_at = NULL
       WHERE id = $1`,
      [concern.rows[0].id]
    ),
    (error) => error.code === "23514"
  );
});
