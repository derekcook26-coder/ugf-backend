"use strict";

const { types: { isProxy } } = require("node:util");
const {
  monotonicNow,
  positiveRemainingMilliseconds,
  validTerminalState,
} = require("./bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesHTTPTransportV2,
} = require("./member-conversation-openai-responses-http-transport-v2");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesTransportV2,
} = require("./member-conversation-openai-responses-transport-v2");
const {
  validMemberConversationOpenAIResponsesAdapterV2,
} = require("./member-conversation-openai-responses-adapter-v2");
const {
  validMemberConversationOpenAICredentialResolver,
} = require("./member-conversation-openai-credential-resolver");
const {
  validMemberConversationOpenAIHTTPClient,
  memberConversationOpenAIHTTPClientMatchesOrigin,
} = require("./member-conversation-openai-http-client");
const {
  validMemberConversationOpenAIPromptCachePolicy,
} = require("./member-conversation-openai-prompt-cache-policy");
const {
  MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
  createMemberConversationProviderRequestV2,
} = require("./member-conversation-provider-request-envelope-v2");
const {
  createMemberConversationProviderTransportV2,
} = require("./member-conversation-provider-transport-v2");
const {
  readMemberConversationProviderRejectionV2,
  readMemberConversationProviderResultV2,
  revokeMemberConversationProviderResultAuthorityV2,
} = require("./member-conversation-provider-result-v2");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
  createMemberConversationProviderTransport,
} = require("./member-conversation-provider-transport");
const {
  createMemberConversationTurnResponseV2,
} = require("./member-conversation-provider-result");
const {
  memberConversationTurnRequestHash,
  parseMemberConversationTurnRequest,
  parseMemberConversationTurnResponse,
  responseMatchesRequest,
} = require("./member-conversation-turn-contract");

const MEMBER_CONVERSATION_OPENAI_RESPONSES_ORCHESTRATOR_TRANSPORT_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ORCHESTRATOR-TRANSPORT-2";
const FACTORY_KEYS = Object.freeze([
  "adapter", "httpClient", "origin", "promptCachePolicy", "requestConfig",
  "resolver", "turnRequest", "turnResponse", "version",
]);
const REQUEST_CONFIG_KEYS = Object.freeze([
  "developerPromptSha256", "developerPromptVersion", "regionPolicy",
  "responseSchemaSha256", "responseSchemaVersion",
]);
const DISPATCH_KEYS = Object.freeze([
  "attemptId", "clientRequestId", "contractVersion", "conversation", "model",
  "provider", "requestSignatureSha256", "responseSchemaVersion",
  "safetyRuleVersion", "safetySourceRuleVersion", "transportVersion",
]);
const CONVERSATION_KEYS = Object.freeze(["provenance", "reference", "version"]);
const OPERATION_KEYS = Object.freeze(["outerDeadlineNs", "signal", "terminalState"]);
const ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys) {
  if (!exactObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")
    || ownKeys.slice().sort().join("\0") !== keys.slice().sort().join("\0")) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key] && descriptors[key].enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptors[key], "value")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "get")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "set"));
}

function safeData(value, seen = new Set()) {
  if (typeof value === "function") return false;
  if (value === null || typeof value !== "object") return true;
  if (isProxy(value) || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) return false;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => {
    const descriptor = descriptors[key];
    const arrayLength = Array.isArray(value) && key === "length";
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && !Object.prototype.hasOwnProperty.call(descriptor, "get")
      && !Object.prototype.hasOwnProperty.call(descriptor, "set")
      && (arrayLength || descriptor.enumerable === true)
      && safeData(descriptor.value, seen);
  });
}

function sameConversation(left, right) {
  return exactKeys(left, CONVERSATION_KEYS) && exactKeys(right, CONVERSATION_KEYS)
    && left.reference === right.reference && left.version === right.version
    && left.provenance === right.provenance;
}

function validOperation(value) {
  return exactKeys(value, OPERATION_KEYS)
    && typeof value.outerDeadlineNs === "bigint"
    && validNativeAbortSignal(value.signal)
    && validTerminalState(value.terminalState);
}

function validNativeAbortSignal(value) {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  try {
    return Object.getPrototypeOf(value) === AbortSignal.prototype
      && !Object.prototype.hasOwnProperty.call(value, "aborted")
      && !Object.prototype.hasOwnProperty.call(value, "addEventListener")
      && !Object.prototype.hasOwnProperty.call(value, "removeEventListener")
      && typeof ABORTED.call(value) === "boolean";
  } catch (_) { return false; }
}

function aborted(signal) {
  try { return ABORTED.call(signal); } catch (_) { return true; }
}

function active(operation) {
  return !aborted(operation.signal) && !operation.terminalState.isTerminal()
    && positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) !== null;
}

function notContacted() { return Object.freeze({ category: "not_contacted" }); }
function indeterminate() { return Object.freeze({ category: "indeterminate" }); }

function exactDispatch(value, turnRequest, turnResponse, adapter) {
  return exactKeys(value, DISPATCH_KEYS)
    && value.clientRequestId === value.attemptId
    && value.contractVersion === turnRequest.contractVersion
    && sameConversation(value.conversation, turnRequest.conversation)
    && value.model === adapter.model && value.provider === "openai"
    && value.requestSignatureSha256 === memberConversationTurnRequestHash(turnRequest)
    && value.responseSchemaVersion === adapter.responseSchemaVersion
    && value.safetyRuleVersion === turnResponse.result.safety.ruleVersion
    && value.safetySourceRuleVersion === turnResponse.result.safety.sourceRuleVersion
    && value.transportVersion === MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION;
}

function createBoundV2Chain(state, attemptId) {
  const request = createMemberConversationProviderRequestV2({
    version: MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION,
    transportVersion: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    attemptId,
    model: state.adapter.model,
    developerPromptVersion: state.requestConfig.developerPromptVersion,
    developerPromptSha256: state.requestConfig.developerPromptSha256,
    responseSchemaVersion: state.requestConfig.responseSchemaVersion,
    responseSchemaSha256: state.requestConfig.responseSchemaSha256,
    promptCachePolicy: state.promptCachePolicy,
    turnRequest: state.turnRequest,
    turnResponse: state.turnResponse,
    controls: {
      background: false, conversation: null,
      maxOutputTokens: state.adapter.maxOutputTokens, metadata: null,
      previousResponseId: null, store: false, stream: false, tools: [],
      truncation: "disabled",
    },
    regionPolicy: state.requestConfig.regionPolicy,
  });
  if (!request) return null;
  let httpTransport = null;
  const providerTransport = createMemberConversationProviderTransportV2({
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    request,
    provider: "openai",
    model: request.model,
    responseSchemaVersion: request.responseSchemaVersion,
    dispatch: (boundRequest, boundOperation) => httpTransport
      ? httpTransport.dispatch(boundRequest, boundOperation) : notContacted(),
  });
  const responsesTransport = providerTransport
    && createMemberConversationOpenAIResponsesTransportV2({
      version: MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION,
      adapter: state.adapter, request, transport: providerTransport,
    });
  httpTransport = responsesTransport
    && createMemberConversationOpenAIResponsesHTTPTransportV2({
      version: MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION,
      adapter: state.adapter,
      httpClient: state.httpClient,
      origin: state.origin,
      providerTransport,
      regionPolicy: state.requestConfig.regionPolicy,
      request,
      resolver: state.resolver,
      responsesTransport,
    });
  return httpTransport ? Object.freeze({ request, providerTransport }) : null;
}

function createMemberConversationOpenAIResponsesOrchestratorTransportV2(value = {}) {
  try {
    if (!exactKeys(value, FACTORY_KEYS)
      || value.version !== MEMBER_CONVERSATION_OPENAI_RESPONSES_ORCHESTRATOR_TRANSPORT_V2_VERSION
      || !validMemberConversationOpenAIResponsesAdapterV2(value.adapter)
      || !validMemberConversationOpenAICredentialResolver(value.resolver)
      || !validMemberConversationOpenAIHTTPClient(value.httpClient)
      || !validMemberConversationOpenAIPromptCachePolicy(value.promptCachePolicy)
      || !exactKeys(value.requestConfig, REQUEST_CONFIG_KEYS)
      || !REQUEST_CONFIG_KEYS.every((key) => typeof value.requestConfig[key] === "string")
      || typeof value.origin !== "string"
      || !memberConversationOpenAIHTTPClientMatchesOrigin(value.httpClient, value.origin)
      || !safeData(value.turnRequest)
      || !safeData(value.turnResponse)) return null;
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

    const state = Object.freeze({
      adapter: value.adapter,
      httpClient: value.httpClient,
      origin: value.origin,
      promptCachePolicy: value.promptCachePolicy,
      requestConfig: Object.freeze({ ...value.requestConfig }),
      resolver: value.resolver,
      turnRequest,
      turnResponse,
    });
    if (!createBoundV2Chain(state, "00000000-0000-4000-8000-000000000000")) {
      return null;
    }
    let consumed = false;
    return createMemberConversationProviderTransport({
      version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
      provider: "openai",
      model: state.adapter.model,
      responseSchemaVersion: state.adapter.responseSchemaVersion,
      async dispatch(dispatchRequest, operation = {}) {
        if (!exactDispatch(dispatchRequest, state.turnRequest, state.turnResponse, state.adapter)
          || !validOperation(operation)) return notContacted();
        if (consumed) return indeterminate();
        consumed = true;
        if (!active(operation)) return notContacted();
        const chain = createBoundV2Chain(state, dispatchRequest.attemptId);
        if (!chain || !active(operation)) return notContacted();
        const { request, providerTransport } = chain;
        let returned;
        try { returned = await providerTransport.dispatch(request, operation); }
        catch (_) { return indeterminate(); }
        const authority = returned && returned.authority;
        try {
          if (!returned || !active(operation)) return indeterminate();
          if (returned.classification === "not_contacted" && !authority) {
            return notContacted();
          }
          if (returned.classification === "indeterminate" && !authority) {
            return indeterminate();
          }
          if (!authority) return indeterminate();
          if (returned.classification === "rejected") {
            const rejection = readMemberConversationProviderRejectionV2(
              returned.outcome, authority
            );
            return rejection && rejection.attemptId === dispatchRequest.attemptId
              && active(operation) ? Object.freeze({
                category: "rejected",
                providerRequestId: rejection.providerRequestId,
                terminalCategory: rejection.terminalCategory,
              }) : indeterminate();
          }
          if (returned.classification !== "succeeded") {
            return returned.classification === "not_contacted"
              ? notContacted() : indeterminate();
          }
          const result = readMemberConversationProviderResultV2(returned.outcome, authority);
          if (!result || result.attemptId !== dispatchRequest.attemptId || !active(operation)) {
            return indeterminate();
          }
          const response = createMemberConversationTurnResponseV2(
            state.turnRequest, state.turnResponse, result.coaching
          );
          return response && active(operation) ? Object.freeze({
            category: "succeeded",
            providerRequestId: result.providerRequestId,
            providerResponseId: result.providerResponseId,
            response,
          }) : indeterminate();
        } finally {
          if (authority) revokeMemberConversationProviderResultAuthorityV2(authority);
        }
      },
    });
  } catch (_) { return null; }
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_ORCHESTRATOR_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesOrchestratorTransportV2,
};
