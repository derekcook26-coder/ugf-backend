"use strict";

const crypto = require("node:crypto");
const {
  validMemberConversationProviderDispatchService,
} = require("./member-conversation-provider-dispatch-service");
const {
  validMemberConversationProviderTransport,
} = require("./member-conversation-provider-transport");
const {
  parseMemberConversationTurnResponse,
} = require("./member-conversation-turn-contract");
const {
  monotonicNow,
  positiveRemainingMilliseconds,
} = require("./bounded-postgres-transaction");

const MEMBER_CONVERSATION_PROVIDER_ORCHESTRATOR_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-ORCHESTRATOR-1";
const MEMBER_CONVERSATION_PROVIDER_ORCHESTRATOR_TIMEOUT_MILLISECONDS = 30000;
const MEMBER_CONVERSATION_TURN_CONTRACT_VERSION = "GC-MEMBER-CONVERSATION-TURN-1";
const SAFETY_RULE_VERSION = "GC-MEMBER-CONVERSATION-SAFETY-1";
const SAFETY_SOURCE_RULE_VERSION = "GC-MEMBER-CONVERSATION-SAFETY-RULES-1";
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
const SUCCEEDED_KEYS = Object.freeze([
  "category", "providerRequestId", "providerResponseId", "response",
]);
const REJECTED_KEYS = Object.freeze([
  "category", "providerRequestId", "terminalCategory",
]);
const TERMINAL_RESULT_KEYS = Object.freeze(["category"]);
const REJECTION_CATEGORIES = Object.freeze([
  "authentication_rejected", "rate_limited", "request_rejected",
]);
const brandedOrchestrators = new WeakSet();

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === keys.join("\0"));
}

function parseReservation(value) {
  if (!exactKeys(value, RESERVATION_KEYS)
    || !exactKeys(value.conversation, CONVERSATION_KEYS)) return null;
  const parsed = {
    contractVersion: value.contractVersion,
    conversation: Object.freeze({
      provenance: value.conversation.provenance,
      reference: typeof value.conversation.reference === "string"
        ? value.conversation.reference.toLowerCase() : null,
      version: value.conversation.version,
    }),
    conversationBindingId: String(value.conversationBindingId),
    idempotencyKey: typeof value.idempotencyKey === "string"
      ? value.idempotencyKey.toLowerCase() : null,
    requestSignatureSha256: value.requestSignatureSha256,
    safetyRuleVersion: value.safetyRuleVersion,
    safetySourceRuleVersion: value.safetySourceRuleVersion,
  };
  return parsed.contractVersion === MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    && UUID.test(parsed.conversation.reference || "")
    && parsed.conversation.version === 1
    && parsed.conversation.provenance === "member_session"
    && DATABASE_ID.test(parsed.conversationBindingId)
    && UUID.test(parsed.idempotencyKey || "")
    && SHA256.test(parsed.requestSignatureSha256 || "")
    && parsed.safetyRuleVersion === SAFETY_RULE_VERSION
    && parsed.safetySourceRuleVersion === SAFETY_SOURCE_RULE_VERSION
    ? Object.freeze(parsed) : null;
}

function validOperation(operation) {
  const terminal = operation && operation.terminalState;
  return Boolean(operation && typeof operation === "object"
    && typeof operation.outerDeadlineNs === "bigint"
    && terminal
    && typeof terminal.isTerminal === "function"
    && typeof terminal.responseAllowed === "function"
    && typeof terminal.terminate === "function"
    && typeof terminal.subscribe === "function"
    && (!operation.signal || (typeof operation.signal.addEventListener === "function"
      && typeof operation.signal.removeEventListener === "function")));
}

function responseOutcome(response) {
  return Object.freeze({ outcome: "success", response });
}

function unavailableOutcome(terminalState) {
  return Object.freeze({
    outcome: terminalState.responseAllowed() ? "unavailable" : "silent",
  });
}

function active(operation, now) {
  return !operation.terminalState.isTerminal()
    && !(operation.signal && operation.signal.aborted === true)
    && positiveRemainingMilliseconds(operation.outerDeadlineNs, now()) !== null;
}

function attemptInput(reservation, attemptId) {
  return Object.freeze({ ...reservation, attemptId });
}

function transportRequest(reservation, attemptId, transport) {
  return Object.freeze({
    attemptId,
    clientRequestId: attemptId,
    contractVersion: reservation.contractVersion,
    conversation: reservation.conversation,
    model: transport.model,
    provider: transport.provider,
    requestSignatureSha256: reservation.requestSignatureSha256,
    responseSchemaVersion: transport.responseSchemaVersion,
    safetyRuleVersion: reservation.safetyRuleVersion,
    safetySourceRuleVersion: reservation.safetySourceRuleVersion,
    transportVersion: transport.version,
  });
}

function parseTransportResult(value) {
  if (exactKeys(value, SUCCEEDED_KEYS) && value.category === "succeeded"
    && PROVIDER_IDENTIFIER.test(value.providerRequestId || "")
    && PROVIDER_IDENTIFIER.test(value.providerResponseId || "")) {
    try {
      return Object.freeze({
        category: "succeeded",
        providerRequestId: value.providerRequestId,
        providerResponseId: value.providerResponseId,
        response: parseMemberConversationTurnResponse(value.response),
      });
    } catch (_) { return null; }
  }
  if (exactKeys(value, REJECTED_KEYS) && value.category === "rejected"
    && PROVIDER_IDENTIFIER.test(value.providerRequestId || "")
    && REJECTION_CATEGORIES.includes(value.terminalCategory)) return Object.freeze(value);
  return exactKeys(value, TERMINAL_RESULT_KEYS)
    && ["indeterminate", "not_contacted"].includes(value.category)
    ? Object.freeze({ category: value.category }) : null;
}

function digestResponse(response) {
  return crypto.createHash("sha256").update(JSON.stringify(response), "utf8").digest("hex");
}

function createMemberConversationProviderOrchestrator(options = {}) {
  if (!validMemberConversationProviderDispatchService(options.dispatchService)
    || !validMemberConversationProviderTransport(options.transport)) return null;
  const dispatchService = options.dispatchService;
  const transport = options.transport;
  const now = typeof options.monotonicNow === "function" ? options.monotonicNow : monotonicNow;

  async function execute(inputValue, operation = {}) {
    const reservation = parseReservation(inputValue);
    if (!reservation || !validOperation(operation)) {
      throw new Error("Member conversation provider orchestration is unavailable");
    }
    const shared = Object.freeze({
      outerDeadlineNs: operation.outerDeadlineNs,
      signal: operation.signal,
      terminalState: operation.terminalState,
    });
    const abort = () => operation.terminalState.terminate(
      "member_conversation_provider_orchestrator_aborted",
      { responseAllowed: false }
    );
    if (operation.signal) operation.signal.addEventListener("abort", abort, { once: true });
    if (operation.signal && operation.signal.aborted) abort();
    const remaining = positiveRemainingMilliseconds(operation.outerDeadlineNs, now());
    if (remaining === null) {
      operation.terminalState.terminate("member_conversation_provider_orchestrator_deadline");
    }
    const timer = remaining === null ? null : setTimeout(() => {
      operation.terminalState.terminate("member_conversation_provider_orchestrator_deadline");
    }, Math.min(remaining, MEMBER_CONVERSATION_PROVIDER_ORCHESTRATOR_TIMEOUT_MILLISECONDS));
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      if (!active(operation, now)) return unavailableOutcome(operation.terminalState);
      let state;
      try { state = await dispatchService.reserve(reservation, shared); }
      catch (_) { return unavailableOutcome(operation.terminalState); }
      if (!active(operation, now)) return unavailableOutcome(operation.terminalState);
      if (state.state === "finalized") {
        try {
          const replay = await dispatchService.readFinalized(reservation, shared);
          return replay && active(operation, now)
            ? responseOutcome(replay.response) : unavailableOutcome(operation.terminalState);
        } catch (_) { return unavailableOutcome(operation.terminalState); }
      }
      if (["provider_rejected", "indeterminate"].includes(state.state)) {
        return unavailableOutcome(operation.terminalState);
      }
      if (state.state === "dispatch_started" && state.attemptId) {
        try { await dispatchService.markIndeterminate(attemptInput(reservation, state.attemptId), shared); }
        catch (_) {}
        return unavailableOutcome(operation.terminalState);
      }
      if (!["reserved", "lease_acquired"].includes(state.state)) {
        return unavailableOutcome(operation.terminalState);
      }

      let lease;
      try { lease = await dispatchService.acquireLease(reservation, shared); }
      catch (_) { return unavailableOutcome(operation.terminalState); }
      if (!active(operation, now) || lease.state !== "lease_acquired" || !UUID.test(lease.attemptId || "")) {
        return unavailableOutcome(operation.terminalState);
      }
      const attempt = attemptInput(reservation, lease.attemptId);
      let started;
      try { started = await dispatchService.startDispatch(attempt, shared); }
      catch (_) {
        if (!active(operation, now)) return unavailableOutcome(operation.terminalState);
        try { started = await dispatchService.read(reservation, shared); }
        catch (_) { return unavailableOutcome(operation.terminalState); }
      }
      if (!active(operation, now) || !started || started.state !== "dispatch_started"
        || started.attemptId !== lease.attemptId) return unavailableOutcome(operation.terminalState);

      let unsubscribe = () => {};
      const terminalPromise = new Promise((resolve) => {
        unsubscribe = operation.terminalState.subscribe(() => resolve({ terminal: true }));
      });
      const transportPromise = Promise.resolve()
        .then(() => transport.dispatch(transportRequest(reservation, lease.attemptId, transport), shared))
        .then((value) => ({ value }), () => ({ failed: true }));
      const winner = await Promise.race([transportPromise, terminalPromise]);
      unsubscribe();
      if (winner.terminal || !active(operation, now)) {
        transportPromise.then(() => {}, () => {});
        return unavailableOutcome(operation.terminalState);
      }
      const result = winner.failed ? null : parseTransportResult(winner.value);
      if (!result || ["indeterminate", "not_contacted"].includes(result.category)) {
        try { await dispatchService.markIndeterminate(attempt, shared); } catch (_) {}
        return unavailableOutcome(operation.terminalState);
      }
      if (result.category === "rejected") {
        try {
          await dispatchService.recordRejection(Object.freeze({
            ...attempt,
            providerRequestId: result.providerRequestId,
            terminalCategory: result.terminalCategory,
          }), shared);
        } catch (_) {}
        return unavailableOutcome(operation.terminalState);
      }
      try {
        const finalized = await dispatchService.finalizeSuccess(Object.freeze({
          ...attempt,
          providerRequestId: result.providerRequestId,
          providerResponseId: result.providerResponseId,
          response: result.response,
          responseDigestSha256: digestResponse(result.response),
        }), shared);
        return active(operation, now)
          ? responseOutcome(finalized.response) : unavailableOutcome(operation.terminalState);
      } catch (_) {
        if (!active(operation, now)) return unavailableOutcome(operation.terminalState);
        try {
          const replay = await dispatchService.readFinalized(reservation, shared);
          return replay ? responseOutcome(replay.response) : unavailableOutcome(operation.terminalState);
        } catch (_) { return unavailableOutcome(operation.terminalState); }
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (operation.signal) operation.signal.removeEventListener("abort", abort);
    }
  }

  const orchestrator = Object.freeze({
    execute,
    externalCallsPermitted: true,
    providerFree: false,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_PROVIDER_ORCHESTRATOR_VERSION,
  });
  brandedOrchestrators.add(orchestrator);
  return orchestrator;
}

function validMemberConversationProviderOrchestrator(value) {
  return Boolean(value && brandedOrchestrators.has(value) && Object.isFrozen(value)
    && value.version === MEMBER_CONVERSATION_PROVIDER_ORCHESTRATOR_VERSION
    && value.externalCallsPermitted === true && value.providerFree === false
    && value.runtimeWired === false && typeof value.execute === "function");
}

module.exports = {
  MEMBER_CONVERSATION_PROVIDER_ORCHESTRATOR_TIMEOUT_MILLISECONDS,
  MEMBER_CONVERSATION_PROVIDER_ORCHESTRATOR_VERSION,
  createMemberConversationProviderOrchestrator,
  validMemberConversationProviderOrchestrator,
};
