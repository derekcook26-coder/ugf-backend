"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runMigration: runPhase1cTranscriptionMigration } = require("../migrate_005");
const { runMigration: runPhase1dSafetyMigration } = require("../migrate_006");
const { runMigration: runOwnerWorkoutTrackingMigration } = require("../migrate_007");
const { runMigration: runOwnerEditableWorkoutSessionsMigration } = require("../migrate_008");
const { runMigration: runMemberSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");
const {
  MIGRATION_VERSION,
  REQUIRED_MIGRATION_CHECKSUM,
  REQUIRED_MIGRATION_VERSION,
  TABLE_LOCKS,
  runMigration: runNullableNamesMigration,
} = require("../migrate_011");
const {
  TIMEOUT_CONFIGURATION_SQL,
  createTerminalState,
} = require("../src/goals-coach/bounded-postgres-transaction");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires an unprivileged PostgreSQL 16 process; root execution is not acceptance evidence"
  : false;
const disabledEnvironment = {
  GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false",
};

async function postgresAt010(t) {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  await runPhase1cTranscriptionMigration({ pool: disposable.pool });
  await runPhase1dSafetyMigration({ pool: disposable.pool });
  await runOwnerWorkoutTrackingMigration({ pool: disposable.pool });
  await runOwnerEditableWorkoutSessionsMigration({ pool: disposable.pool });
  await runMemberSafetyIntakeMigration({ pool: disposable.pool });
  await runPendingEnrollmentMigration({ pool: disposable.pool });
  assert.match((await disposable.pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
  return disposable;
}

function interceptedPool(pool, intercept, observations = {}) {
  observations.queries = observations.queries || [];
  observations.releases = observations.releases || [];
  observations.releaseEvents = observations.releaseEvents || [];
  observations.connectionErrors = observations.connectionErrors || [];
  observations.lifecycle = observations.lifecycle || [];
  observations.timeoutConfigurations = observations.timeoutConfigurations || [];
  const observeConnectionErrors = observations.observeConnectionErrors === true;
  return {
    async connect() {
      const client = await pool.connect();
      const onConnectionError = (error) => {
        observations.connectionErrors.push(error);
        observations.lifecycle.push({
          type: "connection_error",
          code: error.code || null,
          message: error.message,
        });
      };
      if (observeConnectionErrors) client.on("error", onConnectionError);
      return {
        async query(sql, parameters = []) {
          observations.queries.push({ sql, parameters });
          if (sql === TIMEOUT_CONFIGURATION_SQL) {
            const configuration = {
              value: "100ms",
              queryIndex: observations.queries.length - 1,
              startedAt: process.hrtime.bigint(),
              confirmedAt: null,
              rejectedError: null,
              rejectedAt: null,
            };
            observations.timeoutConfigurations.push(configuration);
            try {
              const result = await client.query(sql, ["100ms"]);
              configuration.confirmedAt = process.hrtime.bigint();
              return result;
            } catch (error) {
              configuration.rejectedError = error;
              configuration.rejectedAt = process.hrtime.bigint();
              throw error;
            }
          }
          return intercept({ client, sql, parameters, observations });
        },
        release(error) {
          observations.releases.push(error);
          observations.releaseEvents.push({
            error,
            releasedAt: process.hrtime.bigint(),
          });
          observations.lifecycle.push({
            type: "release",
            discarded: error instanceof Error,
          });
          if (observeConnectionErrors) {
            client.removeListener("error", onConnectionError);
          }
          client.release(error);
        },
      };
    },
  };
}

function assertOnlyExpectedIdleTermination(observations) {
  assert.equal(observations.connectionErrors.length, 1);
  assert.equal(observations.connectionErrors[0].code, "25P03");
  assert.equal(observations.releases.length, 1);
  assert.ok(observations.releases[0] instanceof Error);
  assert.deepEqual(observations.lifecycle, [
    {
      type: "connection_error",
      code: "25P03",
      message: "terminating connection due to idle-in-transaction timeout",
    },
    { type: "release", discarded: true },
  ]);
}

function assertExpectedIdleTerminationAndSocketClose(observations) {
  assert.equal(observations.connectionErrors.length, 2);
  assert.deepEqual(observations.lifecycle, [
    {
      type: "connection_error",
      code: "25P03",
      message: "terminating connection due to idle-in-transaction timeout",
    },
    {
      type: "connection_error",
      code: null,
      message: "Connection terminated unexpectedly",
    },
    { type: "release", discarded: true },
  ]);
  assert.equal(observations.releases.length, 1);
  assert.ok(observations.releases[0] instanceof Error);
}

async function assertMigration010State(pool) {
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_schema_migrations WHERE version = $1",
    [MIGRATION_VERSION]
  )).rows[0].count, 0);
  const columns = (await pool.query(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'coach_members'
       AND column_name IN ('first_name', 'last_name')`
  )).rows;
  assert.equal(columns.length, 2);
  assert.equal(columns.every((row) => row.is_nullable === "NO"), true);
}

test("PostgreSQL 16 applies and replays Migration 011 with native constraints and triggers", { skip: skipForRoot }, async (t) => {
  const disposable = await postgresAt010(t);
  const preAdmin = (await disposable.pool.query(
    `INSERT INTO staff_users
      (auth_provider, auth_subject, email, display_name, role, active)
     VALUES ('clerk', 'user_m011_preexisting', 'preexisting@example.test',
             'Preexisting', 'admin', TRUE) RETURNING id`
  )).rows[0];
  const preMembers = (await disposable.pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ('83991', 'Expired', 'Existing'),
            ('83992', 'Consumed', 'Existing')
     RETURNING id, gymmaster_member_id`
  )).rows;
  const consumedMember = preMembers.find((row) => (
    row.gymmaster_member_id === "83992"
  ));
  const preMapping = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot,
       active, provisioning_method, provisioning_reference)
     VALUES ($1, 'gymmaster', 'gymmaster:83992',
             'preexisting-consumed@example.test', TRUE,
             'administrative', 'pending_enrollment:83992')
     RETURNING id`,
    [consumedMember.id]
  )).rows[0];
  const expiredPending = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_pending_enrollments
      (member_id, gymmaster_member_id, client_request_id,
       requested_by_staff_user_id, status, created_at, expires_at, expired_at)
     VALUES ($1, '83991', '00000000-0000-4000-8000-000000083991',
             $2, 'expired', '2026-08-10T12:00:00Z',
             '2026-08-11T12:00:00Z', '2026-08-11T12:00:00Z')
     RETURNING id`,
    [preMembers.find((row) => row.gymmaster_member_id === "83991").id, preAdmin.id]
  )).rows[0];
  const consumedPending = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_pending_enrollments
      (member_id, gymmaster_member_id, client_request_id,
       requested_by_staff_user_id, status, auth_mapping_id,
       created_at, expires_at, consumed_at)
     VALUES ($1, '83992', '00000000-0000-4000-8000-000000083992',
             $2, 'consumed', $3, '2026-08-10T12:00:00Z',
             '2026-08-11T12:00:00Z', '2026-08-10T13:00:00Z')
     RETURNING id`,
    [consumedMember.id, preAdmin.id, preMapping.id]
  )).rows[0];
  for (const [pending, member, requestId] of [
    [expiredPending, preMembers.find((row) => row.gymmaster_member_id === "83991"), "00000000-0000-4000-8000-000000083991"],
    [consumedPending, consumedMember, "00000000-0000-4000-8000-000000083992"],
  ]) {
    await disposable.pool.query(
      `INSERT INTO goals_coach_member_provisioning_events
        (pending_enrollment_id, member_id, staff_user_id, client_request_id,
         action, result, created_at)
       VALUES ($1, $2, $3, $4, 'pending_enrollment_created', 'created',
               '2026-08-10T12:00:00Z')`,
      [pending.id, member.id, preAdmin.id, requestId]
    );
  }
  await disposable.pool.query(
    `INSERT INTO goals_coach_member_provisioning_events
      (pending_enrollment_id, auth_mapping_id, member_id, staff_user_id,
       client_request_id, action, result, created_at)
     VALUES ($1, $2, $3, $4, '00000000-0000-4000-8000-000000083992',
             'mapping_completed', 'completed', '2026-08-10T13:00:00Z')`,
    [consumedPending.id, preMapping.id, consumedMember.id, preAdmin.id]
  );
  const result = await runNullableNamesMigration({
    pool: disposable.pool,
    environment: disabledEnvironment,
  });
  assert.equal(result.status, "applied");
  assert.equal((await runNullableNamesMigration({
    pool: disposable.pool,
    environment: disabledEnvironment,
  })).status, "already_applied");
  const constraints = (await disposable.pool.query(
    `SELECT conname, convalidated
     FROM pg_constraint
     WHERE conname IN (
       'ck_coach_members_name_pair',
       'uq_goals_coach_member_pending_event_provenance',
       'ck_goals_coach_member_pending_consumed_member',
       'fk_goals_coach_member_provisioning_event_pending',
       'ck_goals_coach_member_provisioning_event_completed_member'
     )`
  )).rows;
  assert.equal(constraints.length, 5);
  assert.equal(constraints.every((row) => row.convalidated), true);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM app_schema_migrations WHERE version = $1",
    [MIGRATION_VERSION]
  )).rows[0].count, 1);
  assert.deepEqual((await disposable.pool.query(
    `SELECT gymmaster_member_id, status, member_id, auth_mapping_id
     FROM goals_coach_member_pending_enrollments
     WHERE gymmaster_member_id IN ('83991', '83992')
     ORDER BY gymmaster_member_id`
  )).rows.map((row) => ({
    ...row,
    member_id: String(row.member_id),
    auth_mapping_id: row.auth_mapping_id === null
      ? null
      : String(row.auth_mapping_id),
  })), [
    {
      gymmaster_member_id: "83991",
      status: "expired",
      member_id: String(preMembers.find((row) => row.gymmaster_member_id === "83991").id),
      auth_mapping_id: null,
    },
    {
      gymmaster_member_id: "83992",
      status: "consumed",
      member_id: String(consumedMember.id),
      auth_mapping_id: String(preMapping.id),
    },
  ]);

  const admin = (await disposable.pool.query(
    `INSERT INTO staff_users
      (auth_provider, auth_subject, email, display_name, role, active)
     VALUES ('clerk', 'user_m011_native', 'native@example.test',
             'Native', 'admin', TRUE) RETURNING id`
  )).rows[0];
  const pending = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_pending_enrollments
      (member_id, gymmaster_member_id, client_request_id,
       requested_by_staff_user_id, status, created_at, expires_at)
     VALUES (NULL, '83001', '00000000-0000-4000-8000-000000008301',
             $1, 'pending', transaction_timestamp(),
             transaction_timestamp() + interval '24 hours')
     RETURNING id`,
    [admin.id]
  )).rows[0];
  await disposable.pool.query(
    `INSERT INTO goals_coach_member_provisioning_events
      (pending_enrollment_id, member_id, staff_user_id, client_request_id,
       action, result, created_at)
     VALUES ($1, NULL, $2, '00000000-0000-4000-8000-000000008301',
             'pending_enrollment_created', 'created', transaction_timestamp())`,
    [pending.id, admin.id]
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
       VALUES ('83002', 'Half', NULL)`
    ),
    /ck_coach_members_name_pair/i
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_member_pending_enrollments
        (member_id, gymmaster_member_id, client_request_id,
         requested_by_staff_user_id, status, auth_mapping_id,
         created_at, expires_at, consumed_at)
       VALUES (NULL, '83003', '00000000-0000-4000-8000-000000008303',
               $1, 'consumed', $2, transaction_timestamp(),
               transaction_timestamp() + interval '24 hours',
               transaction_timestamp())`,
      [admin.id, preMapping.id]
    ),
    /ck_goals_coach_member_pending_consumed_member/i
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_member_provisioning_events
        (pending_enrollment_id, auth_mapping_id, member_id, staff_user_id,
         client_request_id, action, result, created_at)
       VALUES ($1, $2, NULL, $3,
               '00000000-0000-4000-8000-000000008301',
               'mapping_completed', 'completed', transaction_timestamp())`,
      [pending.id, preMapping.id, admin.id]
    ),
    /ck_goals_coach_member_provisioning_event_completed_member/i
  );
  const otherAdmin = (await disposable.pool.query(
    `INSERT INTO staff_users
      (auth_provider, auth_subject, email, display_name, role, active)
     VALUES ('clerk', 'user_m011_native_other', 'native-other@example.test',
             'Native Other', 'admin', TRUE) RETURNING id`
  )).rows[0];
  const provenancePending = (await disposable.pool.query(
    `INSERT INTO goals_coach_member_pending_enrollments
      (member_id, gymmaster_member_id, client_request_id,
       requested_by_staff_user_id, status, created_at, expires_at)
     VALUES (NULL, '83004', '00000000-0000-4000-8000-000000008304',
             $1, 'pending', transaction_timestamp(),
             transaction_timestamp() + interval '24 hours')
     RETURNING id`,
    [admin.id]
  )).rows[0];
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_member_provisioning_events
        (pending_enrollment_id, member_id, staff_user_id, client_request_id,
         action, result, created_at)
       VALUES ($1, NULL, $2, '00000000-0000-4000-8000-000000008304',
               'pending_enrollment_created', 'created', transaction_timestamp())`,
      [provenancePending.id, otherAdmin.id]
    ),
    /fk_goals_coach_member_provisioning_event_pending/i
  );
  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_member_provisioning_events SET result = result WHERE pending_enrollment_id = $1",
      [pending.id]
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

for (const [index, table] of TABLE_LOCKS.entries()) {
  test(`Migration 011 aggregate lock deadline rolls back when ${table} is blocked`, { skip: skipForRoot }, async (t) => {
    const disposable = await postgresAt010(t);
    let blocker;
    try {
      blocker = await disposable.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${table} IN ACCESS SHARE MODE`);
      const started = process.hrtime.bigint();
      await assert.rejects(runNullableNamesMigration({
        pool: disposable.pool,
        environment: disabledEnvironment,
      }));
      const elapsedMilliseconds = Number(
        (process.hrtime.bigint() - started) / 1000000n
      );
      assert.equal(elapsedMilliseconds >= 4500, true, `lock ${index + 1} ended too early`);
      assert.equal(elapsedMilliseconds <= 5500, true, `lock ${index + 1} exceeded bounded tolerance`);
      assert.equal((await disposable.pool.query(
        "SELECT COUNT(*)::int AS count FROM app_schema_migrations WHERE version = $1",
        [MIGRATION_VERSION]
      )).rows[0].count, 0);
      const columns = (await disposable.pool.query(
        `SELECT is_nullable
         FROM information_schema.columns
         WHERE table_name = 'coach_members'
           AND column_name IN ('first_name', 'last_name')`
      )).rows;
      assert.equal(columns.every((row) => row.is_nullable === "NO"), true);
      if (index > 0) {
        const verifier = await disposable.pool.connect();
        try {
          await verifier.query("BEGIN");
          for (const prior of TABLE_LOCKS.slice(0, index)) {
            await verifier.query(
              `LOCK TABLE ${prior} IN ACCESS EXCLUSIVE MODE NOWAIT`
            );
          }
          await verifier.query("ROLLBACK");
        } finally {
          verifier.release();
        }
      }
    } finally {
      if (blocker) {
        try { await blocker.query("ROLLBACK"); } catch (_) {}
        blocker.release();
      }
    }
  });
}

test("Migration 011 bounds its advisory, predecessor, and ledger queries", {
  skip: skipForRoot,
  timeout: 30000,
}, async (t) => {
  await t.test("blocked migration advisory lock", async (subtest) => {
    const disposable = await postgresAt010(subtest);
    let blocker;
    try {
      blocker = await disposable.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(82720511::bigint)");
      const observations = {};
      const wrapped = interceptedPool(
        disposable.pool,
        ({ client, sql, parameters }) => client.query(sql, parameters),
        observations
      );
      await assert.rejects(runNullableNamesMigration({
        pool: wrapped,
        environment: disabledEnvironment,
      }));
      await blocker.query("ROLLBACK");
      await assertMigration010State(disposable.pool);
      assert.equal(observations.releases.length, 1);
    } finally {
      if (blocker) {
        try { await blocker.query("ROLLBACK"); } catch (_) {}
        blocker.release();
      }
    }
  });

  await t.test("blocked predecessor query", async (subtest) => {
    const disposable = await postgresAt010(subtest);
    let blocker;
    try {
      blocker = await disposable.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE app_schema_migrations IN ACCESS EXCLUSIVE MODE");
      const wrapped = interceptedPool(
        disposable.pool,
        ({ client, sql, parameters }) => client.query(sql, parameters)
      );
      await assert.rejects(runNullableNamesMigration({
        pool: wrapped,
        environment: disabledEnvironment,
      }));
      await blocker.query("ROLLBACK");
      await assertMigration010State(disposable.pool);
    } finally {
      if (blocker) {
        try { await blocker.query("ROLLBACK"); } catch (_) {}
        blocker.release();
      }
    }
  });

  await t.test("preacquired native ledger lock after a synthetic predecessor result", async (subtest) => {
    const disposable = await postgresAt010(subtest);
    let blocker;
    try {
      blocker = await disposable.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE app_schema_migrations IN ACCESS EXCLUSIVE MODE"
      );
      const blockerLockedAt = process.hrtime.bigint();
      const predecessor = {
        intercepted: 0,
        syntheticResultReturned: false,
        syntheticReturnedAt: null,
      };
      const protectedLedger = {
        entered: 0,
        clientQueryIssued: 0,
        resolved: 0,
        rejectedError: null,
        startedAt: null,
        rejectedAt: null,
      };
      const observations = { observeConnectionErrors: true };
      const wrapped = interceptedPool(
        disposable.pool,
        async ({ client, sql, parameters }) => {
          if (
            /^SELECT checksum FROM app_schema_migrations/.test(sql)
            && parameters[0] === MIGRATION_VERSION
          ) {
            protectedLedger.entered += 1;
            protectedLedger.startedAt = process.hrtime.bigint();
            try {
              protectedLedger.clientQueryIssued += 1;
              const result = await client.query(sql, parameters);
              protectedLedger.resolved += 1;
              return result;
            } catch (error) {
              protectedLedger.rejectedError = error;
              protectedLedger.rejectedAt = process.hrtime.bigint();
              throw error;
            }
          }
          if (
            /^SELECT checksum FROM app_schema_migrations/.test(sql)
            && parameters[0] === REQUIRED_MIGRATION_VERSION
          ) {
            predecessor.intercepted += 1;
            predecessor.syntheticResultReturned = true;
            predecessor.syntheticReturnedAt = process.hrtime.bigint();
            return { rows: [{ checksum: REQUIRED_MIGRATION_CHECKSUM }] };
          }
          return client.query(sql, parameters);
        },
        observations
      );
      let failure;
      try {
        await runNullableNamesMigration({
          pool: wrapped,
          environment: disabledEnvironment,
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      assert.equal(failure.code, "query_failed");
      assert.ok(failure.cause instanceof Error);
      assert.equal(failure.cause, protectedLedger.rejectedError);
      assert.equal(predecessor.intercepted, 1);
      assert.equal(predecessor.syntheticResultReturned, true);
      assert.equal(typeof blockerLockedAt, "bigint");
      assert.equal(typeof predecessor.syntheticReturnedAt, "bigint");
      assert.equal(predecessor.syntheticReturnedAt > blockerLockedAt, true);
      assert.equal(protectedLedger.entered, 1);
      assert.equal(protectedLedger.clientQueryIssued, 1);
      assert.equal(protectedLedger.resolved, 0);
      assert.ok(protectedLedger.rejectedError instanceof Error);
      assert.equal(typeof protectedLedger.startedAt, "bigint");
      assert.equal(typeof protectedLedger.rejectedAt, "bigint");
      assert.equal(
        protectedLedger.startedAt > predecessor.syntheticReturnedAt,
        true
      );
      const protectedLedgerQueryIndex = observations.queries.findIndex(
        ({ sql, parameters }) => (
          /^SELECT checksum FROM app_schema_migrations/.test(sql)
          && parameters[0] === MIGRATION_VERSION
        )
      );
      assert.equal(protectedLedgerQueryIndex >= 1, true);
      assert.equal(
        observations.queries[protectedLedgerQueryIndex - 1].sql,
        TIMEOUT_CONFIGURATION_SQL
      );
      const protectedTimeoutConfigurations = observations.timeoutConfigurations.filter(
        (configuration) => configuration.queryIndex === protectedLedgerQueryIndex - 1
      );
      assert.equal(protectedTimeoutConfigurations.length, 1);
      const [protectedTimeoutConfiguration] = protectedTimeoutConfigurations;
      assert.equal(protectedTimeoutConfiguration.value, "100ms");
      assert.equal(typeof protectedTimeoutConfiguration.confirmedAt, "bigint");
      assert.equal(
        protectedTimeoutConfiguration.confirmedAt > blockerLockedAt,
        true
      );
      assert.equal(
        protectedTimeoutConfiguration.confirmedAt < protectedLedger.startedAt,
        true
      );
      const cleanupTimeoutConfigurations = observations.timeoutConfigurations.filter(
        (configuration) => configuration.startedAt > protectedLedger.rejectedAt
      );
      assert.equal(cleanupTimeoutConfigurations.length, 1);
      const [cleanupTimeoutConfiguration] = cleanupTimeoutConfigurations;
      assert.equal(cleanupTimeoutConfiguration.value, "100ms");
      assert.equal(cleanupTimeoutConfiguration.confirmedAt, null);
      assert.ok(cleanupTimeoutConfiguration.rejectedError instanceof Error);
      const cleanupError = cleanupTimeoutConfiguration.rejectedError;
      const acceptedCleanupOutcome = (
        cleanupError.code === "25P02"
        && cleanupError.message === (
          "current transaction is aborted, commands ignored until end of transaction block"
        )
      ) || (
        (cleanupError.code === undefined || cleanupError.code === null)
        && cleanupError.message === (
          "Client has encountered a connection error and is not queryable"
        )
      );
      assert.equal(acceptedCleanupOutcome, true);
      assert.notEqual(
        cleanupTimeoutConfiguration.rejectedError,
        failure.cause
      );
      assert.equal(typeof cleanupTimeoutConfiguration.rejectedAt, "bigint");
      assert.equal(
        cleanupTimeoutConfiguration.rejectedAt >= cleanupTimeoutConfiguration.startedAt,
        true
      );
      assert.equal(observations.releaseEvents.length, 1);
      assert.equal(
        observations.releaseEvents[0].releasedAt >= cleanupTimeoutConfiguration.rejectedAt,
        true
      );
      const lockWaitMilliseconds = Number(
        (protectedLedger.rejectedAt - protectedLedger.startedAt) / 1000000n
      );
      assert.equal(lockWaitMilliseconds >= 50, true);
      assert.equal(lockWaitMilliseconds <= 1000, true);
      assert.equal(
        observations.queries.some(({ sql }) => sql === "COMMIT"),
        false
      );
      assert.equal(
        observations.queries.some(({ sql }) => (
          /^INSERT INTO app_schema_migrations/.test(sql)
        )),
        false
      );
      assert.deepEqual(
        observations.queries.slice(protectedLedgerQueryIndex + 1).map(({ sql }) => sql),
        [TIMEOUT_CONFIGURATION_SQL]
      );
      await blocker.query("ROLLBACK");
      await assertMigration010State(disposable.pool);
      if (cleanupError.code === "25P02") {
        assert.equal(observations.connectionErrors.length, 0);
        assert.equal(observations.releases.length, 1);
        assert.ok(observations.releases[0] instanceof Error);
        assert.deepEqual(observations.lifecycle, [
          { type: "release", discarded: true },
        ]);
      } else if (
        cleanupError.code === undefined || cleanupError.code === null
      ) {
        assertOnlyExpectedIdleTermination(observations);
      } else {
        assert.fail("unexpected accepted cleanup lifecycle");
      }
    } finally {
      if (blocker) {
        try { await blocker.query("ROLLBACK"); } catch (_) {}
        blocker.release();
      }
    }
  });
});

test("Migration 011 aborts every slow post-lock stage without partial adoption", {
  skip: skipForRoot,
  timeout: 60000,
}, async (t) => {
  const stages = [
    ["catalog preflight", (sql) => sql.includes("SELECT 'column'::text AS object_kind")],
    ["mutable-data preflight", (sql) => sql.includes("AS incomplete_name_pair")],
    ["DDL", (sql) => /ALTER TABLE coach_members\s+ALTER COLUMN first_name/i.test(sql)],
    ["constraint validation", (sql) => /VALIDATE CONSTRAINT ck_coach_members_name_pair/i.test(sql)],
    ["ledger insertion", (sql) => /^INSERT INTO app_schema_migrations/.test(sql)],
  ];
  for (const [name, target] of stages) {
    await t.test(name, async (subtest) => {
      const disposable = await postgresAt010(subtest);
      let slowed = 0;
      const wrapped = interceptedPool(
        disposable.pool,
        ({ client, sql, parameters }) => {
          if (target(sql, parameters)) {
            slowed += 1;
            return client.query("SELECT pg_sleep(30)");
          }
          return client.query(sql, parameters);
        }
      );
      await assert.rejects(runNullableNamesMigration({
        pool: wrapped,
        environment: disabledEnvironment,
      }));
      assert.equal(slowed, 1);
      await assertMigration010State(disposable.pool);
    });
  }
});

test("Migration 011 unknown and late COMMIT outcomes never report success", {
  skip: skipForRoot,
  timeout: 30000,
}, async (t) => {
  await t.test("unknown COMMIT destroys the client and requires reconciliation", async (subtest) => {
    const disposable = await postgresAt010(subtest);
    const observations = {};
    const wrapped = interceptedPool(
      disposable.pool,
      async ({ client, sql, parameters }) => {
        const result = await client.query(sql, parameters);
        if (sql === "COMMIT") throw new Error("synthetic transport loss");
        return result;
      },
      observations
    );
    await assert.rejects(runNullableNamesMigration({
      pool: wrapped,
      environment: disabledEnvironment,
    }), (error) => error.code === "commit_unknown");
    assert.equal(observations.releases.length, 1);
    assert.ok(observations.releases[0] instanceof Error);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    )).rows[0].count, 1);
  });

  await t.test("confirmed COMMIT after terminal state remains committed but fails", async (subtest) => {
    const disposable = await postgresAt010(subtest);
    const terminalState = createTerminalState();
    const observations = {};
    const wrapped = interceptedPool(
      disposable.pool,
      async ({ client, sql, parameters }) => {
        const result = await client.query(sql, parameters);
        if (sql === "COMMIT") {
          terminalState.terminate("migration_overall_deadline");
        }
        return result;
      },
      observations
    );
    await assert.rejects(runNullableNamesMigration({
      pool: wrapped,
      environment: disabledEnvironment,
      terminalState,
    }), (error) => error.code === "commit_after_deadline");
    assert.deepEqual(observations.releases, [undefined]);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    )).rows[0].count, 1);
  });
});

test("Migration 011 drains terminal work before delayed rollback and issues only cleanup", {
  skip: skipForRoot,
  timeout: 30000,
}, async (t) => {
  const disposable = await postgresAt010(t);
  const terminalState = createTerminalState();
  const observations = { observeConnectionErrors: true };
  let failedAt = -1;
  const wrapped = interceptedPool(
    disposable.pool,
    async ({ client, sql, parameters, observations: seen }) => {
      if (sql.includes("AS incomplete_name_pair")) {
        failedAt = seen.queries.length - 1;
        terminalState.terminate("migration_overall_deadline");
        throw new Error("synthetic terminal preflight");
      }
      if (sql === "ROLLBACK") {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return client.query(sql, parameters);
    },
    observations
  );
  const started = process.hrtime.bigint();
  await assert.rejects(runNullableNamesMigration({
    pool: wrapped,
    environment: disabledEnvironment,
    terminalState,
  }), (error) => (
    error.code === "query_failed"
    && error.cause
    && error.cause.message === "synthetic terminal preflight"
  ));
  const elapsed = Number((process.hrtime.bigint() - started) / 1000000n);
  assert.equal(elapsed >= 200, true);
  assert.equal(failedAt >= 0, true);
  assert.deepEqual(
    observations.queries.slice(failedAt + 1).map(({ sql }) => sql),
    ["ROLLBACK"]
  );
  assertExpectedIdleTerminationAndSocketClose(observations);
  await assertMigration010State(disposable.pool);
});
