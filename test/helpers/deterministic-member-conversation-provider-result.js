"use strict";

const { createTerminalState } = require("../../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
  createMemberConversationProviderResult,
  createMemberConversationProviderResultAuthority,
  readMemberConversationProviderResult,
} = require("../../src/goals-coach/member-conversation-provider-result");
const {
  createDeterministicMemberConversationProviderRequest,
} = require("./deterministic-member-conversation-provider-request");

function createDeterministicMemberConversationProviderResult(overrides = {}) {
  const request = overrides.request
    || createDeterministicMemberConversationProviderRequest().request;
  const terminalState = overrides.terminalState || createTerminalState();
  const authority = createMemberConversationProviderResultAuthority({ request, terminalState });
  const result = createMemberConversationProviderResult({
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
    authority,
    coaching: "Keep the movement controlled and stop if symptoms change.",
    providerRequestId: "synthetic-request-1",
    providerResponseId: "synthetic-response-1",
    ...(overrides.result || {}),
  });
  if (!authority || !result) throw new Error("Deterministic provider result construction failed");
  return Object.freeze({
    authority,
    result,
    terminalState,
    value: readMemberConversationProviderResult(result, authority),
  });
}

module.exports = { createDeterministicMemberConversationProviderResult };
