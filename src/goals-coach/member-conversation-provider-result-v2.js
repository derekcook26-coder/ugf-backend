"use strict";

const { createHash } = require("node:crypto");
const { types: { isProxy } } = require("node:util");
const {
  monotonicNow,
  positiveRemainingMilliseconds,
  validTerminalState,
} = require("./bounded-postgres-transaction");
const {
  memberConversationProviderRequestV2Digest,
  validMemberConversationProviderRequestV2,
} = require("./member-conversation-provider-request-envelope-v2");

const MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-AUTHORITY-2";
const MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-2";
const MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-REJECTION-2";
const COACHING_MAXIMUM_CHARACTERS = 800;
const COACHING_MAXIMUM_BYTES = 1600;
const PROVIDER_IDENTIFIER = /^[\x21-\x7e]{1,255}$/;
const AUTHORITY_KEYS = Object.freeze(["request", "terminalState", "version"]);
const RESULT_KEYS = Object.freeze([
  "coaching", "providerRequestId", "providerResponseId", "version",
]);
const REJECTION_KEYS = Object.freeze([
  "providerRequestId", "terminalCategory", "version",
]);
const REJECTION_CATEGORIES = new Set([
  "authentication_rejected", "rate_limited", "request_rejected",
]);
const authorities = new WeakMap();
const successes = new WeakMap();
const rejections = new WeakMap();
const ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

function aborted(signal) {
  try { return ABORTED.call(signal); } catch { return true; }
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

function opaqueToken() {
  return Object.freeze(Object.create(null));
}

function activeAuthority(token, requireContacted = false) {
  const state = token && authorities.get(token);
  return state && state.revoked === false && state.consumed === false
    && state.generation > 0 && (!requireContacted || state.contacted === true)
    && state.terminalState.isTerminal() === false ? state : null;
}

function releaseTerminalSubscription(state) {
  if (state.children.size || typeof state.unsubscribeTerminal !== "function") return;
  const unsubscribe = state.unsubscribeTerminal;
  state.unsubscribeTerminal = null;
  unsubscribe();
}

function releaseOperationBinding(state) {
  if (typeof state.releaseOperation !== "function") return;
  const release = state.releaseOperation;
  state.releaseOperation = null;
  release();
}

function deleteChild(state, token, records) {
  records.delete(token);
  state.children.delete(token);
  if (!state.children.size) releaseOperationBinding(state);
  releaseTerminalSubscription(state);
}

function deleteChildren(state) {
  for (const token of state.children) {
    successes.delete(token);
    rejections.delete(token);
  }
  state.children.clear();
  releaseOperationBinding(state);
  releaseTerminalSubscription(state);
}

function revokeState(state) {
  if (!state || state.revoked) return false;
  state.revoked = true;
  state.consumed = true;
  state.generation += 1;
  deleteChildren(state);
  return true;
}

function consumeContactedAuthority(token) {
  const state = activeAuthority(token, true);
  if (!state) return null;
  state.consumed = true;
  return state;
}

function coachingText(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && value === value.normalize("NFC") && !/[\uD800-\uDFFF]/u.test(value)
    && [...value].length <= COACHING_MAXIMUM_CHARACTERS
    && Buffer.byteLength(value, "utf8") <= COACHING_MAXIMUM_BYTES
    && !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value) ? value : null;
}

function providerIdentifier(value) {
  return typeof value === "string" && PROVIDER_IDENTIFIER.test(value) ? value : null;
}

function createMemberConversationProviderResultAuthorityV2(value = {}) {
  try {
    if (!exactKeys(value, AUTHORITY_KEYS)
      || value.version !== MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION
      || !validMemberConversationProviderRequestV2(value.request)
      || !validTerminalState(value.terminalState)
      || value.terminalState.isTerminal()) return null;
    const digest = memberConversationProviderRequestV2Digest(value.request);
    if (!digest) return null;
    const token = opaqueToken();
    const state = {
      attemptId: value.request.attemptId,
      children: new Set(),
      consumed: false,
      contacted: false,
      generation: 1,
      requestDigestSha256: digest,
      releaseOperation: null,
      revoked: false,
      terminalState: value.terminalState,
      unsubscribeTerminal: null,
    };
    authorities.set(token, state);
    state.unsubscribeTerminal = value.terminalState.subscribe(() => revokeState(state));
    return token;
  } catch (_) { return null; }
}

function bindMemberConversationProviderResultAuthorityV2Operation(
  authority, signal, outerDeadlineNs
) {
  const state = activeAuthority(authority);
  if (!state || state.releaseOperation !== null
    || !(signal instanceof AbortSignal) || typeof outerDeadlineNs !== "bigint") {
    return false;
  }
  const remaining = positiveRemainingMilliseconds(outerDeadlineNs, monotonicNow());
  if (aborted(signal) || remaining === null) {
    revokeState(state);
    return false;
  }
  const revoke = () => revokeState(state);
  ADD_EVENT_LISTENER.call(signal, "abort", revoke, { once: true });
  const timer = setTimeout(revoke, remaining);
  if (typeof timer.unref === "function") timer.unref();
  state.releaseOperation = () => {
    clearTimeout(timer);
    try { REMOVE_EVENT_LISTENER.call(signal, "abort", revoke); } catch {}
  };
  if (aborted(signal)
    || positiveRemainingMilliseconds(outerDeadlineNs, monotonicNow()) === null) {
    revokeState(state);
    return false;
  }
  return true;
}

function validMemberConversationProviderResultAuthorityV2(value) {
  return Boolean(activeAuthority(value));
}

function memberConversationProviderResultAuthorityV2MatchesRequest(authority, request) {
  const state = activeAuthority(authority);
  if (!state || !validMemberConversationProviderRequestV2(request)) return false;
  return request.attemptId === state.attemptId
    && memberConversationProviderRequestV2Digest(request) === state.requestDigestSha256;
}

function markMemberConversationProviderResultAuthorityV2Contacted(authority) {
  const state = activeAuthority(authority);
  if (!state || state.contacted) return false;
  state.contacted = true;
  return true;
}

function revokeMemberConversationProviderResultAuthorityV2(authority) {
  return revokeState(authority && authorities.get(authority));
}

function createMemberConversationProviderResultV2(authority, value = {}) {
  const state = consumeContactedAuthority(authority);
  if (!state) return null;
  try {
    if (!exactKeys(value, RESULT_KEYS)
      || value.version !== MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION) {
      revokeState(state); return null;
    }
    const coaching = coachingText(value.coaching);
    const providerRequestId = providerIdentifier(value.providerRequestId);
    const providerResponseId = providerIdentifier(value.providerResponseId);
    if (!coaching || !providerRequestId || !providerResponseId) {
      revokeState(state); return null;
    }
    const token = opaqueToken();
    const canonical = Object.freeze({ coaching });
    successes.set(token, {
      authority: state,
      consumed: false,
      generation: state.generation,
      coaching,
      providerRequestId,
      providerResponseId,
      providerResultDigestSha256: createHash("sha256")
        .update(JSON.stringify(canonical), "utf8").digest("hex"),
    });
    state.children.add(token);
    return token;
  } catch (_) { revokeState(state); return null; }
}

function readMemberConversationProviderResultV2(token, authority) {
  const state = authority && authorities.get(authority);
  const result = token && successes.get(token);
  if (!state || !result || result.consumed || result.authority !== state
    || result.generation !== state.generation || state.revoked
    || state.terminalState.isTerminal()) return null;
  const output = Object.freeze({
    attemptId: state.attemptId,
    coaching: result.coaching,
    providerRequestId: result.providerRequestId,
    providerResponseId: result.providerResponseId,
    providerResultDigestSha256: result.providerResultDigestSha256,
    requestEnvelopeDigestSha256: state.requestDigestSha256,
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION,
  });
  result.consumed = true;
  deleteChild(state, token, successes);
  return output;
}

function createMemberConversationProviderRejectionV2(authority, value = {}) {
  const state = consumeContactedAuthority(authority);
  if (!state) return null;
  try {
    if (!exactKeys(value, REJECTION_KEYS)
      || value.version !== MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION
      || !REJECTION_CATEGORIES.has(value.terminalCategory)) {
      revokeState(state); return null;
    }
    const providerRequestId = providerIdentifier(value.providerRequestId);
    if (!providerRequestId) { revokeState(state); return null; }
    const token = opaqueToken();
    rejections.set(token, {
      authority: state,
      consumed: false,
      generation: state.generation,
      providerRequestId,
      terminalCategory: value.terminalCategory,
    });
    state.children.add(token);
    return token;
  } catch (_) { revokeState(state); return null; }
}

function readMemberConversationProviderRejectionV2(token, authority) {
  const state = authority && authorities.get(authority);
  const rejection = token && rejections.get(token);
  if (!state || !rejection || rejection.consumed || rejection.authority !== state
    || rejection.generation !== state.generation || state.revoked
    || state.terminalState.isTerminal()) return null;
  const output = Object.freeze({
    attemptId: state.attemptId,
    providerRequestId: rejection.providerRequestId,
    requestEnvelopeDigestSha256: state.requestDigestSha256,
    terminalCategory: rejection.terminalCategory,
    version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
  });
  rejection.consumed = true;
  deleteChild(state, token, rejections);
  return output;
}

module.exports = {
  MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION,
  bindMemberConversationProviderResultAuthorityV2Operation,
  createMemberConversationProviderRejectionV2,
  createMemberConversationProviderResultAuthorityV2,
  createMemberConversationProviderResultV2,
  markMemberConversationProviderResultAuthorityV2Contacted,
  memberConversationProviderResultAuthorityV2MatchesRequest,
  readMemberConversationProviderRejectionV2,
  readMemberConversationProviderResultV2,
  revokeMemberConversationProviderResultAuthorityV2,
  validMemberConversationProviderResultAuthorityV2,
};
