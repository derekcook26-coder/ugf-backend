"use strict";

const {
  monotonicNow,
  positiveRemainingMilliseconds,
  validTerminalState,
} = require("./bounded-postgres-transaction");
const {
  createMemberConversationOpenAIResponsesRequest,
  readMemberConversationOpenAIResponsesRejection,
  validMemberConversationOpenAIResponsesAdapter,
} = require("./member-conversation-openai-responses-adapter");
const {
  createMemberConversationProviderResultAuthority,
  createMemberConversationTurnResponseV2,
  readMemberConversationProviderResult,
  revokeMemberConversationProviderResultAuthority,
} = require("./member-conversation-provider-result");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
  createMemberConversationProviderTransport,
} = require("./member-conversation-provider-transport");
const {
  parseMemberConversationTurnRequest,
  parseMemberConversationTurnResponse,
  memberConversationTurnRequestHash,
  responseMatchesRequest,
} = require("./member-conversation-turn-contract");

const MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-1";
const FACTORY_KEYS = Object.freeze([
  "adapter", "turnRequest", "turnResponse", "version",
]);
const DISPATCH_KEYS = Object.freeze([
  "attemptId", "clientRequestId", "contractVersion", "conversation", "model",
  "provider", "requestSignatureSha256", "responseSchemaVersion",
  "safetyRuleVersion", "safetySourceRuleVersion", "transportVersion",
]);
const OPERATION_KEYS = Object.freeze(["outerDeadlineNs", "signal", "terminalState"]);
const CONVERSATION_KEYS = Object.freeze(["provenance", "reference", "version"]);

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return exactObject(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function sameConversation(left, right) {
  return exactKeys(left, CONVERSATION_KEYS) && exactKeys(right, CONVERSATION_KEYS)
    && left.reference === right.reference
    && left.version === right.version
    && left.provenance === right.provenance;
}

function exactDispatchRequest(value, turnRequest, turnResponse, adapter) {
  return exactKeys(value, DISPATCH_KEYS)
    && value.clientRequestId === value.attemptId
    && value.contractVersion === turnRequest.contractVersion
    && sameConversation(value.conversation, turnRequest.conversation)
    && value.model === adapter.model
    && value.provider === "openai"
    && value.requestSignatureSha256 === memberConversationTurnRequestHash(turnRequest)
    && value.responseSchemaVersion === adapter.responseSchemaVersion
    && value.safetyRuleVersion === turnResponse.result.safety.ruleVersion
    && value.safetySourceRuleVersion === turnResponse.result.safety.sourceRuleVersion
    && value.transportVersion === MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION;
}

function validOperation(value) {
  return exactKeys(value, OPERATION_KEYS)
    && typeof value.outerDeadlineNs === "bigint"
    && (value.signal === undefined || value.signal instanceof AbortSignal)
    && validTerminalState(value.terminalState);
}

function notContacted() {
  return Object.freeze({ category: "not_contacted" });
}

function indeterminate() {
  return Object.freeze({ category: "indeterminate" });
}

function createMemberConversationOpenAIResponsesTransport(value = {}) {
  if (!exactKeys(value, FACTORY_KEYS)
    || value.version !== MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_VERSION
    || !validMemberConversationOpenAIResponsesAdapter(value.adapter)) return null;
  let turnRequest;
  let turnResponse;
  try {
    turnRequest = parseMemberConversationTurnRequest(value.turnRequest);
    turnResponse = parseMemberConversationTurnResponse(value.turnResponse);
  } catch (_) { return null; }
  if (!responseMatchesRequest(turnRequest, turnResponse)
    || turnResponse.result.state !== "safe_to_process"
    || turnResponse.result.reason !== null
    || turnResponse.result.safety.classification !== "clear"
    || turnResponse.result.safety.action !== "allow_provider_processing") return null;

  const adapter = value.adapter;
  let consumed = false;
  const transport = createMemberConversationProviderTransport({
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
    provider: adapter.provider,
    model: adapter.model,
    responseSchemaVersion: adapter.responseSchemaVersion,
    async dispatch(dispatchRequest, operation = {}) {
      if (!exactDispatchRequest(dispatchRequest, turnRequest, turnResponse, adapter)
        || !validOperation(operation)) return notContacted();
      if (consumed) return indeterminate();
      consumed = true;
      if (operation.terminalState.isTerminal()
        || (operation.signal && operation.signal.aborted)
        || positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) === null) {
        return notContacted();
      }
      const request = createMemberConversationOpenAIResponsesRequest(adapter, {
        attemptId: dispatchRequest.attemptId,
        turnRequest,
        turnResponse,
      });
      if (!request) return notContacted();
      const authority = createMemberConversationProviderResultAuthority({
        request,
        terminalState: operation.terminalState,
      });
      if (!authority) return notContacted();
      const controller = new AbortController();
      const abort = () => controller.abort();
      let unsubscribe = operation.terminalState.subscribe(abort);
      if (operation.signal) operation.signal.addEventListener("abort", abort, { once: true });
      if ((operation.signal && operation.signal.aborted)
        || operation.terminalState.isTerminal()) abort();
      try {
        const resultToken = await adapter.execute({ authority, request }, Object.freeze({
          outerDeadlineNs: operation.outerDeadlineNs,
          signal: controller.signal,
        }));
        const rejection = readMemberConversationOpenAIResponsesRejection(resultToken);
        if (rejection && !operation.terminalState.isTerminal()
          && !(operation.signal && operation.signal.aborted)
          && positiveRemainingMilliseconds(
            operation.outerDeadlineNs, monotonicNow()
          ) !== null) return Object.freeze({ category: "rejected", ...rejection });
        const result = readMemberConversationProviderResult(resultToken, authority);
        if (!result || operation.terminalState.isTerminal()
          || (operation.signal && operation.signal.aborted)
          || positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) === null) {
          return indeterminate();
        }
        const response = createMemberConversationTurnResponseV2(
          turnRequest, turnResponse, result.coaching
        );
        if (!response) return indeterminate();
        return Object.freeze({
          category: "succeeded",
          providerRequestId: result.providerRequestId,
          providerResponseId: result.providerResponseId,
          response,
        });
      } catch (_) {
        return indeterminate();
      } finally {
        revokeMemberConversationProviderResultAuthority(authority);
        unsubscribe();
        unsubscribe = () => {};
        if (operation.signal) operation.signal.removeEventListener("abort", abort);
      }
    },
  });
  return transport;
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_VERSION,
  createMemberConversationOpenAIResponsesTransport,
};
