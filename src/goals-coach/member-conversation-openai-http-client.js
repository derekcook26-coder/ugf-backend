"use strict";

const { types: { isProxy } } = require("node:util");

const {
  monotonicNow,
  positiveRemainingMilliseconds,
} = require("./bounded-postgres-transaction");
const {
  consumeMemberConversationOpenAICredentialLease,
  memberConversationOpenAICredentialAuthorityMatchesAttempt,
  revokeMemberConversationOpenAICredentialLease,
  subscribeMemberConversationOpenAICredentialAuthority,
  validMemberConversationOpenAICredentialAuthority,
  validMemberConversationOpenAICredentialLease,
} = require("./member-conversation-openai-credential-resolver");

const MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-HTTP-CLIENT-1";
const MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-BOUNDED-HTTP-INTERFACE-1";
const INTERFACE_KEYS = Object.freeze(["request", "version"]);
const CLIENT_KEYS = Object.freeze([
  "finalizationReserveMilliseconds", "http", "origin",
  "requestBodyMaximumBytes", "requestHeaderMaximumBytes",
  "responseBodyMaximumBytes", "responseHeaderMaximumBytes",
  "timeoutMilliseconds", "version",
]);
const REQUEST_KEYS = Object.freeze(["body", "clientRequestId"]);
const OPERATION_KEYS = Object.freeze([
  "authority", "credentialLease", "outerDeadlineNs", "signal",
]);
const V2_OPERATION_KEYS = Object.freeze([
  "authority", "credentialLease", "outerDeadlineNs", "request",
  "resultAuthority", "signal", "wireRequest",
]);
const OUTCOME_KEYS = Object.freeze([
  "body", "complete", "contacted", "decompressedBytes", "headers",
  "kind", "redirected", "statusCode",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;
const clients = new WeakMap();
const interfaces = new WeakMap();
const responses = new WeakMap();
const consumedAuthorities = new WeakSet();
const credentialConsumers = new WeakSet();
const credentialConsumer = Object.freeze(Object.create(null));
credentialConsumers.add(credentialConsumer);

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

function boundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function normalizedOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.search || parsed.hash || parsed.pathname !== "/"
      || (parsed.port && parsed.port !== "443")) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function headerBytes(headers) {
  if (!exactObject(headers)) return null;
  let total = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[a-z0-9-]{1,64}$/.test(name)
      || typeof value !== "string" || /[\r\n]/.test(value)) return null;
    total += byteLength(name) + 2 + byteLength(value) + 2;
  }
  return total;
}

function createMemberConversationOpenAIBoundedHTTPInterface(value = {}) {
  if (!exactKeys(value, INTERFACE_KEYS)
    || value.version !== MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION
    || typeof value.request !== "function") return null;
  const token = Object.freeze({
    externalCallsPermitted: false,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION,
  });
  interfaces.set(token, { request: value.request });
  return token;
}

function validMemberConversationOpenAIBoundedHTTPInterface(value) {
  return Boolean(value && interfaces.has(value) && Object.isFrozen(value)
    && value.version === MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION
    && value.externalCallsPermitted === false && value.runtimeWired === false);
}

function createMemberConversationOpenAIHTTPClient(value = {}) {
  if (!exactKeys(value, CLIENT_KEYS)
    || value.version !== MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION
    || !validMemberConversationOpenAIBoundedHTTPInterface(value.http)) return null;
  const origin = normalizedOrigin(value.origin);
  if (!origin
    || !boundedInteger(value.requestHeaderMaximumBytes, 16384)
    || !boundedInteger(value.requestBodyMaximumBytes, 262144)
    || !boundedInteger(value.responseHeaderMaximumBytes, 32768)
    || !boundedInteger(value.responseBodyMaximumBytes, 262144)
    || !boundedInteger(value.timeoutMilliseconds, 25000)
    || !boundedInteger(value.finalizationReserveMilliseconds, 5000)
    || value.finalizationReserveMilliseconds >= value.timeoutMilliseconds) return null;
  const token = Object.freeze({
    automaticRetries: false,
    externalCallsPermitted: false,
    maximumAttempts: 1,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
  });
  clients.set(token, Object.freeze({
    finalizationReserveMilliseconds: value.finalizationReserveMilliseconds,
    http: value.http,
    origin,
    requestBodyMaximumBytes: value.requestBodyMaximumBytes,
    requestHeaderMaximumBytes: value.requestHeaderMaximumBytes,
    responseBodyMaximumBytes: value.responseBodyMaximumBytes,
    responseHeaderMaximumBytes: value.responseHeaderMaximumBytes,
    timeoutMilliseconds: value.timeoutMilliseconds,
  }));
  return token;
}

function validMemberConversationOpenAIHTTPClient(value) {
  return Boolean(value && clients.has(value) && Object.isFrozen(value)
    && value.version === MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION
    && value.automaticRetries === false && value.maximumAttempts === 1
    && value.externalCallsPermitted === false && value.runtimeWired === false);
}

function validMemberConversationOpenAIHTTPCredentialConsumer(value) {
  return Boolean(value && credentialConsumers.has(value));
}

function validOperation(value) {
  return exactKeys(value, OPERATION_KEYS)
    && typeof value.outerDeadlineNs === "bigint"
    && value.signal instanceof AbortSignal;
}

function publicFailure(classification) {
  return Object.freeze({ classification, response: null });
}

function parsedOutcome(value, state) {
  if (!exactKeys(value, OUTCOME_KEYS) || value.kind !== "response"
    || value.contacted !== true || value.complete !== true
    || value.redirected !== false || !Number.isSafeInteger(value.statusCode)
    || value.statusCode < 100 || value.statusCode > 599
    || !(value.body instanceof Uint8Array)
    || !Number.isSafeInteger(value.decompressedBytes)
    || value.decompressedBytes !== value.body.byteLength
    || value.body.byteLength > state.responseBodyMaximumBytes) return null;
  const bytes = headerBytes(value.headers);
  if (bytes === null || bytes > state.responseHeaderMaximumBytes
    || value.headers["content-type"] !== "application/json") return null;
  return {
    body: Buffer.from(value.body),
    contentType: value.headers["content-type"],
    providerRequestId: typeof value.headers["x-request-id"] === "string"
      ? value.headers["x-request-id"] : null,
    statusCode: value.statusCode,
  };
}

async function executeMemberConversationOpenAIHTTPRequest(
  client, request = {}, operation = {}, beforeContact = null
) {
  const state = client && clients.get(client);
  if (!state || !exactKeys(request, REQUEST_KEYS)
    || !exactObject(request.body) || !UUID.test(request.clientRequestId || "")
    || !validOperation(operation)
    || !validMemberConversationOpenAICredentialAuthority(operation.authority)
    || !memberConversationOpenAICredentialAuthorityMatchesAttempt(
      operation.authority, request.clientRequestId
    )
    || !validMemberConversationOpenAICredentialLease(
      operation.credentialLease, operation.authority
    ) || consumedAuthorities.has(operation.authority)) {
    return publicFailure("not_contacted");
  }
  consumedAuthorities.add(operation.authority);
  let serialized;
  try { serialized = JSON.stringify(request.body); } catch { serialized = null; }
  const shared = positiveRemainingMilliseconds(
    operation.outerDeadlineNs, monotonicNow()
  );
  if (!serialized || byteLength(serialized) > state.requestBodyMaximumBytes
    || aborted(operation.signal) || shared === null
    || shared <= state.finalizationReserveMilliseconds) {
    revokeMemberConversationOpenAICredentialLease(operation.credentialLease);
    return publicFailure("not_contacted");
  }
  const remaining = Math.min(
    shared - state.finalizationReserveMilliseconds,
    state.timeoutMilliseconds - state.finalizationReserveMilliseconds
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  const unsubscribeAuthority = subscribeMemberConversationOpenAICredentialAuthority(
    operation.authority, credentialConsumer, abort
  );
  if (!unsubscribeAuthority) {
    revokeMemberConversationOpenAICredentialLease(operation.credentialLease);
    return publicFailure("not_contacted");
  }
  addAbortListener(operation.signal, abort);
  let timer = setTimeout(abort, remaining);
  if (typeof timer.unref === "function") timer.unref();
  let contacted = false;
  let removeInternalAbort = () => {};
  try {
    const credential = consumeMemberConversationOpenAICredentialLease(
      operation.credentialLease, operation.authority, credentialConsumer
    );
    if (!credential || aborted(operation.signal) || aborted(controller.signal)
      || !validMemberConversationOpenAICredentialAuthority(operation.authority)
      || positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) === null) {
      return publicFailure("not_contacted");
    }
    const headers = Object.freeze({
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "x-client-request-id": request.clientRequestId,
    });
    if (headerBytes(headers) > state.requestHeaderMaximumBytes) {
      return publicFailure("not_contacted");
    }
    const boundary = Object.freeze({
      automaticRetries: false,
      body: serialized,
      headers,
      maximumAttempts: 1,
      method: "POST",
      origin: state.origin,
      path: "/v1/responses",
      redirectLimit: 0,
      signal: controller.signal,
      tlsVerification: true,
    });
    await Promise.resolve();
    const cancelledBeforeContact = Symbol("openai_http_cancelled_before_contact");
    const pending = Promise.resolve()
      .then(() => {
        if (aborted(operation.signal) || aborted(controller.signal)
          || !validMemberConversationOpenAICredentialAuthority(operation.authority)
          || positiveRemainingMilliseconds(
            operation.outerDeadlineNs, monotonicNow()
          ) === null || (beforeContact && beforeContact() !== true)) {
          return cancelledBeforeContact;
        }
        // This transition and invocation share one synchronous callback boundary.
        contacted = true;
        return interfaces.get(state.http).request(boundary);
      })
      .then((outcome) => outcome === cancelledBeforeContact
        ? { notContacted: true } : { outcome }, () => ({ failed: true }));
    const cancelled = new Promise((resolve) => {
      if (aborted(controller.signal)) return resolve({ cancelled: true });
      const listener = () => resolve({ cancelled: true });
      addAbortListener(controller.signal, listener);
      removeInternalAbort = () => removeAbortListener(controller.signal, listener);
    });
    const settled = await Promise.race([pending, cancelled]);
    if (settled.cancelled) {
      pending.then(() => {}, () => {});
      return publicFailure(contacted ? "indeterminate" : "not_contacted");
    }
    if (settled.notContacted) return publicFailure("not_contacted");
    if (settled.failed) return publicFailure("indeterminate");
    const outcome = settled.outcome;
    if (aborted(operation.signal) || aborted(controller.signal)
      || !validMemberConversationOpenAICredentialAuthority(operation.authority)
      || positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) === null) {
      return publicFailure("indeterminate");
    }
    const parsed = parsedOutcome(outcome, state);
    if (!parsed) return publicFailure("indeterminate");
    const token = opaqueToken();
    responses.set(token, parsed);
    return Object.freeze({ classification: "complete", response: token });
  } catch {
    return publicFailure(contacted ? "indeterminate" : "not_contacted");
  } finally {
    clearTimeout(timer);
    timer = null;
    removeAbortListener(operation.signal, abort);
    removeInternalAbort();
    unsubscribeAuthority();
  }
}

function exactDataKeys(value, keys) {
  if (!exactObject(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")
    || ownKeys.slice().sort().join("\0") !== keys.slice().sort().join("\0")) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key] && descriptors[key].enumerable
    && Object.prototype.hasOwnProperty.call(descriptors[key], "value")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "get")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "set"));
}

function executeMemberConversationOpenAIHTTPRequestV2(
  client, request = {}, operation = {}
) {
  if (!exactKeys(operation, V2_OPERATION_KEYS)) return publicFailure("not_contacted");
  const {
    memberConversationOpenAIResponsesWireRequestV2HTTPBinding,
    memberConversationOpenAIResponsesWireRequestV2MatchesRequest,
  } = require("./member-conversation-openai-responses-adapter-v2");
  const {
    markMemberConversationProviderResultAuthorityV2Contacted,
    memberConversationProviderResultAuthorityV2MatchesRequest,
  } = require("./member-conversation-provider-result-v2");
  const binding = memberConversationOpenAIResponsesWireRequestV2HTTPBinding(
    operation.wireRequest, operation.request, operation.signal
  );
  if (!binding || !exactDataKeys(request, REQUEST_KEYS)
    || !memberConversationProviderResultAuthorityV2MatchesRequest(
    operation.resultAuthority, operation.request
  ) || !memberConversationOpenAIResponsesWireRequestV2MatchesRequest(
    operation.wireRequest, operation.request
  ) || request.body !== binding.body
    || request.clientRequestId !== binding.clientRequestId) {
    return publicFailure("not_contacted");
  }
  const credentialOperation = Object.freeze({
    authority: operation.authority,
    credentialLease: operation.credentialLease,
    outerDeadlineNs: operation.outerDeadlineNs,
    signal: operation.signal,
  });
  return executeMemberConversationOpenAIHTTPRequest(
    client,
    binding,
    credentialOperation,
    () => {
      const currentBinding = memberConversationOpenAIResponsesWireRequestV2HTTPBinding(
        operation.wireRequest, operation.request, operation.signal
      );
      return Boolean(currentBinding
        && currentBinding.body === binding.body
        && currentBinding.clientRequestId === binding.clientRequestId
        && memberConversationProviderResultAuthorityV2MatchesRequest(
          operation.resultAuthority, operation.request
        )
        && markMemberConversationProviderResultAuthorityV2Contacted(
          operation.resultAuthority
        ));
    }
  );
}

function readMemberConversationOpenAIHTTPResponse(value) {
  const state = value && responses.get(value);
  if (!state) return null;
  responses.delete(value);
  return Object.freeze({
    body: Buffer.from(state.body),
    contentType: state.contentType,
    providerRequestId: state.providerRequestId,
    statusCode: state.statusCode,
  });
}

function memberConversationOpenAIHTTPClientMatchesOrigin(value, origin) {
  const state = value && clients.get(value);
  const normalized = normalizedOrigin(origin);
  return Boolean(state && normalized && state.origin === normalized);
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION,
  MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
  createMemberConversationOpenAIBoundedHTTPInterface,
  createMemberConversationOpenAIHTTPClient,
  executeMemberConversationOpenAIHTTPRequest,
  executeMemberConversationOpenAIHTTPRequestV2,
  memberConversationOpenAIHTTPClientMatchesOrigin,
  readMemberConversationOpenAIHTTPResponse,
  validMemberConversationOpenAIBoundedHTTPInterface,
  validMemberConversationOpenAIHTTPCredentialConsumer,
  validMemberConversationOpenAIHTTPClient,
};
