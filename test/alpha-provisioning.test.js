const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  PROTECTED_FAILURE,
  loadProvisioningInput,
  provisionAlphaOwner,
} = require("../scripts/provision-alpha-owner");
const {
  applyMigration011ForTests,
  createDisposableDatabase,
} = require("./helpers/disposable-db");
const { runMigration: runSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");

function inputFor(memberId, overrides = {}) {
  return {
    action: "create",
    memberId: String(memberId),
    authProvider: "clerk",
    authSubject: "user_alpha_provisioned",
    verifiedEmail: "synthetic-owner@example.test",
    provisioningReference: "approved-phase-1a-test",
    activate: false,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function syntheticAlphaClient(options = {}) {
  const queries = [];
  const releases = [];
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (options.commitUnknown && sql === "COMMIT") {
        throw new Error("synthetic unknown commit");
      }
      if (/FROM information_schema\.columns/.test(sql)) {
        return { rows: [
          { column_name: "expires_at", data_type: "timestamp with time zone", is_nullable: "NO" },
          { column_name: "gymmaster_member_id", data_type: "text", is_nullable: "NO" },
          { column_name: "status", data_type: "text", is_nullable: "NO" },
        ] };
      }
      if (/FROM pg_constraint constraint_row/.test(sql)) {
        return { rows: [
          { definition: "CHECK ((status = ANY (ARRAY['pending'::text, 'consumed'::text, 'expired'::text])))" },
          { definition: "CHECK ((((status = 'pending'::text) AND (auth_mapping_id IS NULL) AND (consumed_at IS NULL) AND (expired_at IS NULL)) OR ((status = 'consumed'::text) AND (auth_mapping_id IS NOT NULL) AND (consumed_at IS NOT NULL) AND (expired_at IS NULL)) OR ((status = 'expired'::text) AND (auth_mapping_id IS NULL) AND (consumed_at IS NULL) AND (expired_at IS NOT NULL))))" },
        ] };
      }
      if (/FROM coach_members/.test(sql)) {
        return { rows: [{ id: "1", gymmaster_member_id: "95001" }] };
      }
      if (/FROM goals_coach_member_pending_enrollments/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM goals_coach_member_auth_mappings/.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT INTO goals_coach_member_auth_mappings/.test(sql)) {
        return { rows: [{ id: "9", active: false }] };
      }
      return { rows: [] };
    },
    release(error) { releases.push(error); },
  };
  return { client, queries, releases };
}

async function alphaFixture(t) {
  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  await runSafetyIntakeMigration({ pool: disposable.pool });
  await runPendingEnrollmentMigration({ pool: disposable.pool });
  await applyMigration011ForTests(disposable.pool);
  return disposable;
}

function provision(pool, input, overrides = {}) {
  return provisionAlphaOwner({
    pool,
    input,
    environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" },
    ...overrides,
  });
}

async function seedCanonicalMember(pool, gymmasterMemberId) {
  return (await pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ($1, 'Synthetic', 'Member')
     RETURNING *`,
    [gymmasterMemberId]
  )).rows[0];
}

test("alpha provisioning accepts protected environment input and rejects malformed or missing values", () => {
  const valid = loadProvisioningInput({
    GOALS_COACH_PROVISION_ACTION: "create",
    GOALS_COACH_PROVISION_MEMBER_ID: "11",
    GOALS_COACH_PROVISION_AUTH_PROVIDER: "clerk",
    GOALS_COACH_PROVISION_AUTH_SUBJECT: "user_alpha_example",
    GOALS_COACH_PROVISION_VERIFIED_EMAIL: "synthetic@example.test",
    GOALS_COACH_PROVISIONING_REFERENCE: "approved-test",
  });
  assert.equal(valid.activate, false);
  assert.equal(valid.authSubject, "user_alpha_example");
  assert.throws(() => loadProvisioningInput({}), /GOALS_COACH_PROVISION_ACTION is required/);
  assert.throws(() => loadProvisioningInput({
    GOALS_COACH_PROVISION_ACTION: "create",
    GOALS_COACH_PROVISION_MEMBER_ID: "11",
    GOALS_COACH_PROVISION_AUTH_PROVIDER: "clerk",
    GOALS_COACH_PROVISION_AUTH_SUBJECT: "email@example.test",
    GOALS_COACH_PROVISION_VERIFIED_EMAIL: "synthetic@example.test",
    GOALS_COACH_PROVISIONING_REFERENCE: "approved-test",
  }), /not a valid immutable Clerk user subject/);
});

test("alpha provisioning creates inactive by default, safely reruns, and activates only explicitly", async (t) => {
  const disposable = await alphaFixture(t);
  const member = await seedCanonicalMember(disposable.pool, "71001");
  const created = await provision(disposable.pool, inputFor(member.id));
  assert.deepEqual(Object.keys(created).sort(), ["action", "active", "mappingId", "status"]);
  assert.equal(created.status, "created");
  assert.equal(created.active, false);
  const rerun = await provision(disposable.pool, inputFor(member.id));
  assert.equal(rerun.status, "already_exists");
  assert.equal(rerun.mappingId, created.mappingId);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings")).rows[0].count, 1);
  const activated = await provision(
    disposable.pool,
    inputFor(member.id, { activate: true })
  );
  assert.equal(activated.status, "activated_existing");
  assert.equal(activated.active, true);
});

test("alpha provisioning refuses cross-member subjects and supports non-destructive deactivation", async (t) => {
  const disposable = await alphaFixture(t);
  const first = await seedCanonicalMember(disposable.pool, "71002");
  const second = await seedCanonicalMember(disposable.pool, "71003");
  await provision(disposable.pool, inputFor(first.id, { activate: true }));
  await assert.rejects(
    provision(disposable.pool, inputFor(second.id)),
    (error) => error.message === PROTECTED_FAILURE
  );
  const deactivated = await provision(disposable.pool, {
      action: "deactivate",
      memberId: String(first.id),
      authProvider: "clerk",
      authSubject: "user_alpha_provisioned",
      deactivationReason: "Synthetic test deactivation",
  });
  assert.equal(deactivated.status, "deactivated");
  assert.equal(deactivated.active, false);
  const row = await disposable.pool.query("SELECT active, deactivated_at, deactivation_reason FROM goals_coach_member_auth_mappings");
  assert.equal(row.rows[0].active, false);
  assert.ok(row.rows[0].deactivated_at);
  assert.equal(row.rows[0].deactivation_reason, "Synthetic test deactivation");
});

test("alpha provisioning refuses before connecting unless pending enrollment is exact-disabled", async () => {
  let connections = 0;
  const pool = { async connect() { connections += 1; throw new Error("must not connect"); } };
  for (const value of [undefined, "False", " false", "false ", "true"]) {
    await assert.rejects(
      provisionAlphaOwner({
        pool,
        input: inputFor("1"),
        environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: value },
      }),
      (error) => error.message === PROTECTED_FAILURE
    );
  }
  assert.equal(connections, 0);
});

test("alpha provisioning CLI prints only its fixed protected failure", () => {
  const script = path.join(__dirname, "..", "scripts", "provision-alpha-owner.js");
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "true",
      GOALS_COACH_PROVISION_MEMBER_ID: "sensitive-should-not-print",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${PROTECTED_FAILURE}\n`);
  assert.equal(result.stderr.includes("sensitive-should-not-print"), false);
});

test("alpha provisioning blocks a live target pending row and prints no state through its fixed error", async (t) => {
  const disposable = await alphaFixture(t);
  const member = await seedCanonicalMember(disposable.pool, "71004");
  const staff = (await disposable.pool.query(
    `INSERT INTO staff_users
      (auth_provider, auth_subject, email, display_name, role, active)
     VALUES ('clerk', 'user_alpha_guard', 'guard@example.test',
             'Guard', 'admin', TRUE) RETURNING id`
  )).rows[0];
  await disposable.pool.query(
    `INSERT INTO goals_coach_member_pending_enrollments
      (member_id, gymmaster_member_id, client_request_id,
       requested_by_staff_user_id, status, created_at, expires_at)
     VALUES (NULL, '71004', '00000000-0000-4000-8000-000000007104',
             $1, 'pending', '2099-08-10T12:00:00Z', '2099-08-11T12:00:00Z')`,
    [staff.id]
  );
  await assert.rejects(
    provision(disposable.pool, inputFor(member.id)),
    (error) => error.message === PROTECTED_FAILURE
  );
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings"
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    "SELECT status FROM goals_coach_member_pending_enrollments WHERE gymmaster_member_id = '71004'"
  )).rows[0].status, "pending");
  assert.equal(PROTECTED_FAILURE.includes("71004"), false);
  assert.equal(PROTECTED_FAILURE.includes("pending"), false);
});

test("alpha provisioning fails closed when the pending schema is absent", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const member = await seedCanonicalMember(disposable.pool, "71005");
  await assert.rejects(
    provision(disposable.pool, inputFor(member.id)),
    (error) => error.message === PROTECTED_FAILURE
  );
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings"
  )).rows[0].count, 0);
});

test("alpha provisioning rejects a same-name public pending table with weakened lifecycle schema", async (t) => {
  const disposable = await alphaFixture(t);
  const member = await seedCanonicalMember(disposable.pool, "71006");
  await disposable.pool.query(
    `ALTER TABLE goals_coach_member_pending_enrollments
       DROP CONSTRAINT goals_coach_member_pending_enrollments_status_check;
     ALTER TABLE goals_coach_member_pending_enrollments
       ADD CONSTRAINT goals_coach_member_pending_enrollments_status_check
       CHECK (status IS NOT NULL)`
  );
  await assert.rejects(
    provision(disposable.pool, inputFor(member.id)),
    (error) => error.message === PROTECTED_FAILURE
  );
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings"
  )).rows[0].count, 0);
});

test("alpha provisioning drains a checkout that resolves after its separate deadline", async () => {
  const checkout = deferred();
  const late = syntheticAlphaClient();
  let clockCalls = 0;
  const run = provisionAlphaOwner({
    pool: { connect() { return checkout.promise; } },
    input: inputFor("1"),
    environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" },
    monotonicNow() {
      clockCalls += 1;
      return clockCalls === 1 ? 0n : 6000000000n;
    },
  });
  await assert.rejects(run, (error) => error.message === PROTECTED_FAILURE);
  checkout.resolve(late.client);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.queries.length, 0);
  assert.deepEqual(late.releases, [undefined]);
});

test("alpha provisioning uses one decreasing aggregate transaction budget and pending-first order", async () => {
  const observed = syntheticAlphaClient();
  let tick = 0n;
  const result = await provisionAlphaOwner({
    pool: { async connect() { return observed.client; } },
    input: inputFor("1"),
    environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" },
    monotonicNow() {
      const value = tick;
      tick += 1000000n;
      return value;
    },
  });
  assert.equal(result.status, "created");
  const timeoutValues = observed.queries
    .filter(({ sql }) => /set_config\('lock_timeout'/.test(sql))
    .map(({ parameters }) => Number(parameters[0].replace("ms", "")));
  assert.equal(timeoutValues.length > 5, true);
  assert.equal(timeoutValues.every((value) => value > 0 && value <= 5000), true);
  assert.equal(timeoutValues.every((value, index) => (
    index === 0 || value <= timeoutValues[index - 1]
  )), true);
  assert.equal(timeoutValues.at(-1) < timeoutValues[0], true);
  const sql = observed.queries.map((entry) => entry.sql);
  const pendingLock = sql.findIndex((value) => (
    value === "LOCK TABLE goals_coach_member_pending_enrollments IN ACCESS EXCLUSIVE MODE"
  ));
  const memberLock = sql.findIndex((value) => /FROM coach_members/.test(value));
  const mappingLock = sql.findIndex((value) => (
    /FROM goals_coach_member_auth_mappings/.test(value)
  ));
  assert.equal(pendingLock >= 0, true);
  assert.equal(memberLock > pendingLock, true);
  assert.equal(mappingLock > memberLock, true);
  assert.equal(sql.filter((value) => value === "COMMIT").length, 1);
  assert.equal(sql.includes("ROLLBACK"), false);
  assert.deepEqual(observed.releases, [undefined]);
});

test("alpha provisioning treats unknown COMMIT as protected failure and destroys the client", async () => {
  const observed = syntheticAlphaClient({ commitUnknown: true });
  await assert.rejects(provisionAlphaOwner({
    pool: { async connect() { return observed.client; } },
    input: inputFor("1"),
    environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" },
  }), (error) => error.message === PROTECTED_FAILURE);
  const sql = observed.queries.map((entry) => entry.sql);
  assert.equal(sql.filter((value) => value === "COMMIT").length, 1);
  assert.equal(sql.includes("ROLLBACK"), false);
  assert.equal(observed.releases.length, 1);
  assert.ok(observed.releases[0] instanceof Error);
});

test("alpha provisioning drains a server-bounded query after a catchable signal", async () => {
  const lock = deferred();
  const queries = [];
  const releases = [];
  const client = {
    query(sql) {
      queries.push(sql);
      if (
        sql ===
        "LOCK TABLE goals_coach_member_pending_enrollments IN ACCESS EXCLUSIVE MODE"
      ) return lock.promise;
      return Promise.resolve({ rows: [] });
    },
    release(error) { releases.push(error); },
  };
  const run = provisionAlphaOwner({
    pool: { async connect() { return client; } },
    input: inputFor("1"),
    environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" },
  });
  while (!queries.some((sql) => /^LOCK TABLE/.test(sql))) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  process.emit("SIGTERM");
  lock.resolve({ rows: [] });
  await assert.rejects(run, (error) => error.message === PROTECTED_FAILURE);
  assert.equal(queries.includes("COMMIT"), false);
  assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.deepEqual(releases, [undefined]);
});
