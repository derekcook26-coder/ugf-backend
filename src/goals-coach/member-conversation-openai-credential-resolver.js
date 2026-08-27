"use strict";

const {
  monotonicNow,
  positiveRemainingMilliseconds,
  validTerminalState,
} = require("./bounded-postgres-transaction");

const MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-RESOLVER-1";
const MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-AUTHORITY-1";
const RESOLVER_KEYS = Object.freeze(["resolve", "version"]);
const AUTHORITY_KEYS = Object.freeze(["attemptId", "terminalState", "version"]);
const RESOLUTION_KEYS = Object.freeze(["authority", "outerDeadlineNs", "signal"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREDENTIAL = /^[\x21-\x7e]{1,512}$/;
const ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;
const resolvers = new WeakMap();
const authorities = new WeakMap();
const leases = new WeakMap();

function aborted(signal) {
  try { return ABORTED.call(signal); } catch { return true; }
}

function addAbortListener(signal, listener) {
  ADD_EVENT_LISTENER.call(signal, "abort", listener, { once: true });
}

function removeAbortListener(signal, listener) {
  try { REMOVE_EVENT_LISTENER.call(signal, "abort", listener); } catch {}
}

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
  return state && !state.revoked && state.generation > 0
    && !state.terminalState.isTerminal() ? state : null;
}

function revokeLeaseState(state) {
  if (!state || state.revoked) return false;
  state.revoked = true;
  state.credential = null;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.unsubscribe();
  state.unsubscribe = () => {};
  removeAbortListener(state.signal, state.abort);
  state.authority.leases.delete(state);
  return true;
}

function createMemberConversationOpenAICredentialResolver(value = {}) {
  if (!exactKeys(value, RESOLVER_KEYS)
    || value.version !== MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION
    || typeof value.resolve !== "function") return null;
  const resolver = Object.freeze({
    externalCallsPermitted: false,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
  });
  resolvers.set(resolver, { resolve: value.resolve });
  return resolver;
}

function validMemberConversationOpenAICredentialResolver(value) {
  return Boolean(value && resolvers.has(value) && Object.isFrozen(value)
    && value.version === MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION
    && value.externalCallsPermitted === false && value.runtimeWired === false);
}

function createMemberConversationOpenAICredentialAuthority(value = {}) {
  if (!exactKeys(value, AUTHORITY_KEYS)
    || value.version !== MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION
    || !UUID.test(value.attemptId || "")
    || !validTerminalState(value.terminalState)
    || value.terminalState.isTerminal()) return null;
  const authority = opaqueToken();
  authorities.set(authority, {
    attemptId: value.attemptId,
    consumers: new Set(),
    consumed: false,
    generation: 1,
    leases: new Set(),
    resolutions: new Set(),
    revoked: false,
    terminalState: value.terminalState,
  });
  return authority;
}

function validMemberConversationOpenAICredentialAuthority(value) {
  return Boolean(activeAuthority(value));
}

function memberConversationOpenAICredentialAuthorityMatchesAttempt(
  value, attemptId
) {
  const state = activeAuthority(value);
  return Boolean(state && state.attemptId === attemptId);
}

function revokeMemberConversationOpenAICredentialAuthority(value) {
  const state = value && authorities.get(value);
  if (!state || state.revoked) return false;
  state.revoked = true;
  state.generation += 1;
  for (const abort of Array.from(state.consumers)) abort();
  state.consumers.clear();
  for (const controller of Array.from(state.resolutions)) controller.abort();
  state.resolutions.clear();
  for (const lease of Array.from(state.leases)) revokeLeaseState(lease);
  return true;
}

function validResolution(value) {
  return exactKeys(value, RESOLUTION_KEYS)
    && typeof value.outerDeadlineNs === "bigint"
    && value.signal instanceof AbortSignal;
}

async function resolveMemberConversationOpenAICredential(resolver, value = {}) {
  const resolverState = resolver && resolvers.get(resolver);
  const authority = validResolution(value) && activeAuthority(value.authority);
  if (!resolverState || !authority || authority.consumed) return null;

  // Consumed synchronously before any resolver, timer, or promise boundary.
  authority.consumed = true;
  if (aborted(value.signal)
    || positiveRemainingMilliseconds(value.outerDeadlineNs, monotonicNow()) === null) {
    return null;
  }

  const generation = authority.generation;
  const controller = new AbortController();
  authority.resolutions.add(controller);
  const abort = () => controller.abort();
  let unsubscribe = authority.terminalState.subscribe(abort);
  addAbortListener(value.signal, abort);
  if (aborted(value.signal) || authority.terminalState.isTerminal()) abort();

  let timer;
  const remaining = positiveRemainingMilliseconds(value.outerDeadlineNs, monotonicNow());
  if (remaining === null) abort();
  else {
    timer = setTimeout(abort, remaining);
    if (typeof timer.unref === "function") timer.unref();
  }

  let internalAbortListener = () => {};
  const cancelledBeforeResolver = Symbol("credential_resolution_cancelled");
  try {
    const resolved = await Promise.race([
      Promise.resolve().then(() => {
        const current = activeAuthority(value.authority);
        if (aborted(controller.signal) || !current || current !== authority
          || current.generation !== generation
          || positiveRemainingMilliseconds(
            value.outerDeadlineNs, monotonicNow()
          ) === null) return cancelledBeforeResolver;
        return resolverState.resolve(Object.freeze({
          outerDeadlineNs: value.outerDeadlineNs,
          signal: controller.signal,
        }));
      }).then(
        (credential) => ({ credential }),
        () => ({ failed: true })
      ),
      new Promise((resolve) => {
        if (aborted(controller.signal)) return resolve({ aborted: true });
        internalAbortListener = () => resolve({ aborted: true });
        addAbortListener(controller.signal, internalAbortListener);
      }),
    ]);
    const current = activeAuthority(value.authority);
    if (resolved.failed || resolved.aborted
      || resolved.credential === cancelledBeforeResolver
      || !current || current !== authority
      || current.generation !== generation || aborted(value.signal)
      || positiveRemainingMilliseconds(value.outerDeadlineNs, monotonicNow()) === null
      || typeof resolved.credential !== "string"
      || !CREDENTIAL.test(resolved.credential)) return null;
    const lease = opaqueToken();
    const leaseState = {
      authority,
      abort: () => revokeLeaseState(leaseState),
      credential: resolved.credential,
      generation,
      outerDeadlineNs: value.outerDeadlineNs,
      revoked: false,
      signal: value.signal,
      timer: null,
      unsubscribe: () => {},
    };
    leases.set(lease, leaseState);
    authority.leases.add(leaseState);
    leaseState.unsubscribe = authority.terminalState.subscribe(leaseState.abort);
    addAbortListener(value.signal, leaseState.abort);
    const leaseRemaining = positiveRemainingMilliseconds(
      value.outerDeadlineNs, monotonicNow()
    );
    if (leaseRemaining === null || aborted(value.signal)
      || authority.terminalState.isTerminal()) revokeLeaseState(leaseState);
    else {
      leaseState.timer = setTimeout(leaseState.abort, leaseRemaining);
      if (typeof leaseState.timer.unref === "function") leaseState.timer.unref();
    }
    if (leaseState.revoked) return null;
    return lease;
  } finally {
    authority.resolutions.delete(controller);
    if (timer) clearTimeout(timer);
    unsubscribe();
    unsubscribe = () => {};
    removeAbortListener(value.signal, abort);
    removeAbortListener(controller.signal, internalAbortListener);
  }
}

function validMemberConversationOpenAICredentialLease(lease, authorityToken) {
  const authority = activeAuthority(authorityToken);
  const state = lease && leases.get(lease);
  if (!authority || !state || state.revoked || state.authority !== authority
    || state.generation !== authority.generation) return false;
  if (aborted(state.signal)
    || positiveRemainingMilliseconds(state.outerDeadlineNs, monotonicNow()) === null) {
    revokeLeaseState(state);
    return false;
  }
  return true;
}

function revokeMemberConversationOpenAICredentialLease(value) {
  const state = value && leases.get(value);
  return revokeLeaseState(state);
}

function consumeMemberConversationOpenAICredentialLease(
  lease, authorityToken, consumer
) {
  const { validMemberConversationOpenAIHTTPCredentialConsumer } = require(
    "./member-conversation-openai-http-client"
  );
  if (!validMemberConversationOpenAIHTTPCredentialConsumer(consumer)
    || !validMemberConversationOpenAICredentialLease(lease, authorityToken)) {
    return null;
  }
  const state = leases.get(lease);
  const credential = state.credential;
  revokeLeaseState(state);
  return credential;
}

function subscribeMemberConversationOpenAICredentialAuthority(
  authorityToken, consumer, abort
) {
  const { validMemberConversationOpenAIHTTPCredentialConsumer } = require(
    "./member-conversation-openai-http-client"
  );
  const state = activeAuthority(authorityToken);
  if (!state || !validMemberConversationOpenAIHTTPCredentialConsumer(consumer)
    || typeof abort !== "function") return null;
  state.consumers.add(abort);
  const unsubscribeTerminal = state.terminalState.subscribe(abort);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    state.consumers.delete(abort);
    unsubscribeTerminal();
  };
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
  createMemberConversationOpenAICredentialAuthority,
  createMemberConversationOpenAICredentialResolver,
  consumeMemberConversationOpenAICredentialLease,
  memberConversationOpenAICredentialAuthorityMatchesAttempt,
  resolveMemberConversationOpenAICredential,
  revokeMemberConversationOpenAICredentialAuthority,
  revokeMemberConversationOpenAICredentialLease,
  subscribeMemberConversationOpenAICredentialAuthority,
  validMemberConversationOpenAICredentialAuthority,
  validMemberConversationOpenAICredentialLease,
  validMemberConversationOpenAICredentialResolver,
};
