"use strict";

const NANOSECONDS_PER_MILLISECOND = 1000000n;
const DEFAULT_PHASE_MILLISECONDS = 5000;
const TIMEOUT_CONFIGURATION_SQL = `SELECT
  set_config('lock_timeout', $1, true),
  set_config('statement_timeout', $1, true),
  set_config('idle_in_transaction_session_timeout', $1, true)`;

class BoundedTransactionError extends Error {
  constructor(code, options = {}) {
    super("Bounded database transaction did not complete");
    this.name = "BoundedTransactionError";
    this.code = code;
    this.committed = options.committed === true;
    this.discarded = options.discarded === true;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function monotonicNow() {
  return process.hrtime.bigint();
}

function millisecondsToNanoseconds(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("Deadline duration must be a positive safe integer");
  }
  return BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND;
}

function deadlineAfter(nowNs, milliseconds) {
  if (typeof nowNs !== "bigint") throw new Error("Monotonic time must be bigint");
  return nowNs + millisecondsToNanoseconds(milliseconds);
}

function minimumDeadline(...deadlines) {
  const values = deadlines.filter((value) => typeof value === "bigint");
  if (!values.length) throw new Error("At least one deadline is required");
  return values.reduce((minimum, value) => value < minimum ? value : minimum);
}

function positiveRemainingMilliseconds(deadlineNs, nowNs = monotonicNow()) {
  if (typeof deadlineNs !== "bigint" || typeof nowNs !== "bigint") {
    throw new Error("Monotonic deadlines must be bigint");
  }
  const remainingNs = deadlineNs - nowNs;
  if (remainingNs <= 0n) return null;
  const rounded = (remainingNs + NANOSECONDS_PER_MILLISECOND - 1n)
    / NANOSECONDS_PER_MILLISECOND;
  if (rounded <= 0n) return null;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Deadline remainder exceeds supported range");
  }
  return Number(rounded);
}

function timeoutValue(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("PostgreSQL timeout must be positive");
  }
  return `${milliseconds}ms`;
}

function createTerminalState() {
  let terminal = false;
  let reason = null;
  let responseAllowed = true;
  const listeners = new Set();
  return Object.freeze({
    isTerminal() { return terminal; },
    reason() { return reason; },
    responseAllowed() { return responseAllowed; },
    terminate(nextReason, options = {}) {
      if (terminal) return false;
      terminal = true;
      reason = typeof nextReason === "string" ? nextReason : "terminal";
      responseAllowed = options.responseAllowed !== false;
      for (const listener of Array.from(listeners)) {
        try { listener(reason); } catch (_) {}
      }
      listeners.clear();
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new Error("Terminal listener is required");
      if (terminal) {
        listener(reason);
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function armDeadline(deadlineNs, terminalState, now, reason) {
  const remaining = positiveRemainingMilliseconds(deadlineNs, now());
  if (remaining === null) {
    terminalState.terminate(reason);
    return () => {};
  }
  const timer = setTimeout(() => terminalState.terminate(reason), remaining);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

function releaseClient(client, discardError) {
  if (!client || typeof client.release !== "function") return;
  client.release(discardError);
}

async function checkoutClientOnce(options) {
  const { pool, deadlineNs, terminalState, now = monotonicNow } = options;
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("A PostgreSQL pool is required");
  }
  if (terminalState.isTerminal()) {
    throw new BoundedTransactionError("terminal_before_checkout");
  }

  let connectPromise;
  try {
    connectPromise = Promise.resolve(pool.connect());
  } catch (error) {
    throw new BoundedTransactionError("checkout_failed", { cause: error });
  }

  let timer;
  let unsubscribe = () => {};
  const terminalPromise = new Promise((resolve) => {
    const signal = () => resolve({ terminal: true });
    unsubscribe = terminalState.subscribe(signal);
    const remaining = positiveRemainingMilliseconds(deadlineNs, now());
    if (remaining === null) return signal();
    timer = setTimeout(signal, remaining);
    if (typeof timer.unref === "function") timer.unref();
  });
  const wrappedCheckout = connectPromise.then(
    (client) => ({ client }),
    (error) => ({ error })
  );
  const winner = await Promise.race([wrappedCheckout, terminalPromise]);
  if (timer) clearTimeout(timer);
  unsubscribe();

  if (winner.terminal) {
    terminalState.terminate("database_checkout_deadline");
    wrappedCheckout.then((late) => {
      if (late.client) {
        try { releaseClient(late.client); } catch (_) {}
      }
    });
    throw new BoundedTransactionError("checkout_terminal");
  }
  if (winner.error) {
    throw new BoundedTransactionError("checkout_failed", { cause: winner.error });
  }
  if (
    terminalState.isTerminal()
    || positiveRemainingMilliseconds(deadlineNs, now()) === null
  ) {
    try { releaseClient(winner.client); } catch (_) {}
    throw new BoundedTransactionError("checkout_late");
  }
  return winner.client;
}

async function runBoundedPostgresTransaction(options = {}) {
  const pool = options.pool;
  const now = typeof options.monotonicNow === "function"
    ? options.monotonicNow
    : monotonicNow;
  const terminalState = options.terminalState || createTerminalState();
  const phaseMilliseconds = options.phaseMilliseconds || DEFAULT_PHASE_MILLISECONDS;
  const outerDeadlineNs = options.outerDeadlineNs;
  const phaseStartNs = now();
  const phaseDeadlineNs = minimumDeadline(
    deadlineAfter(phaseStartNs, phaseMilliseconds),
    outerDeadlineNs
  );
  const clearPhaseTimer = armDeadline(
    phaseDeadlineNs,
    terminalState,
    now,
    "database_phase_deadline"
  );

  let client = null;
  let released = false;
  let discarded = false;
  let began = false;
  let timeoutInstalled = false;
  let activePromise = null;
  let commitIssued = false;
  let rollbackIssued = false;
  let committed = false;

  function remainingMilliseconds() {
    return positiveRemainingMilliseconds(
      minimumDeadline(phaseDeadlineNs, outerDeadlineNs),
      now()
    );
  }

  function discard(cause) {
    if (released) return;
    discarded = true;
    released = true;
    const error = cause instanceof Error
      ? cause
      : new Error("Discarding uncertain PostgreSQL client");
    try { releaseClient(client, error); } catch (_) {}
  }

  function ordinaryRelease() {
    if (released) return;
    released = true;
    releaseClient(client);
  }

  async function issue(sql, params, queryOptions = {}) {
    if (activePromise) throw new Error("Concurrent PostgreSQL query is prohibited");
    if (!queryOptions.cleanup && terminalState.isTerminal()) {
      throw new BoundedTransactionError("terminal_before_query");
    }
    let promise;
    try {
      promise = Promise.resolve(client.query(sql, params));
    } catch (error) {
      throw new BoundedTransactionError("query_failed", { cause: error });
    }
    activePromise = promise;
    const unlisten = terminalState.subscribe(() => {
      if (!queryOptions.serverBounded) discard(new Error("Unbounded query crossed terminal state"));
    });
    try {
      return await promise;
    } catch (error) {
      throw new BoundedTransactionError("query_failed", {
        cause: error,
        discarded,
      });
    } finally {
      unlisten();
      activePromise = null;
    }
  }

  async function configureTimeouts() {
    const remaining = remainingMilliseconds();
    if (remaining === null || terminalState.isTerminal()) {
      terminalState.terminate("database_phase_deadline");
      throw new BoundedTransactionError("terminal_before_timeout_configuration");
    }
    await issue(
      TIMEOUT_CONFIGURATION_SQL,
      [timeoutValue(remaining)],
      { serverBounded: timeoutInstalled }
    );
    timeoutInstalled = true;
    if (remainingMilliseconds() === null || terminalState.isTerminal()) {
      terminalState.terminate("database_phase_deadline");
      throw new BoundedTransactionError("terminal_after_timeout_configuration");
    }
  }

  async function protectedQuery(sql, params = []) {
    await configureTimeouts();
    if (remainingMilliseconds() === null || terminalState.isTerminal()) {
      terminalState.terminate("database_phase_deadline");
      throw new BoundedTransactionError("terminal_before_protected_query");
    }
    const result = await issue(sql, params, { serverBounded: true });
    if (remainingMilliseconds() === null || terminalState.isTerminal()) {
      terminalState.terminate("database_phase_deadline");
      throw new BoundedTransactionError("terminal_after_protected_query");
    }
    return result;
  }

  try {
    client = await checkoutClientOnce({
      pool,
      deadlineNs: phaseDeadlineNs,
      terminalState,
      now,
    });
    if (remainingMilliseconds() === null || terminalState.isTerminal()) {
      ordinaryRelease();
      throw new BoundedTransactionError("terminal_before_begin");
    }
    await issue("BEGIN", [], { serverBounded: false });
    began = true;
    if (discarded) throw new BoundedTransactionError("begin_unknown", { discarded: true });
    await configureTimeouts();
    const value = await options.work(Object.freeze({
      query: protectedQuery,
      remainingMilliseconds,
    }));
    if (remainingMilliseconds() === null || terminalState.isTerminal()) {
      throw new BoundedTransactionError("terminal_before_commit");
    }
    await configureTimeouts();
    if (remainingMilliseconds() === null || terminalState.isTerminal()) {
      throw new BoundedTransactionError("terminal_before_commit");
    }
    commitIssued = true;
    await issue("COMMIT", [], { serverBounded: true });
    committed = true;
    began = false;
    if (remainingMilliseconds() === null || terminalState.isTerminal()) {
      ordinaryRelease();
      throw new BoundedTransactionError("commit_after_terminal", { committed: true });
    }
    ordinaryRelease();
    return Object.freeze({ committed: true, value });
  } catch (error) {
    if (committed) {
      if (!released) ordinaryRelease();
      throw error;
    }
    if (commitIssued) {
      discard(error);
      throw new BoundedTransactionError("commit_unknown", {
        cause: error,
        discarded: true,
      });
    }
    if (began && !discarded && !released && !activePromise) {
      if (!timeoutInstalled && terminalState.isTerminal()) {
        discard(error);
      } else {
        try {
          if (!terminalState.isTerminal() && remainingMilliseconds() !== null) {
            await configureTimeouts();
          }
          rollbackIssued = true;
          await issue("ROLLBACK", [], { cleanup: true, serverBounded: timeoutInstalled });
          began = false;
          ordinaryRelease();
        } catch (rollbackError) {
          discard(rollbackError);
        }
      }
    } else if (!released) {
      if (client && !began && !activePromise) ordinaryRelease();
      else discard(error);
    }
    if (error instanceof BoundedTransactionError) throw error;
    throw new BoundedTransactionError("work_failed", {
      cause: error,
      discarded,
    });
  } finally {
    clearPhaseTimer();
    if (activePromise) {
      try { await activePromise; } catch (_) {}
    }
    if (!released && client) {
      if (!began && !commitIssued && !rollbackIssued) ordinaryRelease();
      else discard(new Error("PostgreSQL client state was not confirmed idle"));
    }
  }
}

module.exports = {
  BoundedTransactionError,
  DEFAULT_PHASE_MILLISECONDS,
  NANOSECONDS_PER_MILLISECOND,
  TIMEOUT_CONFIGURATION_SQL,
  checkoutClientOnce,
  createTerminalState,
  deadlineAfter,
  minimumDeadline,
  monotonicNow,
  positiveRemainingMilliseconds,
  runBoundedPostgresTransaction,
  timeoutValue,
};
