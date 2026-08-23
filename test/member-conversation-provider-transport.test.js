"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
  createMemberConversationProviderTransport,
  validMemberConversationProviderTransport,
} = require("../src/goals-coach/member-conversation-provider-transport");
const {
  createDeterministicMemberConversationProviderTransport,
} = require("./helpers/deterministic-member-conversation-provider-transport");

function options(overrides = {}) {
  return {
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
    provider: "synthetic_provider",
    model: "synthetic-model-1",
    responseSchemaVersion: "synthetic-response-1",
    async dispatch() { return Object.freeze({ category: "synthetic" }); },
    ...overrides,
  };
}

test("transport factory returns one frozen branded disabled-from-runtime boundary", () => {
  const transport = createMemberConversationProviderTransport(options());
  assert.ok(transport);
  assert.equal(validMemberConversationProviderTransport(transport), true);
  assert.equal(Object.isFrozen(transport), true);
  assert.deepEqual({
    version: transport.version,
    provider: transport.provider,
    model: transport.model,
    responseSchemaVersion: transport.responseSchemaVersion,
    externalCallsPermitted: transport.externalCallsPermitted,
    providerFree: transport.providerFree,
    runtimeWired: transport.runtimeWired,
  }, {
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
    provider: "synthetic_provider",
    model: "synthetic-model-1",
    responseSchemaVersion: "synthetic-response-1",
    externalCallsPermitted: true,
    providerFree: false,
    runtimeWired: false,
  });
});

test("metadata lookalikes cannot satisfy the private transport brand", () => {
  const transport = createMemberConversationProviderTransport(options());
  const lookalike = Object.freeze({ ...transport });
  assert.equal(validMemberConversationProviderTransport(lookalike), false);
  assert.equal(validMemberConversationProviderTransport({}), false);
  assert.equal(validMemberConversationProviderTransport(null), false);
});

test("unknown fields, versions, identifiers, and missing dispatch fail closed", () => {
  const invalid = [
    options({ unsupported: true }),
    options({ version: "GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-2" }),
    options({ provider: "" }),
    options({ provider: "Open AI" }),
    options({ model: "" }),
    options({ responseSchemaVersion: "contains whitespace" }),
    options({ dispatch: null }),
  ];
  for (const value of invalid) {
    assert.equal(createMemberConversationProviderTransport(value), null);
  }
});

test("construction performs no dispatch and deterministic fake dispatches only explicitly", async () => {
  const expected = Object.freeze({ category: "succeeded" });
  const fake = createDeterministicMemberConversationProviderTransport({
    results: [expected],
  });
  assert.equal(validMemberConversationProviderTransport(fake.transport), true);
  assert.equal(fake.calls.length, 0);

  const request = Object.freeze({ synthetic: true });
  const operationContext = Object.freeze({ synthetic: true });
  assert.equal(await fake.transport.dispatch(request, operationContext), expected);
  assert.deepEqual(fake.calls, [Object.freeze({ request, operationContext })]);
});

test("deterministic fake is test-only and production has no transport import", () => {
  const root = path.resolve(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const startup = fs.readFileSync(
    path.join(root, "src", "goals-coach", "gymmaster-member-conversation-turn-startup.js"),
    "utf8"
  );
  const composition = fs.readFileSync(
    path.join(root, "src", "goals-coach", "member-conversation-provider-dispatch-composition.js"),
    "utf8"
  );
  assert.doesNotMatch(server, /member-conversation-provider-transport/);
  assert.doesNotMatch(startup, /member-conversation-provider-transport/);
  assert.doesNotMatch(composition, /member-conversation-provider-transport/);
  assert.doesNotMatch(server, /deterministic-member-conversation-provider-transport/);
  assert.doesNotMatch(startup, /deterministic-member-conversation-provider-transport/);
});
