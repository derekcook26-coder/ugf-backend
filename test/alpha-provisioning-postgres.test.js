"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PROTECTED_FAILURE,
  provisionAlphaOwner,
} = require("../scripts/provision-alpha-owner");
const { runMigration: runPhase1cTranscriptionMigration } = require("../migrate_005");
const { runMigration: runPhase1dSafetyMigration } = require("../migrate_006");
const { runMigration: runOwnerWorkoutTrackingMigration } = require("../migrate_007");
const { runMigration: runOwnerEditableWorkoutSessionsMigration } = require("../migrate_008");
const { runMigration: runMemberSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");
const { runMigration: runNullableNamesMigration } = require("../migrate_011");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires unprivileged PostgreSQL 16; root skips are not acceptance evidence"
  : false;
const disabledEnvironment = {
  GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false",
};

async function postgresAt011(t) {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  await runPhase1cTranscriptionMigration({ pool: disposable.pool });
  await runPhase1dSafetyMigration({ pool: disposable.pool });
  await runOwnerWorkoutTrackingMigration({ pool: disposable.pool });
  await runOwnerEditableWorkoutSessionsMigration({ pool: disposable.pool });
  await runMemberSafetyIntakeMigration({ pool: disposable.pool });
  await runPendingEnrollmentMigration({ pool: disposable.pool });
  await runNullableNamesMigration({
    pool: disposable.pool,
    environment: disabledEnvironment,
  });
  assert.match((await disposable.pool.query(
    "SHOW server_version"
  )).rows[0].server_version, /^16\./);
  const member = (await disposable.pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('94001', 'Alpha', 'Guard') RETURNING id`
  )).rows[0];
  return { disposable, member };
}

function input(memberId) {
  return {
    action: "create",
    memberId: String(memberId),
    authProvider: "clerk",
    authSubject: "user_alpha_native_guard",
    verifiedEmail: "alpha-native@example.test",
    provisioningReference: "native-revision-3-test",
    activate: false,
  };
}

test("alpha-owner times out behind a migration-style pending-table lock with no mapping", {
  skip: skipForRoot,
  timeout: 15000,
}, async (t) => {
  const { disposable, member } = await postgresAt011(t);
  let blocker;
  try {
    blocker = await disposable.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "LOCK TABLE goals_coach_member_pending_enrollments IN ACCESS SHARE MODE"
    );
    const started = process.hrtime.bigint();
    await assert.rejects(provisionAlphaOwner({
      pool: disposable.pool,
      input: input(member.id),
      environment: disabledEnvironment,
    }), (error) => error.message === PROTECTED_FAILURE);
    const elapsed = Number((process.hrtime.bigint() - started) / 1000000n);
    assert.equal(elapsed >= 4500, true);
    assert.equal(elapsed <= 5500, true);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings"
    )).rows[0].count, 0);
  } finally {
    if (blocker) {
      try { await blocker.query("ROLLBACK"); } catch (_) {}
      blocker.release();
    }
  }
});

test("alpha-owner never resets its budget after a long pending lock wait", {
  skip: skipForRoot,
  timeout: 15000,
}, async (t) => {
  const { disposable, member } = await postgresAt011(t);
  let pendingBlocker;
  let memberBlocker;
  let releasePending;
  let pendingRollback;
  try {
    pendingBlocker = await disposable.pool.connect();
    memberBlocker = await disposable.pool.connect();
    await pendingBlocker.query("BEGIN");
    await pendingBlocker.query(
      "LOCK TABLE goals_coach_member_pending_enrollments IN ACCESS SHARE MODE"
    );
    await memberBlocker.query("BEGIN");
    await memberBlocker.query(
      "SELECT id FROM coach_members WHERE id = $1 FOR UPDATE",
      [member.id]
    );
    releasePending = setTimeout(() => {
      pendingRollback = pendingBlocker.query("ROLLBACK").catch(() => {});
    }, 4200);
    const started = process.hrtime.bigint();
    await assert.rejects(provisionAlphaOwner({
      pool: disposable.pool,
      input: input(member.id),
      environment: disabledEnvironment,
    }), (error) => error.message === PROTECTED_FAILURE);
    const elapsed = Number((process.hrtime.bigint() - started) / 1000000n);
    assert.equal(elapsed >= 4500, true);
    assert.equal(elapsed <= 5500, true);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings"
    )).rows[0].count, 0);
  } finally {
    if (releasePending) clearTimeout(releasePending);
    if (pendingBlocker) {
      if (pendingRollback) await pendingRollback;
      else {
        try { await pendingBlocker.query("ROLLBACK"); } catch (_) {}
      }
      pendingBlocker.release();
    }
    for (const blocker of [memberBlocker]) {
      if (!blocker) continue;
      try { await blocker.query("ROLLBACK"); } catch (_) {}
      blocker.release();
    }
  }
});

test("alpha-owner and actual Migration 011 replay serialize pending-first without deadlock", {
  skip: skipForRoot,
  timeout: 15000,
}, async (t) => {
  const { disposable, member } = await postgresAt011(t);
  let reachedMemberLock;
  const atMemberLock = new Promise((resolve) => { reachedMemberLock = resolve; });
  let resumeMemberLock;
  const resume = new Promise((resolve) => { resumeMemberLock = resolve; });
  const migrationPool = {
    async connect() {
      const client = await disposable.pool.connect();
      return {
        async query(sql, parameters) {
          if (sql === "LOCK TABLE coach_members IN ACCESS EXCLUSIVE MODE") {
            reachedMemberLock();
            await resume;
          }
          return client.query(sql, parameters);
        },
        release(error) { client.release(error); },
      };
    },
  };
  let migration;
  let script;
  try {
    migration = runNullableNamesMigration({
      pool: migrationPool,
      environment: disabledEnvironment,
    });
    await atMemberLock;
    let scriptSettled = false;
    script = provisionAlphaOwner({
      pool: disposable.pool,
      input: input(member.id),
      environment: disabledEnvironment,
    }).finally(() => { scriptSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(scriptSettled, false);
    resumeMemberLock();
    assert.equal((await migration).status, "already_applied");
    assert.equal((await script).status, "created");
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings"
    )).rows[0].count, 1);
  } finally {
    resumeMemberLock();
    await Promise.allSettled([migration, script].filter(Boolean));
  }
});
