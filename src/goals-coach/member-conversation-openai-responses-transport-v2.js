"use strict";

const { types: { isProxy } } = require("node:util");
const {
  createMemberConversationOpenAIResponsesWireRequestV2,
  validMemberConversationOpenAIResponsesAdapterV2,
} = require("./member-conversation-openai-responses-adapter-v2");
const {
  memberConversationProviderRequestV2Digest,
  validMemberConversationProviderRequestV2,
} = require("./member-conversation-provider-request-envelope-v2");
const {
  validMemberConversationProviderTransportV2,
} = require("./member-conversation-provider-transport-v2");

const MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-2";
const FACTORY_KEYS = Object.freeze(["adapter", "request", "transport", "version"]);
const CREATE_KEYS = Object.freeze(["signal"]);
const PUBLIC_KEYS = Object.freeze([
  "createWireRequest", "externalCallsPermitted", "model", "promptCacheBreakpointCount",
  "promptCacheMode", "promptCachePolicyVersion", "provider", "providerFree",
  "requestDigestSha256", "responseSchemaVersion", "runtimeWired", "version",
]);
const ABORT_SIGNAL_ABORTED = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype, "aborted"
).get;
const brandedTransports = new WeakSet();
const transportState = new WeakMap();

function validActiveAbortSignal(value) {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  try { return ABORT_SIGNAL_ABORTED.call(value) === false; } catch (_) { return false; }
}

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys) {
  if (!exactObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")
    || ownKeys.slice().sort().join("\0") !== keys.join("\0")) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key]
    && descriptors[key].enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptors[key], "value")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "get")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "set"));
}

function exactBinding(adapter, request, transport) {
  if (!validMemberConversationOpenAIResponsesAdapterV2(adapter)
    || !validMemberConversationProviderRequestV2(request)
    || !validMemberConversationProviderTransportV2(transport)) return null;
  const digest = memberConversationProviderRequestV2Digest(request);
  if (!digest || adapter.provider !== "openai" || transport.provider !== "openai"
    || adapter.model !== request.model || transport.model !== request.model
    || adapter.responseSchemaVersion !== request.responseSchemaVersion
    || transport.responseSchemaVersion !== request.responseSchemaVersion
    || adapter.maxOutputTokens !== request.controls.maxOutputTokens
    || adapter.promptCachePolicyVersion !== request.controls.promptCachePolicy.version
    || adapter.promptCacheMode !== request.controls.promptCachePolicy.mode
    || adapter.promptCacheBreakpointCount !== request.controls.promptCachePolicy.breakpointCount
    || transport.promptCachePolicyVersion !== request.controls.promptCachePolicy.version
    || transport.promptCacheMode !== request.controls.promptCachePolicy.mode
    || transport.promptCacheBreakpointCount !== request.controls.promptCachePolicy.breakpointCount
    || transport.requestDigestSha256 !== digest) return null;
  const probe = createMemberConversationOpenAIResponsesWireRequestV2(adapter, {
    request,
    signal: new AbortController().signal,
    transport,
  });
  if (!probe) return null;
  return digest;
}

function createMemberConversationOpenAIResponsesTransportV2(value = {}) {
  try {
    if (!exactKeys(value, FACTORY_KEYS)
      || value.version !== MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION) return null;
    const requestDigestSha256 = exactBinding(value.adapter, value.request, value.transport);
    if (!requestDigestSha256) return null;
    const state = Object.freeze({
      adapter: value.adapter,
      request: value.request,
      transport: value.transport,
      requestDigestSha256,
    });
    const responsesTransport = Object.freeze({
      createWireRequest(input = {}) {
        try {
          const current = transportState.get(responsesTransport);
          if (!current || !exactKeys(input, CREATE_KEYS)
            || !validActiveAbortSignal(input.signal)
            || exactBinding(current.adapter, current.request, current.transport)
              !== current.requestDigestSha256) return null;
          return createMemberConversationOpenAIResponsesWireRequestV2(current.adapter, {
            request: current.request,
            signal: input.signal,
            transport: current.transport,
          });
        } catch (_) { return null; }
      },
      externalCallsPermitted: false,
      model: value.request.model,
      promptCachePolicyVersion: value.request.controls.promptCachePolicy.version,
      promptCacheMode: value.request.controls.promptCachePolicy.mode,
      promptCacheBreakpointCount: value.request.controls.promptCachePolicy.breakpointCount,
      provider: "openai",
      providerFree: true,
      requestDigestSha256,
      responseSchemaVersion: value.request.responseSchemaVersion,
      runtimeWired: false,
      version: MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION,
    });
    transportState.set(responsesTransport, state);
    brandedTransports.add(responsesTransport);
    return responsesTransport;
  } catch (_) { return null; }
}

function validMemberConversationOpenAIResponsesTransportV2(value) {
  if (!value || !brandedTransports.has(value) || !Object.isFrozen(value)
    || !exactKeys(value, PUBLIC_KEYS)) return false;
  const state = transportState.get(value);
  return Boolean(state
    && value.version === MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION
    && value.externalCallsPermitted === false && value.providerFree === true
    && value.runtimeWired === false && value.provider === "openai"
    && value.model === state.request.model
    && value.promptCachePolicyVersion === state.request.controls.promptCachePolicy.version
    && value.promptCacheMode === state.request.controls.promptCachePolicy.mode
    && value.promptCacheBreakpointCount === state.request.controls.promptCachePolicy.breakpointCount
    && value.responseSchemaVersion === state.request.responseSchemaVersion
    && value.requestDigestSha256 === state.requestDigestSha256
    && typeof value.createWireRequest === "function"
    && exactBinding(state.adapter, state.request, state.transport)
      === state.requestDigestSha256);
}

function memberConversationOpenAIResponsesTransportV2MatchesDependencies(
  value, adapter, request, providerTransport
) {
  const state = value && transportState.get(value);
  return Boolean(state && validMemberConversationOpenAIResponsesTransportV2(value)
    && state.adapter === adapter && state.request === request
    && state.transport === providerTransport
    && exactBinding(adapter, request, providerTransport) === state.requestDigestSha256);
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesTransportV2,
  memberConversationOpenAIResponsesTransportV2MatchesDependencies,
  validMemberConversationOpenAIResponsesTransportV2,
};
