"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const {
  MIGRATION_FILE,
  MIGRATION_VERSION,
  REQUIRED_MIGRATION_CHECKSUM,
  TABLE_LOCKS,
  checksum,
  runMigration,
} = require("../migrate_011");
const {
  TIMEOUT_CONFIGURATION_SQL,
  createTerminalState,
} = require("../src/goals-coach/bounded-postgres-transaction");
const { createDisposableDatabase } = require("./helpers/disposable-db");
const { runMigration: runSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");

async function databaseAt010(t) {
  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  await runSafetyIntakeMigration({ pool: disposable.pool });
  await runPendingEnrollmentMigration({ pool: disposable.pool });
  return disposable;
}

const disabledEnvironment = Object.freeze({
  GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false",
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("Migration 011 is explicit-only, exact-disabled, ordered, checksum-ledgered, and leaves Migration 010 unchanged", async (t) => {
  const migration010 = fs.readFileSync(
    "migration_010_goals_coach_member_pending_enrollment.sql"
  );
  assert.equal(
    crypto.createHash("sha256").update(migration010).digest("hex"),
    REQUIRED_MIGRATION_CHECKSUM
  );
  const source = fs.readFileSync("migrate_011.js", "utf8");
  const server = fs.readFileSync("server.js", "utf8");
  assert.equal(server.includes("migrate_011"), false);
  assert.deepEqual(TABLE_LOCKS, [
    "goals_coach_member_pending_enrollments",
    "coach_members",
    "goals_coach_member_auth_mappings",
    "goals_coach_member_provisioning_events",
  ]);
  assert.match(source, /ACCESS EXCLUSIVE MODE/);
  assert.match(source, /OVERALL_MILLISECONDS = 60000/);
  assert.match(source, /TABLE_LOCK_MILLISECONDS = 5000/);
  assert.match(source, /POST_LOCK_MILLISECONDS = 45000/);
  assert.doesNotMatch(source, /Client\.cancel|activeQuery|queryQueue|query_timeout/);

  let connections = 0;
  for (const flag of [undefined, "False", "FALSE", " false", "false ", "true"]) {
    await assert.rejects(runMigration({
      pool: { async connect() { connections += 1; throw new Error("must not connect"); } },
      environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: flag },
    }), (error) => error.code === "feature_not_exact_disabled");
  }
  assert.equal(connections, 0);

  const disposable = await databaseAt010(t);
  const named = (await disposable.pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('82001', 'Existing', 'Member') RETURNING *`
  )).rows[0];
  const admin = (await disposable.pool.query(
    `INSERT INTO staff_users
      (auth_provider, auth_subject, email, display_name, role, active)
     VALUES ('clerk', 'user_m011_existing', 'existing@example.test',
             'Existing Admin', 'admin', TRUE)
     RETURNING id`
  )).rows[0];
  const oldPending = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_pending_enrollments
      (member_id, gymmaster_member_id, client_request_id,
       requested_by_staff_user_id, status, created_at, expires_at)
     VALUES ($1, '82001', '00000000-0000-4000-8000-000000008201',
             $2, 'pending', '2099-08-10T12:00:00Z', '2099-08-11T12:00:00Z')
     RETURNING id`,
    [named.id, admin.id]
  )).rows[0];
  const oldEvent = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_provisioning_events
      (pending_enrollment_id, member_id, staff_user_id, client_request_id,
       action, result, created_at)
     VALUES ($1, $2, $3, '00000000-0000-4000-8000-000000008201',
             'pending_enrollment_created', 'created', '2099-08-10T12:00:00Z')
     RETURNING id`,
    [oldPending.id, named.id, admin.id]
  )).rows[0];
  const applied = await runMigration({
    pool: disposable.pool,
    environment: disabledEnvironment,
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.version, MIGRATION_VERSION);
  assert.equal(applied.checksum, checksum(fs.readFileSync(MIGRATION_FILE, "utf8")));
  const replay = await runMigration({
    pool: disposable.pool,
    environment: disabledEnvironment,
  });
  assert.equal(replay.status, "already_applied");
  assert.equal(replay.checksum, applied.checksum);

  const columns = (await disposable.pool.query(
    `SELECT table_name, column_name, is_nullable
     FROM information_schema.columns
     WHERE (table_name = 'coach_members' AND column_name IN ('first_name', 'last_name'))
        OR (table_name = 'goals_coach_member_pending_enrollments' AND column_name = 'member_id')
        OR (table_name = 'goals_coach_member_provisioning_events' AND column_name = 'member_id')
     ORDER BY table_name, column_name`
  )).rows;
  assert.equal(columns.every((row) => row.is_nullable === "YES"), true);
  const preserved = (await disposable.pool.query(
    "SELECT * FROM coach_members WHERE id = $1",
    [named.id]
  )).rows[0];
  assert.equal(preserved.first_name, "Existing");
  assert.equal(preserved.last_name, "Member");
  assert.equal(preserved.gymmaster_member_id, "82001");
  assert.equal((await disposable.pool.query(
    "SELECT member_id FROM goals_coach_member_pending_enrollments WHERE id = $1",
    [oldPending.id]
  )).rows[0].member_id, named.id);
  assert.equal((await disposable.pool.query(
    "SELECT member_id FROM goals_coach_member_provisioning_events WHERE id = $1",
    [oldEvent.id]
  )).rows[0].member_id, named.id);

  await disposable.pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('82002', NULL, NULL)`
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
       VALUES ('82003', 'Half', NULL)`
    ),
    /ck_coach_members_name_pair/i
  );
  assert.equal((await disposable.pool.query(
    "SELECT checksum FROM app_schema_migrations WHERE version = $1",
    [MIGRATION_VERSION]
  )).rows[0].checksum, applied.checksum);
});

test("Migration 011 refuses a partial manual application and rolls back every runner-owned change", async (t) => {
  const disposable = await databaseAt010(t);
  await disposable.pool.query(
    "ALTER TABLE coach_members ALTER COLUMN first_name DROP NOT NULL"
  );
  await assert.rejects(runMigration({
    pool: disposable.pool,
    environment: disabledEnvironment,
  }), (error) => error.code === "catalog_preflight_failed");
  const columns = (await disposable.pool.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'coach_members'
       AND column_name IN ('first_name', 'last_name')
     ORDER BY column_name`
  )).rows;
  assert.deepEqual(columns, [
    { column_name: "first_name", is_nullable: "YES" },
    { column_name: "last_name", is_nullable: "NO" },
  ]);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM app_schema_migrations WHERE version = $1",
    [MIGRATION_VERSION]
  )).rows[0].count, 0);
});

test("Migration 011 replay rejects semantic index, constraint, and trigger drift", async (t) => {
  const mutations = [
    [
      "same-name live-index drift",
      `DROP INDEX uq_goals_coach_member_pending_enrollment_gymmaster;
       CREATE UNIQUE INDEX uq_goals_coach_member_pending_enrollment_gymmaster
         ON goals_coach_member_pending_enrollments (id)`,
    ],
    [
      "same-name constraint drift",
      `ALTER TABLE goals_coach_member_pending_enrollments
         DROP CONSTRAINT ck_goals_coach_member_pending_consumed_member;
       ALTER TABLE goals_coach_member_pending_enrollments
         ADD CONSTRAINT ck_goals_coach_member_pending_consumed_member
         CHECK (TRUE)`,
    ],
    [
      "replica-only append trigger drift",
      `ALTER TABLE goals_coach_member_provisioning_events
         ENABLE REPLICA TRIGGER
           trg_preserve_goals_coach_member_provisioning_event`,
    ],
  ];
  for (const [name, mutation] of mutations) {
    await t.test(name, async (subtest) => {
      const disposable = await databaseAt010(subtest);
      await runMigration({
        pool: disposable.pool,
        environment: disabledEnvironment,
      });
      await disposable.pool.query(mutation);
      await assert.rejects(runMigration({
        pool: disposable.pool,
        environment: disabledEnvironment,
      }), (error) => error.code === "applied_schema_drift");
    });
  }
});

test("Migration 011 applies non-extending overall, lock, and post-lock budgets to every statement", async (t) => {
  const disposable = await databaseAt010(t);
  const queries = [];
  const wrappedPool = {
    async connect() {
      const client = await disposable.pool.connect();
      return {
        async query(sql, parameters = []) {
          queries.push({ sql, parameters });
          return client.query(sql, parameters);
        },
        release(error) { client.release(error); },
      };
    },
  };
  let tick = 0n;
  const applied = await runMigration({
    pool: wrappedPool,
    environment: disabledEnvironment,
    monotonicNow() {
      const value = tick;
      tick += 1000000n;
      return value;
    },
  });
  assert.equal(applied.status, "applied");

  for (let index = 0; index < queries.length; index += 1) {
    const sql = queries[index].sql;
    if (sql === "BEGIN" || sql === TIMEOUT_CONFIGURATION_SQL) continue;
    assert.equal(
      queries[index - 1].sql,
      TIMEOUT_CONFIGURATION_SQL,
      `statement must be immediately preceded by timeout setup: ${sql.slice(0, 60)}`
    );
    assert.match(queries[index - 1].parameters[0], /^[1-9][0-9]*ms$/);
  }

  const lockTimeouts = TABLE_LOCKS.map((table) => {
    const index = queries.findIndex(({ sql }) => (
      sql === `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`
    ));
    assert.equal(index > 0, true);
    return Number(queries[index - 1].parameters[0].replace("ms", ""));
  });
  assert.equal(lockTimeouts.every((value) => value > 0 && value <= 5000), true);
  assert.equal(lockTimeouts.every((value, index) => (
    index === 0 || value <= lockTimeouts[index - 1]
  )), true);

  const fourthLockIndex = queries.findIndex(({ sql }) => (
    sql === `LOCK TABLE ${TABLE_LOCKS.at(-1)} IN ACCESS EXCLUSIVE MODE`
  ));
  const postLockTimeouts = queries
    .slice(fourthLockIndex + 1)
    .filter(({ sql }) => sql === TIMEOUT_CONFIGURATION_SQL)
    .map(({ parameters }) => Number(parameters[0].replace("ms", "")));
  assert.equal(postLockTimeouts.length > 5, true);
  assert.equal(postLockTimeouts.every((value) => value > 0 && value <= 45000), true);
  assert.equal(postLockTimeouts.every((value, index) => (
    index === 0 || value <= postLockTimeouts[index - 1]
  )), true);
});

test("Migration 011 drains a checkout that resolves beyond its separate connection deadline", async () => {
  const checkout = deferred();
  const queries = [];
  const releases = [];
  let clockCalls = 0;
  const run = runMigration({
    pool: { connect() { return checkout.promise; } },
    environment: disabledEnvironment,
    monotonicNow() {
      clockCalls += 1;
      return clockCalls === 1 ? 0n : 6000000000n;
    },
  });
  await assert.rejects(run);
  checkout.resolve({
    async query(sql) { queries.push(sql); return { rows: [] }; },
    release(error) { releases.push(error); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queries, []);
  assert.deepEqual(releases, [undefined]);
});

test("Migration 011 evicts an unresolved BEGIN and never issues concurrent rollback", async () => {
  const begin = deferred();
  const queries = [];
  const releases = [];
  const terminalState = createTerminalState();
  const client = {
    query(sql) {
      queries.push(sql);
      if (sql === "BEGIN") return begin.promise;
      throw new Error("no SQL may follow unresolved BEGIN");
    },
    release(error) {
      releases.push(error);
      if (error) begin.reject(new Error("destroyed unresolved BEGIN"));
    },
  };
  const run = runMigration({
    pool: { async connect() { return client; } },
    environment: disabledEnvironment,
    terminalState,
  });
  while (!queries.includes("BEGIN")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  terminalState.terminate("migration_overall_deadline");
  await assert.rejects(run);
  assert.deepEqual(queries, ["BEGIN"]);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
});
