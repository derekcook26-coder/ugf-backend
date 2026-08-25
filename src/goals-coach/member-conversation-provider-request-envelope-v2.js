"use strict";

const { createHash } = require("node:crypto");
const { types: { isProxy } } = require("node:util");
const {
  MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES,
  memberConversationTurnRequestHash,
  parseMemberConversationTurnRequest,
  parseMemberConversationTurnResponse,
  responseMatchesRequest,
} = require("./member-conversation-turn-contract");
const {
  readMemberConversationOpenAIPromptCachePolicy,
} = require("./member-conversation-openai-prompt-cache-policy");

const MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2";
const MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-2";
const MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_MAXIMUM_BYTES = 4096;
const MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_MAXIMUM_CHARACTERS = 800;
const MEMBER_CONVERSATION_PROVIDER_OUTPUT_V2_MAXIMUM_TOKENS = 4096;
const MEMBER_CONVERSATION_SAFETY_RULE_VERSION = "GC-MEMBER-CONVERSATION-SAFETY-1";
const MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION =
  "GC-MEMBER-CONVERSATION-SAFETY-RULES-1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSIONED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INPUT_KEYS = Object.freeze([
  "attemptId", "controls", "developerPromptSha256", "developerPromptVersion",
  "model", "promptCachePolicy", "regionPolicy", "responseSchemaSha256",
  "responseSchemaVersion", "transportVersion", "turnRequest", "turnResponse",
  "version",
]);
const REQUEST_KEYS = Object.freeze([
  "attemptId", "controls", "developerPromptSha256", "developerPromptVersion",
  "memberTurn", "model", "regionPolicy", "requestSignatureSha256",
  "responseSchemaSha256", "responseSchemaVersion", "safetyRuleVersion",
  "safetySourceRuleVersion", "transportVersion", "version",
]);
const CONTROL_KEYS = Object.freeze([
  "background", "conversation", "maxOutputTokens", "metadata",
  "previousResponseId", "promptCachePolicy", "store", "stream", "tools",
  "truncation",
]);
const POLICY_KEYS = Object.freeze(["breakpointCount", "mode", "version"]);
const brandedRequests = new WeakSet();

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && !isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype);
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

function exactEmptyArray(value) {
  if (!value || typeof value !== "object" || isProxy(value)
    || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== 1 || ownKeys[0] !== "length") return false;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  return Boolean(length && Object.prototype.hasOwnProperty.call(length, "value")
    && length.value === 0 && !Object.prototype.hasOwnProperty.call(length, "get")
    && !Object.prototype.hasOwnProperty.call(length, "set"));
}

function exactIdentifier(value) {
  return typeof value === "string" && VERSIONED_IDENTIFIER.test(value)
    ? value : null;
}

function exactSha256(value) {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function exactUuid(value) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function safeStructuralData(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return true;
  if (isProxy(value) || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) return false;
  seen.add(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return ownKeys.every((key) => {
    const descriptor = descriptors[key];
    const arrayLength = Array.isArray(value) && key === "length";
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && !Object.prototype.hasOwnProperty.call(descriptor, "get")
      && !Object.prototype.hasOwnProperty.call(descriptor, "set")
      && (arrayLength || descriptor.enumerable === true)
      && safeStructuralData(descriptor.value, seen);
  });
}

function parsePolicyCopy(value) {
  if (!exactKeys(value, POLICY_KEYS)
    || value.mode !== "explicit"
    || value.breakpointCount !== 0
    || !exactIdentifier(value.version)) return null;
  return Object.freeze({
    version: value.version,
    mode: "explicit",
    breakpointCount: 0,
  });
}

function parseInputControls(value, promptCachePolicy) {
  if (!exactKeys(value, [
    "background", "conversation", "maxOutputTokens", "metadata",
    "previousResponseId", "store", "stream", "tools", "truncation",
  ])
    || value.background !== false
    || value.conversation !== null
    || !Number.isSafeInteger(value.maxOutputTokens)
    || value.maxOutputTokens < 1
    || value.maxOutputTokens > MEMBER_CONVERSATION_PROVIDER_OUTPUT_V2_MAXIMUM_TOKENS
    || value.metadata !== null
    || value.previousResponseId !== null
    || value.store !== false
    || value.stream !== false
    || !exactEmptyArray(value.tools)
    || value.truncation !== "disabled") return null;
  return Object.freeze({
    background: false,
    conversation: null,
    maxOutputTokens: value.maxOutputTokens,
    metadata: null,
    previousResponseId: null,
    promptCachePolicy,
    store: false,
    stream: false,
    tools: Object.freeze([]),
    truncation: "disabled",
  });
}

function parseNormalizedControls(value) {
  if (!exactKeys(value, CONTROL_KEYS)) return null;
  const policy = parsePolicyCopy(value.promptCachePolicy);
  if (!policy) return null;
  const input = {
    background: value.background,
    conversation: value.conversation,
    maxOutputTokens: value.maxOutputTokens,
    metadata: value.metadata,
    previousResponseId: value.previousResponseId,
    store: value.store,
    stream: value.stream,
    tools: value.tools,
    truncation: value.truncation,
  };
  return parseInputControls(input, policy);
}

function parseMemberTurn(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0
    || [...value].length > MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_MAXIMUM_CHARACTERS
    || Buffer.byteLength(value, "utf8") > MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES) return null;
  return value;
}

function normalizedRequest(value) {
  if (!exactKeys(value, INPUT_KEYS)
    || value.version !== MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION
    || value.transportVersion !== MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION
    || !exactUuid(value.attemptId)
    || !exactSha256(value.developerPromptSha256)
    || !exactSha256(value.responseSchemaSha256)
    || !safeStructuralData(value.turnRequest)
    || !safeStructuralData(value.turnResponse)) return null;
  const promptCachePolicy = readMemberConversationOpenAIPromptCachePolicy(
    value.promptCachePolicy
  );
  if (!promptCachePolicy) return null;
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
  const controls = parseInputControls(value.controls, promptCachePolicy);
  const memberTurn = parseMemberTurn(turnRequest.memberText);
  const model = exactIdentifier(value.model);
  const developerPromptVersion = exactIdentifier(value.developerPromptVersion);
  const responseSchemaVersion = exactIdentifier(value.responseSchemaVersion);
  const regionPolicy = exactIdentifier(value.regionPolicy);
  if (!controls || !memberTurn || !model || !developerPromptVersion
    || !responseSchemaVersion || !regionPolicy) return null;
  const normalized = {
    version: MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION,
    transportVersion: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    attemptId: exactUuid(value.attemptId).toLowerCase(),
    model,
    developerPromptVersion,
    developerPromptSha256: exactSha256(value.developerPromptSha256),
    responseSchemaVersion,
    responseSchemaSha256: exactSha256(value.responseSchemaSha256),
    requestSignatureSha256: memberConversationTurnRequestHash(turnRequest),
    safetyRuleVersion: turnResponse.result.safety.ruleVersion,
    safetySourceRuleVersion: turnResponse.result.safety.sourceRuleVersion,
    memberTurn,
    controls,
    regionPolicy,
  };
  return Buffer.byteLength(JSON.stringify(normalized), "utf8")
    <= MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_MAXIMUM_BYTES ? normalized : null;
}

function validNormalizedRequest(value) {
  return exactKeys(value, REQUEST_KEYS)
    && value.version === MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION
    && value.transportVersion === MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION
    && exactUuid(value.attemptId)
    && exactIdentifier(value.model)
    && exactIdentifier(value.developerPromptVersion)
    && exactSha256(value.developerPromptSha256)
    && exactIdentifier(value.responseSchemaVersion)
    && exactSha256(value.responseSchemaSha256)
    && exactSha256(value.requestSignatureSha256)
    && value.safetyRuleVersion === MEMBER_CONVERSATION_SAFETY_RULE_VERSION
    && value.safetySourceRuleVersion === MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION
    && parseMemberTurn(value.memberTurn)
    && parseNormalizedControls(value.controls)
    && exactIdentifier(value.regionPolicy)
    && Buffer.byteLength(JSON.stringify(value), "utf8")
      <= MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_MAXIMUM_BYTES;
}

function createMemberConversationProviderRequestV2(value = {}) {
  try {
    const normalized = normalizedRequest(value);
    if (!normalized) return null;
    const request = Object.freeze({ ...normalized });
    brandedRequests.add(request);
    return request;
  } catch (_) { return null; }
}

function validMemberConversationProviderRequestV2(value) {
  return Boolean(value && brandedRequests.has(value) && Object.isFrozen(value)
    && validNormalizedRequest(value));
}

function parseMemberConversationProviderRequestV2(value) {
  return validMemberConversationProviderRequestV2(value) ? value : null;
}

function memberConversationProviderRequestV2Digest(value) {
  const request = parseMemberConversationProviderRequestV2(value);
  return request ? createHash("sha256").update(
    JSON.stringify(request), "utf8"
  ).digest("hex") : null;
}

module.exports = {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_V2_MAXIMUM_TOKENS,
  MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_MAXIMUM_BYTES,
  MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_MAXIMUM_CHARACTERS,
  MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
  createMemberConversationProviderRequestV2,
  memberConversationProviderRequestV2Digest,
  parseMemberConversationProviderRequestV2,
  validMemberConversationProviderRequestV2,
};
