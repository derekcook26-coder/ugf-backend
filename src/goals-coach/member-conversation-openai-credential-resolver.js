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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREDENTIAL = /^[\x21-\x7e]{1,512}$/;
const resolvers = new WeakMap();
const authorities = new WeakMap();
const leases = new WeakMap();

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
  state.signal.removeEventListener("abort", state.abort);
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
    consumed: false,
    generation: 1,
    leases: new Set(),
    revoked: false,
    terminalState: value.terminalState,
  });
  return authority;
}

function validMemberConversationOpenAICredentialAuthority(value) {
  return Boolean(activeAuthority(value));
}

function revokeMemberConversationOpenAICredentialAuthority(value) {
  const state = value && authorities.get(value);
  if (!state || state.revoked) return false;
  state.revoked = true;
  state.generation += 1;
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
  if (value.signal.aborted
    || positiveRemainingMilliseconds(value.outerDeadlineNs, monotonicNow()) === null) {
    return null;
  }

  const generation = authority.generation;
  const controller = new AbortController();
  const abort = () => controller.abort();
  let unsubscribe = authority.terminalState.subscribe(abort);
  value.signal.addEventListener("abort", abort, { once: true });
  if (value.signal.aborted || authority.terminalState.isTerminal()) abort();

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
        if (controller.signal.aborted || !current || current !== authority
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
        if (controller.signal.aborted) return resolve({ aborted: true });
        internalAbortListener = () => resolve({ aborted: true });
        controller.signal.addEventListener("abort", internalAbortListener, {
          once: true,
        });
      }),
    ]);
    const current = activeAuthority(value.authority);
    if (resolved.failed || resolved.aborted
      || resolved.credential === cancelledBeforeResolver
      || !current || current !== authority
      || current.generation !== generation || value.signal.aborted
      || positiveRemainingMilliseconds(value.outerDeadlineNs, monotonicNow()) === null
      || !CREDENTIAL.test(resolved.credential || "")) return null;
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
    value.signal.addEventListener("abort", leaseState.abort, { once: true });
    const leaseRemaining = positiveRemainingMilliseconds(
      value.outerDeadlineNs, monotonicNow()
    );
    if (leaseRemaining === null || value.signal.aborted
      || authority.terminalState.isTerminal()) revokeLeaseState(leaseState);
    else {
      leaseState.timer = setTimeout(leaseState.abort, leaseRemaining);
      if (typeof leaseState.timer.unref === "function") leaseState.timer.unref();
    }
    if (leaseState.revoked) return null;
    return lease;
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
    unsubscribe = () => {};
    value.signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", internalAbortListener);
  }
}

function validMemberConversationOpenAICredentialLease(lease, authorityToken) {
  const authority = activeAuthority(authorityToken);
  const state = lease && leases.get(lease);
  if (!authority || !state || state.revoked || state.authority !== authority
    || state.generation !== authority.generation) return false;
  if (state.signal.aborted
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

module.exports = {
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
  createMemberConversationOpenAICredentialAuthority,
  createMemberConversationOpenAICredentialResolver,
  resolveMemberConversationOpenAICredential,
  revokeMemberConversationOpenAICredentialAuthority,
  revokeMemberConversationOpenAICredentialLease,
  validMemberConversationOpenAICredentialAuthority,
  validMemberConversationOpenAICredentialLease,
  validMemberConversationOpenAICredentialResolver,
};
