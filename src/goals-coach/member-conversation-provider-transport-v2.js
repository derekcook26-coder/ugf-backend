"use strict";

const { types: { isProxy } } = require("node:util");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
  memberConversationProviderRequestV2Digest,
  validMemberConversationProviderRequestV2,
} = require("./member-conversation-provider-request-envelope-v2");

const PROVIDER_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSIONED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INPUT_KEYS = Object.freeze([
  "dispatch", "model", "provider", "request", "responseSchemaVersion", "version",
]);
const TRANSPORT_KEYS = Object.freeze([
  "dispatch", "externalCallsPermitted", "model", "promptCacheBreakpointCount",
  "promptCacheMode", "promptCachePolicyVersion", "provider", "providerFree",
  "requestDigestSha256", "responseSchemaVersion", "runtimeWired", "version",
]);
const brandedTransports = new WeakSet();
const transportState = new WeakMap();

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

function exactString(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function validBoundRequest(state, request) {
  return Boolean(state && validMemberConversationProviderRequestV2(request)
    && request.model === state.model
    && request.controls.promptCachePolicy.version === state.promptCachePolicyVersion
    && request.controls.promptCachePolicy.mode === state.promptCacheMode
    && request.controls.promptCachePolicy.breakpointCount === state.promptCacheBreakpointCount
    && request.responseSchemaVersion === state.responseSchemaVersion
    && memberConversationProviderRequestV2Digest(request) === state.requestDigestSha256);
}

function createMemberConversationProviderTransportV2(options = {}) {
  try {
    if (!exactKeys(options, INPUT_KEYS)
      || options.version !== MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION
      || typeof options.dispatch !== "function"
      || !validMemberConversationProviderRequestV2(options.request)) return null;

    const provider = exactString(options.provider, PROVIDER_NAME);
    const model = exactString(options.model, VERSIONED_IDENTIFIER);
    const responseSchemaVersion = exactString(
      options.responseSchemaVersion,
      VERSIONED_IDENTIFIER
    );
    const requestDigestSha256 = memberConversationProviderRequestV2Digest(options.request);
    const promptCachePolicyVersion = options.request.controls.promptCachePolicy.version;
    const promptCacheMode = options.request.controls.promptCachePolicy.mode;
    const promptCacheBreakpointCount = options.request.controls.promptCachePolicy.breakpointCount;
    if (!provider || !model || !responseSchemaVersion
      || !exactString(requestDigestSha256, SHA256)
      || options.request.model !== model
      || options.request.responseSchemaVersion !== responseSchemaVersion) return null;

    const state = Object.freeze({
      dispatch: options.dispatch,
      model,
      promptCachePolicyVersion,
      promptCacheMode,
      promptCacheBreakpointCount,
      requestDigestSha256,
      responseSchemaVersion,
    });
    const transport = Object.freeze({
      async dispatch(request, operationContext) {
        const current = transportState.get(transport);
        if (!validBoundRequest(current, request)) return null;
        return current.dispatch(request, operationContext);
      },
      externalCallsPermitted: true,
      model,
      promptCachePolicyVersion,
      promptCacheMode,
      promptCacheBreakpointCount,
      provider,
      providerFree: false,
      requestDigestSha256,
      responseSchemaVersion,
      runtimeWired: false,
      version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    });
    transportState.set(transport, state);
    brandedTransports.add(transport);
    return transport;
  } catch (_) { return null; }
}

function validMemberConversationProviderTransportV2(value) {
  if (!value || !brandedTransports.has(value) || !Object.isFrozen(value)
    || !exactKeys(value, TRANSPORT_KEYS)) return false;
  const state = transportState.get(value);
  return Boolean(state
    && value.version === MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION
    && value.externalCallsPermitted === true
    && value.providerFree === false
    && value.runtimeWired === false
    && exactString(value.provider, PROVIDER_NAME)
    && value.model === state.model
    && value.promptCachePolicyVersion === state.promptCachePolicyVersion
    && value.promptCacheMode === state.promptCacheMode
    && value.promptCacheBreakpointCount === state.promptCacheBreakpointCount
    && value.responseSchemaVersion === state.responseSchemaVersion
    && value.requestDigestSha256 === state.requestDigestSha256
    && exactString(value.requestDigestSha256, SHA256)
    && typeof value.dispatch === "function");
}

module.exports = {
  createMemberConversationProviderTransportV2,
  validMemberConversationProviderTransportV2,
};
