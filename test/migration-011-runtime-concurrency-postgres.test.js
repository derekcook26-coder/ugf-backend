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
     VALUES ('clerk', 'user_migration_runtime', 'runtime@example.test',
             'Runtime', 'admin', TRUE) RETURNING id`
  )).rows[0];
  return { disposable, admin };
}

function pausedReplayPool(pool, reached, resume) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, parameters) {
          if (sql === "LOCK TABLE coach_members IN ACCESS EXCLUSIVE MODE") {
            reached.resolve();
            await resume.promise;
          }
          return client.query(sql, parameters);
        },
        release(error) { client.release(error); },
      };
    },
  };
}

async function provePendingFirstSerialization(disposable, operation) {
  const reached = deferred();
  const resume = deferred();
  let migration;
  let runtime;
  try {
    migration = runNullableNamesMigration({
      pool: pausedReplayPool(disposable.pool, reached, resume),
      environment: disabledEnvironment,
    });
    await reached.promise;
    let runtimeSettled = false;
    runtime = Promise.resolve()
      .then(operation)
      .finally(() => { runtimeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(runtimeSettled, false, "runtime writer must wait behind pending table");
    resume.resolve();
    const [migrationResult, runtimeResult] = await Promise.all([
      migration,
      runtime,
    ]);
    assert.equal(migrationResult.status, "already_applied");
    return runtimeResult;
  } finally {
    resume.resolve();
    await Promise.allSettled([migration, runtime].filter(Boolean));
  }
}

function service(pool, memberIds) {
  return createGymMasterMemberPendingEnrollmentService({
    db: pool,
    membershipVerifier: {
      async verifyActiveMember(memberId) {
        return { active: memberIds.has(memberId) };
      },
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
    email: `runtime-${memberId}@example.test`,
    password: "synthetic-password",
  });
}

test("Migration 011 replay serializes pending-first with approval", {
  skip: skipForRoot,
  timeout: 20000,
}, async (t) => {
  const { disposable, admin } = await postgresAt011(t);
  const enrollment = service(disposable.pool, new Set(["96001"]));
  const result = await provePendingFirstSerialization(disposable, () => (
    enrollment.createPendingEnrollment(
      { id: String(admin.id), role: "admin" },
      {
        gymmasterMemberId: "96001",
        clientRequestId: "00000000-0000-4000-8000-000000009601",
      }
    )
  ));
  assert.equal(result.created, true);
});

test("Migration 011 replay serializes pending-first with authenticated completion", {
  skip: skipForRoot,
  timeout: 20000,
}, async (t) => {
  const { disposable, admin } = await postgresAt011(t);
  const enrollment = service(disposable.pool, new Set(["96002"]));
  await enrollment.createPendingEnrollment(
    { id: String(admin.id), role: "admin" },
    {
      gymmasterMemberId: "96002",
      clientRequestId: "00000000-0000-4000-8000-000000009602",
    }
  );
  const result = await provePendingFirstSerialization(disposable, async () => (
    enrollment.completeAuthenticatedEnrollment(await identity("96002"))
  ));
  assert.equal(result.active, true);
});

test("Migration 011 replay serializes pending-first with both plan database phases", {
  skip: skipForRoot,
  timeout: 20000,
}, async (t) => {
  const { disposable } = await postgresAt011(t);
  await disposable.pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('96003', 'Plan', 'Runtime')`
  );
  const req = new EventEmitter();
  req.complete = true;
  const res = new EventEmitter();
  res.writableEnded = false;
  const route = createPlanRouteTerminalContext(req, res);
  try {
    const result = await provePendingFirstSerialization(disposable, () => (
      executePersonalizedPlan({
        pool: disposable.pool,
        route,
        gymmasterMemberId: "96003",
        firstName: "Plan",
        lastName: "Runtime",
        profile: {},
        messages: [],
        async generatePlan() { return "# Native serialization"; },
      })
    ));
    assert.equal(result, "# Native serialization");
  } finally {
    route.cleanup();
  }
});

test("Migration 011 replay serializes pending-first with plan Phase 3", {
  skip: skipForRoot,
  timeout: 20000,
}, async (t) => {
  const { disposable } = await postgresAt011(t);
  await disposable.pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('96005', 'Plan Three', 'Runtime')`
  );
  const req = new EventEmitter();
  req.complete = true;
  const res = new EventEmitter();
  res.writableEnded = false;
  const route = createPlanRouteTerminalContext(req, res);
  const providerReached = deferred();
  const providerResume = deferred();
  const reached = deferred();
  const resume = deferred();
  let migration;
  let plan;
  try {
    plan = executePersonalizedPlan({
      pool: disposable.pool,
      route,
      gymmasterMemberId: "96005",
      firstName: "Plan Three",
      lastName: "Runtime",
      profile: {},
      messages: [],
      async generatePlan() {
        providerReached.resolve();
        await providerResume.promise;
        return "# Phase 3 serialization";
      },
    });
    await providerReached.promise;

    migration = runNullableNamesMigration({
      pool: pausedReplayPool(disposable.pool, reached, resume),
      environment: disabledEnvironment,
    });
    await reached.promise;
    providerResume.resolve();
    let planSettled = false;
    plan.finally(() => { planSettled = true; }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(planSettled, false);
    resume.resolve();
    assert.equal((await migration).status, "already_applied");
    assert.equal(await plan, "# Phase 3 serialization");
  } finally {
    providerResume.resolve();
    resume.resolve();
    await Promise.allSettled([migration, plan].filter(Boolean));
    route.cleanup();
  }
});

test("Migration 011 replay serializes pending-first with the weekly writer", {
  skip: skipForRoot,
  timeout: 20000,
}, async (t) => {
  const { disposable } = await postgresAt011(t);
  await disposable.pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('96004', 'Weekly', 'Runtime')`
  );
  const result = await provePendingFirstSerialization(disposable, () => (
    createWeeklyCheckinSessionState({
      pool: disposable.pool,
      gymmasterMemberId: "96004",
      firstName: "Weekly",
      lastName: "Runtime",
      weekStart: "2026-08-10",
      buildToken: () => "native-weekly-token",
    })
  ));
  assert.equal(result.sessionToken, "native-weekly-token");
});
