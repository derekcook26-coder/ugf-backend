"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BoundedTransactionError,
  createTerminalState,
  deadlineAfter,
  monotonicNow,
  runBoundedPostgresTransaction,
} = require("../src/goals-coach/bounded-postgres-transaction");
const {
  acquireGymMasterMemberProvisioningLock,
} = require("../src/goals-coach/gymmaster-member-provisioning-lock");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires unprivileged PostgreSQL 16; root skips are not acceptance evidence"
  : false;

function boundedOptions(pool, work, terminalState = createTerminalState()) {
  const started = monotonicNow();
  return {
    pool,
    outerDeadlineNs: deadlineAfter(started, 5000),
    phaseMilliseconds: 5000,
    terminalState,
    work,
  };
}

function instrumentedPool(pool) {
  const releases = [];
  const queries = [];
  const lifecycle = [];
  return {
    releases,
    queries,
    lifecycle,
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, parameters) {
          queries.push(sql);
          if (sql === "ROLLBACK") lifecycle.push("rollback_started");
          const result = await client.query(sql, parameters);
          if (sql === "ROLLBACK") lifecycle.push("rollback_confirmed");
          return result;
        },
        release(error) {
          lifecycle.push("release");
          releases.push(error);
          client.release(error);
        },
      };
    },
  };
}

async function assertNativeTimeout(run, observed, started) {
  await assert.rejects(run, BoundedTransactionError);
  const elapsed = Number((monotonicNow() - started) / 1000000n);
  assert.equal(elapsed >= 4500, true, "server timeout must remain authoritative");
  assert.equal(elapsed <= 5500, true, "phase must remain bounded");
  assert.equal(observed.queries.includes("COMMIT"), false);
  assert.equal(
    observed.queries.filter((sql) => sql === "ROLLBACK").length,
    1
  );
  assert.equal(observed.releases.length, 1);
  // PostgreSQL statement/lock timeout aborts the transaction, not the
  // connection. The helper must roll the known transaction back before its
  // one ordinary pool release; a release(error) assertion would incorrectly
  // require eviction of a connection PostgreSQL has confirmed usable.
  assert.equal(observed.releases[0], undefined);
  assert.deepEqual(observed.lifecycle, [
    "rollback_started",
    "rollback_confirmed",
    "release",
  ]);
}

test("PostgreSQL 16 bounds an advisory-lock wait, rolls back, and safely reuses the connection", {
  skip: skipForRoot,
  timeout: 15000,
}, async (t) => {
  const disposable = await createRealDisposablePostgres();
  t.after(() => disposable.close());
  let blocker;
  try {
    blocker = await disposable.pool.connect();
    await blocker.query("BEGIN");
    await acquireGymMasterMemberProvisioningLock(blocker, "93001");

    const observed = instrumentedPool(disposable.pool);
    const started = monotonicNow();
    const run = runBoundedPostgresTransaction(boundedOptions(
      observed,
      (transaction) => acquireGymMasterMemberProvisioningLock(
        transaction,
        "93001"
      )
    ));
    await assertNativeTimeout(run, observed, started);
  } finally {
    if (blocker) {
      try { await blocker.query("ROLLBACK"); } catch (_) {}
      blocker.release();
    }
  }
});

test("PostgreSQL 16 bounds a row-lock wait and commits no protected write", {
  skip: skipForRoot,
  timeout: 15000,
}, async (t) => {
  const disposable = await createRealDisposablePostgres();
  t.after(() => disposable.close());
  let blocker;
  try {
    const member = (await disposable.pool.query(
      `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
       VALUES ('93002', 'Row', 'Lock') RETURNING id`
    )).rows[0];
    blocker = await disposable.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM coach_members WHERE id = $1 FOR UPDATE",
      [member.id]
    );

    const observed = instrumentedPool(disposable.pool);
    const started = monotonicNow();
    const run = runBoundedPostgresTransaction(boundedOptions(
      observed,
      (transaction) => transaction.query(
        "SELECT id FROM coach_members WHERE id = $1 FOR UPDATE",
        [member.id]
      )
    ));
    await assertNativeTimeout(run, observed, started);
  } finally {
    if (blocker) {
      try { await blocker.query("ROLLBACK"); } catch (_) {}
      blocker.release();
    }
  }
});

test("HTTP-style terminal cancellation cannot outrun the server statement timeout", {
  skip: skipForRoot,
  timeout: 15000,
}, async (t) => {
  const disposable = await createRealDisposablePostgres();
  t.after(() => disposable.close());
  let timer;
  try {
    const terminalState = createTerminalState();
    const observed = instrumentedPool(disposable.pool);
    const started = monotonicNow();
    const run = runBoundedPostgresTransaction(boundedOptions(
      observed,
      (transaction) => transaction.query("SELECT pg_sleep(30)"),
      terminalState
    ));
    timer = setTimeout(() => {
      terminalState.terminate("request_aborted", { responseAllowed: false });
    }, 100);
    await assertNativeTimeout(run, observed, started);
    assert.equal(terminalState.responseAllowed(), false);
    assert.equal(
      observed.queries.filter((sql) => sql === "SELECT pg_sleep(30)").length,
      1
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
});
