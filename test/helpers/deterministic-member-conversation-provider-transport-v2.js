"use strict";

const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
} = require("../../src/goals-coach/member-conversation-provider-request-envelope-v2");
const {
  createMemberConversationProviderTransportV2,
} = require("../../src/goals-coach/member-conversation-provider-transport-v2");
const {
  createDeterministicMemberConversationProviderRequestV2,
} = require("./deterministic-member-conversation-provider-request-v2");

function createDeterministicMemberConversationProviderTransportV2(options = {}) {
  const created = options.created
    || createDeterministicMemberConversationProviderRequestV2();
  const calls = [];
  const results = Array.isArray(options.results) ? [...options.results] : [];
  const transport = createMemberConversationProviderTransportV2({
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    provider: "deterministic_test_only",
    model: created.request.model,
    responseSchemaVersion: created.request.responseSchemaVersion,
    request: created.request,
    async dispatch(request, operationContext) {
      calls.push(Object.freeze({ request, operationContext }));
      if (!results.length) throw new Error("Deterministic V2 transport result required");
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  });
  if (!transport) throw new Error("Deterministic V2 transport construction failed");
  return Object.freeze({ calls, created, transport });
}

module.exports = { createDeterministicMemberConversationProviderTransportV2 };
