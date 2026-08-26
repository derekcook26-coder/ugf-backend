"use strict";

const { createHash } = require("node:crypto");
const { types: { isProxy } } = require("node:util");
const {
  readMemberConversationOpenAIPromptCachePolicy,
  validMemberConversationOpenAIPromptCachePolicy,
} = require("./member-conversation-openai-prompt-cache-policy");
const {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_V2_MAXIMUM_TOKENS,
  memberConversationProviderRequestV2Digest,
  validMemberConversationProviderRequestV2,
} = require("./member-conversation-provider-request-envelope-v2");
const {
  validMemberConversationProviderTransportV2,
} = require("./member-conversation-provider-transport-v2");

const MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ADAPTER-2";
const PROVIDER_SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const IMMUTABLE_GPT_56_MODEL = /^gpt-(?:[6-9]|5\.(?:[6-9]|[1-9][0-9]))[A-Za-z0-9._:-]*-\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SURROGATE_CODE_UNIT = /[\uD800-\uDFFF]/u;
const VERSIONED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADAPTER_KEYS = Object.freeze([
  "developerPrompt", "developerPromptSha256", "developerPromptVersion", "maxOutputTokens", "model",
  "promptCachePolicy", "regionPolicy", "responseSchema", "responseSchemaSha256",
  "responseSchemaVersion", "version",
]);
const PUBLIC_KEYS = Object.freeze([
  "externalCallsPermitted", "maxOutputTokens", "model", "promptCacheBreakpointCount", "promptCacheMode",
  "promptCachePolicyVersion", "provider", "providerFree", "responseSchemaVersion",
  "runtimeWired", "version",
]);
const WIRE_INPUT_KEYS = Object.freeze(["request", "signal", "transport"]);
const SCHEMA_KEYS = Object.freeze([
  "additionalProperties", "properties", "required", "type",
]);
const COACHING_MAXIMUM_CHARACTERS = 800;
const ABORT_SIGNAL_ABORTED = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype, "aborted"
).get;
const brandedAdapters = new WeakSet();
const adapterState = new WeakMap();

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

function exactDataTree(value, seen = new Set()) {
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
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && !Object.prototype.hasOwnProperty.call(descriptor, "get")
      && !Object.prototype.hasOwnProperty.call(descriptor, "set")
      && (arrayLength || descriptor.enumerable === true)
      && exactDataTree(descriptor.value, seen);
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function strictSchema(value) {
  if (!exactDataTree(value) || !exactKeys(value, SCHEMA_KEYS)
    || value.type !== "object" || value.additionalProperties !== false
    || !Array.isArray(value.required) || value.required.length !== 1
    || value.required[0] !== "coaching"
    || !exactKeys(value.properties, ["coaching"])
    || !exactKeys(value.properties.coaching, ["maxLength", "type"])
    || value.properties.coaching.type !== "string"
    || value.properties.coaching.maxLength !== COACHING_MAXIMUM_CHARACTERS) return null;
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["coaching"]),
    properties: Object.freeze({
      coaching: Object.freeze({ type: "string", maxLength: COACHING_MAXIMUM_CHARACTERS }),
    }),
  });
}

function createMemberConversationOpenAIResponsesAdapterV2(value = {}) {
  try {
    if (!exactKeys(value, ADAPTER_KEYS)
      || value.version !== MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_V2_VERSION
      || typeof value.model !== "string" || !IMMUTABLE_GPT_56_MODEL.test(value.model)
      || typeof value.developerPromptVersion !== "string"
      || !VERSIONED_IDENTIFIER.test(value.developerPromptVersion)
      || typeof value.responseSchemaVersion !== "string"
      || !PROVIDER_SCHEMA_NAME.test(value.responseSchemaVersion)
      || typeof value.regionPolicy !== "string" || !VERSIONED_IDENTIFIER.test(value.regionPolicy)
      || typeof value.developerPrompt !== "string" || value.developerPrompt.length === 0
      || value.developerPrompt !== value.developerPrompt.trim()
      || SURROGATE_CODE_UNIT.test(value.developerPrompt)
      || !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1
      || value.maxOutputTokens > MEMBER_CONVERSATION_PROVIDER_OUTPUT_V2_MAXIMUM_TOKENS
      || typeof value.developerPromptSha256 !== "string"
      || !SHA256.test(value.developerPromptSha256)
      || sha256(value.developerPrompt) !== value.developerPromptSha256
      || typeof value.responseSchemaSha256 !== "string"
      || !SHA256.test(value.responseSchemaSha256)
      || !validMemberConversationOpenAIPromptCachePolicy(value.promptCachePolicy)) return null;
    const responseSchema = strictSchema(value.responseSchema);
    const promptCachePolicy = readMemberConversationOpenAIPromptCachePolicy(
      value.promptCachePolicy
    );
    if (!responseSchema || !promptCachePolicy
      || sha256(JSON.stringify(responseSchema)) !== value.responseSchemaSha256) return null;
    const state = Object.freeze({
      developerPrompt: value.developerPrompt,
      developerPromptSha256: value.developerPromptSha256,
      developerPromptVersion: value.developerPromptVersion,
      maxOutputTokens: value.maxOutputTokens,
      model: value.model,
      promptCachePolicy,
      regionPolicy: value.regionPolicy,
      responseSchema,
      responseSchemaSha256: value.responseSchemaSha256,
      responseSchemaVersion: value.responseSchemaVersion,
    });
    const adapter = Object.freeze({
      externalCallsPermitted: false,
      maxOutputTokens: state.maxOutputTokens,
      model: state.model,
      promptCachePolicyVersion: promptCachePolicy.version,
      promptCacheMode: promptCachePolicy.mode,
      promptCacheBreakpointCount: promptCachePolicy.breakpointCount,
      provider: "openai",
      providerFree: true,
      responseSchemaVersion: state.responseSchemaVersion,
      runtimeWired: false,
      version: MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_V2_VERSION,
    });
    adapterState.set(adapter, state);
    brandedAdapters.add(adapter);
    return adapter;
  } catch (_) { return null; }
}

function validMemberConversationOpenAIResponsesAdapterV2(value) {
  if (!value || !brandedAdapters.has(value) || !Object.isFrozen(value)
    || !exactKeys(value, PUBLIC_KEYS)) return false;
  const state = adapterState.get(value);
  return Boolean(state
    && value.version === MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_V2_VERSION
    && value.externalCallsPermitted === false && value.providerFree === true
    && value.runtimeWired === false && value.provider === "openai"
    && value.maxOutputTokens === state.maxOutputTokens
    && value.model === state.model
    && value.responseSchemaVersion === state.responseSchemaVersion
    && value.promptCachePolicyVersion === state.promptCachePolicy.version
    && value.promptCacheMode === state.promptCachePolicy.mode
    && value.promptCacheBreakpointCount === state.promptCachePolicy.breakpointCount);
}

function createMemberConversationOpenAIResponsesWireRequestV2(adapter, input = {}) {
  try {
    const state = adapter && adapterState.get(adapter);
    if (!state || !validMemberConversationOpenAIResponsesAdapterV2(adapter)
      || !exactKeys(input, WIRE_INPUT_KEYS)
      || !validActiveAbortSignal(input.signal)
      || !validMemberConversationProviderRequestV2(input.request)
      || !validMemberConversationProviderTransportV2(input.transport)) return null;
    const request = input.request;
    const policy = request.controls.promptCachePolicy;
    if (request.model !== state.model
      || request.developerPromptVersion !== state.developerPromptVersion
      || request.developerPromptSha256 !== state.developerPromptSha256
      || request.responseSchemaVersion !== state.responseSchemaVersion
      || request.responseSchemaSha256 !== state.responseSchemaSha256
      || request.regionPolicy !== state.regionPolicy
      || request.controls.maxOutputTokens !== state.maxOutputTokens
      || policy.version !== state.promptCachePolicy.version
      || policy.mode !== state.promptCachePolicy.mode
      || policy.breakpointCount !== state.promptCachePolicy.breakpointCount
      || input.transport.model !== state.model
      || input.transport.provider !== "openai"
      || input.transport.responseSchemaVersion !== state.responseSchemaVersion
      || input.transport.promptCachePolicyVersion !== policy.version
      || input.transport.promptCacheMode !== policy.mode
      || input.transport.promptCacheBreakpointCount !== policy.breakpointCount
      || input.transport.requestDigestSha256
        !== memberConversationProviderRequestV2Digest(request)) return null;
    return Object.freeze({
      body: Object.freeze({
        model: state.model,
        input: Object.freeze([
          Object.freeze({ role: "developer", content: state.developerPrompt }),
          Object.freeze({ role: "user", content: request.memberTurn }),
        ]),
        text: Object.freeze({
          format: Object.freeze({
            type: "json_schema",
            name: state.responseSchemaVersion,
            strict: true,
            schema: state.responseSchema,
          }),
        }),
        max_output_tokens: state.maxOutputTokens,
        prompt_cache_options: Object.freeze({ mode: "explicit" }),
        store: false,
        background: false,
        stream: false,
        truncation: "disabled",
        tools: Object.freeze([]),
      }),
      clientRequestId: request.attemptId,
      regionPolicy: state.regionPolicy,
      signal: input.signal,
    });
  } catch (_) { return null; }
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_V2_VERSION,
  createMemberConversationOpenAIResponsesAdapterV2,
  createMemberConversationOpenAIResponsesWireRequestV2,
  validMemberConversationOpenAIResponsesAdapterV2,
};
