"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createMemberConversationOpenAIResponsesAdapterV2,
  createMemberConversationOpenAIResponsesWireRequestV2,
  validMemberConversationOpenAIResponsesAdapterV2,
} = require("../src/goals-coach/member-conversation-openai-responses-adapter-v2");
const {
  createDeterministicMemberConversationOpenAIResponsesAdapterV2,
  deterministicMemberConversationOpenAIResponsesAdapterV2Options,
} = require("./helpers/deterministic-member-conversation-openai-responses-adapter-v2");
const {
  createDeterministicMemberConversationProviderRequestV2,
} = require("./helpers/deterministic-member-conversation-provider-request-v2");
const {
  createDeterministicMemberConversationProviderTransportV2,
} = require("./helpers/deterministic-member-conversation-provider-transport-v2");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
} = require("../src/goals-coach/member-conversation-provider-request-envelope-v2");
const {
  createMemberConversationProviderTransportV2,
} = require("../src/goals-coach/member-conversation-provider-transport-v2");

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture() {
  const adapter = createDeterministicMemberConversationOpenAIResponsesAdapterV2();
  const created = createDeterministicMemberConversationProviderRequestV2({
    developerPromptSha256: adapter.options.developerPromptSha256,
    responseSchemaSha256: adapter.options.responseSchemaSha256,
  });
  const transport = Object.freeze({
    calls: [],
    transport: createMemberConversationProviderTransportV2({
      version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
      provider: "openai",
      model: created.request.model,
      responseSchemaVersion: created.request.responseSchemaVersion,
      request: created.request,
      async dispatch(request, operationContext) {
        transport.calls.push(Object.freeze({ request, operationContext }));
        throw new Error("Offline Adapter V2 test transport must not dispatch");
      },
    }),
  });
  const controller = new AbortController();
  return { ...adapter, created, transport, controller };
}

test("Adapter V2 is private, frozen, offline, and exposes exact cache identity", () => {
  const { adapter } = fixture();
  assert.equal(validMemberConversationOpenAIResponsesAdapterV2(adapter), true);
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Object.keys(adapter), [
    "externalCallsPermitted", "maxOutputTokens", "model", "promptCachePolicyVersion", "promptCacheMode",
    "promptCacheBreakpointCount", "provider", "providerFree", "responseSchemaVersion",
    "runtimeWired", "version",
  ]);
  assert.equal(adapter.promptCacheMode, "explicit");
  assert.equal(adapter.promptCacheBreakpointCount, 0);
  assert.equal(adapter.maxOutputTokens, 512);
  assert.equal(adapter.externalCallsPermitted, false);
  assert.equal(adapter.providerFree, true);
  assert.equal(adapter.runtimeWired, false);
  assert.equal(validMemberConversationOpenAIResponsesAdapterV2(
    Object.freeze({ ...adapter })
  ), false);
});

test("wire request exactly matches the approved minimized synthetic vector", () => {
  const value = fixture();
  const wire = createMemberConversationOpenAIResponsesWireRequestV2(value.adapter, {
    request: value.created.request,
    signal: value.controller.signal,
    transport: value.transport.transport,
  });
  assert.ok(wire);
  assert.equal(wire.clientRequestId, value.created.request.attemptId);
  assert.equal(wire.regionPolicy, "synthetic-region-2");
  assert.equal(wire.signal, value.controller.signal);
  assert.equal(digest(JSON.stringify(wire.body)),
    "8223797909f557cba474342f6b6ca1e125a2dc06c1d8fa245977434a1e335740");
  assert.deepEqual(Object.keys(wire.body), [
    "model", "input", "text", "max_output_tokens", "prompt_cache_options", "store",
    "background", "stream", "truncation", "tools",
  ]);
  assert.deepEqual(wire.body.prompt_cache_options, { mode: "explicit" });
  assert.equal(JSON.stringify(wire.body).includes("prompt_cache_breakpoint"), false);
  assert.equal(JSON.stringify(wire.body).includes("prompt_cache_key"), false);
  assert.equal(JSON.stringify(wire.body).includes("prompt_cache_retention"), false);
});

test("request, transport, policy, model, schema, region, and abort drift fail closed", () => {
  const value = fixture();
  const nonOpenAI = createDeterministicMemberConversationProviderTransportV2({
    created: value.created,
  });
  const outputDrift = createDeterministicMemberConversationProviderRequestV2({
    developerPromptSha256: value.options.developerPromptSha256,
    responseSchemaSha256: value.options.responseSchemaSha256,
    controls: Object.freeze({
      ...value.created.input.controls,
      maxOutputTokens: 513,
    }),
  });
  const outputDriftTransport = createMemberConversationProviderTransportV2({
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    provider: "openai",
    model: outputDrift.request.model,
    responseSchemaVersion: outputDrift.request.responseSchemaVersion,
    request: outputDrift.request,
    async dispatch() { throw new Error("must not dispatch"); },
  });
  const variants = [
    { request: Object.freeze({ ...value.created.request }) },
    { request: createDeterministicMemberConversationProviderRequestV2({
      attemptId: "00000000-0000-4000-8000-000000000003",
    }).request },
    { request: createDeterministicMemberConversationProviderRequestV2({
      memberTurn: "What should I do next?",
    }).request },
    { transport: Object.freeze({ ...value.transport.transport }) },
    { transport: nonOpenAI.transport },
    { request: outputDrift.request, transport: outputDriftTransport },
  ];
  for (const variant of variants) {
    assert.equal(createMemberConversationOpenAIResponsesWireRequestV2(value.adapter, {
      request: value.created.request,
      signal: value.controller.signal,
      transport: value.transport.transport,
      ...variant,
    }), null);
  }
  assert.equal(nonOpenAI.calls.length, 0);
  value.controller.abort();
  assert.equal(createMemberConversationOpenAIResponsesWireRequestV2(value.adapter, {
    request: value.created.request,
    signal: value.controller.signal,
    transport: value.transport.transport,
  }), null);
});

test("factory rejects unknown, moving, pre-5.6, forged, accessor, and proxy input unobserved", () => {
  const base = deterministicMemberConversationOpenAIResponsesAdapterV2Options();
  for (const invalid of [
    { ...base, unknown: true },
    { ...base, model: "gpt-5.6-terra" },
    { ...base, model: "gpt-5.4-mini-2099-01-01" },
    { ...base, maxOutputTokens: 0 },
    { ...base, maxOutputTokens: 4097 },
    {
      ...base,
      developerPrompt: "Synthetic \uD800 prompt.",
      developerPromptSha256: digest("Synthetic \uD800 prompt."),
    },
    {
      ...base,
      developerPrompt: "Synthetic \uDC00 prompt.",
      developerPromptSha256: digest("Synthetic \uDC00 prompt."),
    },
    { ...base, promptCachePolicy: Object.freeze({ ...base.promptCachePolicy }) },
    { ...base, responseSchema: { ...base.responseSchema, additionalProperties: true } },
  ]) assert.equal(createMemberConversationOpenAIResponsesAdapterV2(invalid), null);

  let getterCalls = 0;
  const accessor = {};
  for (const [key, value] of Object.entries(base)) {
    Object.defineProperty(accessor, key, key === "model" ? {
      enumerable: true,
      get() { getterCalls += 1; throw new Error("observed"); },
    } : { enumerable: true, value });
  }
  assert.equal(createMemberConversationOpenAIResponsesAdapterV2(accessor), null);
  assert.equal(getterCalls, 0);
  let traps = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() { traps += 1; throw new Error("observed"); },
    ownKeys() { traps += 1; throw new Error("observed"); },
    get() { traps += 1; throw new Error("observed"); },
  });
  assert.equal(createMemberConversationOpenAIResponsesAdapterV2(proxy), null);
  assert.equal(traps, 0);
});

test("schema accessors and proxies fail without observation", () => {
  const base = deterministicMemberConversationOpenAIResponsesAdapterV2Options();
  let getterCalls = 0;
  const schema = { ...base.responseSchema };
  Object.defineProperty(schema, "properties", {
    enumerable: true,
    get() { getterCalls += 1; throw new Error("observed"); },
  });
  assert.equal(createMemberConversationOpenAIResponsesAdapterV2({
    ...base, responseSchema: schema,
  }), null);
  assert.equal(getterCalls, 0);
  let traps = 0;
  assert.equal(createMemberConversationOpenAIResponsesAdapterV2({
    ...base,
    responseSchema: new Proxy({}, {
      getPrototypeOf() { traps += 1; throw new Error("observed"); },
    }),
  }), null);
  assert.equal(traps, 0);
});

test("V1 and production startup remain isolated from Adapter V2", () => {
  const root = path.resolve(__dirname, "..");
  const sources = [
    fs.readFileSync(path.join(root, "server.js"), "utf8"),
    fs.readFileSync(path.join(
      root, "src", "goals-coach", "member-conversation-openai-responses-adapter.js"
    ), "utf8"),
    fs.readFileSync(path.join(
      root, "src", "goals-coach", "member-conversation-provider-dispatch-composition.js"
    ), "utf8"),
  ];
  for (const source of sources) {
    assert.doesNotMatch(source, /member-conversation-openai-responses-adapter-v2/);
    assert.doesNotMatch(source, /deterministic-member-conversation-openai-responses-adapter-v2/);
  }
  assert.match(sources[0], /idempotency:\s*null/);
  assert.match(sources[0], /provider:\s*null/);
});
