"use strict";

const {
  MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION,
  createMemberConversationOpenAIBoundedHTTPInterface,
} = require("../../src/goals-coach/member-conversation-openai-http-client");

function defaultOutcome() {
  return Object.freeze({
    body: Buffer.from('{"synthetic":true}', "utf8"),
    complete: true,
    contacted: true,
    decompressedBytes: 18,
    headers: Object.freeze({ "content-type": "application/json" }),
    kind: "response",
    redirected: false,
    statusCode: 200,
  });
}

function createDeterministicMemberConversationOpenAIHTTPInterface(options = {}) {
  const calls = [];
  let releasePending = () => {};
  const http = createMemberConversationOpenAIBoundedHTTPInterface({
    version: MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION,
    async request(value) {
      calls.push(Object.freeze({
        automaticRetries: value.automaticRetries,
        authorizationPresent: /^Bearer [\x21-\x7e]+$/.test(
          value.headers.authorization || ""
        ),
        body: value.body,
        clientRequestId: value.headers["x-client-request-id"],
        maximumAttempts: value.maximumAttempts,
        method: value.method,
        origin: value.origin,
        path: value.path,
        redirectLimit: value.redirectLimit,
        signal: value.signal,
        tlsVerification: value.tlsVerification,
      }));
      if (options.pending) await new Promise((resolve) => {
        releasePending = resolve;
      });
      if (options.error) throw options.error;
      return options.outcome || defaultOutcome();
    },
  });
  if (!http) throw new Error("Deterministic bounded HTTP construction failed");
  return Object.freeze({ calls, http, release() { releasePending(); } });
}

module.exports = { createDeterministicMemberConversationOpenAIHTTPInterface };
