"use strict";

const crypto = require("node:crypto");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
  runBoundedPostgresTransaction,
} = require("./bounded-postgres-transaction");

const MEMBER_CONVERSATION_PROVIDER_DISPATCH_CONTRACT_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-DISPATCH-1";
const MEMBER_CONVERSATION_PROVIDER_CONTRACT_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-1";
const MEMBER_CONVERSATION_TURN_CONTRACT_VERSION =
  "GC-MEMBER-CONVERSATION-TURN-1";
const MEMBER_CONVERSATION_SAFETY_RULE_VERSION =
  "GC-MEMBER-CONVERSATION-SAFETY-1";
const MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION =
  "GC-MEMBER-CONVERSATION-SAFETY-RULES-1";
const MEMBER_CONVERSATION_PROVIDER_DISPATCH_TIMEOUT_MILLISECONDS = 5000;
const MEMBER_CONVERSATION_PROVIDER_DISPATCH_LEASE_MILLISECONDS = 30000;
const MEMBER_CONVERSATION_PROVIDER_RECONCILIATION_MILLISECONDS = 30000;
const DATABASE_ID = /^[1-9]\d{0,18}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_IDENTIFIER = /^[\x21-\x7e]{1,255}$/;
const RESERVATION_KEYS = Object.freeze([
  "contractVersion",
  "conversation",
  "conversationBindingId",
  "idempotencyKey",
  "requestSignatureSha256",
  "safetyRuleVersion",
  "safetySourceRuleVersion",
]);
const CONVERSATION_KEYS = Object.freeze(["provenance", "reference", "version"]);
const ATTEMPT_KEYS = Object.freeze([...RESERVATION_KEYS, "attemptId"].sort());
const REJECTION_KEYS = Object.freeze([
  ...ATTEMPT_KEYS,
  "providerRequestId",
  "terminalCategory",
].sort());
const REJECTION_CATEGORIES = Object.freeze([
  "authentication_rejected",
  "rate_limited",
  "request_rejected",
]);

class MemberConversationProviderDispatchError extends Error {
  constructor(code, cause) {
    super("Member conversation provider dispatch is unavailable");
    this.name = "MemberConversationProviderDispatchError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === keys.join("\u0000"));
}

function databaseId(value) {
  const normalized = String(value);
  return DATABASE_ID.test(normalized) ? normalized : null;
}

function exactString(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function parseReservationInput(value) {
  if (!exactKeys(value, RESERVATION_KEYS)
    || !exactKeys(value.conversation, CONVERSATION_KEYS)) return null;
  const parsed = Object.freeze({
    contractVersion: value.contractVersion,
    conversation: Object.freeze({
      provenance: value.conversation.provenance,
      reference: exactString(value.conversation.reference, UUID),
      version: value.conversation.version,
    }),
    conversationBindingId: databaseId(value.conversationBindingId),
    idempotencyKey: exactString(value.idempotencyKey, UUID),
    requestSignatureSha256: exactString(value.requestSignatureSha256, SHA256),
    safetyRuleVersion: value.safetyRuleVersion,
    safetySourceRuleVersion: value.safetySourceRuleVersion,
  });
  return parsed.conversation.reference
    && parsed.conversation.version === 1
    && parsed.conversation.provenance === "member_session"
    && parsed.conversationBindingId
    && parsed.idempotencyKey
    && parsed.requestSignatureSha256
    && parsed.contractVersion === MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    && parsed.safetyRuleVersion === MEMBER_CONVERSATION_SAFETY_RULE_VERSION
    && parsed.safetySourceRuleVersion === MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION
    ? parsed : null;
}

function parseAttemptInput(value) {
  if (!exactKeys(value, ATTEMPT_KEYS)) return null;
  const reservation = parseReservationInput(Object.fromEntries(
    RESERVATION_KEYS.map((key) => [key, value[key]])
  ));
  const attemptId = exactString(value.attemptId, UUID);
  return reservation && attemptId ? Object.freeze({ reservation, attemptId }) : null;
}

function parseRejectionInput(value) {
  if (!exactKeys(value, REJECTION_KEYS)) return null;
  const attempt = parseAttemptInput(Object.fromEntries(
    ATTEMPT_KEYS.map((key) => [key, value[key]])
  ));
  const providerRequestId = exactString(value.providerRequestId, PROVIDER_IDENTIFIER);
  return attempt && providerRequestId && REJECTION_CATEGORIES.includes(value.terminalCategory)
    ? Object.freeze({ ...attempt, providerRequestId, terminalCategory: value.terminalCategory })
    : null;
}

function createOperationContext(options, operation = {}) {
  const now = typeof operation.monotonicNow === "function"
    ? operation.monotonicNow : options.monotonicNow;
  const terminalState = operation.terminalState || createTerminalState();
  const outerDeadlineNs = typeof operation.outerDeadlineNs === "bigint"
    ? operation.outerDeadlineNs
    : deadlineAfter(now(), options.timeoutMilliseconds);
  const signal = operation.signal;
  const onAbort = () => terminalState.terminate(
    "member_conversation_provider_dispatch_aborted",
    { responseAllowed: false }
  );
  if (signal && typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  if (signal && signal.aborted === true) onAbort();
  return Object.freeze({
    cleanup() {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    },
    monotonicNow: now,
    outerDeadlineNs,
    signal,
    terminalState,
  });
}

function requireActive(context) {
  if (!context.terminalState.isTerminal()
    && !(context.signal && context.signal.aborted === true)) return;
  throw new MemberConversationProviderDispatchError("operation_terminal");
}

function acceptedCause(error) {
  for (let cause = error; cause; cause = cause.cause) {
    if (cause instanceof MemberConversationProviderDispatchError) return cause;
  }
  return null;
}

function postgresCause(error, code) {
  for (let cause = error; cause; cause = cause.cause) {
    if (cause.code === code) return cause;
  }
  return null;
}

function sameReservation(row, input) {
  return Boolean(row
    && String(row.conversation_binding_id) === input.conversationBindingId
    && String(row.conversation_reference).toLowerCase() === input.conversation.reference
    && Number(row.conversation_version) === input.conversation.version
    && row.conversation_provenance === input.conversation.provenance
    && row.request_signature_sha256 === input.requestSignatureSha256
    && row.contract_version === input.contractVersion
    && row.safety_rule_version === input.safetyRuleVersion
    && row.safety_source_rule_version === input.safetySourceRuleVersion);
}

function stateResult(row) {
  if (!row || !DATABASE_ID.test(String(row.reservation_id))
    || !Number.isSafeInteger(Number(row.event_sequence))
    || Number(row.event_sequence) < 1
    || typeof row.event_type !== "string") {
    throw new MemberConversationProviderDispatchError("invalid_state_result");
  }
  const result = {
    eventSequence: Number(row.event_sequence),
    state: row.event_type,
  };
  if (row.attempt_id !== null && row.attempt_id !== undefined) {
    const attemptId = String(row.attempt_id).toLowerCase();
    if (!UUID.test(attemptId)) {
      throw new MemberConversationProviderDispatchError("invalid_state_result");
    }
    result.attemptId = attemptId;
  }
  return Object.freeze(result);
}

function createMemberConversationProviderDispatchService(options = {}) {
  if (!options.pool || typeof options.pool.connect !== "function") {
    throw new Error("Member conversation provider dispatch service requires a PostgreSQL pool");
  }
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds)
    && options.timeoutMilliseconds > 0
    && options.timeoutMilliseconds <= MEMBER_CONVERSATION_PROVIDER_DISPATCH_TIMEOUT_MILLISECONDS
    ? options.timeoutMilliseconds : MEMBER_CONVERSATION_PROVIDER_DISPATCH_TIMEOUT_MILLISECONDS;
  const leaseMilliseconds = Number.isInteger(options.leaseMilliseconds)
    && options.leaseMilliseconds > 0
    && options.leaseMilliseconds <= 60000
    ? options.leaseMilliseconds : MEMBER_CONVERSATION_PROVIDER_DISPATCH_LEASE_MILLISECONDS;
  const reconciliationMilliseconds = Number.isInteger(options.reconciliationMilliseconds)
    && options.reconciliationMilliseconds > 0
    && options.reconciliationMilliseconds <= 300000
    ? options.reconciliationMilliseconds
    : MEMBER_CONVERSATION_PROVIDER_RECONCILIATION_MILLISECONDS;
  const randomUUID = typeof options.randomUUID === "function" ? options.randomUUID : crypto.randomUUID;
  const runtime = Object.freeze({
    monotonicNow: typeof options.monotonicNow === "function" ? options.monotonicNow : monotonicNow,
    timeoutMilliseconds,
  });

  async function transact(operation, readOnly, work) {
    const context = createOperationContext(runtime, operation);
    try {
      requireActive(context);
      const result = await runBoundedPostgresTransaction({
        pool: options.pool,
        terminalState: context.terminalState,
        outerDeadlineNs: context.outerDeadlineNs,
        monotonicNow: context.monotonicNow,
        phaseMilliseconds: timeoutMilliseconds,
        readOnly,
        work,
      });
      requireActive(context);
      return result.value;
    } catch (error) {
      const known = acceptedCause(error);
      if (known) throw known;
      throw new MemberConversationProviderDispatchError("database_unavailable", error);
    } finally {
      context.cleanup();
    }
  }

  async function exactReservation(query, input, lock = false) {
    const result = await query(
      `SELECT * FROM goals_coach_member_conversation_turn_reservations
        WHERE idempotency_key=$1::uuid${lock ? " FOR SHARE" : ""}`,
      [input.idempotencyKey]
    );
    const row = result.rows && result.rows[0];
    if (!sameReservation(row, input)) {
      throw new MemberConversationProviderDispatchError(row
        ? "reservation_conflict" : "reservation_unavailable");
    }
    return row;
  }

  async function currentState(query, reservationId) {
    const result = await query(
      `SELECT reservation_id,event_sequence,event_type,attempt_id
         FROM goals_coach_member_conversation_turn_dispatch_events
        WHERE reservation_id=$1 ORDER BY event_sequence DESC LIMIT 1`,
      [reservationId]
    );
    return stateResult(result.rows && result.rows[0]);
  }

  async function appendEvent(query, reservationId, event) {
    try {
      const result = await query(
        `INSERT INTO goals_coach_member_conversation_turn_dispatch_events
           (reservation_id,event_sequence,event_type,attempt_id,lease_expires_at,
            reconciliation_not_before,provider_contract_version,client_request_id,
            provider_request_id,provider_response_id,response_digest_sha256,terminal_category)
         VALUES(
           $1,0,$2,$3,
           CASE WHEN $4::integer IS NULL THEN NULL
                ELSE clock_timestamp() + ($4::integer * INTERVAL '1 millisecond') END,
           CASE WHEN $5::integer IS NULL THEN NULL
                ELSE clock_timestamp() + ($5::integer * INTERVAL '1 millisecond') END,
           $6,$7,$8,$9,$10,$11
         )
         RETURNING reservation_id,event_sequence,event_type,attempt_id`,
        [
          reservationId,
          event.eventType,
          event.attemptId || null,
          event.leaseMilliseconds || null,
          event.reconciliationMilliseconds || null,
          event.providerContractVersion || null,
          event.clientRequestId || null,
          event.providerRequestId || null,
          event.providerResponseId || null,
          event.responseDigestSha256 || null,
          event.terminalCategory || null,
        ]
      );
      return stateResult(result.rows && result.rows[0]);
    } catch (error) {
      const transitionCause = postgresCause(error, "23514");
      if (transitionCause) {
        throw new MemberConversationProviderDispatchError("transition_unavailable", transitionCause);
      }
      throw error;
    }
  }

  async function reserve(inputValue, operation = {}) {
    const input = parseReservationInput(inputValue);
    if (!input) throw new MemberConversationProviderDispatchError("invalid_reservation_input");
    return transact(operation, false, async ({ query }) => {
      const inserted = await query(
        `INSERT INTO goals_coach_member_conversation_turn_reservations
           (idempotency_key,conversation_binding_id,conversation_reference,
            conversation_version,conversation_provenance,request_signature_sha256,
            contract_version,safety_rule_version,safety_source_rule_version)
         VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
        [
          input.idempotencyKey,
          input.conversationBindingId,
          input.conversation.reference,
          input.conversation.version,
          input.conversation.provenance,
          input.requestSignatureSha256,
          input.contractVersion,
          input.safetyRuleVersion,
          input.safetySourceRuleVersion,
        ]
      );
      const reservation = await exactReservation(query, input, true);
      if (inserted.rows && inserted.rows.length === 1) {
        return appendEvent(query, reservation.id, { eventType: "reserved" });
      }
      return currentState(query, reservation.id);
    });
  }

  async function read(inputValue, operation = {}) {
    const input = parseReservationInput(inputValue);
    if (!input) return null;
    return transact(operation, true, async ({ query }) => {
      let reservation;
      try { reservation = await exactReservation(query, input, false); }
      catch (error) {
        if (error instanceof MemberConversationProviderDispatchError
          && error.code === "reservation_unavailable") return null;
        throw error;
      }
      return currentState(query, reservation.id);
    });
  }

  async function acquireLease(inputValue, operation = {}) {
    const input = parseReservationInput(inputValue);
    if (!input) throw new MemberConversationProviderDispatchError("invalid_reservation_input");
    const attemptId = String(randomUUID()).toLowerCase();
    if (!UUID.test(attemptId)) {
      throw new MemberConversationProviderDispatchError("uuid_generation_failed");
    }
    return transact(operation, false, async ({ query }) => {
      const reservation = await exactReservation(query, input, true);
      return appendEvent(query, reservation.id, {
        attemptId,
        eventType: "lease_acquired",
        leaseMilliseconds,
      });
    });
  }

  async function startDispatch(inputValue, operation = {}) {
    const input = parseAttemptInput(inputValue);
    if (!input) throw new MemberConversationProviderDispatchError("invalid_attempt_input");
    return transact(operation, false, async ({ query }) => {
      const reservation = await exactReservation(query, input.reservation, true);
      return appendEvent(query, reservation.id, {
        attemptId: input.attemptId,
        clientRequestId: input.attemptId,
        eventType: "dispatch_started",
        providerContractVersion: MEMBER_CONVERSATION_PROVIDER_CONTRACT_VERSION,
        reconciliationMilliseconds,
      });
    });
  }

  async function recordRejection(inputValue, operation = {}) {
    const input = parseRejectionInput(inputValue);
    if (!input) throw new MemberConversationProviderDispatchError("invalid_rejection_input");
    return transact(operation, false, async ({ query }) => {
      const reservation = await exactReservation(query, input.reservation, true);
      return appendEvent(query, reservation.id, {
        attemptId: input.attemptId,
        clientRequestId: input.attemptId,
        eventType: "provider_rejected",
        providerContractVersion: MEMBER_CONVERSATION_PROVIDER_CONTRACT_VERSION,
        providerRequestId: input.providerRequestId,
        terminalCategory: input.terminalCategory,
      });
    });
  }

  async function markIndeterminate(inputValue, operation = {}) {
    const input = parseAttemptInput(inputValue);
    if (!input) throw new MemberConversationProviderDispatchError("invalid_attempt_input");
    return transact(operation, false, async ({ query }) => {
      const reservation = await exactReservation(query, input.reservation, true);
      return appendEvent(query, reservation.id, {
        attemptId: input.attemptId,
        clientRequestId: input.attemptId,
        eventType: "indeterminate",
        providerContractVersion: MEMBER_CONVERSATION_PROVIDER_CONTRACT_VERSION,
        terminalCategory: "provider_contact_indeterminate",
      });
    });
  }

  return Object.freeze({
    acquireLease,
    contractVersion: MEMBER_CONVERSATION_PROVIDER_DISPATCH_CONTRACT_VERSION,
    externalEffectsPermitted: false,
    markIndeterminate,
    providerFree: true,
    read,
    recordRejection,
    reserve,
    startDispatch,
  });
}

module.exports = {
  MEMBER_CONVERSATION_PROVIDER_DISPATCH_CONTRACT_VERSION,
  MEMBER_CONVERSATION_PROVIDER_DISPATCH_LEASE_MILLISECONDS,
  MEMBER_CONVERSATION_PROVIDER_DISPATCH_TIMEOUT_MILLISECONDS,
  MEMBER_CONVERSATION_PROVIDER_RECONCILIATION_MILLISECONDS,
  MEMBER_CONVERSATION_PROVIDER_CONTRACT_VERSION,
  MemberConversationProviderDispatchError,
  createMemberConversationProviderDispatchService,
};
