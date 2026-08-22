"use strict";

const crypto = require("node:crypto");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
  runBoundedPostgresTransaction,
} = require("./bounded-postgres-transaction");
const { MEMBER_CONVERSATION_TURN_CONTRACT_VERSION } = require("./member-conversation-turn-contract");

const MEMBER_CONVERSATION_BINDING_CONTRACT_VERSION = "GC-MEMBER-CONVERSATION-BINDING-1";
const MEMBER_CONVERSATION_BINDING_VERSION = 1;
const MEMBER_CONVERSATION_BINDING_PROVENANCE = "member_session";
const MEMBER_CONVERSATION_BINDING_TIMEOUT_MILLISECONDS = 5000;
const DATABASE_ID = /^[1-9]\d{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CREATE_KEYS = Object.freeze([
  "authMappingId",
  "coachingConversationId",
  "memberId",
  "memberSessionId",
]);
const AUTHORIZE_KEYS = Object.freeze([
  "authMappingId",
  "conversation",
  "memberId",
  "memberSessionId",
]);
const CONVERSATION_KEYS = Object.freeze(["provenance", "reference", "version"]);

class MemberConversationBindingError extends Error {
  constructor(code, cause) {
    super("Member conversation binding is unavailable");
    this.name = "MemberConversationBindingError";
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

function parseCreateInput(value) {
  if (!exactKeys(value, CREATE_KEYS)) return null;
  const parsed = Object.freeze({
    authMappingId: databaseId(value.authMappingId),
    coachingConversationId: databaseId(value.coachingConversationId),
    memberId: databaseId(value.memberId),
    memberSessionId: databaseId(value.memberSessionId),
  });
  return Object.values(parsed).every(Boolean) ? parsed : null;
}

function parseOwnershipInput(value) {
  if (!exactKeys(value, AUTHORIZE_KEYS) || !exactKeys(value.conversation, CONVERSATION_KEYS)) return null;
  const reference = typeof value.conversation.reference === "string"
    ? value.conversation.reference.toLowerCase() : null;
  const parsed = Object.freeze({
    authMappingId: databaseId(value.authMappingId),
    memberId: databaseId(value.memberId),
    memberSessionId: databaseId(value.memberSessionId),
    conversation: Object.freeze({
      provenance: value.conversation.provenance,
      reference,
      version: value.conversation.version,
    }),
  });
  return parsed.authMappingId && parsed.memberId && parsed.memberSessionId
    && UUID.test(reference || "")
    && parsed.conversation.version === MEMBER_CONVERSATION_BINDING_VERSION
    && parsed.conversation.provenance === MEMBER_CONVERSATION_BINDING_PROVENANCE
    ? parsed : null;
}

function bindingResult(row) {
  if (!row || !UUID.test(String(row.conversation_reference || "").toLowerCase())
    || Number(row.conversation_version) !== MEMBER_CONVERSATION_BINDING_VERSION
    || row.provenance !== MEMBER_CONVERSATION_BINDING_PROVENANCE) {
    throw new MemberConversationBindingError("invalid_binding_result");
  }
  return Object.freeze({
    conversation: Object.freeze({
      provenance: MEMBER_CONVERSATION_BINDING_PROVENANCE,
      reference: String(row.conversation_reference).toLowerCase(),
      version: MEMBER_CONVERSATION_BINDING_VERSION,
    }),
  });
}

function activeOperation(context) {
  return !context.terminalState.isTerminal()
    && !(context.signal && context.signal.aborted === true);
}

function requireActive(context) {
  if (activeOperation(context)) return;
  throw new MemberConversationBindingError("operation_terminal");
}

function bindingCause(error) {
  for (let cause = error; cause; cause = cause.cause) {
    if (cause instanceof MemberConversationBindingError) return cause;
  }
  return null;
}

function createOperationContext(options, operation = {}) {
  const now = typeof operation.monotonicNow === "function"
    ? operation.monotonicNow
    : options.monotonicNow;
  const terminalState = operation.terminalState || createTerminalState();
  const outerDeadlineNs = typeof operation.outerDeadlineNs === "bigint"
    ? operation.outerDeadlineNs
    : deadlineAfter(now(), options.timeoutMilliseconds);
  const signal = operation.signal;
  const onAbort = () => terminalState.terminate("member_conversation_binding_aborted", { responseAllowed: false });
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

function validExistingBinding(row, input) {
  return Boolean(row
    && String(row.coaching_conversation_id) === input.coachingConversationId
    && String(row.member_id) === input.memberId
    && String(row.auth_mapping_id) === input.authMappingId
    && String(row.member_session_id) === input.memberSessionId
    && Number(row.conversation_version) === MEMBER_CONVERSATION_BINDING_VERSION
    && row.provenance === MEMBER_CONVERSATION_BINDING_PROVENANCE);
}

function createMemberConversationBindingService(options = {}) {
  if (!options.pool || typeof options.pool.connect !== "function") {
    throw new Error("Member conversation binding service requires a PostgreSQL pool");
  }
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds)
    && options.timeoutMilliseconds > 0
    && options.timeoutMilliseconds <= MEMBER_CONVERSATION_BINDING_TIMEOUT_MILLISECONDS
    ? options.timeoutMilliseconds : MEMBER_CONVERSATION_BINDING_TIMEOUT_MILLISECONDS;
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
      const acceptedCause = bindingCause(error);
      if (acceptedCause) throw acceptedCause;
      throw new MemberConversationBindingError("database_unavailable", error);
    } finally {
      context.cleanup();
    }
  }

  async function createBinding(inputValue, operation = {}) {
    const input = parseCreateInput(inputValue);
    if (!input) throw new MemberConversationBindingError("invalid_create_input");
    return transact(operation, false, async ({ query }) => {
      const current = await query(
        `SELECT conversation.id
           FROM coaching_conversations conversation
           JOIN goals_coach_member_auth_mappings mapping
             ON mapping.id = $3 AND mapping.member_id = conversation.member_id
           JOIN goals_coach_member_sessions session
             ON session.id = $4
            AND session.member_id = conversation.member_id
            AND session.auth_mapping_id = mapping.id
          WHERE conversation.id = $1
            AND conversation.member_id = $2
            AND conversation.status = 'active'
            AND mapping.active = TRUE
            AND session.revoked_at IS NULL
            AND session.expires_at > CURRENT_TIMESTAMP
          FOR KEY SHARE OF conversation, mapping, session`,
        [input.coachingConversationId, input.memberId, input.authMappingId, input.memberSessionId]
      );
      if (!current.rows || current.rows.length !== 1) {
        throw new MemberConversationBindingError("binding_prerequisite_unavailable");
      }
      const reference = String(randomUUID()).toLowerCase();
      if (!UUID.test(reference)) throw new MemberConversationBindingError("uuid_generation_failed");
      const inserted = await query(
        `INSERT INTO goals_coach_member_conversation_bindings
           (conversation_reference, conversation_version, provenance,
            coaching_conversation_id, member_id, auth_mapping_id, member_session_id)
         VALUES ($1, 1, 'member_session', $2, $3, $4, $5)
         ON CONFLICT (coaching_conversation_id) DO NOTHING
         RETURNING conversation_reference, conversation_version, provenance,
                   coaching_conversation_id, member_id, auth_mapping_id, member_session_id`,
        [reference, input.coachingConversationId, input.memberId, input.authMappingId, input.memberSessionId]
      );
      let row = inserted.rows && inserted.rows[0];
      if (!row) {
        const existing = await query(
          `SELECT conversation_reference, conversation_version, provenance,
                  coaching_conversation_id, member_id, auth_mapping_id, member_session_id
             FROM goals_coach_member_conversation_bindings
            WHERE coaching_conversation_id = $1`,
          [input.coachingConversationId]
        );
        row = existing.rows && existing.rows[0];
        if (!validExistingBinding(row, input)) {
          throw new MemberConversationBindingError("binding_conflict");
        }
      }
      return bindingResult(row);
    });
  }

  async function authorize(inputValue, operation = {}) {
    const input = parseOwnershipInput(inputValue);
    if (!input) return null;
    try {
      return await transact(operation, true, async ({ query }) => {
        const result = await query(
          `SELECT 1
             FROM goals_coach_member_conversation_bindings binding
             JOIN coaching_conversations conversation
               ON conversation.id = binding.coaching_conversation_id
              AND conversation.member_id = binding.member_id
             JOIN goals_coach_member_auth_mappings mapping
               ON mapping.id = binding.auth_mapping_id
              AND mapping.member_id = binding.member_id
             JOIN goals_coach_member_sessions session
               ON session.id = binding.member_session_id
              AND session.member_id = binding.member_id
              AND session.auth_mapping_id = binding.auth_mapping_id
            WHERE binding.conversation_reference = $1::uuid
              AND binding.conversation_version = $2
              AND binding.provenance = $3
              AND binding.member_id = $4
              AND binding.auth_mapping_id = $5
              AND binding.member_session_id = $6
              AND conversation.status = 'active'
              AND mapping.active = TRUE
              AND session.revoked_at IS NULL
              AND session.expires_at > CURRENT_TIMESTAMP`,
          [
            input.conversation.reference,
            input.conversation.version,
            input.conversation.provenance,
            input.memberId,
            input.authMappingId,
            input.memberSessionId,
          ]
        );
        return result.rows && result.rows.length === 1 ? Object.freeze({ owned: true }) : null;
      });
    } catch (_) {
      return null;
    }
  }

  const ownership = Object.freeze({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    providerFree: true,
    readOnly: true,
    concealUnknown: true,
    exactConversationBinding: true,
    authorize,
  });
  return Object.freeze({
    contractVersion: MEMBER_CONVERSATION_BINDING_CONTRACT_VERSION,
    createBinding,
    ownership,
  });
}

module.exports = {
  MEMBER_CONVERSATION_BINDING_CONTRACT_VERSION,
  MEMBER_CONVERSATION_BINDING_PROVENANCE,
  MEMBER_CONVERSATION_BINDING_TIMEOUT_MILLISECONDS,
  MEMBER_CONVERSATION_BINDING_VERSION,
  MemberConversationBindingError,
  createMemberConversationBindingService,
};
