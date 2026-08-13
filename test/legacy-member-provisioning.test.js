"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  PLAN_DATABASE_PHASE_MILLISECONDS,
  PLAN_OUTER_MILLISECONDS,
  PLAN_PROVIDER_MILLISECONDS,
  createPlanRouteTerminalContext,
  createWeeklyCheckinSessionState,
  executePersonalizedPlan,
} = require("../src/goals-coach/legacy-member-provisioning");
const {
  createGymMasterMemberPendingEnrollmentService,
} = require("../src/goals-coach/gymmaster-member-pending-enrollment");
const {
  createGymMasterMemberLoginService,
} = require("../src/goals-coach/gymmaster-member-login");
const {
  applyMigration011ForTests,
  createDisposableDatabase,
  seedStaff,
} = require("./helpers/disposable-db");
const { runMigration: runSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");

async function fixture(t) {
  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  await runSafetyIntakeMigration({ pool: disposable.pool });
  await runPendingEnrollmentMigration({ pool: disposable.pool });
  await applyMigration011ForTests(disposable.pool);
  return disposable;
}

function routeContext() {
  const req = new EventEmitter();
  req.complete = true;
  const res = new EventEmitter();
  res.writableEnded = false;
  return { req, res, route: createPlanRouteTerminalContext(req, res) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function observedPool(pool) {
  let activeClients = 0;
  let checkouts = 0;
  return {
    get activeClients() { return activeClients; },
    get checkouts() { return checkouts; },
    async query(sql, parameters) { return pool.query(sql, parameters); },
    async connect() {
      checkouts += 1;
      const client = await pool.connect();
      activeClients += 1;
      let released = false;
      return {
        query: client.query.bind(client),
        release(error) {
          assert.equal(released, false, "client released exactly once");
          released = true;
          activeClients -= 1;
          client.release(error);
        },
      };
    },
  };
}

async function authenticatedIdentity(memberId, email = `legacy-${memberId}@example.test`) {
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
  }).authenticate({ email, password: "synthetic-password" });
}

test("personalized plan uses two short transactions and no database resource during its one provider attempt", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const context = routeContext();
  t.after(() => context.route.cleanup());
  let attempts = 0;
  const plan = await executePersonalizedPlan({
    pool,
    route: context.route,
    gymmasterMemberId: "81001",
    firstName: "Legacy",
    lastName: "Member",
    profile: { daysPerWeek: 3 },
    messages: [{ role: "user", content: "Synthetic" }],
    async generatePlan(options) {
      attempts += 1;
      assert.equal(pool.activeClients, 0);
      assert.equal(options.timeout, 30000);
      assert.equal(options.maxRetries, 0);
      assert.equal(options.signal.aborted, false);
      return "# Synthetic plan";
    },
  });
  assert.equal(plan, "# Synthetic plan");
  assert.equal(attempts, 1);
  assert.equal(pool.activeClients, 0);
  assert.equal(pool.checkouts, 2);
  const member = (await pool.query(
    "SELECT * FROM coach_members WHERE gymmaster_member_id = '81001'"
  )).rows[0];
  assert.equal(member.first_name, "Legacy");
  assert.equal(member.last_name, "Member");
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_plans WHERE member_id = $1",
    [member.id]
  )).rows[0].count, 1);
});

test("approval during provider work discards AI output and writes no legacy member or plan", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const admin = await seedStaff(pool, "legacy-race", "admin", true);
  const enrollment = createGymMasterMemberPendingEnrollmentService({
    db: pool,
    membershipVerifier: {
      async verifyActiveMember(memberId) { return { active: memberId === "81002" }; },
    },
    transactionTimestamp: () => new Date("2099-08-10T12:00:00.000Z"),
  });
  const context = routeContext();
  t.after(() => context.route.cleanup());
  await assert.rejects(executePersonalizedPlan({
    pool,
    route: context.route,
    gymmasterMemberId: "81002",
    firstName: "Legacy",
    lastName: "Member",
    profile: {},
    messages: [],
    async generatePlan() {
      assert.equal(pool.activeClients, 0);
      await enrollment.createPendingEnrollment(
        { id: String(admin.id), role: "admin" },
        {
          gymmasterMemberId: "81002",
          clientRequestId: "00000000-0000-4000-8000-000000008102",
        }
      );
      return "# Discard me";
    },
  }));
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_members WHERE gymmaster_member_id = '81002'"
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_plans"
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_member_pending_enrollments WHERE gymmaster_member_id = '81002'"
  )).rows[0].count, 1);
});

test("live pending and NULL-name rows block before provider; populated names remain byte-identical", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const admin = await seedStaff(pool, "legacy-block", "admin", true);
  await pool.query(
    `INSERT INTO goals_coach_member_pending_enrollments
      (member_id, gymmaster_member_id, client_request_id,
       requested_by_staff_user_id, status, created_at, expires_at)
     VALUES (NULL, '81003', '00000000-0000-4000-8000-000000008103',
             $1, 'pending', '2099-08-10T12:00:00Z', '2099-08-11T12:00:00Z')`,
    [admin.id]
  );
  await pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('81004', NULL, NULL), ('81005', 'Byte Exact', 'Display')`
  );

  for (const memberId of ["81003", "81004"]) {
    const context = routeContext();
    let providerCalls = 0;
    await assert.rejects(executePersonalizedPlan({
      pool,
      route: context.route,
      gymmasterMemberId: memberId,
      firstName: "Unsafe",
      lastName: "Input",
      profile: {},
      messages: [],
      async generatePlan() { providerCalls += 1; return "# Must not run"; },
    }));
    context.route.cleanup();
    assert.equal(providerCalls, 0);
  }

  const context = routeContext();
  await executePersonalizedPlan({
    pool,
    route: context.route,
    gymmasterMemberId: "81005",
    firstName: "Different",
    lastName: "Input",
    profile: {},
    messages: [],
    async generatePlan() { return "# Preserved"; },
  });
  context.route.cleanup();
  const preserved = (await pool.query(
    "SELECT first_name, last_name FROM coach_members WHERE gymmaster_member_id = '81005'"
  )).rows[0];
  assert.deepEqual(preserved, { first_name: "Byte Exact", last_name: "Display" });
});

test("weekly session creates historically named members only without live pending and never repairs NULL names", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const first = await createWeeklyCheckinSessionState({
    pool,
    gymmasterMemberId: "81006",
    firstName: "Weekly",
    lastName: "Member",
    weekStart: "2026-08-10",
    buildToken: (memberId, gymmasterId, firstName) => `${memberId}:${gymmasterId}:${firstName}`,
  });
  assert.match(first.sessionToken, /^[1-9][0-9]*:81006:Weekly$/);
  const second = await createWeeklyCheckinSessionState({
    pool,
    gymmasterMemberId: "81006",
    firstName: "Changed",
    lastName: "Input",
    weekStart: "2026-08-10",
    buildToken: () => "second-token",
  });
  assert.equal(second.sessionToken, "second-token");
  const preserved = (await pool.query(
    "SELECT first_name, last_name FROM coach_members WHERE gymmaster_member_id = '81006'"
  )).rows[0];
  assert.deepEqual(preserved, { first_name: "Weekly", last_name: "Member" });

  await pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('81007', NULL, NULL)`
  );
  let tokenCalls = 0;
  await assert.rejects(createWeeklyCheckinSessionState({
    pool,
    gymmasterMemberId: "81007",
    firstName: "Repair",
    lastName: "Refused",
    weekStart: "2026-08-10",
    buildToken: () => { tokenCalls += 1; return "must-not-issue"; },
  }));
  assert.equal(tokenCalls, 0);
  const nameless = (await pool.query(
    "SELECT first_name, last_name FROM coach_members WHERE gymmaster_member_id = '81007'"
  )).rows[0];
  assert.deepEqual(nameless, { first_name: null, last_name: null });
});

test("HTTP abort during the provider attempt drains a late result and prevents Phase 3", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const context = routeContext();
  t.after(() => context.route.cleanup());
  const provider = deferred();
  let observedSignal;
  const execution = executePersonalizedPlan({
    pool,
    route: context.route,
    gymmasterMemberId: "81008",
    firstName: "Abort",
    lastName: "Member",
    profile: {},
    messages: [],
    generatePlan({ signal }) {
      observedSignal = signal;
      return provider.promise;
    },
  });
  while (!observedSignal) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.activeClients, 0);
  context.req.emit("aborted");
  await assert.rejects(execution);
  assert.equal(observedSignal.aborted, true);
  provider.resolve("# Late result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.checkouts, 1);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_members WHERE gymmaster_member_id = '81008'"
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_plans"
  )).rows[0].count, 0);
});

test("a normal completed request close is not treated as an abort", () => {
  const context = routeContext();
  context.req.complete = true;
  context.req.emit("close");
  assert.equal(context.route.terminalState.isTerminal(), false);
  context.route.cleanup();
});

test("provider and route limits are exact and a retryable failure is attempted once", async (t) => {
  assert.equal(PLAN_DATABASE_PHASE_MILLISECONDS, 5000);
  assert.equal(PLAN_OUTER_MILLISECONDS, 45000);
  assert.equal(PLAN_PROVIDER_MILLISECONDS, 30000);
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const context = routeContext();
  t.after(() => context.route.cleanup());
  let attempts = 0;
  await assert.rejects(executePersonalizedPlan({
    pool,
    route: context.route,
    gymmasterMemberId: "81014",
    firstName: "One",
    lastName: "Attempt",
    profile: {},
    messages: [],
    async generatePlan(options) {
      attempts += 1;
      assert.equal(options.timeout, 30000);
      assert.equal(options.maxRetries, 0);
      throw new Error("synthetic retryable provider failure");
    },
  }));
  assert.equal(attempts, 1);
  assert.equal(pool.checkouts, 1);
  assert.equal(pool.activeClients, 0);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_members WHERE gymmaster_member_id = '81014'"
  )).rows[0].count, 0);
});

test("premature response close aborts one provider attempt and drains its late rejection", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const context = routeContext();
  t.after(() => context.route.cleanup());
  const provider = deferred();
  let observedSignal;
  const run = executePersonalizedPlan({
    pool,
    route: context.route,
    gymmasterMemberId: "81015",
    firstName: "Response",
    lastName: "Closed",
    profile: {},
    messages: [],
    generatePlan({ signal }) {
      observedSignal = signal;
      return provider.promise;
    },
  });
  while (!observedSignal) await new Promise((resolve) => setImmediate(resolve));
  context.res.emit("close");
  await assert.rejects(run);
  assert.equal(observedSignal.aborted, true);
  provider.reject(new Error("late provider rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.checkouts, 1);
  assert.equal(pool.activeClients, 0);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_plans"
  )).rows[0].count, 0);
});

test("weekly session and approval serialize safely in both completed orders", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const admin = await seedStaff(pool, "weekly-order", "admin", true);
  const enrollment = createGymMasterMemberPendingEnrollmentService({
    db: pool,
    membershipVerifier: {
      async verifyActiveMember(memberId) {
        return { active: memberId === "81009" || memberId === "81010" };
      },
    },
    transactionTimestamp: () => new Date("2099-08-10T12:00:00.000Z"),
  });

  await createWeeklyCheckinSessionState({
    pool,
    gymmasterMemberId: "81009",
    firstName: "Legacy First",
    lastName: "Display",
    weekStart: "2099-08-10",
    buildToken: () => "legacy-first-token",
  });
  await enrollment.createPendingEnrollment(
    { id: String(admin.id), role: "admin" },
    {
      gymmasterMemberId: "81009",
      clientRequestId: "00000000-0000-4000-8000-000000008109",
    }
  );
  assert.deepEqual((await pool.query(
    "SELECT first_name, last_name FROM coach_members WHERE gymmaster_member_id = '81009'"
  )).rows[0], { first_name: "Legacy First", last_name: "Display" });

  await enrollment.createPendingEnrollment(
    { id: String(admin.id), role: "admin" },
    {
      gymmasterMemberId: "81010",
      clientRequestId: "00000000-0000-4000-8000-000000008110",
    }
  );
  let tokenCalls = 0;
  await assert.rejects(createWeeklyCheckinSessionState({
    pool,
    gymmasterMemberId: "81010",
    firstName: "Approval",
    lastName: "Won",
    weekStart: "2099-08-10",
    buildToken: () => { tokenCalls += 1; return "must-not-issue"; },
  }));
  assert.equal(tokenCalls, 0);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_members WHERE gymmaster_member_id = '81010'"
  )).rows[0].count, 0);
});

test("authenticated completion leaves a NULL profile that blocks both legacy writers", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const admin = await seedStaff(pool, "legacy-completion-null", "admin", true);
  const enrollment = createGymMasterMemberPendingEnrollmentService({
    db: pool,
    membershipVerifier: {
      async verifyActiveMember(memberId) { return { active: memberId === "81011" }; },
    },
    transactionTimestamp: () => new Date("2099-08-10T12:00:00.000Z"),
  });
  await enrollment.createPendingEnrollment(
    { id: String(admin.id), role: "admin" },
    {
      gymmasterMemberId: "81011",
      clientRequestId: "00000000-0000-4000-8000-000000008111",
    }
  );
  const completion = await enrollment.completeAuthenticatedEnrollment(
    await authenticatedIdentity("81011")
  );
  assert.equal(completion.active, true);

  const context = routeContext();
  let providerCalls = 0;
  await assert.rejects(executePersonalizedPlan({
    pool,
    route: context.route,
    gymmasterMemberId: "81011",
    firstName: "Must Not",
    lastName: "Repair",
    profile: {},
    messages: [],
    async generatePlan() { providerCalls += 1; return "# forbidden"; },
  }));
  context.route.cleanup();
  let tokenCalls = 0;
  await assert.rejects(createWeeklyCheckinSessionState({
    pool,
    gymmasterMemberId: "81011",
    firstName: "Must Not",
    lastName: "Repair",
    weekStart: "2099-08-10",
    buildToken: () => { tokenCalls += 1; return "forbidden"; },
  }));
  assert.equal(providerCalls, 0);
  assert.equal(tokenCalls, 0);
  assert.deepEqual((await pool.query(
    "SELECT first_name, last_name FROM coach_members WHERE gymmaster_member_id = '81011'"
  )).rows[0], { first_name: null, last_name: null });
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM coach_plans"
  )).rows[0].count, 0);
});

test("legacy-first plan and weekly members keep byte-exact names through completion", async (t) => {
  const disposable = await fixture(t);
  const pool = observedPool(disposable.pool);
  const admin = await seedStaff(pool, "legacy-completion-named", "admin", true);
  const enrollment = createGymMasterMemberPendingEnrollmentService({
    db: pool,
    membershipVerifier: {
      async verifyActiveMember(memberId) {
        return { active: memberId === "81012" || memberId === "81013" };
      },
    },
    transactionTimestamp: () => new Date("2099-08-10T12:00:00.000Z"),
  });

  const context = routeContext();
  await executePersonalizedPlan({
    pool,
    route: context.route,
    gymmasterMemberId: "81012",
    firstName: "Plan First",
    lastName: "Display Bytes",
    profile: {},
    messages: [],
    async generatePlan() { return "# legacy first"; },
  });
  context.route.cleanup();
  await createWeeklyCheckinSessionState({
    pool,
    gymmasterMemberId: "81013",
    firstName: "Weekly First",
    lastName: "Display Bytes",
    weekStart: "2099-08-10",
    buildToken: () => "legacy-first",
  });

  for (const [memberId, requestSuffix] of [["81012", "8112"], ["81013", "8113"]]) {
    await enrollment.createPendingEnrollment(
      { id: String(admin.id), role: "admin" },
      {
        gymmasterMemberId: memberId,
        clientRequestId:
          `00000000-0000-4000-8000-${requestSuffix.padStart(12, "0")}`,
      }
    );
    const result = await enrollment.completeAuthenticatedEnrollment(
      await authenticatedIdentity(memberId)
    );
    assert.equal(result.active, true);
  }
  assert.deepEqual((await pool.query(
    `SELECT gymmaster_member_id, first_name, last_name
     FROM coach_members
     WHERE gymmaster_member_id IN ('81012', '81013')
     ORDER BY gymmaster_member_id`
  )).rows, [
    {
      gymmaster_member_id: "81012",
      first_name: "Plan First",
      last_name: "Display Bytes",
    },
    {
      gymmaster_member_id: "81013",
      first_name: "Weekly First",
      last_name: "Display Bytes",
    },
  ]);
});
