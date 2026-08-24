"use strict";

const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
  createMemberConversationOpenAIResponsesClient,
} = require("../../src/goals-coach/member-conversation-openai-responses-adapter");

function createDeterministicMemberConversationOpenAIResponsesClient(options = {}) {
  const calls = [];
  let resolvePending;
  const client = createMemberConversationOpenAIResponsesClient({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
    createResponse: async (request) => {
      calls.push(request);
      if (options.pending) await new Promise((resolve, reject) => {
        const cleanup = () => request.signal.removeEventListener("abort", abort);
        const abort = () => {
          cleanup();
          reject(new Error("synthetic client aborted"));
        };
        resolvePending = () => {
          cleanup();
          resolve();
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      });
      if (options.error) throw options.error;
      return options.result || {
        providerRequestId: "synthetic-openai-request-1",
        providerResponseId: "synthetic-openai-response-1",
        output: { coaching: "Use a controlled range and stop if symptoms change." },
      };
    },
  });
  if (!client) throw new Error("Deterministic OpenAI Responses client construction failed");
  return Object.freeze({
    calls,
    client,
    release: () => { if (resolvePending) resolvePending(); },
  });
}

module.exports = { createDeterministicMemberConversationOpenAIResponsesClient };
