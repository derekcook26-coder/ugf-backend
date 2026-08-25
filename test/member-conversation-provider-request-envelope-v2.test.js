"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
  createMemberConversationOpenAIPromptCachePolicy,
  readMemberConversationOpenAIPromptCachePolicy,
  validMemberConversationOpenAIPromptCachePolicy,
} = require("../src/goals-coach/member-conversation-openai-prompt-cache-policy");
const {
  MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
  createMemberConversationProviderRequestV2,
  memberConversationProviderRequestV2Digest,
  parseMemberConversationProviderRequestV2,
  validMemberConversationProviderRequestV2,
} = require("../src/goals-coach/member-conversation-provider-request-envelope-v2");
const {
  MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
  validMemberConversationProviderRequest,
} = require("../src/goals-coach/member-conversation-provider-request-envelope");
const {
  createDeterministicMemberConversationProviderRequest,
} = require("./helpers/deterministic-member-conversation-provider-request");
const {
  createDeterministicMemberConversationProviderRequestV2,
  createDeterministicPromptCachePolicy,
  deterministicMemberConversationProviderRequestV2Input,
} = require("./helpers/deterministic-member-conversation-provider-request-v2");

test("cache policy is exact, opaque by brand, and copied without caller ownership", () => {
  const policy = createDeterministicPromptCachePolicy();
  assert.equal(validMemberConversationOpenAIPromptCachePolicy(policy), true);
  assert.deepEqual(Object.keys(policy), ["version", "mode", "breakpointCount"]);
  assert.equal(JSON.stringify(policy), JSON.stringify({
    version: MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
    mode: "explicit",
    breakpointCount: 0,
  }));
  assert.equal(validMemberConversationOpenAIPromptCachePolicy(Object.freeze({ ...policy })), false);
  for (const invalid of [
    { ...policy, mode: "implicit" },
    { ...policy, breakpointCount: 1 },
    { ...policy, ttl: "30m" },
    { mode: "explicit", breakpointCount: 0 },
  ]) assert.equal(createMemberConversationOpenAIPromptCachePolicy(invalid), null);
  const read = readMemberConversationOpenAIPromptCachePolicy(policy);
  assert.notEqual(read, policy);
  assert.equal(Object.isFrozen(read), true);
});

test("cache policy rejects accessors and proxies without observing their traps", () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperties(accessor, {
    version: { enumerable: true, get() { getterCalls += 1; throw new Error("observed"); } },
    mode: { enumerable: true, value: "explicit" },
    breakpointCount: { enumerable: true, value: 0 },
  });
  assert.equal(createMemberConversationOpenAIPromptCachePolicy(accessor), null);
  assert.equal(getterCalls, 0);

  let traps = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
    ownKeys() { traps += 1; throw new Error("keys trap"); },
    get() { traps += 1; throw new Error("get trap"); },
  });
  assert.equal(createMemberConversationOpenAIPromptCachePolicy(proxy), null);
  assert.equal(traps, 0);
});

test("V2 factory derives one exact deeply frozen request and canonical digest", () => {
  const created = createDeterministicMemberConversationProviderRequestV2();
  assert.equal(validMemberConversationProviderRequestV2(created.request), true);
  assert.equal(parseMemberConversationProviderRequestV2(created.request), created.request);
  assert.equal(Object.isFrozen(created.request), true);
  assert.equal(Object.isFrozen(created.request.controls), true);
  assert.equal(Object.isFrozen(created.request.controls.promptCachePolicy), true);
  assert.equal(Object.isFrozen(created.request.controls.tools), true);
  assert.notEqual(created.request.controls.promptCachePolicy, created.input.promptCachePolicy);
  assert.deepEqual(Object.keys(created.request), [
    "version", "transportVersion", "attemptId", "model",
    "developerPromptVersion", "developerPromptSha256", "responseSchemaVersion",
    "responseSchemaSha256", "requestSignatureSha256", "safetyRuleVersion",
    "safetySourceRuleVersion", "memberTurn", "controls", "regionPolicy",
  ]);
  assert.deepEqual(Object.keys(created.request.controls), [
    "background", "conversation", "maxOutputTokens", "metadata",
    "previousResponseId", "promptCachePolicy", "store", "stream", "tools",
    "truncation",
  ]);
  assert.equal(
    memberConversationProviderRequestV2Digest(created.request),
    createHash("sha256").update(JSON.stringify(created.request), "utf8").digest("hex")
  );
});

test("V1, structural lookalikes, policy drift, and unknown controls fail closed", () => {
  const v1 = createDeterministicMemberConversationProviderRequest().request;
  const v2 = createDeterministicMemberConversationProviderRequestV2().request;
  assert.equal(validMemberConversationProviderRequestV2(v1), false);
  assert.equal(validMemberConversationProviderRequest(v2), false);
  assert.equal(parseMemberConversationProviderRequestV2(Object.freeze({ ...v2 })), null);
  assert.equal(memberConversationProviderRequestV2Digest(Object.freeze({ ...v2 })), null);
  assert.equal(createMemberConversationProviderRequestV2(
    deterministicMemberConversationProviderRequestV2Input({
      version: MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
    })
  ), null);
  assert.equal(createMemberConversationProviderRequestV2(
    deterministicMemberConversationProviderRequestV2Input({
      promptCachePolicy: Object.freeze({
        version: MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
        mode: "explicit",
        breakpointCount: 0,
      }),
    })
  ), null);
  const input = deterministicMemberConversationProviderRequestV2Input();
  for (const controls of [
    { ...input.controls, prompt_cache_key: "member" },
    { ...input.controls, prompt_cache_retention: "24h" },
    { ...input.controls, ttl: "30m" },
    { ...input.controls, background: true },
    { ...input.controls, stream: true },
    { ...input.controls, tools: [{}] },
  ]) assert.equal(createMemberConversationProviderRequestV2({ ...input, controls }), null);
});

test("V2 factory rejects top-level, controls, and tools accessors or proxies unobserved", () => {
  const base = deterministicMemberConversationProviderRequestV2Input();
  let getterCalls = 0;
  const accessorInput = {};
  for (const [key, value] of Object.entries(base)) {
    Object.defineProperty(accessorInput, key, key === "model" ? {
      enumerable: true,
      get() { getterCalls += 1; throw new Error("observed"); },
    } : { enumerable: true, value });
  }
  assert.equal(createMemberConversationProviderRequestV2(accessorInput), null);
  assert.equal(getterCalls, 0);

  const accessorControls = {};
  for (const [key, value] of Object.entries(base.controls)) {
    Object.defineProperty(accessorControls, key, key === "store" ? {
      enumerable: true,
      get() { getterCalls += 1; throw new Error("observed"); },
    } : { enumerable: true, value });
  }
  assert.equal(createMemberConversationProviderRequestV2({
    ...base,
    controls: accessorControls,
  }), null);
  assert.equal(getterCalls, 0);

  let traps = 0;
  const throwingProxy = new Proxy({}, {
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
    ownKeys() { traps += 1; throw new Error("keys trap"); },
    get() { traps += 1; throw new Error("get trap"); },
  });
  assert.equal(createMemberConversationProviderRequestV2(throwingProxy), null);
  assert.equal(createMemberConversationProviderRequestV2({
    ...base,
    controls: throwingProxy,
  }), null);
  assert.equal(createMemberConversationProviderRequestV2({
    ...base,
    controls: { ...base.controls, tools: throwingProxy },
  }), null);
  assert.equal(traps, 0);
});

test("caller insertion order is ignored but every normalized field is digest-bound", () => {
  const original = createDeterministicMemberConversationProviderRequestV2();
  const input = original.input;
  const reordered = createMemberConversationProviderRequestV2({
    regionPolicy: input.regionPolicy,
    controls: { ...input.controls, tools: [] },
    turnResponse: input.turnResponse,
    turnRequest: input.turnRequest,
    promptCachePolicy: input.promptCachePolicy,
    responseSchemaSha256: input.responseSchemaSha256,
    responseSchemaVersion: input.responseSchemaVersion,
    developerPromptSha256: input.developerPromptSha256,
    developerPromptVersion: input.developerPromptVersion,
    model: input.model,
    attemptId: input.attemptId,
    transportVersion: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    version: MEMBER_CONVERSATION_PROVIDER_REQUEST_V2_VERSION,
  });
  assert.equal(memberConversationProviderRequestV2Digest(reordered), original.digestSha256);
  const changes = [
    { model: "gpt-5.6-terra-2099-01-02" },
    { developerPromptSha256: "d".repeat(64) },
    { responseSchemaSha256: "e".repeat(64) },
    { regionPolicy: "synthetic-region-3" },
    { controls: { ...input.controls, tools: [], maxOutputTokens: 513 } },
  ];
  for (const change of changes) {
    const changed = createMemberConversationProviderRequestV2(
      deterministicMemberConversationProviderRequestV2Input(change)
    );
    assert.notEqual(memberConversationProviderRequestV2Digest(changed), original.digestSha256);
  }
});

test("approved synthetic canonical request vector remains exact", () => {
  const canonical = "{\"version\":\"GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2\",\"transportVersion\":\"GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-2\",\"attemptId\":\"00000000-0000-4000-8000-000000000001\",\"model\":\"gpt-5.6-terra-2099-01-01\",\"developerPromptVersion\":\"synthetic-prompt-2\",\"developerPromptSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"responseSchemaVersion\":\"synthetic_response_2\",\"responseSchemaSha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"requestSignatureSha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"safetyRuleVersion\":\"GC-MEMBER-CONVERSATION-SAFETY-1\",\"safetySourceRuleVersion\":\"GC-MEMBER-CONVERSATION-SAFETY-RULES-1\",\"memberTurn\":\"How should I start?\",\"controls\":{\"background\":false,\"conversation\":null,\"maxOutputTokens\":512,\"metadata\":null,\"previousResponseId\":null,\"promptCachePolicy\":{\"version\":\"GC-MEMBER-CONVERSATION-OPENAI-PROMPT-CACHE-POLICY-1\",\"mode\":\"explicit\",\"breakpointCount\":0},\"store\":false,\"stream\":false,\"tools\":[],\"truncation\":\"disabled\"},\"regionPolicy\":\"synthetic-region-2\"}";
  assert.equal(Buffer.byteLength(canonical, "utf8"), 1067);
  assert.equal(
    createHash("sha256").update(canonical, "utf8").digest("hex"),
    "35874ca2a686e000c43a9b3fcd581d3fe250f040820d93d186ebeef26001bea7"
  );
});

test("new V2 modules and deterministic helper remain absent from production startup", () => {
  const root = path.resolve(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const startup = fs.readFileSync(path.join(
    root, "src", "goals-coach", "gymmaster-member-conversation-turn-startup.js"
  ), "utf8");
  for (const source of [server, startup]) {
    assert.doesNotMatch(source, /member-conversation-provider-request-envelope-v2/);
    assert.doesNotMatch(source, /member-conversation-openai-prompt-cache-policy/);
    assert.doesNotMatch(source, /deterministic-member-conversation-provider-request-v2/);
  }
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});
