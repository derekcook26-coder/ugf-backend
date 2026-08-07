"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
  seedStaff,
} = require("./helpers/disposable-db");
const { runMigration: runSafetyIntakeMigration } = require("../migrate_009");
const {
  MIGRATION_VERSION,
  runMigration,
} = require("../migrate_010");

async function readyDatabase(t) {
  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  await runSafetyIntakeMigration({ pool: disposable.pool });
  return disposable;
}

test("Migration 010 is explicit, checksum-ledgered, ordered, and idempotent", async (t) => {
  const missing = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => missing.close());
  await assert.rejects(runMigration({ pool: missing.pool }), /Migration 009/);
  assert.equal(
    (await missing.pool.query(
      "SELECT to_regclass('public.goals_coach_member_pending_enrollments') AS name"
    )).rows[0].name,
    null
  );

  const disposable = await readyDatabase(t);
  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  assert.equal(applied.version, MIGRATION_VERSION);
  assert.match(applied.checksum, /^[a-f0-9]{64}$/);
  assert.equal((await runMigration({ pool: disposable.pool })).status, "already_applied");
  assert.equal(
    (await disposable.pool.query(
      "SELECT checksum FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    )).rows[0].checksum,
    applied.checksum
  );
});

test("Migration 010 preflight refuses noncanonical existing GymMaster identity data without partial schema", async (t) => {
  const disposable = await readyDatabase(t);
  const seeded = await seedMemberAndPlan(disposable.pool, "pending-preflight");
  await disposable.pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot, active,
       provisioning_method, provisioning_reference)
     VALUES ($1, 'gymmaster', 'gymmaster:00041', 'preflight@example.test',
             FALSE, 'owner_approved_script', 'migration-010-preflight')`,
    [seeded.member.id]
  );
  await assert.rejects(
    runMigration({ pool: disposable.pool }),
    /noncanonical GymMaster mapping identity/
  );
  assert.equal(
    (await disposable.pool.query(
      "SELECT to_regclass('public.goals_coach_member_pending_enrollments') AS name"
    )).rows[0].name,
    null
  );
  assert.equal(
    (await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    )).rows[0].count,
    0
  );
});

test("Migration 010 enforces 24-hour single-live enrollment and append-only event integrity", async (t) => {
  const disposable = await readyDatabase(t);
  await runMigration({ pool: disposable.pool });
  const first = await seedMemberAndPlan(disposable.pool, "41001");
  const second = await seedMemberAndPlan(disposable.pool, "41002");
  await disposable.pool.query(
    "UPDATE coach_members SET gymmaster_member_id = $2 WHERE id = $1",
    [first.member.id, "41001"]
  );
  await disposable.pool.query(
    "UPDATE coach_members SET gymmaster_member_id = $2 WHERE id = $1",
    [second.member.id, "41002"]
  );
  const admin = await seedStaff(disposable.pool, "pending-schema-admin", "admin", true);
  const createdAt = new Date("2026-08-07T12:00:00.000Z");
  const expiresAt = new Date("2026-08-08T12:00:00.000Z");
  const pending = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_pending_enrollments
      (member_id, gymmaster_member_id, client_request_id,
       requested_by_staff_user_id, created_at, expires_at)
     VALUES ($1, '41001', '00000000-0000-4000-8000-000000010001',
             $2, $3, $4)
     RETURNING *`,
    [first.member.id, admin.id, createdAt, expiresAt]
  )).rows[0];
  assert.equal(pending.status, "pending");

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_member_pending_enrollments
        (member_id, gymmaster_member_id, client_request_id,
         requested_by_staff_user_id, created_at, expires_at)
       VALUES ($1, '41001', '00000000-0000-4000-8000-000000010002',
               $2, $3, $4)`,
      [first.member.id, admin.id, createdAt, expiresAt]
    ),
    /unique|constraint/i
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_member_pending_enrollments
        (member_id, gymmaster_member_id, client_request_id,
         requested_by_staff_user_id, created_at, expires_at)
       VALUES ($1, '41002', '00000000-0000-4000-8000-000000010003',
               $2, $3, $4)`,
      [second.member.id, admin.id, createdAt, new Date("2026-08-08T11:59:59.000Z")]
    ),
    /constraint/i
  );

  const event = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_provisioning_events
      (pending_enrollment_id, member_id, staff_user_id, client_request_id,
       action, result, created_at)
     VALUES ($1, $2, $3, '00000000-0000-4000-8000-000000010001',
             'pending_enrollment_created', 'created', $4)
     RETURNING *`,
    [pending.id, first.member.id, admin.id, createdAt]
  )).rows[0];
  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_member_provisioning_events SET result = 'completed' WHERE id = $1",
      [event.id]
    ),
    /append-only/i
  );
  await assert.rejects(
    disposable.pool.query(
      "DELETE FROM goals_coach_member_provisioning_events WHERE id = $1",
      [event.id]
    ),
    /append-only/i
  );
  await assert.rejects(
    disposable.pool.query(
      "DELETE FROM goals_coach_member_pending_enrollments WHERE id = $1",
      [pending.id]
    ),
    /cannot be deleted/i
  );
});
