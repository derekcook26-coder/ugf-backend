"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesTransportV2,
  validMemberConversationOpenAIResponsesTransportV2,
} = require("../src/goals-coach/member-conversation-openai-responses-transport-v2");
const {
  createDeterministicMemberConversationOpenAIResponsesTransportV2,
} = require("./helpers/deterministic-member-conversation-openai-responses-transport-v2");
const {
  createDeterministicMemberConversationProviderRequestV2,
} = require("./helpers/deterministic-member-conversation-provider-request-v2");
const {
  createDeterministicMemberConversationProviderTransportV2,
} = require("./helpers/deterministic-member-conversation-provider-transport-v2");

test("Responses Transport V2 is private, frozen, offline, and exact-request bound", () => {
  const value = createDeterministicMemberConversationOpenAIResponsesTransportV2();
  assert.ok(value.transport);
  assert.equal(validMemberConversationOpenAIResponsesTransportV2(value.transport), true);
  assert.equal(Object.isFrozen(value.transport), true);
  assert.deepEqual(Object.keys(value.transport), [
    "createWireRequest", "externalCallsPermitted", "model", "promptCachePolicyVersion",
    "promptCacheMode", "promptCacheBreakpointCount", "provider", "providerFree",
    "requestDigestSha256", "responseSchemaVersion", "runtimeWired", "version",
  ]);
  assert.equal(value.transport.externalCallsPermitted, false);
  assert.equal(value.transport.providerFree, true);
  assert.equal(value.transport.runtimeWired, false);
  assert.equal(value.transport.requestDigestSha256,
    value.providerTransport.transport.requestDigestSha256);
  assert.equal(validMemberConversationOpenAIResponsesTransportV2(
    Object.freeze({ ...value.transport })
  ), false);
  assert.equal(value.providerTransport.calls.length, 0);
});

test("one genuine binding emits only the exact minimized Adapter V2 wire request", () => {
  const value = createDeterministicMemberConversationOpenAIResponsesTransportV2();
  const controller = new AbortController();
  const wire = value.transport.createWireRequest({ signal: controller.signal });
  assert.ok(wire);
  assert.equal(wire.signal, controller.signal);
  assert.equal(wire.clientRequestId, value.created.request.attemptId);
  assert.equal(wire.regionPolicy, value.created.request.regionPolicy);
  assert.deepEqual(wire.body.prompt_cache_options, { mode: "explicit" });
  assert.equal(JSON.stringify(wire.body).includes("prompt_cache_breakpoint"), false);
  assert.equal(JSON.stringify(wire.body).includes("prompt_cache_key"), false);
  assert.equal(value.providerTransport.calls.length, 0);
});

test("request, provider transport, adapter, cache, model, and digest drift fail closed", () => {
  const value = createDeterministicMemberConversationOpenAIResponsesTransportV2();
  const drifted = createDeterministicMemberConversationProviderRequestV2({
    attemptId: "00000000-0000-4000-8000-000000000099",
    developerPromptSha256: value.adapterFixture.options.developerPromptSha256,
    responseSchemaSha256: value.adapterFixture.options.responseSchemaSha256,
  });
  const driftedTransport = createDeterministicMemberConversationProviderTransportV2({
    created: drifted,
  });
  for (const options of [
    { ...value.options, adapter: Object.freeze({ ...value.options.adapter }) },
    { ...value.options, request: Object.freeze({ ...value.options.request }) },
    { ...value.options, transport: Object.freeze({ ...value.options.transport }) },
    { ...value.options, request: drifted.request },
    { ...value.options, transport: driftedTransport.transport },
    { ...value.options, unknown: true },
  ]) assert.equal(createMemberConversationOpenAIResponsesTransportV2(options), null);
  assert.equal(value.providerTransport.calls.length, 0);
  assert.equal(driftedTransport.calls.length, 0);
});

test("genuine prompt, schema, and region policy drift fail during construction", () => {
  const value = createDeterministicMemberConversationOpenAIResponsesTransportV2();
  const variants = [
    { developerPromptSha256: "c".repeat(64) },
    { responseSchemaSha256: "c".repeat(64) },
    { regionPolicy: "different-synthetic-region-2" },
  ];
  for (const overrides of variants) {
    const created = createDeterministicMemberConversationProviderRequestV2({
      developerPromptSha256: value.adapterFixture.options.developerPromptSha256,
      responseSchemaSha256: value.adapterFixture.options.responseSchemaSha256,
      ...overrides,
    });
    const mismatch = createDeterministicMemberConversationOpenAIResponsesTransportV2({
      adapterFixture: value.adapterFixture,
      created,
    });
    assert.equal(mismatch.transport, null);
    assert.equal(mismatch.providerTransport.calls.length, 0);
  }
  assert.equal(value.providerTransport.calls.length, 0);
});

test("aborted, malformed, accessor, and proxy inputs fail without observation", () => {
  const value = createDeterministicMemberConversationOpenAIResponsesTransportV2();
  const controller = new AbortController();
  controller.abort();
  assert.equal(value.transport.createWireRequest({ signal: controller.signal }), null);
  assert.equal(value.transport.createWireRequest({}), null);
  assert.equal(value.transport.createWireRequest({ signal: new AbortController().signal,
    unknown: true }), null);

  let getterCalls = 0;
  const accessor = {};
  for (const [key, current] of Object.entries(value.options)) {
    Object.defineProperty(accessor, key, key === "adapter" ? {
      enumerable: true,
      get() { getterCalls += 1; throw new Error("observed"); },
    } : { enumerable: true, value: current });
  }
  assert.equal(createMemberConversationOpenAIResponsesTransportV2(accessor), null);
  assert.equal(getterCalls, 0);

  let traps = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() { traps += 1; throw new Error("observed"); },
    ownKeys() { traps += 1; throw new Error("observed"); },
    get() { traps += 1; throw new Error("observed"); },
  });
  assert.equal(createMemberConversationOpenAIResponsesTransportV2(proxy), null);
  assert.equal(traps, 0);
  assert.equal(value.providerTransport.calls.length, 0);
});

test("V1, production startup, package, and migrations remain isolated", () => {
  const root = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "src", "goals-coach",
    "member-conversation-openai-responses-transport-v2.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'](?:openai|node-fetch|https?|net|tls)["']\)/);
  assert.doesNotMatch(source, /process\.env|Authorization|Bearer|fetch\(/);
  for (const relative of [
    "server.js",
    "src/goals-coach/member-conversation-openai-responses-transport.js",
    "src/goals-coach/member-conversation-provider-dispatch-composition.js",
  ]) {
    const production = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(production, /member-conversation-openai-responses-transport-v2/);
    assert.doesNotMatch(production,
      /deterministic-member-conversation-openai-responses-transport-v2/);
  }
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});

test("version identity is exact", () => {
  assert.equal(MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_V2_VERSION,
    "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-2");
});
