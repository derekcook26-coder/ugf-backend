"use strict";

const {
  MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
  createMemberConversationOpenAIPromptCachePolicy,
} = require("../../src/goals-coach/member-conversation-openai-prompt-cache-policy");
const {
  MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
  createMemberConversationProviderRequestV2,
  memberConversationProviderRequestV2Digest,
} = require("../../src/goals-coach/member-conversation-provider-request-envelope-v2");
const {
  MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
  createMemberConversationTurnResponse,
  parseMemberConversationTurnRequest,
} = require("../../src/goals-coach/member-conversation-turn-contract");

function createDeterministicPromptCachePolicy() {
  return createMemberConversationOpenAIPromptCachePolicy({
    version: MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
    mode: "explicit",
    breakpointCount: 0,
  });
}

function deterministicMemberConversationProviderRequestV2Input(overrides = {}) {
  const memberTurn = Object.prototype.hasOwnProperty.call(overrides, "memberTurn")
    ? overrides.memberTurn : "How should I start?";
  const turnRequest = overrides.turnRequest || parseMemberConversationTurnRequest({
    contractVersion: MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
    conversation: {
      reference: "00000000-0000-4000-8000-000000000002",
      version: 1,
      provenance: "member_session",
    },
    memberText: memberTurn,
  });
  const turnResponse = overrides.turnResponse || createMemberConversationTurnResponse(
    turnRequest,
    {
      ruleVersion: "GC-MEMBER-CONVERSATION-SAFETY-1",
      sourceRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-RULES-1",
      classification: "clear",
      action: "allow_provider_processing",
    }
  );
  const input = {
    version: MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION,
    transportVersion: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    attemptId: "00000000-0000-4000-8000-000000000001",
    model: "gpt-5.6-terra-2099-01-01",
    developerPromptVersion: "synthetic-prompt-2",
    developerPromptSha256: "a".repeat(64),
    responseSchemaVersion: "synthetic_response_2",
    responseSchemaSha256: "b".repeat(64),
    promptCachePolicy: createDeterministicPromptCachePolicy(),
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
    regionPolicy: "synthetic-region-2",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (!["memberTurn", "turnRequest", "turnResponse"].includes(key)) input[key] = value;
  }
  return input;
}

function createDeterministicMemberConversationProviderRequestV2(overrides = {}) {
  const input = deterministicMemberConversationProviderRequestV2Input(overrides);
  const request = createMemberConversationProviderRequestV2(input);
  if (!request) throw new Error("Deterministic V2 provider request construction failed");
  return Object.freeze({
    digestSha256: memberConversationProviderRequestV2Digest(request),
    input: Object.freeze(input),
    request,
  });
}

module.exports = {
  createDeterministicMemberConversationProviderRequestV2,
  createDeterministicPromptCachePolicy,
  deterministicMemberConversationProviderRequestV2Input,
};
