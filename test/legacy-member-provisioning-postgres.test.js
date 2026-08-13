"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { runMigration: runPhase1cTranscriptionMigration } = require("../migrate_005");
const { runMigration: runPhase1dSafetyMigration } = require("../migrate_006");
const { runMigration: runOwnerWorkoutTrackingMigration } = require("../migrate_007");
const { runMigration: runOwnerEditableWorkoutSessionsMigration } = require("../migrate_008");
const { runMigration: runMemberSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");
const { runMigration: runNullableNamesMigration } = require("../migrate_011");
const {
  createGymMasterMemberPendingEnrollmentService,
} = require("../src/goals-coach/gymmaster-member-pending-enrollment");
const {
  createGymMasterMemberLoginService,
} = require("../src/goals-coach/gymmaster-member-login");
const {
  createPlanRouteTerminalContext,
  createWeeklyCheckinSessionState,
  executePersonalizedPlan,
} = require("../src/goals-coach/legacy-member-provisioning");
const {
  acquireGymMasterMemberProvisioningLock,
} = require("../src/goals-coach/gymmaster-member-provisioning-lock");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires unprivileged PostgreSQL 16; root skips are not acceptance evidence"
  : false;
const disabledEnvironment = {
  GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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
  const admin = (await disposable.pool.query(
    `INSERT INTO staff_users
      (auth_provider, auth_subject, email, display_name, role, active)
     VALUES ('clerk', 'user_legacy_overlap', 'overlap@example.test',
             'Overlap', 'admin', TRUE) RETURNING id`
  )).rows[0];
  return { disposable, admin };
}

function enrollmentService(pool, ids) {
  return createGymMasterMemberPendingEnrollmentService({
    db: pool,
    membershipVerifier: {
      async verifyActiveMember(memberId) { return { active: ids.has(memberId) }; },
    },
  });
}

async function identity(memberId) {
  return createGymMasterMemberLoginService({
    enabled: true,
    memberApiKey: "synthetic-member-api-key",
    loginClient: async () => ({
      result: {
        token: "synthetic-provider-token",
        expires: 3600,
        memberid: Number(memberId),
      },
    }),
  }).authenticate({
    email: `overlap-${memberId}@example.test`,
    password: "synthetic-password",
  });
}

function pausedAfterAdvisoryPool(pool, memberId, reached, resume, occurrence = 1) {
  let acquisitions = 0;
  return {
    async query(sql, parameters) { return pool.query(sql, parameters); },
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, parameters) {
          const result = await client.query(sql, parameters);
          if (
            /pg_advisory_xact_lock/.test(sql)
            && parameters
            && parameters[0] === memberId
          ) {
            acquisitions += 1;
            if (acquisitions === occurrence) {
              reached.resolve();
              await resume.promise;
            }
          }
          return result;
        },
        release(error) { client.release(error); },
      };
    },
  };
}

async function waitForLockWaiter(pool) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT 1
       FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND query LIKE '%pg_advisory_xact_lock%'
       LIMIT 1`
    );
    if (result.rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("expected advisory-lock waiter");
}

function planOptions(pool, memberId) {
  const req = new EventEmitter();
  req.complete = true;
  const res = new EventEmitter();
  res.writableEnded = false;
  const route = createPlanRouteTerminalContext(req, res);
  return {
    route,
    run: () => executePersonalizedPlan({
      pool,
      route,
      gymmasterMemberId: memberId,
      firstName: "Legacy",
      lastName: "Overlap",
      profile: {},
      messages: [],
      async generatePlan() { return "# overlap"; },
    }),
  };
}

test("native approval and both legacy writers serialize in both lock orders", {
  skip: skipForRoot,
  timeout: 30000,
}, async (t) => {
  const { disposable, admin } = await postgresAt011(t);
  for (const [memberId, kind] of [["97001", "plan"], ["97002", "weekly"]]) {
    const service = enrollmentService(disposable.pool, new Set([memberId]));
    const reached = deferred();
    const resume = deferred();
    const legacyPool = pausedAfterAdvisoryPool(
      disposable.pool,
      memberId,
      reached,
      resume,
      kind === "plan" ? 2 : 1
    );
    const plan = kind === "plan" ? planOptions(legacyPool, memberId) : null;
    let legacy;
    let approval;
    try {
      legacy = kind === "plan"
        ? plan.run()
        : createWeeklyCheckinSessionState({
          pool: legacyPool,
          gymmasterMemberId: memberId,
          firstName: "Legacy",
          lastName: "Overlap",
          weekStart: "2026-08-10",
          buildToken: () => "overlap-token",
        });
      await reached.promise;
      approval = service.createPendingEnrollment(
        { id: String(admin.id), role: "admin" },
        {
          gymmasterMemberId: memberId,
          clientRequestId:
            `00000000-0000-4000-8000-${memberId.padStart(12, "0")}`,
        }
      );
      await waitForLockWaiter(disposable.pool);
      resume.resolve();
      await legacy;
      assert.equal((await approval).created, true);
      assert.deepEqual((await disposable.pool.query(
        "SELECT first_name, last_name FROM coach_members WHERE gymmaster_member_id = $1",
        [memberId]
      )).rows[0], { first_name: "Legacy", last_name: "Overlap" });
    } finally {
      resume.resolve();
      await Promise.allSettled([legacy, approval].filter(Boolean));
      if (plan) plan.route.cleanup();
    }

    const approvalFirstId = String(Number(memberId) + 10);
    const approvalFirstService = enrollmentService(
      disposable.pool,
      new Set([approvalFirstId])
    );
    await approvalFirstService.createPendingEnrollment(
      { id: String(admin.id), role: "admin" },
      {
        gymmasterMemberId: approvalFirstId,
        clientRequestId:
          `00000000-0000-4000-8000-${approvalFirstId.padStart(12, "0")}`,
      }
    );
    let sideEffectCalls = 0;
    if (kind === "plan") {
      const blocked = planOptions(disposable.pool, approvalFirstId);
      try {
        await assert.rejects(blocked.run());
      } finally {
        blocked.route.cleanup();
      }
    } else {
      await assert.rejects(createWeeklyCheckinSessionState({
        pool: disposable.pool,
        gymmasterMemberId: approvalFirstId,
        firstName: "Must Not",
        lastName: "Insert",
        weekStart: "2026-08-10",
        buildToken: () => { sideEffectCalls += 1; return "forbidden"; },
      }));
    }
    assert.equal(sideEffectCalls, 0);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM coach_members WHERE gymmaster_member_id = $1",
      [approvalFirstId]
    )).rows[0].count, 0);
  }
});

test("native completion serializes against plan and weekly writers without name repair", {
  skip: skipForRoot,
  timeout: 30000,
}, async (t) => {
  const { disposable, admin } = await postgresAt011(t);
  for (const [memberId, kind] of [["97021", "plan"], ["97022", "weekly"]]) {
    const approvalService = enrollmentService(
      disposable.pool,
      new Set([memberId])
    );
    await approvalService.createPendingEnrollment(
      { id: String(admin.id), role: "admin" },
      {
        gymmasterMemberId: memberId,
        clientRequestId:
          `00000000-0000-4000-8000-${memberId.padStart(12, "0")}`,
      }
    );
    const reached = deferred();
    const resume = deferred();
    const completionPool = pausedAfterAdvisoryPool(
      disposable.pool,
      memberId,
      reached,
      resume
    );
    const completionService = enrollmentService(
      completionPool,
      new Set([memberId])
    );
    const completion = completionService.completeAuthenticatedEnrollment(
      await identity(memberId)
    );
    await reached.promise;
    let sideEffectCalls = 0;
    let legacy;
    let plan;
    try {
      if (kind === "plan") {
        plan = planOptions(disposable.pool, memberId);
        legacy = plan.run();
      } else {
        legacy = createWeeklyCheckinSessionState({
          pool: disposable.pool,
          gymmasterMemberId: memberId,
          firstName: "Must Not",
          lastName: "Repair",
          weekStart: "2026-08-10",
          buildToken: () => { sideEffectCalls += 1; return "forbidden"; },
        });
      }
      await waitForLockWaiter(disposable.pool);
      resume.resolve();
      assert.equal((await completion).active, true);
      await assert.rejects(legacy);
      assert.equal(sideEffectCalls, 0);
      assert.deepEqual((await disposable.pool.query(
        "SELECT first_name, last_name FROM coach_members WHERE gymmaster_member_id = $1",
        [memberId]
      )).rows[0], { first_name: null, last_name: null });
    } finally {
      resume.resolve();
      await Promise.allSettled([completion, legacy].filter(Boolean));
      if (plan) plan.route.cleanup();
    }
  }
});
