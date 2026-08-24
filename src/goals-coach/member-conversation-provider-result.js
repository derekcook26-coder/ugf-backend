"use strict";

const { createHash } = require("node:crypto");
const { validTerminalState } = require("./bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
  parseMemberConversationTurnRequest,
  parseMemberConversationTurnResponse,
  responseMatchesRequest,
} = require("./member-conversation-turn-contract");
const {
  memberConversationProviderRequestDigest,
  validMemberConversationProviderRequest,
} = require("./member-conversation-provider-request-envelope");

const MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-1";
const MEMBER_CONVERSATION_TURN_RESPONSE_VERSION =
  "GC-MEMBER-CONVERSATION-TURN-RESPONSE-2";
const MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS = 800;
const MEMBER_CONVERSATION_COACHING_MAXIMUM_BYTES = 1600;
const MEMBER_CONVERSATION_RESPONSE_MAXIMUM_BYTES = 4096;
const PROVIDER_IDENTIFIER = /^[\x21-\x7e]{1,255}$/;
const RESPONSE_KEYS = Object.freeze([
  "coaching", "contractVersion", "conversation", "idempotencyKey",
  "requestContractVersion", "requestId", "result",
]);
const RESULT_INPUT_KEYS = Object.freeze([
  "authority", "coaching", "providerRequestId", "providerResponseId", "version",
]);
const AUTHORITY_INPUT_KEYS = Object.freeze(["request", "terminalState"]);
const authorities = new WeakMap();
const results = new WeakMap();

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return exactObject(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function opaqueToken() {
  return Object.freeze(Object.create(null));
}

function activeAuthority(token) {
  const state = token && authorities.get(token);
  return state && state.revoked === false && state.generation > 0
    && state.terminalState.isTerminal() === false ? state : null;
}

function coachingText(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value !== value.normalize("NFC")
    || /[\uD800-\uDFFF]/u.test(value)
    || [...value].length > MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS
    || Buffer.byteLength(value, "utf8") > MEMBER_CONVERSATION_COACHING_MAXIMUM_BYTES
    || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function invalidResponse() {
  const error = new Error("Invalid member conversation provider response");
  error.code = "MEMBER_CONVERSATION_PROVIDER_RESPONSE_INVALID";
  return error;
}

function parseMemberConversationTurnResponseV2(value) {
  if (!exactKeys(value, RESPONSE_KEYS)
    || value.contractVersion !== MEMBER_CONVERSATION_TURN_RESPONSE_VERSION
    || value.requestContractVersion !== MEMBER_CONVERSATION_TURN_CONTRACT_VERSION) {
    throw invalidResponse();
  }
  let base;
  try {
    base = parseMemberConversationTurnResponse({
      contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
      requestId: value.requestId,
      idempotencyKey: value.idempotencyKey,
      conversation: value.conversation,
      result: value.result,
    });
  } catch (_) { throw invalidResponse(); }
  const coaching = base.result.state === "safe_to_process"
    ? coachingText(value.coaching) : value.coaching === null ? null : undefined;
  if (coaching === null && base.result.state === "safe_to_process") throw invalidResponse();
  if (coaching === undefined) throw invalidResponse();
  const parsed = Object.freeze({
    contractVersion: MEMBER_CONVERSATION_TURN_RESPONSE_VERSION,
    requestContractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    requestId: base.requestId,
    idempotencyKey: base.idempotencyKey,
    conversation: base.conversation,
    result: base.result,
    coaching,
  });
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8")
    > MEMBER_CONVERSATION_RESPONSE_MAXIMUM_BYTES) throw invalidResponse();
  return parsed;
}

function createMemberConversationTurnResponseV2(requestValue, responseValue, coaching) {
  let request;
  let response;
  try {
    request = parseMemberConversationTurnRequest(requestValue);
    response = parseMemberConversationTurnResponse(responseValue);
  } catch (_) { return null; }
  if (!responseMatchesRequest(request, response)) return null;
  try {
    return parseMemberConversationTurnResponseV2({
      contractVersion: MEMBER_CONVERSATION_TURN_RESPONSE_VERSION,
      requestContractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      conversation: request.conversation,
      result: response.result,
      coaching,
    });
  } catch (_) { return null; }
}

function memberConversationTurnResponseV2Digest(value) {
  let parsed;
  try { parsed = parseMemberConversationTurnResponseV2(value); }
  catch (_) { return null; }
  return createHash("sha256").update(JSON.stringify(parsed), "utf8").digest("hex");
}

function createMemberConversationProviderResultAuthority(value = {}) {
  if (!exactKeys(value, AUTHORITY_INPUT_KEYS)
    || !validMemberConversationProviderRequest(value.request)
    || !validTerminalState(value.terminalState)
    || value.terminalState.isTerminal()) return null;
  const requestEnvelopeDigestSha256 = memberConversationProviderRequestDigest(value.request);
  if (!requestEnvelopeDigestSha256) return null;
  const token = opaqueToken();
  authorities.set(token, {
    attemptId: value.request.attemptId,
    generation: 1,
    requestEnvelopeDigestSha256,
    revoked: false,
    terminalState: value.terminalState,
  });
  return token;
}

function validMemberConversationProviderResultAuthority(value) {
  return Boolean(activeAuthority(value));
}

function revokeMemberConversationProviderResultAuthority(value) {
  const state = value && authorities.get(value);
  if (!state || state.revoked) return false;
  state.revoked = true;
  state.generation += 1;
  return true;
}

function createMemberConversationProviderResult(value = {}) {
  if (!exactKeys(value, RESULT_INPUT_KEYS)
    || value.version !== MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION
    || !PROVIDER_IDENTIFIER.test(value.providerRequestId || "")
    || !PROVIDER_IDENTIFIER.test(value.providerResponseId || "")) return null;
  const authority = activeAuthority(value.authority);
  const coaching = coachingText(value.coaching);
  if (!authority || !coaching) return null;
  const token = opaqueToken();
  const canonicalProviderResult = Object.freeze({ coaching });
  results.set(token, {
    authority,
    canonicalProviderResult,
    generation: authority.generation,
    providerRequestId: value.providerRequestId,
    providerResponseId: value.providerResponseId,
    providerResultDigestSha256: createHash("sha256")
      .update(JSON.stringify(canonicalProviderResult), "utf8").digest("hex"),
  });
  return token;
}

function readMemberConversationProviderResult(resultToken, authorityToken) {
  const authority = activeAuthority(authorityToken);
  const result = resultToken && results.get(resultToken);
  if (!authority || !result || result.authority !== authority
    || result.generation !== authority.generation) return null;
  return Object.freeze({
    attemptId: authority.attemptId,
    coaching: result.canonicalProviderResult.coaching,
    providerRequestId: result.providerRequestId,
    providerResponseId: result.providerResponseId,
    providerResultDigestSha256: result.providerResultDigestSha256,
    requestEnvelopeDigestSha256: authority.requestEnvelopeDigestSha256,
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
  });
}

function validMemberConversationProviderResult(resultToken, authorityToken) {
  return Boolean(readMemberConversationProviderResult(resultToken, authorityToken));
}

module.exports = {
  MEMBER_CONVERSATION_COACHING_MAXIMUM_BYTES,
  MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS,
  MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
  MEMBER_CONVERSATION_RESPONSE_MAXIMUM_BYTES,
  MEMBER_CONVERSATION_TURN_RESPONSE_VERSION,
  createMemberConversationProviderResult,
  createMemberConversationProviderResultAuthority,
  createMemberConversationTurnResponseV2,
  memberConversationTurnResponseV2Digest,
  parseMemberConversationTurnResponseV2,
  readMemberConversationProviderResult,
  revokeMemberConversationProviderResultAuthority,
  validMemberConversationProviderResult,
  validMemberConversationProviderResultAuthority,
};
