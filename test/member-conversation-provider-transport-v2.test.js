"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
} = require("../src/goals-coach/member-conversation-provider-request-envelope-v2");
const {
  createMemberConversationProviderTransportV2,
  validMemberConversationProviderTransportV2,
} = require("../src/goals-coach/member-conversation-provider-transport-v2");
const {
  validMemberConversationProviderTransport,
} = require("../src/goals-coach/member-conversation-provider-transport");
const {
  createDeterministicMemberConversationProviderRequestV2,
  deterministicMemberConversationProviderRequestV2Input,
} = require("./helpers/deterministic-member-conversation-provider-request-v2");
const {
  createDeterministicMemberConversationProviderTransportV2,
} = require("./helpers/deterministic-member-conversation-provider-transport-v2");
const {
  createDeterministicMemberConversationProviderTransport,
} = require("./helpers/deterministic-member-conversation-provider-transport");

function options(created, overrides = {}) {
  return {
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    provider: "synthetic_provider",
    model: created.request.model,
    responseSchemaVersion: created.request.responseSchemaVersion,
    request: created.request,
    async dispatch() { return Object.freeze({ category: "synthetic" }); },
    ...overrides,
  };
}

test("V2 transport is privately branded and bound to one exact request digest", () => {
  const created = createDeterministicMemberConversationProviderRequestV2();
  const transport = createMemberConversationProviderTransportV2(options(created));
  assert.equal(validMemberConversationProviderTransportV2(transport), true);
  assert.equal(Object.isFrozen(transport), true);
  assert.equal(transport.requestDigestSha256, created.digestSha256);
  assert.equal(transport.model, created.request.model);
  assert.equal(
    transport.promptCachePolicyVersion,
    created.request.controls.promptCachePolicy.version
  );
  assert.equal(transport.promptCacheMode, created.request.controls.promptCachePolicy.mode);
  assert.equal(
    transport.promptCacheBreakpointCount,
    created.request.controls.promptCachePolicy.breakpointCount
  );
  assert.deepEqual(Object.keys(transport), [
    "dispatch", "externalCallsPermitted", "model", "promptCachePolicyVersion",
    "promptCacheMode", "promptCacheBreakpointCount", "provider", "providerFree",
    "requestDigestSha256", "responseSchemaVersion", "runtimeWired", "version",
  ]);
  assert.equal(transport.responseSchemaVersion, created.request.responseSchemaVersion);
  assert.equal(transport.runtimeWired, false);
  assert.equal(transport.externalCallsPermitted, true);
  assert.equal(transport.providerFree, false);
  assert.equal(validMemberConversationProviderTransport(transport), false);
  assert.equal(validMemberConversationProviderTransportV2(Object.freeze({ ...transport })), false);
  for (const key of [
    "promptCachePolicyVersion", "promptCacheMode", "promptCacheBreakpointCount",
  ]) {
    assert.equal(validMemberConversationProviderTransportV2(Object.freeze({
      ...transport,
      [key]: key === "promptCacheBreakpointCount" ? 1 : "drift",
    })), false);
  }
});

test("construction is offline and exact bound dispatch reaches the deterministic fake once", async () => {
  const expected = Object.freeze({ category: "succeeded" });
  const fake = createDeterministicMemberConversationProviderTransportV2({
    results: [expected],
  });
  assert.equal(fake.calls.length, 0);
  const operationContext = Object.freeze({ synthetic: true });
  assert.equal(await fake.transport.dispatch(fake.created.request, operationContext), expected);
  assert.deepEqual(fake.calls, [Object.freeze({
    request: fake.created.request,
    operationContext,
  })]);
});

test("lookalike, attempt, content, model, and schema drift fail before dispatch", async () => {
  const fake = createDeterministicMemberConversationProviderTransportV2({
    results: [Object.freeze({ category: "unexpected" })],
  });
  const variants = [
    Object.freeze({ ...fake.created.request }),
    createDeterministicMemberConversationProviderRequestV2({
      attemptId: "00000000-0000-4000-8000-000000000003",
    }).request,
    createDeterministicMemberConversationProviderRequestV2({
      memberTurn: "What should I do next?",
    }).request,
    createDeterministicMemberConversationProviderRequestV2({
      model: "gpt-5.6-terra-2099-01-02",
    }).request,
    createDeterministicMemberConversationProviderRequestV2({
      responseSchemaVersion: "synthetic_response_3",
    }).request,
  ];
  for (const request of variants) {
    assert.equal(await fake.transport.dispatch(request, Object.freeze({})), null);
  }
  assert.equal(fake.calls.length, 0);
});

test("factory rejects metadata drift, unknown keys, accessors, and proxies unobserved", () => {
  const created = createDeterministicMemberConversationProviderRequestV2();
  for (const invalid of [
    options(created, { unsupported: true }),
    options(created, { version: "GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-1" }),
    options(created, { provider: "Open AI" }),
    options(created, { model: "wrong-model" }),
    options(created, { responseSchemaVersion: "wrong-schema" }),
    options(created, { request: Object.freeze({ ...created.request }) }),
    options(created, { dispatch: null }),
  ]) assert.equal(createMemberConversationProviderTransportV2(invalid), null);

  const base = options(created);
  let getterCalls = 0;
  const accessor = {};
  for (const [key, value] of Object.entries(base)) {
    Object.defineProperty(accessor, key, key === "model" ? {
      enumerable: true,
      get() { getterCalls += 1; throw new Error("observed"); },
    } : { enumerable: true, value });
  }
  assert.equal(createMemberConversationProviderTransportV2(accessor), null);
  assert.equal(getterCalls, 0);

  let traps = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
    ownKeys() { traps += 1; throw new Error("keys trap"); },
    get() { traps += 1; throw new Error("get trap"); },
  });
  assert.equal(createMemberConversationProviderTransportV2(proxy), null);
  assert.equal(traps, 0);
});

test("V1 remains unchanged and cannot cross the V2 boundary", async () => {
  const v1 = createDeterministicMemberConversationProviderTransport({
    results: [Object.freeze({ category: "v1" })],
  });
  const v2 = createDeterministicMemberConversationProviderTransportV2({
    results: [Object.freeze({ category: "v2" })],
  });
  assert.equal(validMemberConversationProviderTransport(v1.transport), true);
  assert.equal(validMemberConversationProviderTransportV2(v1.transport), false);
  assert.equal(await v2.transport.dispatch(
    deterministicMemberConversationProviderRequestV2Input(),
    Object.freeze({})
  ), null);
  assert.equal(v2.calls.length, 0);
});

test("V2 transport and fake remain absent from production startup", () => {
  const root = path.resolve(__dirname, "..");
  const sources = [
    fs.readFileSync(path.join(root, "server.js"), "utf8"),
    fs.readFileSync(path.join(
      root, "src", "goals-coach", "gymmaster-member-conversation-turn-startup.js"
    ), "utf8"),
    fs.readFileSync(path.join(
      root, "src", "goals-coach", "member-conversation-provider-dispatch-composition.js"
    ), "utf8"),
  ];
  for (const source of sources) {
    assert.doesNotMatch(source, /member-conversation-provider-transport-v2/);
    assert.doesNotMatch(source, /deterministic-member-conversation-provider-transport-v2/);
  }
  assert.match(sources[0], /idempotency:\s*null/);
  assert.match(sources[0], /provider:\s*null/);
});
