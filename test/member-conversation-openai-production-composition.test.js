"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_ALLOWLISTS,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_VERSION,
  createProductionMemberConversationOpenAIComposition,
} = require("../src/goals-coach/member-conversation-openai-production-composition");
const {
  createDeterministicMemberConversationOpenAICredentialResolver,
} = require("./helpers/deterministic-member-conversation-openai-credential-resolver");
const {
  createDeterministicMemberConversationOpenAIHTTPInterface,
} = require("./helpers/deterministic-member-conversation-openai-http-interface");

const expectedDisabled = Object.freeze({
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

test("production OpenAI composition is exactly disabled with empty allowlists", () => {
  assert.deepEqual(MEMBER_CONVERSATION_OPENAI_PRODUCTION_ALLOWLISTS, {
    activationGenerations: [],
    developerPromptDigests: [],
    models: [],
    origins: [],
    regionPolicies: [],
    responseSchemaDigests: [],
  });
  assert.equal(Object.isFrozen(MEMBER_CONVERSATION_OPENAI_PRODUCTION_ALLOWLISTS), true);
  for (const value of Object.values(MEMBER_CONVERSATION_OPENAI_PRODUCTION_ALLOWLISTS)) {
    assert.equal(Object.isFrozen(value), true);
  }

  const composition = createProductionMemberConversationOpenAIComposition();
  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(composition, expectedDisabled);
});

test("credentials, genuine offline dependencies, and activation lookalikes cannot enable it", () => {
  const resolver = createDeterministicMemberConversationOpenAICredentialResolver();
  const http = createDeterministicMemberConversationOpenAIHTTPInterface();
  let inspected = 0;
  const untrusted = {};
  for (const key of [
    "activationGeneration", "adapter", "client", "configuration",
    "credential", "credentialResolver", "httpClient", "orchestrator", "transport",
  ]) {
    Object.defineProperty(untrusted, key, {
      enumerable: true,
      get() {
        inspected += 1;
        throw new Error("disabled composition must not inspect inputs");
      },
    });
  }

  const composition = createProductionMemberConversationOpenAIComposition(untrusted);
  assert.deepEqual(composition, expectedDisabled);
  assert.equal(inspected, 0);
  assert.equal(resolver.calls.length, 0);
  assert.equal(http.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(composition), /secret|authorization/i);
});

test("production startup remains null, unwired, and import-free", () => {
  const root = path.resolve(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const startup = fs.readFileSync(
    path.join(root, "src/goals-coach/gymmaster-member-conversation-turn-startup.js"),
    "utf8"
  );

  assert.doesNotMatch(server, /member-conversation-openai-production-composition/);
  assert.doesNotMatch(startup, /member-conversation-openai-production-composition/);
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});
