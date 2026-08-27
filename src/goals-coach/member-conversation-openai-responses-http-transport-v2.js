"use strict";

const { types: { isProxy } } = require("node:util");
const { monotonicNow, positiveRemainingMilliseconds, validTerminalState } = require("./bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
  createMemberConversationOpenAICredentialAuthority,
  resolveMemberConversationOpenAICredential,
  revokeMemberConversationOpenAICredentialAuthority,
  validMemberConversationOpenAICredentialResolver,
} = require("./member-conversation-openai-credential-resolver");
const {
  executeMemberConversationOpenAIHTTPRequestV2,
  memberConversationOpenAIHTTPClientMatchesOrigin,
  readMemberConversationOpenAIHTTPResponse,
  validMemberConversationOpenAIHTTPClient,
} = require("./member-conversation-openai-http-client");
const {
  createMemberConversationOpenAIResponsesWireRequestV2,
  validMemberConversationOpenAIResponsesAdapterV2,
} = require("./member-conversation-openai-responses-adapter-v2");
const { validMemberConversationOpenAIResponsesTransportV2 } = require("./member-conversation-openai-responses-transport-v2");
const {
  memberConversationProviderRequestV2Digest,
  validMemberConversationProviderRequestV2,
} = require("./member-conversation-provider-request-envelope-v2");
const { validMemberConversationProviderTransportV2 } = require("./member-conversation-provider-transport-v2");
const {
  MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION,
  createMemberConversationProviderRejectionV2,
  createMemberConversationProviderResultAuthorityV2,
  createMemberConversationProviderResultV2,
  memberConversationProviderResultAuthorityV2MatchesRequest,
  revokeMemberConversationProviderResultAuthorityV2,
} = require("./member-conversation-provider-result-v2");

const MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-HTTP-TRANSPORT-2";
const FACTORY_KEYS = Object.freeze([
  "adapter", "httpClient", "origin", "providerTransport", "regionPolicy",
  "request", "resolver", "responsesTransport", "version",
]);
const OPERATION_KEYS = Object.freeze(["outerDeadlineNs", "signal", "terminalState"]);
const PUBLIC_KEYS = Object.freeze([
  "dispatch", "externalCallsPermitted", "model", "promptCacheBreakpointCount",
  "promptCacheMode", "promptCachePolicyVersion", "provider", "providerFree",
  "requestDigestSha256", "responseSchemaVersion", "runtimeWired", "version",
]);
const PROVIDER_IDENTIFIER = /^[\x21-\x7e]{1,255}$/;
const REGION_POLICY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFINITE_REQUEST_REJECTION = new Set([400, 404, 405, 413, 415, 422]);
const ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const states = new WeakMap();
const brands = new WeakSet();

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys) {
  if (!exactObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")
    || ownKeys.slice().sort().join("\0") !== keys.slice().sort().join("\0")) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key] && descriptors[key].enumerable
    && Object.prototype.hasOwnProperty.call(descriptors[key], "value")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "get")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "set"));
}

function activeSignal(value) {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  try { return ABORTED.call(value) === false; } catch (_) { return false; }
}

function binding(value) {
  if (!validMemberConversationProviderRequestV2(value.request)
    || !validMemberConversationProviderTransportV2(value.providerTransport)
    || !validMemberConversationOpenAIResponsesAdapterV2(value.adapter)
    || !validMemberConversationOpenAIResponsesTransportV2(value.responsesTransport)
    || !validMemberConversationOpenAICredentialResolver(value.resolver)
    || !validMemberConversationOpenAIHTTPClient(value.httpClient)
    || typeof value.origin !== "string"
    || !memberConversationOpenAIHTTPClientMatchesOrigin(value.httpClient, value.origin)
    || typeof value.regionPolicy !== "string" || !REGION_POLICY.test(value.regionPolicy)) return null;
  const request = value.request;
  const digest = memberConversationProviderRequestV2Digest(request);
  const policy = request.controls.promptCachePolicy;
  if (!digest || request.regionPolicy !== value.regionPolicy
    || value.adapter.model !== request.model || value.providerTransport.model !== request.model
    || value.responsesTransport.model !== request.model
    || value.adapter.responseSchemaVersion !== request.responseSchemaVersion
    || value.providerTransport.responseSchemaVersion !== request.responseSchemaVersion
    || value.responsesTransport.responseSchemaVersion !== request.responseSchemaVersion
    || value.providerTransport.requestDigestSha256 !== digest
    || value.responsesTransport.requestDigestSha256 !== digest
    || [value.adapter, value.providerTransport, value.responsesTransport].some((item) =>
      item.promptCachePolicyVersion !== policy.version
      || item.promptCacheMode !== policy.mode
      || item.promptCacheBreakpointCount !== policy.breakpointCount)) return null;
  return digest;
}

function parseResponse(response) {
  if (!response || typeof response.providerRequestId !== "string"
    || !PROVIDER_IDENTIFIER.test(response.providerRequestId)) return null;
  let category = null;
  if (response.statusCode === 401 || response.statusCode === 403) category = "authentication_rejected";
  else if (response.statusCode === 429) category = "rate_limited";
  else if (DEFINITE_REQUEST_REJECTION.has(response.statusCode)) category = "request_rejected";
  if (category) return { category, providerRequestId: response.providerRequestId };
  if (response.statusCode !== 200) return null;
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); } catch (_) { return null; }
  if (!exactObject(parsed) || parsed.object !== "response" || parsed.status !== "completed"
    || parsed.error !== null || parsed.incomplete_details !== null
    || typeof parsed.id !== "string" || !PROVIDER_IDENTIFIER.test(parsed.id)
    || !Array.isArray(parsed.output) || parsed.output.length !== 1) return null;
  const message = parsed.output[0];
  if (!exactObject(message) || message.type !== "message" || message.status !== "completed"
    || message.role !== "assistant" || !Array.isArray(message.content)
    || message.content.length !== 1) return null;
  const content = message.content[0];
  if (!exactObject(content) || content.type !== "output_text"
    || !Array.isArray(content.annotations) || content.annotations.length
    || typeof content.text !== "string") return null;
  let output;
  try { output = JSON.parse(content.text); } catch (_) { return null; }
  if (!exactKeys(output, ["coaching"]) || typeof output.coaching !== "string") return null;
  return { coaching: output.coaching, providerRequestId: response.providerRequestId, providerResponseId: parsed.id };
}

function failure(classification) {
  return Object.freeze({ authority: null, classification, outcome: null });
}

function activeResult(operation, authority, request) {
  return Boolean(!operation.signal.aborted && !operation.terminalState.isTerminal()
    && positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) !== null
    && memberConversationProviderResultAuthorityV2MatchesRequest(authority, request));
}

function createMemberConversationOpenAIResponsesHTTPTransportV2(value = {}) {
  try {
    if (!exactKeys(value, FACTORY_KEYS)
      || value.version !== MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION) return null;
    const digest = binding(value);
    if (!digest) return null;
    const state = {
      ...value,
      consumed: false,
      requestDigestSha256: digest,
    };
    const transport = Object.freeze({
      async dispatch(request, operation = {}) {
        const current = states.get(transport);
        try {
          if (!current || current.consumed || request !== current.request
            || memberConversationProviderRequestV2Digest(request) !== current.requestDigestSha256
            || binding(current) !== current.requestDigestSha256
            || !exactKeys(operation, OPERATION_KEYS) || !activeSignal(operation.signal)
            || typeof operation.outerDeadlineNs !== "bigint"
            || positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) === null
            || !validTerminalState(operation.terminalState)
            || operation.terminalState.isTerminal()) return failure("not_contacted");
          current.consumed = true;
          const resultAuthority = createMemberConversationProviderResultAuthorityV2({
            version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
            request,
            terminalState: operation.terminalState,
          });
          const credentialAuthority = createMemberConversationOpenAICredentialAuthority({
            version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
            attemptId: request.attemptId,
            terminalState: operation.terminalState,
          });
          if (!resultAuthority || !credentialAuthority) return failure("not_contacted");
          const terminate = () => operation.terminalState.terminate("operation_aborted", { responseAllowed: false });
          operation.signal.addEventListener("abort", terminate, { once: true });
          let retainResultAuthority = false;
          try {
            const wire = current.responsesTransport.createWireRequest({ signal: operation.signal });
            if (!wire || !activeResult(operation, resultAuthority, request)) {
              return failure("not_contacted");
            }
            await Promise.resolve();
            if (!activeResult(operation, resultAuthority, request)) return failure("not_contacted");
            const lease = await resolveMemberConversationOpenAICredential(current.resolver, Object.freeze({
              authority: credentialAuthority,
              outerDeadlineNs: operation.outerDeadlineNs,
              signal: operation.signal,
            }));
            if (!lease || !activeResult(operation, resultAuthority, request)) {
              return failure("not_contacted");
            }
            const result = await executeMemberConversationOpenAIHTTPRequestV2(
              current.httpClient,
              Object.freeze({ body: wire.body, clientRequestId: wire.clientRequestId }),
              Object.freeze({ authority: credentialAuthority, credentialLease: lease,
                outerDeadlineNs: operation.outerDeadlineNs, request,
                resultAuthority, signal: operation.signal })
            );
            if (result && result.classification === "not_contacted") return failure("not_contacted");
            if (!result || result.classification !== "complete" || !result.response
              || !activeResult(operation, resultAuthority, request)) return failure("indeterminate");
            const parsed = parseResponse(readMemberConversationOpenAIHTTPResponse(result.response));
            if (!parsed || !activeResult(operation, resultAuthority, request)) {
              return failure("indeterminate");
            }
            if (parsed.category) {
              if (!activeResult(operation, resultAuthority, request)) return failure("indeterminate");
              const outcome = createMemberConversationProviderRejectionV2(resultAuthority, {
                version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
                providerRequestId: parsed.providerRequestId,
                terminalCategory: parsed.category,
              });
              if (!outcome || operation.signal.aborted || operation.terminalState.isTerminal()
                || positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) === null) {
                return failure("indeterminate");
              }
              retainResultAuthority = true;
              return Object.freeze({ authority: resultAuthority, classification: "rejected", outcome });
            }
            if (!activeResult(operation, resultAuthority, request)) return failure("indeterminate");
            const outcome = createMemberConversationProviderResultV2(resultAuthority, {
              version: MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION,
              coaching: parsed.coaching,
              providerRequestId: parsed.providerRequestId,
              providerResponseId: parsed.providerResponseId,
            });
            if (!outcome || operation.signal.aborted || operation.terminalState.isTerminal()
              || positiveRemainingMilliseconds(operation.outerDeadlineNs, monotonicNow()) === null) {
              return failure("indeterminate");
            }
            retainResultAuthority = true;
            return Object.freeze({ authority: resultAuthority, classification: "succeeded", outcome });
          } finally {
            operation.signal.removeEventListener("abort", terminate);
            revokeMemberConversationOpenAICredentialAuthority(credentialAuthority);
            if (!retainResultAuthority || operation.signal.aborted || operation.terminalState.isTerminal()) {
              revokeMemberConversationProviderResultAuthorityV2(resultAuthority);
            }
          }
        } catch (_) { return failure(current && current.consumed ? "indeterminate" : "not_contacted"); }
      },
      externalCallsPermitted: true,
      model: value.request.model,
      promptCachePolicyVersion: value.request.controls.promptCachePolicy.version,
      promptCacheMode: value.request.controls.promptCachePolicy.mode,
      promptCacheBreakpointCount: value.request.controls.promptCachePolicy.breakpointCount,
      provider: "openai",
      providerFree: false,
      requestDigestSha256: digest,
      responseSchemaVersion: value.request.responseSchemaVersion,
      runtimeWired: false,
      version: MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION,
    });
    states.set(transport, state);
    brands.add(transport);
    return transport;
  } catch (_) { return null; }
}

function validMemberConversationOpenAIResponsesHTTPTransportV2(value) {
  return Boolean(value && brands.has(value) && Object.isFrozen(value)
    && exactKeys(value, PUBLIC_KEYS) && states.has(value)
    && value.version === MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION
    && value.externalCallsPermitted === true && value.providerFree === false
    && value.runtimeWired === false && value.provider === "openai");
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesHTTPTransportV2,
  validMemberConversationOpenAIResponsesHTTPTransportV2,
};
