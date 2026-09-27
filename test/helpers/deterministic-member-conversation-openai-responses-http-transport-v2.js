"use strict";

const {
  MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
  createMemberConversationOpenAIHTTPClient,
} = require("../../src/goals-coach/member-conversation-openai-http-client");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesHTTPTransportV2,
} = require("../../src/goals-coach/member-conversation-openai-responses-http-transport-v2");
const { createDeterministicMemberConversationOpenAICredentialResolver } = require(
  "./deterministic-member-conversation-openai-credential-resolver"
);
const { createDeterministicMemberConversationOpenAIHTTPInterface } = require(
  "./deterministic-member-conversation-openai-http-interface"
);
const { createDeterministicMemberConversationOpenAIResponsesTransportV2 } = require(
  "./deterministic-member-conversation-openai-responses-transport-v2"
);

function createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2(options = {}) {
  const responses = options.responses || createDeterministicMemberConversationOpenAIResponsesTransportV2();
  const resolver = options.resolver || createDeterministicMemberConversationOpenAICredentialResolver();
  const http = options.http || createDeterministicMemberConversationOpenAIHTTPInterface(options.httpOptions);
  const origin = options.origin || "https://api.openai.test";
  const httpClient = options.httpClient || createMemberConversationOpenAIHTTPClient({
    version: MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
    http: http.http,
    origin,
    requestHeaderMaximumBytes: 4096,
    requestBodyMaximumBytes: 32768,
    responseHeaderMaximumBytes: 4096,
    responseBodyMaximumBytes: 32768,
    timeoutMilliseconds: 1000,
    finalizationReserveMilliseconds: 50,
  });
  const input = {
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION,
    adapter: responses.adapterFixture.adapter,
    httpClient,
    origin,
    providerTransport: responses.providerTransport.transport,
    regionPolicy: responses.created.request.regionPolicy,
    request: responses.created.request,
    resolver: resolver.resolver,
    responsesTransport: responses.transport,
  };
  return Object.freeze({
    ...responses,
    http,
    httpClient,
    input,
    resolver,
    transport: createMemberConversationOpenAIResponsesHTTPTransportV2(input),
  });
}

module.exports = { createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2 };
