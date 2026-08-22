"use strict";

const { createHash } = require("node:crypto");
const MEMBER_CONVERSATION_TURN_CONTRACT_VERSION = "GC-MEMBER-CONVERSATION-TURN-1";
const MEMBER_CONVERSATION_SAFETY_RULE_VERSION = "GC-MEMBER-CONVERSATION-SAFETY-1";
const MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION = "GC-MEMBER-CONVERSATION-SAFETY-RULES-1";
const MEMBER_CONVERSATION_TURN_MAXIMUM_BYTES = 2048;
const MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES = 800;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_REQUEST_KEYS = Object.freeze(["contractVersion", "requestId", "idempotencyKey", "conversation", "memberText"]);
const CONVERSATION_KEYS = Object.freeze(["reference", "version", "provenance"]);
const ROOT_RESPONSE_KEYS = Object.freeze(["contractVersion", "requestId", "idempotencyKey", "conversation", "result"]);
const RESULT_KEYS = Object.freeze(["state", "reason", "safety"]);
const SAFETY_KEYS = Object.freeze(["ruleVersion", "sourceRuleVersion", "requestHash", "classification", "action"]);
const SHA256 = /^[0-9a-f]{64}$/;

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return exactObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function invalidContract() {
  const error = new Error("Invalid member conversation turn contract");
  error.code = "MEMBER_CONVERSATION_TURN_CONTRACT_INVALID";
  return error;
}

function parseConversation(value) {
  if (!exactKeys(value, CONVERSATION_KEYS)
    || !UUID.test(value.reference)
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.version > 1000000
    || value.provenance !== "member_session") throw invalidContract();
  return Object.freeze({ reference: value.reference, version: value.version, provenance: value.provenance });
}

function parseMemberConversationTurnRequest(value) {
  if (!exactKeys(value, ROOT_REQUEST_KEYS)
    || value.contractVersion !== MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    || !UUID.test(value.requestId) || !UUID.test(value.idempotencyKey)
    || value.requestId !== value.idempotencyKey
    || typeof value.memberText !== "string" || value.memberText !== value.memberText.trim()
    || value.memberText.length === 0
    || Buffer.byteLength(value.memberText, "utf8") > MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES) {
    throw invalidContract();
  }
  const parsed = Object.freeze({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    requestId: value.requestId,
    idempotencyKey: value.idempotencyKey,
    conversation: parseConversation(value.conversation),
    memberText: value.memberText,
  });
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MEMBER_CONVERSATION_TURN_MAXIMUM_BYTES) throw invalidContract();
  return parsed;
}

function memberConversationTurnRequestHash(request) {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function parseSafety(value) {
  if (!exactKeys(value, SAFETY_KEYS)
    || value.ruleVersion !== MEMBER_CONVERSATION_SAFETY_RULE_VERSION
    || value.sourceRuleVersion !== MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION
    || !SHA256.test(value.requestHash)) throw invalidContract();
  const pairs = new Set([
    "unavailable:unavailable",
    "pain_or_instability:stop",
    "concerning_symptoms:stop",
    "clear:allow_provider_processing",
  ]);
  if (!pairs.has(`${value.classification}:${value.action}`)) throw invalidContract();
  return Object.freeze({
    ruleVersion: value.ruleVersion,
    sourceRuleVersion: value.sourceRuleVersion,
    requestHash: value.requestHash,
    classification: value.classification,
    action: value.action,
  });
}

function parseResult(value) {
  if (!exactKeys(value, RESULT_KEYS)) throw invalidContract();
  const safety = parseSafety(value.safety);
  const valid = (value.state === "unavailable" && value.reason === "provider_unavailable"
      && safety.classification === "unavailable" && safety.action === "unavailable")
    || (value.state === "blocked" && value.reason === "safety_stop"
      && ["pain_or_instability", "concerning_symptoms"].includes(safety.classification) && safety.action === "stop")
    || (value.state === "safe_to_process" && value.reason === null
      && safety.classification === "clear" && safety.action === "allow_provider_processing");
  if (!valid) throw invalidContract();
  return Object.freeze({ state: value.state, reason: value.reason, safety });
}

function parseMemberConversationTurnResponse(value) {
  if (!exactKeys(value, ROOT_RESPONSE_KEYS)
    || value.contractVersion !== MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    || !UUID.test(value.requestId) || value.requestId !== value.idempotencyKey) throw invalidContract();
  const parsed = Object.freeze({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    requestId: value.requestId,
    idempotencyKey: value.idempotencyKey,
    conversation: parseConversation(value.conversation),
    result: parseResult(value.result),
  });
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MEMBER_CONVERSATION_TURN_MAXIMUM_BYTES) throw invalidContract();
  return parsed;
}

function responseMatchesRequest(request, response) {
  return response.requestId === request.requestId
    && response.idempotencyKey === request.idempotencyKey
    && response.conversation.reference === request.conversation.reference
    && response.conversation.version === request.conversation.version
    && response.conversation.provenance === request.conversation.provenance
    && response.result.safety.requestHash === memberConversationTurnRequestHash(request);
}

function createMemberConversationTurnResponse(request, safety) {
  const requestHash = memberConversationTurnRequestHash(request);
  const state = safety.classification === "clear" ? "safe_to_process"
    : safety.classification === "unavailable" ? "unavailable" : "blocked";
  const reason = state === "safe_to_process" ? null
    : state === "blocked" ? "safety_stop" : "provider_unavailable";
  return parseMemberConversationTurnResponse({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    conversation: request.conversation,
    result: { state, reason, safety: { ...safety, requestHash } },
  });
}

module.exports = {
  MEMBER_CONVERSATION_SAFETY_RULE_VERSION,
  MEMBER_CONVERSATION_SAFETY_SOURCE_RULE_VERSION,
  MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES,
  MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
  MEMBER_CONVERSATION_TURN_MAXIMUM_BYTES,
  createMemberConversationTurnResponse,
  memberConversationTurnRequestHash,
  parseMemberConversationTurnRequest,
  parseMemberConversationTurnResponse,
  responseMatchesRequest,
};
