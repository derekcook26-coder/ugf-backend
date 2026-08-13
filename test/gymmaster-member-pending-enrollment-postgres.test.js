"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGymMasterMemberPendingEnrollmentService,
} = require("../src/goals-coach/gymmaster-member-pending-enrollment");
const {
  createGymMasterMemberLoginService,
} = require("../src/goals-coach/gymmaster-member-login");
const { runMigration: runPhase1cTranscriptionMigration } = require("../migrate_005");
const { runMigration: runPhase1dSafetyMigration } = require("../migrate_006");
const { runMigration: runOwnerWorkoutTrackingMigration } = require("../migrate_007");
const { runMigration: runOwnerEditableWorkoutSessionsMigration } = require("../migrate_008");
const { runMigration: runMemberSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");
const { runMigration: runNullableNamesMigration } = require("../migrate_011");
const {
  acquireGymMasterMemberProvisioningLock,
} = require("../src/goals-coach/gymmaster-member-provisioning-lock");
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

async function waitForProvisioningLockWaiters(pool, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT pid
       FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND query LIKE '%pg_advisory_xact_lock%'
       ORDER BY pid`
    );
    if (result.rows.length >= expected) return result.rows;
    await delay(20);
  }
  throw new Error(`Expected ${expected} pending-enrollment advisory-lock waiter(s)`);
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
    await runNullableNamesMigration({
      pool: disposable.pool,
      environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" },
    });

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
    const service = createGymMasterMemberPendingEnrollmentService({
      db: disposable.pool,
      membershipVerifier: {
        async verifyActiveMember(memberId) {
          return { active: memberId === "42501" };
        },
      },
    });
    const input = {
      gymmasterMemberId: "42501",
      clientRequestId: requestId(501),
    };
    const staff = { id: String(admin.id), role: "admin" };

    blocker = await disposable.pool.connect();
    await blocker.query("BEGIN");
    await acquireGymMasterMemberProvisioningLock(blocker, "42501");
    const first = service.createPendingEnrollment(staff, input);
    pendingOperations.push(first);
    await waitForProvisioningLockWaiters(disposable.pool, 1);
    const second = service.createPendingEnrollment(staff, input);
    pendingOperations.push(second);
    await waitForProvisioningLockWaiters(disposable.pool, 2);
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
        "SELECT COUNT(*)::int AS count FROM coach_members WHERE gymmaster_member_id = '42501'"
      )).rows[0].count,
      0
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

    const loginService = createGymMasterMemberLoginService({
      enabled: true,
      memberApiKey: "synthetic-member-api-key",
      loginClient: async () => ({
        result: {
          token: "synthetic-provider-token",
          expires: 3600,
          memberid: 42501,
        },
      }),
    });
    const identities = await Promise.all([
      loginService.authenticate({
        email: "native@example.test",
        password: "synthetic-password",
      }),
      loginService.authenticate({
        email: "native@example.test",
        password: "synthetic-password",
      }),
    ]);
    const completions = await Promise.all(
      identities.map((identity) => service.completeAuthenticatedEnrollment(identity))
    );
    assert.equal(completions.every((completion) => completion.active === true), true);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM coach_members WHERE gymmaster_member_id = '42501'"
    )).rows[0].count, 1);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings WHERE auth_subject = 'gymmaster:42501'"
    )).rows[0].count, 1);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_pending_enrollments WHERE status = 'consumed'"
    )).rows[0].count, 1);

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
