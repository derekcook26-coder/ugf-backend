"use strict";

const { createHash } = require("node:crypto");
const { types: { isProxy } } = require("node:util");

const MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-2";
const MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_APPROVAL_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-APPROVAL-2";
const MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-BINDING-2";
const MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_APPROVAL_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-BINDING-APPROVAL-2";
const MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-2";
const MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-PROMPT-CACHE-POLICY-1";
const CONFIGURATION_LIMITS = Object.freeze({
  adapterTimeoutMilliseconds: 25000,
  finalizationReserveMilliseconds: 5000,
  maximumOutputBytes: 1600,
  maximumOutputCharacters: 800,
  maximumOutputTokens: 4096,
  requestBodyBytes: 262144,
  requestHeaderBytes: 16384,
  responseBodyBytes: 262144,
  responseHeaderBytes: 32768,
});

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const IMMUTABLE_GPT_56_MODEL = /^(?:gpt-(?:[6-9]|5\.(?:[6-9]|[1-9][0-9]))[A-Za-z0-9._:-]*-)(\d{4}-\d{2}-\d{2})$/;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CONTROL_OR_SURROGATE = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u;

const CONFIGURATION_PAYLOAD_KEYS = Object.freeze([
  "version", "environmentName", "compositionVersion", "credentialResolverVersion",
  "boundedHttpInterfaceVersion", "httpClientVersion", "responsesHttpClientVersion",
  "responsesClientVersion", "adapterVersion", "transportVersion", "requestContractVersion",
  "resultContractVersion", "outputPolicyVersion", "responseContractVersion", "model",
  "origin", "responsesPath", "regionPolicy", "promptCachePolicyVersion",
  "promptCacheMode", "promptCacheBreakpointCount", "developerPromptVersion",
  "developerPromptSha256", "responseSchemaVersion", "responseSchemaSha256",
  "maximumOutputCharacters", "maximumOutputBytes", "maximumOutputTokens",
  "requestHeaderBytes", "requestBodyBytes", "responseHeaderBytes", "responseBodyBytes",
  "adapterTimeoutMilliseconds", "finalizationReserveMilliseconds",
  "monthlySpendCeilingUsdCents", "dailyWarningThresholdUsdCents",
  "providerBudgetEvidenceSha256", "spendingAlertEvidenceSha256",
  "costControlEvidenceObservedAt", "providerControlEvidenceSha256",
  "providerControlEvidenceObservedAt", "codeTreeSha", "migrationStateEvidenceSha256",
  "approvalExpiresAt",
]);
const CONFIGURATION_ENVELOPE_KEYS = Object.freeze([
  "configurationSha256", "payload", "version",
]);
const COMPOSITION_BINDING_PAYLOAD_KEYS = Object.freeze([
  "version", "configurationSha256", "compositionVersion", "boundedHttpInterfaceVersion",
  "httpClientVersion", "responsesHttpTransportVersion", "orchestratorTransportVersion",
  "providerRequestVersion", "providerTransportVersion", "providerResultVersion",
  "providerRejectionVersion", "modelSnapshotEvidenceSha256",
  "zeroDataRetentionEvidenceSha256", "zeroDataRetentionEvidenceObservedAt", "codeTreeSha",
]);
const COMPOSITION_BINDING_ENVELOPE_KEYS = Object.freeze([
  "compositionBindingSha256", "payload", "version",
]);

const configurationCapabilities = new WeakMap();
const compositionBindingCapabilities = new WeakMap();

const MEMBER_CONVERSATION_OPENAI_PRODUCTION_V2_ALLOWLISTS = Object.freeze({
  compositionBindingDigests: Object.freeze([]),
  configurationDigests: Object.freeze([]),
});

const disabledComposition = Object.freeze({
  adapter: null,
  credentialResolver: null,
  externalCallsPermitted: false,
  httpClient: null,
  httpTransport: null,
  orchestrator: null,
  providerFree: true,
  reason: "production_configuration_unavailable",
  requestFactory: null,
  runtimeWired: false,
  status: "disabled",
  transport: null,
  version: MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_V2_VERSION,
});

function exactDataObject(value, sortedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")
    || keys.slice().sort().join("\0") !== sortedKeys.join("\0")) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return sortedKeys.every((key) => descriptors[key]
    && descriptors[key].enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptors[key], "value")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "get")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "set"));
}

function dataValues(value, keys) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function safeString(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.normalize("NFC") && !CONTROL_OR_SURROGATE.test(value);
}

function identifier(value) {
  return safeString(value) && IDENTIFIER.test(value)
    && !/(^|[._:/-])(latest|current|stable)([._:/-]|$)/i.test(value);
}

function sha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

function timestamp(value) {
  if (typeof value !== "string" || !UTC_SECONDS.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time)
    && new Date(time).toISOString().replace(".000Z", "Z") === value;
}

function immutableModelSnapshot(value) {
  if (typeof value !== "string") return false;
  const match = IMMUTABLE_GPT_56_MODEL.exec(value);
  if (!match) return false;
  const time = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isFinite(time)
    && new Date(time).toISOString().slice(0, 10) === match[1];
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      && parsed.search === "" && parsed.hash === "" && parsed.pathname === "/"
      && parsed.origin === value;
  } catch (_) { return false; }
}

function canonicalSha256(payload) {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function normalizeConfigurationPayload(value) {
  const sorted = [...CONFIGURATION_PAYLOAD_KEYS].sort();
  if (!exactDataObject(value, sorted)) return null;
  const input = dataValues(value, CONFIGURATION_PAYLOAD_KEYS);
  const identifierKeys = [
    "environmentName", "compositionVersion", "credentialResolverVersion",
    "boundedHttpInterfaceVersion", "httpClientVersion", "responsesHttpClientVersion",
    "responsesClientVersion", "adapterVersion", "transportVersion", "requestContractVersion",
    "resultContractVersion", "outputPolicyVersion", "responseContractVersion",
    "regionPolicy", "developerPromptVersion", "responseSchemaVersion",
  ];
  const digestKeys = [
    "developerPromptSha256", "responseSchemaSha256", "providerBudgetEvidenceSha256",
    "spendingAlertEvidenceSha256", "providerControlEvidenceSha256",
    "migrationStateEvidenceSha256",
  ];
  const boundedKeys = [
    "requestHeaderBytes", "requestBodyBytes", "responseHeaderBytes", "responseBodyBytes",
    "adapterTimeoutMilliseconds", "finalizationReserveMilliseconds",
  ];
  if (input.version !== MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_V2_VERSION
    || identifierKeys.some((key) => !identifier(input[key]))
    || !immutableModelSnapshot(input.model)
    || digestKeys.some((key) => !sha256(input[key]))
    || input.maximumOutputCharacters !== CONFIGURATION_LIMITS.maximumOutputCharacters
    || input.maximumOutputBytes !== CONFIGURATION_LIMITS.maximumOutputBytes
    || input.maximumOutputTokens !== CONFIGURATION_LIMITS.maximumOutputTokens
    || boundedKeys.some((key) => !positiveInteger(input[key])
      || input[key] > CONFIGURATION_LIMITS[key])
    || !nonnegativeInteger(input.monthlySpendCeilingUsdCents)
    || !nonnegativeInteger(input.dailyWarningThresholdUsdCents)
    || input.dailyWarningThresholdUsdCents > input.monthlySpendCeilingUsdCents
    || input.finalizationReserveMilliseconds >= input.adapterTimeoutMilliseconds
    || !exactOrigin(input.origin) || input.responsesPath !== "/v1/responses"
    || input.promptCachePolicyVersion !== MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION
    || input.promptCacheMode !== "explicit" || input.promptCacheBreakpointCount !== 0
    || !timestamp(input.costControlEvidenceObservedAt)
    || !timestamp(input.providerControlEvidenceObservedAt)
    || !timestamp(input.approvalExpiresAt)
    || Date.parse(input.approvalExpiresAt) <= Date.now()
    || !GIT_SHA.test(input.codeTreeSha)) return null;
  return Object.freeze(Object.fromEntries(
    CONFIGURATION_PAYLOAD_KEYS.map((key) => [key, input[key]])
  ));
}

function normalizeCompositionBindingPayload(value) {
  const sorted = [...COMPOSITION_BINDING_PAYLOAD_KEYS].sort();
  if (!exactDataObject(value, sorted)) return null;
  const input = dataValues(value, COMPOSITION_BINDING_PAYLOAD_KEYS);
  const identifierKeys = [
    "compositionVersion", "boundedHttpInterfaceVersion", "httpClientVersion",
    "responsesHttpTransportVersion", "orchestratorTransportVersion",
    "providerRequestVersion", "providerTransportVersion", "providerResultVersion",
    "providerRejectionVersion",
  ];
  const digestKeys = [
    "configurationSha256", "modelSnapshotEvidenceSha256",
    "zeroDataRetentionEvidenceSha256",
  ];
  if (input.version !== MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_V2_VERSION
    || identifierKeys.some((key) => !identifier(input[key]))
    || digestKeys.some((key) => !sha256(input[key]))
    || !timestamp(input.zeroDataRetentionEvidenceObservedAt)
    || !GIT_SHA.test(input.codeTreeSha)) return null;
  return Object.freeze(Object.fromEntries(
    COMPOSITION_BINDING_PAYLOAD_KEYS.map((key) => [key, input[key]])
  ));
}

function createMemberConversationOpenAIProductionConfigurationV2(value = {}) {
  try {
    if (!exactDataObject(value, [...CONFIGURATION_ENVELOPE_KEYS].sort())) return null;
    const envelope = dataValues(value, CONFIGURATION_ENVELOPE_KEYS);
    const payload = normalizeConfigurationPayload(envelope.payload);
    if (!payload
      || envelope.version !== MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_APPROVAL_V2_VERSION
      || !sha256(envelope.configurationSha256)
      || canonicalSha256(payload) !== envelope.configurationSha256) return null;
    const capability = Object.freeze(Object.create(null));
    configurationCapabilities.set(capability, Object.freeze({
      configurationSha256: envelope.configurationSha256,
      payload,
    }));
    return capability;
  } catch (_) { return null; }
}

function createMemberConversationOpenAIProductionCompositionBindingV2(value = {}) {
  try {
    if (!exactDataObject(value, [...COMPOSITION_BINDING_ENVELOPE_KEYS].sort())) return null;
    const envelope = dataValues(value, COMPOSITION_BINDING_ENVELOPE_KEYS);
    const payload = normalizeCompositionBindingPayload(envelope.payload);
    if (!payload
      || envelope.version
        !== MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_APPROVAL_V2_VERSION
      || !sha256(envelope.compositionBindingSha256)
      || canonicalSha256(payload) !== envelope.compositionBindingSha256) return null;
    const capability = Object.freeze(Object.create(null));
    compositionBindingCapabilities.set(capability, Object.freeze({
      compositionBindingSha256: envelope.compositionBindingSha256,
      payload,
    }));
    return capability;
  } catch (_) { return null; }
}

function validMemberConversationOpenAIProductionConfigurationV2(value) {
  return Boolean(value && configurationCapabilities.has(value)
    && Object.isFrozen(value) && Reflect.ownKeys(value).length === 0);
}

function validMemberConversationOpenAIProductionCompositionBindingV2(value) {
  return Boolean(value && compositionBindingCapabilities.has(value)
    && Object.isFrozen(value) && Reflect.ownKeys(value).length === 0);
}

function memberConversationOpenAIProductionConfigurationV2Digest(value) {
  const state = value && configurationCapabilities.get(value);
  return state ? state.configurationSha256 : null;
}

function memberConversationOpenAIProductionCompositionBindingV2Digest(value) {
  const state = value && compositionBindingCapabilities.get(value);
  return state ? state.compositionBindingSha256 : null;
}

function memberConversationOpenAIProductionCompositionBindingV2MatchesConfiguration(
  binding,
  configuration
) {
  const bindingState = binding && compositionBindingCapabilities.get(binding);
  const configurationState = configuration && configurationCapabilities.get(configuration);
  return Boolean(bindingState && configurationState
    && bindingState.payload.configurationSha256
      === configurationState.configurationSha256
    && bindingState.payload.compositionVersion
      === configurationState.payload.compositionVersion
    && bindingState.payload.boundedHttpInterfaceVersion
      === configurationState.payload.boundedHttpInterfaceVersion
    && bindingState.payload.httpClientVersion
      === configurationState.payload.httpClientVersion
    && bindingState.payload.codeTreeSha === configurationState.payload.codeTreeSha);
}

function createProductionMemberConversationOpenAICompositionV2() {
  return disabledComposition;
}

module.exports = {
  CONFIGURATION_PAYLOAD_KEYS,
  COMPOSITION_BINDING_PAYLOAD_KEYS,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_APPROVAL_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_APPROVAL_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_V2_ALLOWLISTS,
  createMemberConversationOpenAIProductionCompositionBindingV2,
  createMemberConversationOpenAIProductionConfigurationV2,
  createProductionMemberConversationOpenAICompositionV2,
  memberConversationOpenAIProductionCompositionBindingV2Digest,
  memberConversationOpenAIProductionCompositionBindingV2MatchesConfiguration,
  memberConversationOpenAIProductionConfigurationV2Digest,
  validMemberConversationOpenAIProductionCompositionBindingV2,
  validMemberConversationOpenAIProductionConfigurationV2,
};
