"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const { runMigration: runPhase1cTranscriptionMigration } = require("../migrate_005");
const { runMigration: runPhase1dSafetyMigration } = require("../migrate_006");
const { runMigration: runOwnerWorkoutTrackingMigration } = require("../migrate_007");
const { MIGRATION_VERSION, runMigration } = require("../migrate_008");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "embedded PostgreSQL refuses to run as root; run this test as an unprivileged user"
  : false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function trackSettlement(promise) {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  return {
    promise: tracked,
    isSettled() {
      return settled;
    },
  };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject");
}

async function waitForBlockedBackend(pool, blockedPid, blockerPid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT wait_event_type, pg_blocking_pids($1::int) AS blocking_pids
       FROM pg_stat_activity
       WHERE pid = $1::int`,
      [blockedPid]
    );
    if (
      result.rows[0]?.wait_event_type === "Lock"
      && result.rows[0].blocking_pids.map(Number).includes(Number(blockerPid))
    ) {
      return result.rows[0];
    }
    await delay(20);
  }
  throw new Error(
    `PostgreSQL backend ${blockedPid} did not block behind backend ${blockerPid}`
  );
}

test("Migration 008 requires Migration 007 and is checksum-protected and idempotent", async (t) => {
  const missing = await createDisposableDatabase({ phase1dSafety: true });
  t.after(() => missing.close());
  await assert.rejects(runMigration({ pool: missing.pool }), /Migration 007/);

  const disposable = await createDisposableDatabase({ ownerWorkoutTracking: true });
  t.after(() => disposable.close());
  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  assert.equal(applied.version, MIGRATION_VERSION);
  assert.match(applied.checksum, /^[a-f0-9]{64}$/);
  assert.equal((await runMigration({ pool: disposable.pool })).status, "already_applied");
});

test("Migration 008 creates a separate manual and future plan-snapshot model", async (t) => {
  const disposable = await createDisposableDatabase({ ownerEditableWorkoutSessions: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "tracked-model");

  const names = (await disposable.pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name LIKE 'goals_coach_tracked_workout_%'
     ORDER BY table_name`
  )).rows.map((row) => row.table_name);
  assert.deepEqual(names, [
    "goals_coach_tracked_workout_events",
    "goals_coach_tracked_workout_exercises",
    "goals_coach_tracked_workout_sessions",
    "goals_coach_tracked_workout_sets",
  ]);

  const manual = await disposable.pool.query(
    `INSERT INTO goals_coach_tracked_workout_sessions
      (member_id, client_request_id, client_request_hash, source, workout_name)
     VALUES ($1, '00000000-0000-4000-8000-000000008001', $2, 'manual', 'Manual')
     RETURNING id, status, version`,
    [seeded.member.id, "a".repeat(64)]
  );
  assert.equal(manual.rows[0].status, "draft");
  assert.equal(Number(manual.rows[0].version), 1);

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_tracked_workout_sessions
        (member_id, client_request_id, client_request_hash, source, workout_name)
       VALUES ($1, '00000000-0000-4000-8000-000000008002', $2, 'plan_snapshot', 'Bad')`,
      [seeded.member.id, "b".repeat(64)]
    ),
    /constraint/i
  );
  const snapshot = await disposable.pool.query(
    `INSERT INTO goals_coach_tracked_workout_sessions
      (member_id, client_request_id, client_request_hash, source, source_snapshot, workout_name)
     VALUES (
       $1, '00000000-0000-4000-8000-000000008003', $2,
       'plan_snapshot', '{"frozenPlanVersion":1}'::jsonb, 'Future snapshot'
     )
     RETURNING source, source_snapshot`,
    [seeded.member.id, "c".repeat(64)]
  );
  assert.equal(snapshot.rows[0].source, "plan_snapshot");
  assert.equal(snapshot.rows[0].source_snapshot.frozenPlanVersion, 1);

  const oldModelColumns = (await disposable.pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'goals_coach_workout_sessions'`
  )).rows.map((row) => row.column_name);
  assert.ok(oldModelColumns.includes("conversation_id"));
  assert.ok(oldModelColumns.includes("plan_id"));

  const newModelColumns = (await disposable.pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'goals_coach_tracked_workout_sessions'`
  )).rows.map((row) => row.column_name);
  assert.equal(newModelColumns.includes("conversation_id"), false);
  assert.equal(newModelColumns.includes("plan_id"), false);
});

test("Migration 008 enforces append-only revisions and immutable completion", async (t) => {
  const disposable = await createDisposableDatabase({ ownerEditableWorkoutSessions: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "tracked-immutable");
  const session = (await disposable.pool.query(
    `INSERT INTO goals_coach_tracked_workout_sessions
      (member_id, client_request_id, client_request_hash, source, workout_name)
     VALUES ($1, '00000000-0000-4000-8000-000000008011', $2, 'manual', 'Strength')
     RETURNING id`,
    [seeded.member.id, "d".repeat(64)]
  )).rows[0];
  const exercise = (await disposable.pool.query(
    `INSERT INTO goals_coach_tracked_workout_exercises
      (session_id, member_id, session_version, exercise_order, name, state)
     VALUES ($1, $2, 1, 1, 'Squat', 'completed')
     RETURNING id`,
    [session.id, seeded.member.id]
  )).rows[0];

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_tracked_workout_sets
        (exercise_id, session_id, member_id, session_version, set_order, actual_reps, load)
       VALUES ($1, $2, $3, 1, 1, 5, 100)`,
      [exercise.id, session.id, seeded.member.id]
    ),
    /constraint/i
  );
  await disposable.pool.query(
    `INSERT INTO goals_coach_tracked_workout_sets
      (exercise_id, session_id, member_id, session_version,
       set_order, actual_reps, load, unit)
     VALUES ($1, $2, $3, 1, 1, 5, 100, 'lb')`,
    [exercise.id, session.id, seeded.member.id]
  );
  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_tracked_workout_exercises SET name = 'Changed' WHERE id = $1",
      [exercise.id]
    ),
    /append-only/i
  );

  await disposable.pool.query(
    `UPDATE goals_coach_tracked_workout_sessions
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [session.id]
  );
  await disposable.pool.query(
    `INSERT INTO goals_coach_tracked_workout_events
      (session_id, member_id, event_type, session_version)
     VALUES ($1, $2, 'completed', 1)`,
    [session.id, seeded.member.id]
  );

  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_tracked_workout_sessions SET workout_name = 'Changed' WHERE id = $1",
      [session.id]
    ),
    /immutable/i
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_tracked_workout_exercises
        (session_id, member_id, session_version, exercise_order, name, state)
       VALUES ($1, $2, 1, 2, 'Late', 'skipped')`,
      [session.id, seeded.member.id]
    ),
    /immutable/i
  );
  await assert.rejects(
    disposable.pool.query(
      "DELETE FROM goals_coach_tracked_workout_sessions WHERE id = $1",
      [session.id]
    ),
    /cannot be deleted/i
  );
  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_tracked_workout_events SET event_data = '{}' WHERE session_id = $1",
      [session.id]
    ),
    /append-only/i
  );
});

test(
  "Migration 008 serializes direct child revision writes behind completion",
  { skip: skipForRoot },
  async (t) => {
    const disposable = await createRealDisposablePostgres({ phase1b: true });
    const clients = [];
    t.after(async () => {
      for (const client of clients) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
        client.release();
      }
      await disposable.close();
    });

    await runPhase1cTranscriptionMigration({ pool: disposable.pool });
    await runPhase1dSafetyMigration({ pool: disposable.pool });
    await runOwnerWorkoutTrackingMigration({ pool: disposable.pool });
    await runMigration({ pool: disposable.pool });
    const version = (await disposable.pool.query("SHOW server_version")).rows[0].server_version;
    assert.match(version, /^16\./);

    const seeded = await seedMemberAndPlan(disposable.pool, "tracked-completion-race");
    const session = (await disposable.pool.query(
      `INSERT INTO goals_coach_tracked_workout_sessions
        (member_id, client_request_id, client_request_hash, source, workout_name)
       VALUES ($1, '00000000-0000-4000-8000-000000008021', $2, 'manual', 'Race')
       RETURNING id`,
      [seeded.member.id, "e".repeat(64)]
    )).rows[0];
    const exercise = (await disposable.pool.query(
      `INSERT INTO goals_coach_tracked_workout_exercises
        (session_id, member_id, session_version, exercise_order, name, state)
       VALUES ($1, $2, 1, 1, 'Press', 'completed')
       RETURNING id`,
      [session.id, seeded.member.id]
    )).rows[0];
    await disposable.pool.query(
      `INSERT INTO goals_coach_tracked_workout_sets
        (exercise_id, session_id, member_id, session_version,
         set_order, actual_reps, load, unit)
       VALUES ($1, $2, $3, 1, 1, 8, 50, 'lb')`,
      [exercise.id, session.id, seeded.member.id]
    );
    await disposable.pool.query(
      `INSERT INTO goals_coach_tracked_workout_exercises
        (session_id, member_id, session_version, exercise_order, name, state)
       VALUES ($1, $2, 1, 2, 'Cooldown', 'skipped')`,
      [session.id, seeded.member.id]
    );
    assert.equal((await disposable.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM goals_coach_tracked_workout_exercises
       WHERE session_id = $1 AND session_version = 1`,
      [session.id]
    )).rows[0].count, 2);

    const completion = await disposable.pool.connect();
    const childWriter = await disposable.pool.connect();
    clients.push(completion, childWriter);
    await completion.query("BEGIN");
    await childWriter.query("BEGIN");
    const completionPid = (await completion.query(
      "SELECT pg_backend_pid()::int AS pid"
    )).rows[0].pid;
    const childWriterPid = (await childWriter.query(
      "SELECT pg_backend_pid()::int AS pid"
    )).rows[0].pid;

    const locked = await completion.query(
      `SELECT id, status, version
       FROM goals_coach_tracked_workout_sessions
       WHERE id = $1 AND member_id = $2
       FOR UPDATE`,
      [session.id, seeded.member.id]
    );
    assert.equal(locked.rows[0].status, "draft");
    assert.equal(Number(locked.rows[0].version), 1);
    const planned = await completion.query(
      `SELECT COUNT(*)::int AS count
       FROM goals_coach_tracked_workout_exercises
       WHERE session_id = $1 AND member_id = $2
         AND session_version = 1 AND state = 'planned'`,
      [session.id, seeded.member.id]
    );
    assert.equal(planned.rows[0].count, 0);

    const blockedInsert = trackSettlement(childWriter.query(
      `INSERT INTO goals_coach_tracked_workout_exercises
        (session_id, member_id, session_version, exercise_order, name, state)
       VALUES ($1, $2, 1, 3, 'Late child', 'skipped')`,
      [session.id, seeded.member.id]
    ));
    const waiting = await waitForBlockedBackend(
      disposable.pool,
      childWriterPid,
      completionPid
    );
    assert.equal(waiting.wait_event_type, "Lock");
    assert.equal(blockedInsert.isSettled(), false);

    await completion.query(
      `UPDATE goals_coach_tracked_workout_sessions
       SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND member_id = $2`,
      [session.id, seeded.member.id]
    );
    await completion.query(
      `INSERT INTO goals_coach_tracked_workout_events
        (session_id, member_id, event_type, session_version, event_data)
       VALUES ($1, $2, 'completed', 1, '{"completion":"explicit"}'::jsonb)`,
      [session.id, seeded.member.id]
    );
    await completion.query("COMMIT");

    const childError = await captureRejection(blockedInsert.promise);
    assert.notEqual(childError.code, "40P01");
    assert.equal(childError.code, "23514");
    assert.equal(
      childError.constraint,
      "goals_coach_tracked_workout_completed_immutable"
    );
    await childWriter.query("ROLLBACK");

    const final = await disposable.pool.query(
      `SELECT status, version,
        (SELECT COUNT(*)::int
         FROM goals_coach_tracked_workout_exercises
         WHERE session_id = $1 AND session_version = 1) AS child_count
       FROM goals_coach_tracked_workout_sessions
       WHERE id = $1`,
      [session.id]
    );
    assert.equal(final.rows[0].status, "completed");
    assert.equal(Number(final.rows[0].version), 1);
    assert.equal(final.rows[0].child_count, 2);
  }
);
