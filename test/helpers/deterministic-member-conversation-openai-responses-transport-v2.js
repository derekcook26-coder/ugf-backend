"use strict";

const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesTransportV2,
} = require("../../src/goals-coach/member-conversation-openai-responses-transport-v2");
const {
  createDeterministicMemberConversationOpenAIResponsesAdapterV2,
} = require("./deterministic-member-conversation-openai-responses-adapter-v2");
const {
  createDeterministicMemberConversationProviderRequestV2,
} = require("./deterministic-member-conversation-provider-request-v2");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
} = require("../../src/goals-coach/member-conversation-provider-request-envelope-v2");
const {
  createMemberConversationProviderTransportV2,
} = require("../../src/goals-coach/member-conversation-provider-transport-v2");

function createDeterministicMemberConversationOpenAIResponsesTransportV2(overrides = {}) {
  const adapterFixture = overrides.adapterFixture
    || createDeterministicMemberConversationOpenAIResponsesAdapterV2();
  const created = overrides.created || createDeterministicMemberConversationProviderRequestV2({
    developerPromptSha256: adapterFixture.options.developerPromptSha256,
    responseSchemaSha256: adapterFixture.options.responseSchemaSha256,
  });
  const calls = [];
  const providerTransport = overrides.providerTransport || Object.freeze({
    calls,
    transport: createMemberConversationProviderTransportV2({
      version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
      provider: "openai",
      model: created.request.model,
      responseSchemaVersion: created.request.responseSchemaVersion,
      request: created.request,
      async dispatch(request, operationContext) {
        calls.push(Object.freeze({ request, operationContext }));
        throw new Error("Offline Responses Transport V2 helper must not dispatch");
      },
    }),
  });
  const options = {
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION,
    adapter: adapterFixture.adapter,
    request: created.request,
    transport: providerTransport.transport,
    ...overrides.options,
  };
  return Object.freeze({
    adapterFixture,
    created,
    options,
    providerTransport,
    transport: createMemberConversationOpenAIResponsesTransportV2(options),
  });
}

module.exports = {
  createDeterministicMemberConversationOpenAIResponsesTransportV2,
};
