"use strict";

const { createHash } = require("node:crypto");
const {
  MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES,
  memberConversationTurnRequestHash,
  parseMemberConversationTurnRequest,
  parseMemberConversationTurnResponse,
  responseMatchesRequest,
} = require("./member-conversation-turn-contract");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
} = require("./member-conversation-provider-transport");

const MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-1";
const MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_BYTES = 4096;
const MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_CHARACTERS = 800;
const MEMBER_CONVERSATION_PROVIDER_OUTPUT_MAXIMUM_TOKENS = 4096;
const MEMBER_CONVERSATION_SAFETY_RULE_VERSION = "GC-MEMBER-CONVERSATION-SAFETY-1";
const MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION =
  "GC-MEMBER-CONVERSATION-SAFETY-RULES-1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSIONED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INPUT_KEYS = Object.freeze([
  "attemptId",
  "controls",
  "developerPromptSha256",
  "developerPromptVersion",
  "model",
  "regionPolicy",
  "responseSchemaSha256",
  "responseSchemaVersion",
  "transportVersion",
  "turnRequest",
  "turnResponse",
  "version",
]);
const REQUEST_KEYS = Object.freeze([
  "attemptId", "controls", "developerPromptSha256", "developerPromptVersion",
  "memberTurn", "model", "regionPolicy", "requestSignatureSha256",
  "responseSchemaSha256", "responseSchemaVersion", "safetyRuleVersion",
  "safetySourceRuleVersion", "transportVersion", "version",
]);
const CONTROL_KEYS = Object.freeze([
  "background",
  "conversation",
  "maxOutputTokens",
  "metadata",
  "previousResponseId",
  "store",
  "stream",
  "tools",
  "truncation",
]);
const brandedRequests = new WeakSet();

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return exactObject(value)
    && Object.keys(value).sort().join("\0") === keys.join("\0");
}

function exactIdentifier(value) {
  return typeof value === "string" && VERSIONED_IDENTIFIER.test(value)
    ? value : null;
}

function parseControls(value) {
  if (!exactKeys(value, CONTROL_KEYS)
    || value.background !== false
    || value.conversation !== null
    || !Number.isSafeInteger(value.maxOutputTokens)
    || value.maxOutputTokens < 1
    || value.maxOutputTokens > MEMBER_CONVERSATION_PROVIDER_OUTPUT_MAXIMUM_TOKENS
    || value.metadata !== null
    || value.previousResponseId !== null
    || value.store !== false
    || value.stream !== false
    || !Array.isArray(value.tools) || value.tools.length !== 0
    || value.truncation !== "disabled") return null;
  return Object.freeze({
    background: false,
    conversation: null,
    maxOutputTokens: value.maxOutputTokens,
    metadata: null,
    previousResponseId: null,
    store: false,
    stream: false,
    tools: Object.freeze([]),
    truncation: "disabled",
  });
}

function parseMemberTurn(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0
    || [...value].length > MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_CHARACTERS
    || Buffer.byteLength(value, "utf8") > MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES) return null;
  return value;
}

function normalizedRequest(value) {
  if (!exactKeys(value, INPUT_KEYS)
    || value.version !== MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION
    || value.transportVersion !== MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION
    || !UUID.test(value.attemptId || "")
    || !SHA256.test(value.developerPromptSha256 || "")
    || !SHA256.test(value.responseSchemaSha256 || "")) {
    return null;
  }
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
  const controls = parseControls(value.controls);
  const memberTurn = parseMemberTurn(turnRequest.memberText);
  const model = exactIdentifier(value.model);
  const developerPromptVersion = exactIdentifier(value.developerPromptVersion);
  const responseSchemaVersion = exactIdentifier(value.responseSchemaVersion);
  const regionPolicy = exactIdentifier(value.regionPolicy);
  if (!controls || !memberTurn || !model || !developerPromptVersion
    || !responseSchemaVersion || !regionPolicy) return null;
  const normalized = {
    version: MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
    transportVersion: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
    attemptId: value.attemptId.toLowerCase(),
    model,
    developerPromptVersion,
    developerPromptSha256: value.developerPromptSha256,
    responseSchemaVersion,
    responseSchemaSha256: value.responseSchemaSha256,
    requestSignatureSha256: memberConversationTurnRequestHash(turnRequest),
    safetyRuleVersion: turnResponse.result.safety.ruleVersion,
    safetySourceRuleVersion: turnResponse.result.safety.sourceRuleVersion,
    memberTurn,
    controls,
    regionPolicy,
  };
  return Buffer.byteLength(JSON.stringify(normalized), "utf8")
    <= MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_BYTES ? normalized : null;
}

function validNormalizedRequest(value) {
  return exactKeys(value, REQUEST_KEYS)
    && value.version === MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION
    && value.transportVersion === MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION
    && UUID.test(value.attemptId || "")
    && exactIdentifier(value.model)
    && exactIdentifier(value.developerPromptVersion)
    && SHA256.test(value.developerPromptSha256 || "")
    && exactIdentifier(value.responseSchemaVersion)
    && SHA256.test(value.responseSchemaSha256 || "")
    && SHA256.test(value.requestSignatureSha256 || "")
    && value.safetyRuleVersion === MEMBER_CONVERSATION_SAFETY_RULE_VERSION
    && value.safetySourceRuleVersion === MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION
    && parseMemberTurn(value.memberTurn)
    && parseControls(value.controls)
    && exactIdentifier(value.regionPolicy)
    && Buffer.byteLength(JSON.stringify(value), "utf8")
      <= MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_BYTES;
}

function memberConversationProviderRequestDigest(value) {
  if (!validMemberConversationProviderRequest(value)) return null;
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function createMemberConversationProviderRequest(value = {}) {
  const normalized = normalizedRequest(value);
  if (!normalized) return null;
  const request = Object.freeze({ ...normalized });
  brandedRequests.add(request);
  return request;
}

function validMemberConversationProviderRequest(value) {
  return Boolean(value && brandedRequests.has(value) && Object.isFrozen(value)
    && validNormalizedRequest(value));
}

module.exports = {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_MAXIMUM_TOKENS,
  MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_BYTES,
  MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_CHARACTERS,
  MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
  createMemberConversationProviderRequest,
  memberConversationProviderRequestDigest,
  validMemberConversationProviderRequest,
};
