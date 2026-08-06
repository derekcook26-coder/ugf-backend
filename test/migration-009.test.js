"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const { MIGRATION_VERSION, runMigration } = require("../migrate_009");
const { runRollback } = require("../rollback_009");

async function seedMapping(pool, memberId, subject) {
  return (await pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot, active,
       provisioning_method, provisioning_reference)
     VALUES ($1, 'gymmaster', $2, 'safety@example.test', TRUE,
             'owner_approved_script', 'migration-009-test')
     RETURNING *`,
    [memberId, subject]
  )).rows[0];
}

async function insertSubmission(pool, mapping, overrides = {}) {
  const values = {
    clientRequestId: "00000000-0000-4000-8000-000000009001",
    hash: "a".repeat(64),
    noticeVersion: "approved-member-safety-intake-v1",
    pain: false,
    injury: false,
    surgery: false,
    restriction: false,
    other: false,
    outcome: "screen_complete",
    safetyStop: false,
    ...overrides,
  };
  return pool.query(
    `INSERT INTO goals_coach_member_safety_intake_submissions
      (auth_mapping_id, member_id, client_request_id, client_request_hash,
       notice_version, current_pain_or_concerning_symptoms,
       current_injury_concern, recent_surgery,
       medical_or_exercise_restriction, other_training_safety_concern,
       outcome, safety_stop, rule_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             'GC-MEMBER-SAFETY-INTAKE-1')
     RETURNING *`,
    [
      mapping.id,
      mapping.member_id,
      values.clientRequestId,
      values.hash,
      values.noticeVersion,
      values.pain,
      values.injury,
      values.surgery,
      values.restriction,
      values.other,
      values.outcome,
      values.safetyStop,
    ]
  );
}

test("Migration 009 requires Migration 008 and is checksum-ledgered and idempotent", async (t) => {
  const missing = await createDisposableDatabase({ ownerWorkoutTracking: true });
  t.after(() => missing.close());
  await assert.rejects(runMigration({ pool: missing.pool }), /Migration 008/);

  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  assert.equal(applied.version, MIGRATION_VERSION);
  assert.match(applied.checksum, /^[a-f0-9]{64}$/);
  assert.equal((await runMigration({ pool: disposable.pool })).status, "already_applied");
  const ledger = await disposable.pool.query(
    "SELECT checksum FROM app_schema_migrations WHERE version = $1",
    [MIGRATION_VERSION]
  );
  assert.equal(ledger.rows[0].checksum, applied.checksum);

  await disposable.pool.query(
    "UPDATE app_schema_migrations SET checksum = $2 WHERE version = $1",
    [MIGRATION_VERSION, "0".repeat(64)]
  );
  await assert.rejects(
    runMigration({ pool: disposable.pool }),
    /different checksum/
  );
});

test("Migration 009 enforces mapped-member provenance and derived row outcomes", async (t) => {
  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const first = await seedMemberAndPlan(disposable.pool, "safety-schema-first");
  const second = await seedMemberAndPlan(disposable.pool, "safety-schema-second");
  const mapping = await seedMapping(
    disposable.pool,
    first.member.id,
    "gymmaster:29001"
  );

  const negative = await insertSubmission(disposable.pool, mapping);
  assert.equal(negative.rows[0].outcome, "screen_complete");
  assert.equal(negative.rows[0].safety_stop, false);

  await assert.rejects(
    insertSubmission(disposable.pool, mapping, {
      clientRequestId: "00000000-0000-4000-8000-000000009002",
      pain: true,
      safetyStop: false,
      outcome: "screen_complete",
    }),
    /constraint/i
  );
  await assert.rejects(
    insertSubmission(disposable.pool, {
      ...mapping,
      member_id: second.member.id,
    }, {
      clientRequestId: "00000000-0000-4000-8000-000000009003",
    }),
    /constraint/i
  );

  const positive = await insertSubmission(disposable.pool, mapping, {
    clientRequestId: "00000000-0000-4000-8000-000000009004",
    hash: "b".repeat(64),
    restriction: true,
    safetyStop: true,
    outcome: "handoff_required",
  });
  assert.equal(positive.rows[0].outcome, "handoff_required");
  assert.equal(positive.rows[0].safety_stop, true);

  await assert.rejects(
    disposable.pool.query(
      `UPDATE goals_coach_member_safety_intake_submissions
       SET notice_version = 'changed'
       WHERE id = $1`,
      [negative.rows[0].id]
    ),
    /append-only/i
  );
  await assert.rejects(
    disposable.pool.query(
      "DELETE FROM goals_coach_member_safety_intake_submissions WHERE id = $1",
      [negative.rows[0].id]
    ),
    /append-only/i
  );
});

test("Migration 009 rollback is confirmation-gated and refuses submission loss", async (t) => {
  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  await assert.rejects(
    runRollback({ pool: disposable.pool }),
    /CONFIRM_GOALS_COACH_MEMBER_SAFETY_INTAKE_ROLLBACK/
  );
  assert.deepEqual(
    await runRollback({ pool: disposable.pool, skipConfirmation: true }),
    { status: "rolled_back", version: MIGRATION_VERSION }
  );
  assert.equal(
    (await disposable.pool.query(
      "SELECT to_regclass('public.goals_coach_member_safety_intake_submissions') AS table_name"
    )).rows[0].table_name,
    null
  );

  await runMigration({ pool: disposable.pool });
  const seeded = await seedMemberAndPlan(disposable.pool, "safety-rollback");
  const mapping = await seedMapping(
    disposable.pool,
    seeded.member.id,
    "gymmaster:29002"
  );
  await insertSubmission(disposable.pool, mapping);
  await assert.rejects(
    runRollback({ pool: disposable.pool, skipConfirmation: true }),
    /preservation of member safety-intake submissions/
  );
  assert.equal(
    (await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_safety_intake_submissions"
    )).rows[0].count,
    1
  );
  assert.equal(
    (await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    )).rows[0].count,
    1
  );
});
