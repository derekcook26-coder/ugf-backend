"use strict";

const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
  createMemberConversationProviderTransport,
} = require("../../src/goals-coach/member-conversation-provider-transport");

function createDeterministicMemberConversationProviderTransport(options = {}) {
  const calls = [];
  const results = Array.isArray(options.results) ? [...options.results] : [];
  const transport = createMemberConversationProviderTransport({
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
    provider: "deterministic_test_only",
    model: "deterministic-model-1",
    responseSchemaVersion: "deterministic-response-1",
    async dispatch(request, operationContext) {
      calls.push(Object.freeze({ request, operationContext }));
      if (!results.length) throw new Error("Deterministic transport result required");
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  });
  if (!transport) throw new Error("Deterministic transport construction failed");
  return Object.freeze({ calls, transport });
}

module.exports = { createDeterministicMemberConversationProviderTransport };
