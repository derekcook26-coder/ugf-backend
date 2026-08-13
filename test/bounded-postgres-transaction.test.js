"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BoundedTransactionError,
  TIMEOUT_CONFIGURATION_SQL,
  createTerminalState,
  deadlineAfter,
  monotonicNow,
  positiveRemainingMilliseconds,
  runBoundedPostgresTransaction,
  timeoutValue,
} = require("../src/goals-coach/bounded-postgres-transaction");
const {
  GYMMASTER_PROVISIONING_LOCK_SQL,
  acquireGymMasterMemberProvisioningLock,
  canonicalGymMasterMemberId,
} = require("../src/goals-coach/gymmaster-member-provisioning-lock");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function transactionOptions(pool, overrides = {}) {
  const started = monotonicNow();
  return {
    pool,
    outerDeadlineNs: deadlineAfter(started, 1000),
    terminalState: createTerminalState(),
    phaseMilliseconds: 1000,
    ...overrides,
  };
}

test("bounded transaction configures all PostgreSQL timeouts and releases only after confirmed commit", async () => {
  const queries = [];
  const releases = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      return { rows: [{ value: "ok" }] };
    },
    release(error) { releases.push(error); },
  };
  const result = await runBoundedPostgresTransaction(transactionOptions({
    async connect() { return client; },
  }, {
    work: async (transaction) => (
      transaction.query("SELECT 'protected' AS value")
    ),
  }));
  assert.equal(result.committed, true);
  assert.equal(result.value.rows[0].value, "ok");
  assert.equal(queries[0].sql, "BEGIN");
  assert.equal(queries.at(-1).sql, "COMMIT");
  const configurations = queries.filter((query) => (
    query.sql === TIMEOUT_CONFIGURATION_SQL
  ));
  assert.equal(configurations.length >= 3, true);
  assert.equal(configurations.every(({ parameters }) => /^[1-9][0-9]*ms$/.test(parameters[0])), true);
  assert.deepEqual(releases, [undefined]);
});

test("late checkout is drained and the proven-unused client is released without BEGIN", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  const checkout = deferred();
  const releases = [];
  const started = monotonicNow();
  const pending = runBoundedPostgresTransaction({
    pool: { connect() { return checkout.promise; } },
    outerDeadlineNs: deadlineAfter(started, 5),
    terminalState: createTerminalState(),
    phaseMilliseconds: 5,
    work: async () => null,
  });
  await assert.rejects(pending, BoundedTransactionError);
  checkout.resolve({
    query() { throw new Error("late client must never query"); },
    release(error) { releases.push(error); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  clearTimeout(keepAlive);
  assert.deepEqual(releases, [undefined]);
});

test("route cancellation wins checkout and a late client never reaches transaction logic", async () => {
  const checkout = deferred();
  const terminalState = createTerminalState();
  const releases = [];
  let workCalls = 0;
  const run = runBoundedPostgresTransaction(transactionOptions({
    connect() { return checkout.promise; },
  }, {
    terminalState,
    work: async () => { workCalls += 1; },
  }));
  terminalState.terminate("request_aborted", { responseAllowed: false });
  await assert.rejects(run, BoundedTransactionError);
  checkout.resolve({
    query() { throw new Error("late client must remain unused"); },
    release(error) { releases.push(error); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workCalls, 0);
  assert.deepEqual(releases, [undefined]);
});

test("an unresolved BEGIN is evicted on terminal state and never receives rollback", async () => {
  const begin = deferred();
  const queries = [];
  const releases = [];
  const terminalState = createTerminalState();
  const client = {
    query(sql) {
      queries.push(sql);
      if (sql === "BEGIN") return begin.promise;
      throw new Error("No SQL may follow unresolved BEGIN");
    },
    release(error) {
      releases.push(error);
      if (error) begin.reject(new Error("connection destroyed"));
    },
  };
  const run = runBoundedPostgresTransaction(transactionOptions({
    async connect() { return client; },
  }, {
    terminalState,
    work: async () => null,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  terminalState.terminate("request_aborted", { responseAllowed: false });
  await assert.rejects(run, BoundedTransactionError);
  assert.deepEqual(queries, ["BEGIN"]);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
});

test("rollback failure and unknown COMMIT both evict instead of returning a client to the pool", async (t) => {
  await t.test("rollback failure", async () => {
    const releases = [];
    const client = {
      async query(sql) {
        if (sql === "SELECT broken") throw new Error("protected failure");
        if (sql === "ROLLBACK") throw new Error("rollback failure");
        return { rows: [] };
      },
      release(error) { releases.push(error); },
    };
    await assert.rejects(
      runBoundedPostgresTransaction(transactionOptions({
        async connect() { return client; },
      }, {
        work: (transaction) => transaction.query("SELECT broken"),
      })),
      BoundedTransactionError
    );
    assert.equal(releases.length, 1);
    assert.ok(releases[0] instanceof Error);
  });

  await t.test("unknown commit", async () => {
    const queries = [];
    const releases = [];
    const client = {
      async query(sql) {
        queries.push(sql);
        if (sql === "COMMIT") throw new Error("socket lost");
        return { rows: [] };
      },
      release(error) { releases.push(error); },
    };
    await assert.rejects(
      runBoundedPostgresTransaction(transactionOptions({
        async connect() { return client; },
      }, {
        work: async () => "ready",
      })),
      (error) => error.code === "commit_unknown"
    );
    assert.equal(queries.filter((sql) => sql === "COMMIT").length, 1);
    assert.equal(queries.includes("ROLLBACK"), false);
    assert.equal(releases.length, 1);
    assert.ok(releases[0] instanceof Error);
  });
});

test("disconnect during COMMIT yields one confirmed database outcome and no competing rollback", async () => {
  const commit = deferred();
  const queries = [];
  const releases = [];
  const terminalState = createTerminalState();
  const client = {
    query(sql) {
      queries.push(sql);
      if (sql === "COMMIT") return commit.promise;
      return Promise.resolve({ rows: [] });
    },
    release(error) { releases.push(error); },
  };
  const run = runBoundedPostgresTransaction(transactionOptions({
    async connect() { return client; },
  }, {
    terminalState,
    work: async () => "ready",
  }));
  while (!queries.includes("COMMIT")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  terminalState.terminate("response_closed", { responseAllowed: false });
  commit.resolve({ rows: [] });
  await assert.rejects(run, (error) => error.committed === true);
  assert.equal(queries.filter((sql) => sql === "COMMIT").length, 1);
  assert.equal(queries.includes("ROLLBACK"), false);
  assert.deepEqual(releases, [undefined]);
});

test("terminal state during an active server-bounded query drains before one rollback", async () => {
  const active = deferred();
  const queries = [];
  const releases = [];
  const terminalState = createTerminalState();
  const client = {
    query(sql) {
      queries.push(sql);
      if (sql === "SELECT active") return active.promise;
      return Promise.resolve({ rows: [] });
    },
    release(error) { releases.push(error); },
  };
  const run = runBoundedPostgresTransaction(transactionOptions({
    async connect() { return client; },
  }, {
    terminalState,
    work: (transaction) => transaction.query("SELECT active"),
  }));
  while (!queries.includes("SELECT active")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  terminalState.terminate("request_aborted", { responseAllowed: false });
  active.resolve({ rows: [] });
  await assert.rejects(run, BoundedTransactionError);
  assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.equal(queries.includes("COMMIT"), false);
  assert.deepEqual(releases, [undefined]);
});

test("disconnect before COMMIT prevents COMMIT and selects exactly one rollback path", async () => {
  const queries = [];
  const releases = [];
  const terminalState = createTerminalState();
  const client = {
    async query(sql) {
      queries.push(sql);
      return { rows: [] };
    },
    release(error) { releases.push(error); },
  };
  await assert.rejects(
    runBoundedPostgresTransaction(transactionOptions({
      async connect() { return client; },
    }, {
      terminalState,
      work: async () => {
        terminalState.terminate("response_closed", { responseAllowed: false });
        return "must-not-commit";
      },
    })),
    BoundedTransactionError
  );
  assert.equal(queries.includes("COMMIT"), false);
  assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.deepEqual(releases, [undefined]);
});

test("positive rollback cleanup narrows timeouts before returning an idle client", async () => {
  const queries = [];
  const releases = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (sql === "SELECT fail") throw new Error("synthetic statement failure");
      return { rows: [] };
    },
    release(error) { releases.push(error); },
  };
  await assert.rejects(runBoundedPostgresTransaction(transactionOptions({
    async connect() { return client; },
  }, {
    work: (transaction) => transaction.query("SELECT fail"),
  })), BoundedTransactionError);
  const rollbackIndex = queries.findIndex(({ sql }) => sql === "ROLLBACK");
  assert.notEqual(rollbackIndex, -1);
  assert.equal(queries[rollbackIndex - 1].sql, TIMEOUT_CONFIGURATION_SQL);
  assert.match(queries[rollbackIndex - 1].parameters[0], /^[1-9][0-9]*ms$/);
  assert.deepEqual(releases, [undefined]);
});

test("a stalled first timeout setup is discarded with no concurrent rollback", async () => {
  const setup = deferred();
  const queries = [];
  const releases = [];
  const terminalState = createTerminalState();
  const client = {
    query(sql) {
      queries.push(sql);
      if (sql === TIMEOUT_CONFIGURATION_SQL) return setup.promise;
      return Promise.resolve({ rows: [] });
    },
    release(error) {
      releases.push(error);
      if (error) setup.reject(new Error("destroyed stalled setup"));
    },
  };
  const run = runBoundedPostgresTransaction(transactionOptions({
    async connect() { return client; },
  }, {
    terminalState,
    work: async () => null,
  }));
  while (!queries.includes(TIMEOUT_CONFIGURATION_SQL)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  terminalState.terminate("request_aborted", { responseAllowed: false });
  await assert.rejects(run, BoundedTransactionError);
  assert.deepEqual(queries, ["BEGIN", TIMEOUT_CONFIGURATION_SQL]);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
});

test("a later timeout setup crossing terminal state cannot issue its protected statement", async () => {
  const setup = deferred();
  const queries = [];
  const releases = [];
  const terminalState = createTerminalState();
  let configurations = 0;
  const client = {
    query(sql) {
      queries.push(sql);
      if (sql === TIMEOUT_CONFIGURATION_SQL) {
        configurations += 1;
        if (configurations === 2) return setup.promise;
      }
      return Promise.resolve({ rows: [] });
    },
    release(error) { releases.push(error); },
  };
  const run = runBoundedPostgresTransaction(transactionOptions({
    async connect() { return client; },
  }, {
    terminalState,
    work: (transaction) => transaction.query("SELECT protected"),
  }));
  while (configurations < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  terminalState.terminate("request_aborted", { responseAllowed: false });
  setup.resolve({ rows: [] });
  await assert.rejects(run, BoundedTransactionError);
  assert.equal(queries.includes("SELECT protected"), false);
  assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.deepEqual(releases, [undefined]);
});

test("deadline rounding is monotonic-positive and can never configure zero milliseconds", () => {
  assert.equal(positiveRemainingMilliseconds(1n, 0n), 1);
  assert.equal(positiveRemainingMilliseconds(1000000n, 0n), 1);
  assert.equal(positiveRemainingMilliseconds(1000001n, 0n), 2);
  assert.equal(positiveRemainingMilliseconds(0n, 0n), null);
  assert.equal(positiveRemainingMilliseconds(1n, 2n), null);
  assert.equal(timeoutValue(1), "1ms");
  for (const value of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => timeoutValue(value));
  }
});

test("a client acquired after the phase deadline is released unused before BEGIN", async () => {
  const releases = [];
  const queries = [];
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls <= 2 ? 0n : 2000000000n;
  };
  await assert.rejects(runBoundedPostgresTransaction({
    pool: {
      async connect() {
        return {
          async query(sql) { queries.push(sql); return { rows: [] }; },
          release(error) { releases.push(error); },
        };
      },
    },
    outerDeadlineNs: 1000000000n,
    phaseMilliseconds: 1000,
    terminalState: createTerminalState(),
    monotonicNow: now,
    work: async () => null,
  }), BoundedTransactionError);
  assert.deepEqual(queries, []);
  assert.deepEqual(releases, [undefined]);
});

test("the shared GymMaster advisory helper owns canonicalization, namespace, seed, and SQL", async () => {
  assert.equal(canonicalGymMasterMemberId("90001"), "90001");
  for (const value of [90001, "0", "090001", " 90001", "90001 ", "1e2"]) {
    assert.throws(() => canonicalGymMasterMemberId(value));
  }
  const calls = [];
  await acquireGymMasterMemberProvisioningLock({
    async query(sql, parameters) { calls.push({ sql, parameters }); },
  }, "90001");
  assert.deepEqual(calls, [{
    sql: GYMMASTER_PROVISIONING_LOCK_SQL,
    parameters: ["90001"],
  }]);
  assert.match(GYMMASTER_PROVISIONING_LOCK_SQL, /8272051101::bigint/);
  assert.match(GYMMASTER_PROVISIONING_LOCK_SQL, /ugf\.goals_coach\.member_provisioning\.gymmaster\.v1:/);
});
