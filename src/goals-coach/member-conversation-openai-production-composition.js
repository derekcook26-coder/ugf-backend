"use strict";

const MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-1";

const MEMBER_CONVERSATION_OPENAI_PRODUCTION_ALLOWLISTS = Object.freeze({
  activationGenerations: Object.freeze([]),
  developerPromptDigests: Object.freeze([]),
  models: Object.freeze([]),
  origins: Object.freeze([]),
  regionPolicies: Object.freeze([]),
  responseSchemaDigests: Object.freeze([]),
});

const disabledComposition = Object.freeze({
  adapter: null,
  client: null,
  credentialResolver: null,
  externalCallsPermitted: false,
  httpClient: null,
  orchestrator: null,
  providerFree: true,
  reason: "production_configuration_unavailable",
  runtimeWired: false,
  status: "disabled",
  transport: null,
  version: MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_VERSION,
});

function createProductionMemberConversationOpenAIComposition() {
  return disabledComposition;
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_ALLOWLISTS,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_VERSION,
  createProductionMemberConversationOpenAIComposition,
};
