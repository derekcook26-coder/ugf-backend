"use strict";

const { createTerminalState } = require("./bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
  createMemberConversationOpenAICredentialAuthority,
  resolveMemberConversationOpenAICredential,
  revokeMemberConversationOpenAICredentialAuthority,
  validMemberConversationOpenAICredentialResolver,
} = require("./member-conversation-openai-credential-resolver");
const {
  executeMemberConversationOpenAIHTTPRequest,
  memberConversationOpenAIHTTPClientMatchesOrigin,
  readMemberConversationOpenAIHTTPResponse,
  validMemberConversationOpenAIHTTPClient,
} = require("./member-conversation-openai-http-client");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
  createMemberConversationOpenAIResponsesClient,
} = require("./member-conversation-openai-responses-adapter");

const MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_CLIENT_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-HTTP-CLIENT-1";
const FACTORY_KEYS = Object.freeze([
  "httpClient", "origin", "regionPolicy", "resolver", "version",
]);
const REQUEST_KEYS = Object.freeze([
  "body", "clientRequestId", "regionPolicy", "signal",
]);
const OPERATION_KEYS = Object.freeze(["outerDeadlineNs", "signal"]);
const PROVIDER_IDENTIFIER = /^[\x21-\x7e]{1,255}$/;
const REGION_POLICY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFINITE_REQUEST_REJECTION = new Set([400, 404, 405, 413, 415, 422]);

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return exactObject(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parseProviderResponse(response) {
  if (!response || !PROVIDER_IDENTIFIER.test(response.providerRequestId || "")) {
    return null;
  }
  if ([401, 403].includes(response.statusCode)) return Object.freeze({
    classification: "authentication_rejected",
    providerRequestId: response.providerRequestId,
  });
  if (response.statusCode === 429) return Object.freeze({
    classification: "rate_limited",
    providerRequestId: response.providerRequestId,
  });
  if (DEFINITE_REQUEST_REJECTION.has(response.statusCode)) return Object.freeze({
    classification: "request_rejected",
    providerRequestId: response.providerRequestId,
  });
  if (response.statusCode !== 200) return null;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch { return null; }
  if (!exactObject(value) || value.object !== "response"
    || value.status !== "completed" || value.error !== null
    || value.incomplete_details !== null
    || !PROVIDER_IDENTIFIER.test(value.id || "")
    || !Array.isArray(value.output) || value.output.length !== 1
    || !exactObject(value.output[0])
    || value.output[0].type !== "message"
    || value.output[0].status !== "completed"
    || value.output[0].role !== "assistant"
    || !Array.isArray(value.output[0].content)
    || value.output[0].content.length !== 1
    || !exactObject(value.output[0].content[0])
    || value.output[0].content[0].type !== "output_text"
    || !Array.isArray(value.output[0].content[0].annotations)
    || value.output[0].content[0].annotations.length !== 0
    || typeof value.output[0].content[0].text !== "string") return null;
  let output;
  try { output = JSON.parse(value.output[0].content[0].text); } catch { return null; }
  if (!exactKeys(output, ["coaching"]) || typeof output.coaching !== "string") {
    return null;
  }
  return Object.freeze({
    output: Object.freeze({ coaching: output.coaching }),
    providerRequestId: response.providerRequestId,
    providerResponseId: value.id,
  });
}

function createMemberConversationOpenAIResponsesHTTPClient(value = {}) {
  if (!exactKeys(value, FACTORY_KEYS)
    || value.version !== MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_CLIENT_VERSION
    || !validMemberConversationOpenAICredentialResolver(value.resolver)
    || !validMemberConversationOpenAIHTTPClient(value.httpClient)
    || !REGION_POLICY.test(value.regionPolicy || "")
    || !memberConversationOpenAIHTTPClientMatchesOrigin(
      value.httpClient, value.origin
    )) return null;
  const resolver = value.resolver;
  const httpClient = value.httpClient;
  const regionPolicy = value.regionPolicy;
  return createMemberConversationOpenAIResponsesClient({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
    automaticRetries: false,
    maximumAttempts: 1,
    async createResponse(request = {}, operation = {}) {
      if (!exactKeys(request, REQUEST_KEYS)
        || !exactKeys(operation, OPERATION_KEYS)
        || request.signal !== operation.signal
        || request.regionPolicy !== regionPolicy
        || !(operation.signal instanceof AbortSignal)
        || typeof operation.outerDeadlineNs !== "bigint") return null;
      const terminalState = createTerminalState();
      const terminate = () => terminalState.terminate("operation_aborted", {
        responseAllowed: false,
      });
      operation.signal.addEventListener("abort", terminate, { once: true });
      if (operation.signal.aborted) terminate();
      const authority = createMemberConversationOpenAICredentialAuthority({
        version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
        attemptId: request.clientRequestId,
        terminalState,
      });
      if (!authority) {
        operation.signal.removeEventListener("abort", terminate);
        return null;
      }
      try {
        const credentialLease = await resolveMemberConversationOpenAICredential(
          resolver, Object.freeze({
            authority,
            outerDeadlineNs: operation.outerDeadlineNs,
            signal: operation.signal,
          })
        );
        if (!credentialLease) return null;
        const outcome = await executeMemberConversationOpenAIHTTPRequest(
          httpClient,
          Object.freeze({ body: request.body, clientRequestId: request.clientRequestId }),
          Object.freeze({
            authority,
            credentialLease,
            outerDeadlineNs: operation.outerDeadlineNs,
            signal: operation.signal,
          })
        );
        if (!outcome || outcome.classification !== "complete" || !outcome.response) {
          return null;
        }
        return parseProviderResponse(
          readMemberConversationOpenAIHTTPResponse(outcome.response)
        );
      } finally {
        revokeMemberConversationOpenAICredentialAuthority(authority);
        operation.signal.removeEventListener("abort", terminate);
      }
    },
  });
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_CLIENT_VERSION,
  createMemberConversationOpenAIResponsesHTTPClient,
};
