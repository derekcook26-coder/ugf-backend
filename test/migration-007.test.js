"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");
const { MIGRATION_VERSION, runMigration } = require("../migrate_007");

test("Migration 007 is prerequisite- and checksum-protected and idempotent", async (t) => {
  const missing = await createDisposableDatabase({ phase1cTranscription: true });
  t.after(() => missing.close());
  await assert.rejects(runMigration({ pool: missing.pool }), /Migration 006/);

  const disposable = await createDisposableDatabase({ phase1dSafety: true });
  t.after(() => disposable.close());
  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  assert.equal(applied.version, MIGRATION_VERSION);
  assert.equal((await runMigration({ pool: disposable.pool })).status, "already_applied");
});

test("Migration 007 constrains idempotency, ownership, bounds, source, metrics, and dates", async (t) => {
  const disposable = await createDisposableDatabase({ ownerWorkoutTracking: true });
  t.after(() => disposable.close());
  const first = await seedMemberAndPlan(disposable.pool, "journal-1");
  const second = await seedMemberAndPlan(disposable.pool, "journal-2");
  const log = (await disposable.pool.query(
    `INSERT INTO goals_coach_workout_logs
      (member_id, client_request_id, performed_on, workout_name, duration_minutes)
     VALUES ($1, $2, '2026-07-23', 'Strength', 45) RETURNING *`,
    [first.member.id, "00000000-0000-4000-8000-000000000001"]
  )).rows[0];

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_workout_logs
        (member_id, client_request_id, performed_on, workout_name)
       VALUES ($1, $2, '2026-07-23', 'Retry')`,
      [first.member.id, "00000000-0000-4000-8000-000000000001"]
    ),
    /duplicate|unique/i
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_workout_logs
        (member_id, client_request_id, performed_on, workout_name, source)
       VALUES ($1, $2, '2101-01-01', 'Bad', 'browser')`,
      [first.member.id, "00000000-0000-4000-8000-000000000002"]
    ),
    /constraint/i
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_achievements
        (member_id, client_request_id, achievement_type, title, achieved_on, metric_value)
       VALUES ($1, $2, 'personal_record', 'PR', '2026-07-23', 100)`,
      [first.member.id, "00000000-0000-4000-8000-000000000003"]
    ),
    /constraint/i
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_achievements
        (member_id, client_request_id, achievement_type, title, achieved_on, workout_log_id)
       VALUES ($1, $2, 'achievement', 'Win', '2026-07-23', $3)`,
      [second.member.id, "00000000-0000-4000-8000-000000000004", log.id]
    ),
    /constraint/i
  );
});
