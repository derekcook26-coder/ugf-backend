"use strict";

const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
  positiveRemainingMilliseconds,
  runBoundedPostgresTransaction,
} = require("./bounded-postgres-transaction");
const {
  acquireGymMasterMemberProvisioningLock,
  canonicalGymMasterMemberId,
} = require("./gymmaster-member-provisioning-lock");

const PLAN_OUTER_MILLISECONDS = 45000;
const PLAN_DATABASE_PHASE_MILLISECONDS = 5000;
const PLAN_PROVIDER_MILLISECONDS = 30000;
const WEEKLY_DATABASE_MILLISECONDS = 5000;

class LegacyProvisioningRefusal extends Error {
  constructor(code) {
    super("Legacy member provisioning is unavailable");
    this.name = "LegacyProvisioningRefusal";
    this.code = code;
  }
}

function completeNamePair(row) {
  return Boolean(
    row
    && typeof row.first_name === "string"
    && row.first_name.trim().length > 0
    && typeof row.last_name === "string"
    && row.last_name.trim().length > 0
  );
}

function createPlanRouteTerminalContext(req, res, options = {}) {
  const now = typeof options.monotonicNow === "function"
    ? options.monotonicNow
    : monotonicNow;
  const terminalState = createTerminalState();
  const outerDeadlineNs = deadlineAfter(now(), PLAN_OUTER_MILLISECONDS);
  const remaining = positiveRemainingMilliseconds(outerDeadlineNs, now());
  const outerTimer = setTimeout(() => {
    terminalState.terminate("plan_outer_deadline", { responseAllowed: true });
  }, remaining || 1);
  if (typeof outerTimer.unref === "function") outerTimer.unref();

  const onAborted = () => terminalState.terminate(
    "request_aborted",
    { responseAllowed: false }
  );
  const onRequestClose = () => {
    if (!req.complete) {
      terminalState.terminate("request_closed", { responseAllowed: false });
    }
  };
  const onResponseClose = () => {
    if (!res.writableEnded) {
      terminalState.terminate("response_closed", { responseAllowed: false });
    }
  };
  req.once("aborted", onAborted);
  req.once("close", onRequestClose);
  res.once("close", onResponseClose);
  let cleaned = false;
  return Object.freeze({
    terminalState,
    outerDeadlineNs,
    monotonicNow: now,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(outerTimer);
      req.removeListener("aborted", onAborted);
      req.removeListener("close", onRequestClose);
      res.removeListener("close", onResponseClose);
    },
  });
}

async function inspectLockedLegacyState(transaction, gymmasterMemberId) {
  const canonicalId = canonicalGymMasterMemberId(gymmasterMemberId);
  await acquireGymMasterMemberProvisioningLock(transaction, canonicalId);
  const timestamp = await transaction.query(
    "SELECT transaction_timestamp() AS transaction_now"
  );
  const transactionNow = timestamp.rows[0] && timestamp.rows[0].transaction_now;
  if (!transactionNow || !Number.isFinite(new Date(transactionNow).getTime())) {
    throw new LegacyProvisioningRefusal("malformed_transaction_time");
  }
  const pending = await transaction.query(
    `SELECT id, status, expires_at
     FROM goals_coach_member_pending_enrollments
     WHERE gymmaster_member_id = $1
     ORDER BY id
     FOR UPDATE`,
    [canonicalId]
  );
  await transaction.query(
    `UPDATE goals_coach_member_pending_enrollments
     SET status = 'expired', expired_at = $2
     WHERE gymmaster_member_id = $1
       AND status = 'pending'
       AND expires_at <= $2`,
    [canonicalId, transactionNow]
  );
  const nowMilliseconds = new Date(transactionNow).getTime();
  if (pending.rows.some((row) => (
    row.status === "pending"
    && new Date(row.expires_at).getTime() > nowMilliseconds
  ))) {
    throw new LegacyProvisioningRefusal("live_pending_enrollment");
  }

  const member = await transaction.query(
    `SELECT id, gymmaster_member_id, first_name, last_name
     FROM coach_members
     WHERE gymmaster_member_id = $1
     FOR UPDATE`,
    [canonicalId]
  );
  if (member.rows.length > 1) {
    throw new LegacyProvisioningRefusal("ambiguous_member");
  }
  if (member.rows.length && !completeNamePair(member.rows[0])) {
    throw new LegacyProvisioningRefusal("nameless_member");
  }
  return Object.freeze({
    canonicalId,
    member: member.rows[0] || null,
    transactionNow,
  });
}

async function resolveLegacyMemberForWrite(transaction, state, firstName, lastName) {
  if (state.member) return state.member;
  if (
    typeof firstName !== "string"
    || !firstName.trim()
    || typeof lastName !== "string"
    || !lastName.trim()
  ) {
    throw new LegacyProvisioningRefusal("invalid_legacy_name_pair");
  }
  await transaction.query(
    `INSERT INTO coach_members
      (gymmaster_member_id, first_name, last_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (gymmaster_member_id) DO NOTHING`,
    [state.canonicalId, firstName, lastName]
  );
  const member = await transaction.query(
    `SELECT id, gymmaster_member_id, first_name, last_name
     FROM coach_members
     WHERE gymmaster_member_id = $1
     FOR UPDATE`,
    [state.canonicalId]
  );
  if (member.rows.length !== 1 || !completeNamePair(member.rows[0])) {
    throw new LegacyProvisioningRefusal("member_insert_conflict");
  }
  return member.rows[0];
}

async function runPlanDatabasePhase(options) {
  return runBoundedPostgresTransaction({
    pool: options.pool,
    outerDeadlineNs: options.route.outerDeadlineNs,
    terminalState: options.route.terminalState,
    phaseMilliseconds: PLAN_DATABASE_PHASE_MILLISECONDS,
    monotonicNow: options.route.monotonicNow,
    work: options.work,
  });
}

async function runProviderAttempt(options) {
  const route = options.route;
  if (route.terminalState.isTerminal()) {
    throw new LegacyProvisioningRefusal("terminal_before_provider");
  }
  const outerRemaining = positiveRemainingMilliseconds(
    route.outerDeadlineNs,
    route.monotonicNow()
  );
  if (outerRemaining === null) {
    route.terminalState.terminate("plan_outer_deadline", { responseAllowed: true });
    throw new LegacyProvisioningRefusal("terminal_before_provider");
  }
  const controller = new AbortController();
  let generationActive = true;
  let timer;
  let unsubscribe = () => {};
  const providerMilliseconds = Math.min(
    PLAN_PROVIDER_MILLISECONDS,
    outerRemaining
  );
  const terminalPromise = new Promise((resolve) => {
    const cancel = () => {
      if (!generationActive) return;
      generationActive = false;
      try { controller.abort(); } catch (_) {}
      resolve({ terminal: true });
    };
    unsubscribe = route.terminalState.subscribe(cancel);
    timer = setTimeout(() => {
      route.terminalState.terminate(
        "plan_provider_deadline",
        { responseAllowed: true }
      );
      cancel();
    }, providerMilliseconds);
    if (typeof timer.unref === "function") timer.unref();
  });
  let providerPromise;
  try {
    providerPromise = Promise.resolve(options.generate({
      signal: controller.signal,
      timeout: PLAN_PROVIDER_MILLISECONDS,
      maxRetries: 0,
    }));
  } catch (error) {
    providerPromise = Promise.reject(error);
  }
  const wrappedProvider = providerPromise.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  try {
    const winner = await Promise.race([wrappedProvider, terminalPromise]);
    if (winner.terminal || !generationActive || route.terminalState.isTerminal()) {
      wrappedProvider.then(() => {});
      throw new LegacyProvisioningRefusal("provider_terminal");
    }
    generationActive = false;
    if (winner.error) throw new LegacyProvisioningRefusal("provider_failed");
    return winner.value;
  } finally {
    generationActive = false;
    if (timer) clearTimeout(timer);
    unsubscribe();
  }
}

async function executePersonalizedPlan(options) {
  const route = options.route;
  const gymmasterMemberId = canonicalGymMasterMemberId(
    options.gymmasterMemberId
  );
  await runPlanDatabasePhase({
    pool: options.pool,
    route,
    work: async (transaction) => {
      await inspectLockedLegacyState(transaction, gymmasterMemberId);
      return null;
    },
  });
  if (route.terminalState.isTerminal()) {
    throw new LegacyProvisioningRefusal("terminal_after_phase_1");
  }

  const plan = await runProviderAttempt({
    route,
    generate: options.generatePlan,
  });
  if (typeof plan !== "string" || !plan.trim()) {
    throw new LegacyProvisioningRefusal("invalid_provider_result");
  }
  if (route.terminalState.isTerminal()) {
    throw new LegacyProvisioningRefusal("terminal_before_phase_3");
  }

  await runPlanDatabasePhase({
    pool: options.pool,
    route,
    work: async (transaction) => {
      const state = await inspectLockedLegacyState(
        transaction,
        gymmasterMemberId
      );
      const member = await resolveLegacyMemberForWrite(
        transaction,
        state,
        options.firstName,
        options.lastName
      );
      await transaction.query(
        `INSERT INTO coach_plans
          (member_id, profile_json, assessment_messages, plan_markdown)
         VALUES ($1, $2, $3, $4)`,
        [
          String(member.id),
          JSON.stringify(options.profile),
          JSON.stringify((options.messages || []).slice(-60)),
          plan,
        ]
      );
      return null;
    },
  });
  if (route.terminalState.isTerminal()) {
    throw new LegacyProvisioningRefusal("terminal_after_phase_3");
  }
  return plan;
}

async function createWeeklyCheckinSessionState(options) {
  const started = monotonicNow();
  const terminalState = createTerminalState();
  const deadline = deadlineAfter(started, WEEKLY_DATABASE_MILLISECONDS);
  const result = await runBoundedPostgresTransaction({
    pool: options.pool,
    outerDeadlineNs: deadline,
    terminalState,
    phaseMilliseconds: WEEKLY_DATABASE_MILLISECONDS,
    work: async (transaction) => {
      const state = await inspectLockedLegacyState(
        transaction,
        options.gymmasterMemberId
      );
      const member = await resolveLegacyMemberForWrite(
        transaction,
        state,
        options.firstName,
        options.lastName
      );
      const planResult = await transaction.query(
        `SELECT profile_json, created_at
         FROM coach_plans
         WHERE member_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [String(member.id)]
      );
      const checkinResult = await transaction.query(
        `SELECT id
         FROM weekly_checkins
         WHERE member_id = $1 AND week_start = $2`,
        [String(member.id), options.weekStart]
      );
      const sessionToken = options.buildToken(
        String(member.id),
        state.canonicalId,
        options.firstName
      );
      return Object.freeze({
        memberId: String(member.id),
        latestPlan: planResult.rows[0] || null,
        alreadySubmitted: checkinResult.rows.length > 0,
        sessionToken,
      });
    },
  });
  return result.value;
}

module.exports = {
  LegacyProvisioningRefusal,
  PLAN_DATABASE_PHASE_MILLISECONDS,
  PLAN_OUTER_MILLISECONDS,
  PLAN_PROVIDER_MILLISECONDS,
  WEEKLY_DATABASE_MILLISECONDS,
  completeNamePair,
  createPlanRouteTerminalContext,
  createWeeklyCheckinSessionState,
  executePersonalizedPlan,
  inspectLockedLegacyState,
};
