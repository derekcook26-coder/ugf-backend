"use strict";

const {
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
  createMemberConversationOpenAICredentialResolver,
} = require("../../src/goals-coach/member-conversation-openai-credential-resolver");

function createDeterministicMemberConversationOpenAICredentialResolver(options = {}) {
  const calls = [];
  let releasePending = () => {};
  const resolver = createMemberConversationOpenAICredentialResolver({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
    async resolve(operation) {
      calls.push(operation);
      if (options.pending) await new Promise((resolve) => {
        releasePending = resolve;
      });
      if (options.error) throw options.error;
      return options.credential === undefined
        ? "synthetic-openai-credential"
        : options.credential;
    },
  });
  if (!resolver) throw new Error("Deterministic credential resolver construction failed");
  return Object.freeze({
    calls,
    release() { releasePending(); },
    resolver,
  });
}

module.exports = { createDeterministicMemberConversationOpenAICredentialResolver };
