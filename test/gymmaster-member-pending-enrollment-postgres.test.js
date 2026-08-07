"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGymMasterMemberPendingEnrollmentService,
} = require("../src/goals-coach/gymmaster-member-pending-enrollment");
const { runMigration: runPhase1cTranscriptionMigration } = require("../migrate_005");
const { runMigration: runPhase1dSafetyMigration } = require("../migrate_006");
const { runMigration: runOwnerWorkoutTrackingMigration } = require("../migrate_007");
const { runMigration: runOwnerEditableWorkoutSessionsMigration } = require("../migrate_008");
const { runMigration: runMemberSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "embedded PostgreSQL refuses to run as root; run this test as an unprivileged user"
  : false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestId(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

async function waitForMemberLockWaiters(pool, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT pid
       FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND query LIKE '%FROM coach_members%'
       ORDER BY pid`
    );
    if (result.rows.length >= expected) return result.rows;
    await delay(20);
  }
  throw new Error(`Expected ${expected} pending-enrollment member-lock waiter(s)`);
}

test(
  "PostgreSQL 16 serializes pending-enrollment replays and conflicts with one live row",
  { skip: skipForRoot },
  async (t) => {
    const disposable = await createRealDisposablePostgres({ phase1b: true });
    let blocker = null;
    const pendingOperations = [];
    t.after(async () => {
      if (blocker) {
        try { await blocker.query("ROLLBACK"); } catch (_) {}
        blocker.release();
      }
      await Promise.allSettled(pendingOperations);
      await disposable.close();
    });
    await runPhase1cTranscriptionMigration({ pool: disposable.pool });
    await runPhase1dSafetyMigration({ pool: disposable.pool });
    await runOwnerWorkoutTrackingMigration({ pool: disposable.pool });
    await runOwnerEditableWorkoutSessionsMigration({ pool: disposable.pool });
    await runMemberSafetyIntakeMigration({ pool: disposable.pool });
    await runPendingEnrollmentMigration({ pool: disposable.pool });

    const version = (await disposable.pool.query(
      "SHOW server_version"
    )).rows[0].server_version;
    assert.match(version, /^16\./);
    const admin = (await disposable.pool.query(
      `INSERT INTO staff_users
        (auth_provider, auth_subject, email, display_name, role, active)
       VALUES ('clerk', 'user_pending_pg_admin', 'admin@example.test',
               'Admin', 'admin', TRUE)
       RETURNING *`
    )).rows[0];
    const member = (await disposable.pool.query(
      `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
       VALUES ('42501', 'Pending', 'Postgres')
       RETURNING *`
    )).rows[0];
    const service = createGymMasterMemberPendingEnrollmentService({
      db: disposable.pool,
      membershipVerifier: {
        async verifyActiveMember(memberId) {
          return { active: memberId === "42501" };
        },
      },
      now: () => new Date("2026-08-07T16:00:00.000Z"),
    });
    const input = {
      gymmasterMemberId: "42501",
      clientRequestId: requestId(501),
    };
    const staff = { id: String(admin.id), role: "admin" };

    blocker = await disposable.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM coach_members WHERE id = $1 FOR UPDATE",
      [member.id]
    );
    const first = service.createPendingEnrollment(staff, input);
    pendingOperations.push(first);
    await waitForMemberLockWaiters(disposable.pool, 1);
    const second = service.createPendingEnrollment(staff, input);
    pendingOperations.push(second);
    await waitForMemberLockWaiters(disposable.pool, 2);
    await blocker.query("COMMIT");
    blocker.release();
    blocker = null;

    const results = await Promise.all([first, second]);
    assert.deepEqual(
      results.map((result) => result.created).sort(),
      [false, true]
    );
    assert.equal(
      (await disposable.pool.query(
        "SELECT COUNT(*)::int AS count FROM goals_coach_member_pending_enrollments WHERE status = 'pending'"
      )).rows[0].count,
      1
    );
    assert.equal(
      (await disposable.pool.query(
        "SELECT COUNT(*)::int AS count FROM goals_coach_member_provisioning_events"
      )).rows[0].count,
      1
    );

    const conflict = await Promise.allSettled([
      service.createPendingEnrollment(staff, {
        gymmasterMemberId: "42501",
        clientRequestId: requestId(502),
      }),
      service.createPendingEnrollment(staff, {
        gymmasterMemberId: "42501",
        clientRequestId: requestId(503),
      }),
    ]);
    assert.equal(conflict.every((result) => result.status === "rejected"), true);
    assert.equal(
      conflict.every((result) => (
        result.reason.code === "MEMBER_PENDING_ENROLLMENT_CONFLICT"
      )),
      true
    );

    const event = (await disposable.pool.query(
      "SELECT id FROM goals_coach_member_provisioning_events LIMIT 1"
    )).rows[0];
    await assert.rejects(
      disposable.pool.query(
        "DELETE FROM goals_coach_member_provisioning_events WHERE id = $1",
        [event.id]
      ),
      /append-only/i
    );
    const columns = (await disposable.pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name IN (
         'goals_coach_member_pending_enrollments',
         'goals_coach_member_provisioning_events'
       )`
    )).rows.map((row) => row.column_name);
    for (const forbidden of ["email", "password", "token", "provider_payload"]) {
      assert.equal(columns.some((column) => column.includes(forbidden)), false);
    }
  }
);
