"use strict";

const { createHash } = require("node:crypto");
const {
  createMemberConversationOpenAIPromptCachePolicy,
  MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
} = require("../../src/goals-coach/member-conversation-openai-prompt-cache-policy");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_V2_VERSION,
  createMemberConversationOpenAIResponsesAdapterV2,
} = require("../../src/goals-coach/member-conversation-openai-responses-adapter-v2");

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicMemberConversationOpenAIResponsesAdapterV2Options(overrides = {}) {
  const responseSchema = {
    type: "object",
    additionalProperties: false,
    required: ["coaching"],
    properties: { coaching: { type: "string", maxLength: 800 } },
  };
  return {
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_V2_VERSION,
    model: "gpt-5.6-terra-2099-01-01",
    developerPromptVersion: "synthetic-prompt-2",
    developerPromptSha256: digest("Synthetic prompt."),
    developerPrompt: "Synthetic prompt.",
    responseSchemaVersion: "synthetic_response_2",
    responseSchemaSha256: digest(JSON.stringify(responseSchema)),
    responseSchema,
    regionPolicy: "synthetic-region-2",
    promptCachePolicy: createMemberConversationOpenAIPromptCachePolicy({
      version: MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
      mode: "explicit",
      breakpointCount: 0,
    }),
    ...overrides,
  };
}

function createDeterministicMemberConversationOpenAIResponsesAdapterV2(overrides = {}) {
  const options = deterministicMemberConversationOpenAIResponsesAdapterV2Options(overrides);
  return Object.freeze({
    adapter: createMemberConversationOpenAIResponsesAdapterV2(options),
    options,
  });
}

module.exports = {
  createDeterministicMemberConversationOpenAIResponsesAdapterV2,
  deterministicMemberConversationOpenAIResponsesAdapterV2Options,
};
