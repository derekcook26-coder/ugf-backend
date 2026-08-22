"use strict";

const {
  createTerminalState,
  deadlineAfter,
  minimumDeadline,
  monotonicNow,
  positiveRemainingMilliseconds,
  runBoundedPostgresTransaction,
} = require("./bounded-postgres-transaction");
const { MEMBER_COACHING_CONSENT_NOTICE_VERSION } = require("./gymmaster-member-coaching-consent");
const {
  createGymMasterGatekeeperMembershipVerifier,
} = require("./gymmaster-gatekeeper-membership");
const { MEMBER_SAFETY_NOTICE_VERSION } = require("./gymmaster-member-safety-intake");
const { createMemberConversationBindingService } = require("./member-conversation-binding-service");
const { MEMBER_CONVERSATION_TURN_CONTRACT_VERSION } = require("./member-conversation-turn-contract");

const MEMBER_CONVERSATION_AUTHORIZATION_TIMEOUT_MILLISECONDS = 5000;
const DATABASE_ID = /^[1-9]\d{0,18}$/;
const unavailableAdapters = Object.freeze({
  conversationOwnership: null,
  currentConsent: null,
  currentMembership: null,
  currentSafetyEligibility: null,
});

class MemberConversationAuthorizationError extends Error {
  constructor(code, cause) {
    super("Member conversation authorization is unavailable");
    this.name = "MemberConversationAuthorizationError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function databaseId(value) {
  const normalized = String(value);
  return DATABASE_ID.test(normalized) ? normalized : null;
}

function active(context) {
  return !context.terminalState.isTerminal()
    && !(context.signal && context.signal.aborted === true);
}

function requireActive(context) {
  if (active(context)) return;
  throw new MemberConversationAuthorizationError("operation_terminal");
}

function operationContext(options, input = {}) {
  const now = options.monotonicNow;
  const terminalState = input.terminalState || createTerminalState();
  const localDeadlineNs = deadlineAfter(now(), options.timeoutMilliseconds);
  const outerDeadlineNs = minimumDeadline(localDeadlineNs, input.outerDeadlineNs);
  const signal = input.signal;
  const onAbort = () => terminalState.terminate("member_conversation_authorization_aborted", {
    responseAllowed: false,
  });
  if (signal && typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  if (signal && signal.aborted === true) onAbort();
  return Object.freeze({
    monotonicNow: now,
    outerDeadlineNs,
    signal,
    terminalState,
    cleanup() {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    },
  });
}

async function awaitBounded(promise, context) {
  requireActive(context);
  let timer;
  let unsubscribe = () => {};
  const terminal = new Promise((_, reject) => {
    const end = () => reject(new MemberConversationAuthorizationError("operation_terminal"));
    unsubscribe = context.terminalState.subscribe(end);
    const remaining = positiveRemainingMilliseconds(
      context.outerDeadlineNs,
      context.monotonicNow()
    );
    if (remaining === null) {
      context.terminalState.terminate("member_conversation_authorization_deadline");
      return;
    }
    timer = setTimeout(() => {
      context.terminalState.terminate("member_conversation_authorization_deadline");
    }, remaining);
    if (typeof timer.unref === "function") timer.unref();
  });
  const settled = Promise.resolve(promise);
  try {
    const result = await Promise.race([settled, terminal]);
    requireActive(context);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
    settled.catch(() => {});
  }
}

function validMembershipInput(value) {
  if (!value || typeof value !== "object" || !value.identity) return null;
  const memberId = databaseId(value.memberId);
  const mappingId = databaseId(value.identity.mappingId);
  const identityMemberId = databaseId(value.identity.memberId);
  const memberSessionId = databaseId(value.identity.memberSessionId);
  const expectedSubject = memberId ? `gymmaster:${memberId}` : null;
  return memberId && mappingId && memberSessionId && identityMemberId === memberId
    && value.identity.authProvider === "gymmaster"
    && value.identity.authSubject === expectedSubject
    ? Object.freeze({ memberId }) : null;
}

function validDatabaseInput(value) {
  if (!value || typeof value !== "object") return null;
  const memberId = databaseId(value.memberId);
  const mappingId = databaseId(value.mappingId);
  return memberId && mappingId ? Object.freeze({ mappingId, memberId }) : null;
}

function createMemberConversationAuthorizationAdapters(options = {}) {
  if (!options.pool || typeof options.pool.connect !== "function") {
    throw new Error("Member conversation authorization adapters require a PostgreSQL pool");
  }
  if (!options.membershipVerifier
    || typeof options.membershipVerifier.verifyActiveMember !== "function") {
    throw new Error("Member conversation authorization adapters require a Gatekeeper verifier");
  }
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds)
    && options.timeoutMilliseconds > 0
    && options.timeoutMilliseconds <= MEMBER_CONVERSATION_AUTHORIZATION_TIMEOUT_MILLISECONDS
    ? options.timeoutMilliseconds : MEMBER_CONVERSATION_AUTHORIZATION_TIMEOUT_MILLISECONDS;
  const runtime = Object.freeze({
    monotonicNow: typeof options.monotonicNow === "function" ? options.monotonicNow : monotonicNow,
    timeoutMilliseconds,
  });
  const bindingService = createMemberConversationBindingService({
    pool: options.pool,
    timeoutMilliseconds,
    monotonicNow: runtime.monotonicNow,
  });

  async function read(inputValue, work) {
    const input = validDatabaseInput(inputValue);
    if (!input) return null;
    const context = operationContext(runtime, inputValue);
    try {
      requireActive(context);
      const result = await runBoundedPostgresTransaction({
        pool: options.pool,
        terminalState: context.terminalState,
        outerDeadlineNs: context.outerDeadlineNs,
        monotonicNow: context.monotonicNow,
        phaseMilliseconds: timeoutMilliseconds,
        readOnly: true,
        work: ({ query }) => work(query, input),
      });
      requireActive(context);
      return result.value;
    } catch (error) {
      if (error instanceof MemberConversationAuthorizationError) throw error;
      throw new MemberConversationAuthorizationError("database_unavailable", error);
    } finally {
      context.cleanup();
    }
  }

  const currentMembership = Object.freeze({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    source: "gymmaster_gatekeeper",
    readOnly: true,
    currentRequestVerification: true,
    async verify(inputValue) {
      const input = validMembershipInput(inputValue);
      if (!input) return null;
      const context = operationContext(runtime, inputValue);
      try {
        const result = await awaitBounded(
          options.membershipVerifier.verifyActiveMember(input.memberId),
          context
        );
        return result && typeof result === "object" && !Array.isArray(result)
          && result.active === true && Object.keys(result).length === 1
          ? Object.freeze({ active: true }) : null;
      } finally {
        context.cleanup();
      }
    },
  });

  const currentConsent = Object.freeze({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    noticeVersion: MEMBER_COACHING_CONSENT_NOTICE_VERSION,
    providerFree: true,
    readOnly: true,
    currentAcceptedConsentRequired: true,
    async verify(inputValue) {
      return read(inputValue, async (query, input) => {
        const result = await query(
          `SELECT 1
             FROM goals_coach_member_coaching_consents consent
             JOIN goals_coach_member_auth_mappings mapping
               ON mapping.id = consent.auth_mapping_id
              AND mapping.member_id = consent.member_id
            WHERE consent.member_id = $1
              AND consent.auth_mapping_id = $2
              AND consent.notice_version = $3
              AND consent.status = 'accepted'
              AND consent.withdrawn_at IS NULL
              AND mapping.active = TRUE`,
          [input.memberId, input.mappingId, MEMBER_COACHING_CONSENT_NOTICE_VERSION]
        );
        return result.rows && result.rows.length === 1
          ? Object.freeze({ accepted: true }) : null;
      });
    },
  });

  const currentSafetyEligibility = Object.freeze({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    noticeVersion: MEMBER_SAFETY_NOTICE_VERSION,
    providerFree: true,
    readOnly: true,
    currentScreenCompleteRequired: true,
    async verify(inputValue) {
      return read(inputValue, async (query, input) => {
        const result = await query(
          `SELECT assessment.outcome
             FROM goals_coach_member_safety_intake_v2_assessments assessment
             JOIN goals_coach_member_auth_mappings mapping
               ON mapping.id = assessment.auth_mapping_id
              AND mapping.member_id = assessment.member_id
            WHERE assessment.member_id = $1
              AND assessment.auth_mapping_id = $2
              AND assessment.notice_version = $3
              AND assessment.valid_until > CURRENT_TIMESTAMP
              AND mapping.active = TRUE
            ORDER BY assessment.submitted_at DESC, assessment.id DESC
            LIMIT 1`,
          [input.memberId, input.mappingId, MEMBER_SAFETY_NOTICE_VERSION]
        );
        return result.rows && result.rows.length === 1
          && result.rows[0].outcome === "SCREEN_COMPLETE"
          ? Object.freeze({ eligible: true }) : null;
      });
    },
  });

  return Object.freeze({
    currentMembership,
    currentConsent,
    currentSafetyEligibility,
    conversationOwnership: bindingService.ownership,
  });
}

function createProductionMemberConversationAuthorizationAdapters(options = {}) {
  const environment = options.environment || process.env;
  if (!options.pool || typeof options.pool.connect !== "function"
    || typeof options.fetchImpl !== "function") return unavailableAdapters;
  try {
    const membershipVerifier = createGymMasterGatekeeperMembershipVerifier({
      endpoint: environment.GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL,
      site: environment.GYMMASTER_SITE,
      apiKey: environment.GYMMASTER_API_KEY,
      fetchImpl: options.fetchImpl,
      ...(options.gatekeeperTimeoutMilliseconds === undefined
        ? {} : { timeoutMs: options.gatekeeperTimeoutMilliseconds }),
    });
    return createMemberConversationAuthorizationAdapters({
      pool: options.pool,
      membershipVerifier,
      ...(options.timeoutMilliseconds === undefined
        ? {} : { timeoutMilliseconds: options.timeoutMilliseconds }),
      ...(typeof options.monotonicNow === "function"
        ? { monotonicNow: options.monotonicNow } : {}),
    });
  } catch (_) {
    return unavailableAdapters;
  }
}

module.exports = {
  MEMBER_CONVERSATION_AUTHORIZATION_TIMEOUT_MILLISECONDS,
  MemberConversationAuthorizationError,
  createMemberConversationAuthorizationAdapters,
  createProductionMemberConversationAuthorizationAdapters,
};
