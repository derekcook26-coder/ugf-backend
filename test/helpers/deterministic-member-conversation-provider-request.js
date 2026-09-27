"use strict";

const {
  MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
  createMemberConversationProviderRequest,
  memberConversationProviderRequestDigest,
} = require("../../src/goals-coach/member-conversation-provider-request-envelope");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
} = require("../../src/goals-coach/member-conversation-provider-transport");
const {
  MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
  createMemberConversationTurnResponse,
  parseMemberConversationTurnRequest,
} = require("../../src/goals-coach/member-conversation-turn-contract");

function deterministicMemberConversationProviderRequestInput(overrides = {}) {
  const memberTurn = Object.prototype.hasOwnProperty.call(overrides, "memberTurn")
    ? overrides.memberTurn : "Synthetic member turn.";
  const turnRequest = overrides.turnRequest || parseMemberConversationTurnRequest({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    requestId: "20000000-0000-4000-8000-000000000001",
    idempotencyKey: "20000000-0000-4000-8000-000000000001",
    conversation: {
      reference: "30000000-0000-4000-8000-000000000001",
      version: 1,
      provenance: "member_session",
    },
    memberText: memberTurn,
  });
  const safety = overrides.safety || {
    ruleVersion: "GC-MEMBER-CONVERSATION-SAFETY-1",
    sourceRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-RULES-1",
    classification: "clear",
    action: "allow_provider_processing",
  };
  const turnResponse = overrides.turnResponse
    || createMemberConversationTurnResponse(turnRequest, safety);
  const input = {
    version: MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
    transportVersion: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
    attemptId: "10000000-0000-4000-8000-000000000001",
    model: "synthetic-model-1",
    developerPromptVersion: "synthetic-prompt-1",
    developerPromptSha256: "a".repeat(64),
    responseSchemaVersion: "synthetic-response-1",
    responseSchemaSha256: "b".repeat(64),
    turnRequest,
    turnResponse,
    controls: {
      background: false,
      conversation: null,
      maxOutputTokens: 512,
      metadata: null,
      previousResponseId: null,
      store: false,
      stream: false,
      tools: [],
      truncation: "disabled",
    },
    regionPolicy: "synthetic-region-1",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (!["memberTurn", "safety", "turnRequest", "turnResponse"].includes(key)) {
      input[key] = value;
    }
  }
  return input;
}

function createDeterministicMemberConversationProviderRequest(overrides = {}) {
  const input = deterministicMemberConversationProviderRequestInput(overrides);
  const request = createMemberConversationProviderRequest(input);
  if (!request) throw new Error("Deterministic provider request construction failed");
  return Object.freeze({
    digestSha256: memberConversationProviderRequestDigest(request),
    input: Object.freeze(input),
    request,
  });
}

module.exports = {
  createDeterministicMemberConversationProviderRequest,
  deterministicMemberConversationProviderRequestInput,
};
