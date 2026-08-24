"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { getEventListeners } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createTerminalState } = require("../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION,
  MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
  createMemberConversationOpenAIResponsesAdapter,
  createMemberConversationOpenAIResponsesClient,
  validMemberConversationOpenAIResponsesAdapter,
  validMemberConversationOpenAIResponsesClient,
} = require("../src/goals-coach/member-conversation-openai-responses-adapter");
const {
  createMemberConversationProviderResultAuthority,
  readMemberConversationProviderResult,
  validMemberConversationProviderResultAuthority,
} = require("../src/goals-coach/member-conversation-provider-result");
const {
  createDeterministicMemberConversationOpenAIResponsesClient,
} = require("./helpers/deterministic-member-conversation-openai-responses-client");
const {
  createDeterministicMemberConversationProviderRequest,
} = require("./helpers/deterministic-member-conversation-provider-request");

const developerPrompt = "Return concise coaching that respects deterministic safety.";
const responseSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["coaching"]),
  properties: Object.freeze({ coaching: Object.freeze({ type: "string" }) }),
});
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function policy(overrides = {}) {
  return {
    model: "synthetic-model-1",
    developerPromptVersion: "synthetic-prompt-1",
    developerPromptSha256: sha256(developerPrompt),
    developerPrompt,
    responseSchemaVersion: "synthetic-response-1",
    responseSchemaSha256: sha256(JSON.stringify(responseSchema)),
    responseSchema,
    maxOutputTokens: 512,
    regionPolicy: "synthetic-region-1",
    finalizationReserveMilliseconds: 100,
    timeoutMilliseconds: 1000,
    ...overrides,
  };
}

function operation(milliseconds = 5000) {
  const controller = new AbortController();
  return {
    controller,
    value: Object.freeze({
      outerDeadlineNs: process.hrtime.bigint() + BigInt(milliseconds) * 1000000n,
      signal: controller.signal,
    }),
  };
}

function setup(clientOptions = {}, adapterOverrides = {}) {
  const request = createDeterministicMemberConversationProviderRequest({
    developerPromptSha256: sha256(developerPrompt),
    responseSchemaSha256: sha256(JSON.stringify(responseSchema)),
  }).request;
  const terminalState = createTerminalState();
  const authority = createMemberConversationProviderResultAuthority({ request, terminalState });
  const fake = createDeterministicMemberConversationOpenAIResponsesClient(clientOptions);
  const adapter = createMemberConversationOpenAIResponsesAdapter({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION,
    client: fake.client,
    policy: policy(),
    ...adapterOverrides,
  });
  return { adapter, authority, fake, request, terminalState };
}

test("factory creates one frozen dormant privately branded adapter and client", () => {
  const created = setup();
  assert.equal(validMemberConversationOpenAIResponsesAdapter(created.adapter), true);
  assert.equal(validMemberConversationOpenAIResponsesClient(created.fake.client), true);
  assert.equal(Object.isFrozen(created.adapter), true);
  assert.deepEqual({ ...created.adapter }, {
    execute: created.adapter.execute,
    externalCallsPermitted: true,
    model: "synthetic-model-1",
    provider: "openai",
    providerFree: false,
    responseSchemaVersion: "synthetic-response-1",
    runtimeWired: false,
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION,
  });
  assert.equal(createMemberConversationOpenAIResponsesClient({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
    createResponse: "not-a-function",
  }), null);
  assert.equal(validMemberConversationOpenAIResponsesAdapter(Object.freeze({
    ...created.adapter,
  })), false);
});

test("one offline call emits only the exact privately branded provider result", async () => {
  const created = setup();
  const token = await created.adapter.execute({
    authority: created.authority,
    request: created.request,
  }, operation().value);
  assert.ok(token);
  assert.deepEqual(Object.keys(token), []);
  assert.equal(JSON.stringify(token), "{}");
  assert.equal(created.fake.calls.length, 1);
  assert.deepEqual(readMemberConversationProviderResult(token, created.authority), {
    attemptId: created.request.attemptId,
    coaching: "Use a controlled range and stop if symptoms change.",
    providerRequestId: "synthetic-openai-request-1",
    providerResponseId: "synthetic-openai-response-1",
    providerResultDigestSha256: sha256(JSON.stringify({
      coaching: "Use a controlled range and stop if symptoms change.",
    })),
    requestEnvelopeDigestSha256: sha256(JSON.stringify(created.request)),
    version: "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-1",
  });
});

test("captured request is minimized, stateless, exact, and provider-identity free", async () => {
  const created = setup();
  await created.adapter.execute(
    { authority: created.authority, request: created.request }, operation().value
  );
  const captured = created.fake.calls[0];
  assert.equal(captured.signal instanceof AbortSignal, true);
  assert.equal(captured.signal.aborted, false);
  assert.deepEqual({ ...captured, signal: undefined }, {
    body: {
      model: "synthetic-model-1",
      input: [
        { role: "developer", content: developerPrompt },
        { role: "user", content: "Synthetic member turn." },
      ],
      text: { format: {
        type: "json_schema", name: "synthetic-response-1", strict: true,
        schema: responseSchema,
      } },
      max_output_tokens: 512,
      store: false,
      background: false,
      stream: false,
      truncation: "disabled",
      tools: [],
    },
    clientRequestId: created.request.attemptId,
    regionPolicy: "synthetic-region-1",
    signal: undefined,
  });
  const serialized = JSON.stringify(captured);
  for (const prohibited of ["memberId", "sessionId", "conversation", "binding",
    "idempotency", "requestSignature", "safetyRule", "credential", "metadata",
    "previous_response_id"]) assert.doesNotMatch(serialized, new RegExp(prohibited, "i"));
});

test("policy, request, brand, and unknown-key drift fail before the client", async () => {
  const invalidPolicies = [
    { developerPromptSha256: "a".repeat(64) },
    { responseSchemaSha256: "b".repeat(64) },
    { maxOutputTokens: 0 },
    { finalizationReserveMilliseconds: 0 },
    { finalizationReserveMilliseconds: 1000 },
    { timeoutMilliseconds: 0 },
    { timeoutMilliseconds: 25001 },
    { regionPolicy: "" },
    { responseSchema: { ...responseSchema, additionalProperties: true } },
    { responseSchema: { ...responseSchema, unknown: true } },
  ];
  for (const override of invalidPolicies) {
    const created = setup({}, { policy: policy(override) });
    assert.equal(created.adapter, null);
    assert.equal(created.fake.calls.length, 0);
  }
  const mismatched = setup({}, { policy: policy({ model: "different-model" }) });
  assert.ok(mismatched.adapter);
  assert.equal(await mismatched.adapter.execute({
    authority: mismatched.authority, request: mismatched.request,
  }, operation().value), null);
  assert.equal(mismatched.fake.calls.length, 0);
  const created = setup();
  assert.equal(await created.adapter.execute({
    authority: created.authority, request: Object.freeze({ ...created.request }),
  }, operation().value), null);
  assert.equal(await created.adapter.execute({
    authority: created.authority, request: created.request, unknown: true,
  }, operation().value), null);
  assert.equal(await created.adapter.execute({
    authority: created.authority, request: created.request,
  }, { outerDeadlineNs: process.hrtime.bigint() + 1000000n }), null);
  assert.equal(await created.adapter.execute({
    authority: created.authority, request: created.request,
  }, { outerDeadlineNs: process.hrtime.bigint() + 1000000n,
    signal: new AbortController().signal, unknown: true }), null);
  assert.equal(created.fake.calls.length, 0);
});

test("malformed, unsafe, or extra provider output fails closed after one call", async () => {
  const invalidResults = [
    { providerRequestId: "request", providerResponseId: "response", output: {} },
    { providerRequestId: "bad id", providerResponseId: "response", output: { coaching: "Valid." } },
    { providerRequestId: "request", providerResponseId: "response", output: { coaching: " padded " } },
    { providerRequestId: "request", providerResponseId: "response", output: { coaching: "Valid.", extra: true } },
    { providerRequestId: "request", providerResponseId: "response", output: { coaching: "Valid." }, extra: true },
  ];
  for (const result of invalidResults) {
    const created = setup({ result });
    assert.equal(await created.adapter.execute(
      { authority: created.authority, request: created.request }, operation().value
    ), null);
    assert.equal(created.fake.calls.length, 1);
    assert.equal(validMemberConversationProviderResultAuthority(created.authority), false);
    assert.equal(await created.adapter.execute(
      { authority: created.authority, request: created.request }, operation().value
    ), null);
    assert.equal(created.fake.calls.length, 1);
  }
  const failed = setup({ error: new Error("synthetic client failure") });
  assert.equal(await failed.adapter.execute(
    { authority: failed.authority, request: failed.request }, operation().value
  ), null);
  assert.equal(failed.fake.calls.length, 1);
  assert.equal(validMemberConversationProviderResultAuthority(failed.authority), false);
  assert.equal(await failed.adapter.execute(
    { authority: failed.authority, request: failed.request }, operation().value
  ), null);
  assert.equal(failed.fake.calls.length, 1);
});

test("terminal revocation while the fake is pending discards the late result", async () => {
  const created = setup({ pending: true });
  const pending = created.adapter.execute(
    { authority: created.authority, request: created.request }, operation().value
  );
  while (created.fake.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  created.terminalState.terminate("synthetic_abort", { responseAllowed: false });
  created.fake.release();
  assert.equal(await pending, null);
  assert.equal(created.fake.calls.length, 1);
});

test("bounded timeout aborts the one client call and permanently revokes authority", async () => {
  const created = setup({ pending: true }, { policy: policy({
    finalizationReserveMilliseconds: 1, timeoutMilliseconds: 5,
  }) });
  assert.equal(await created.adapter.execute({
    authority: created.authority, request: created.request,
  }, operation().value), null);
  assert.equal(created.fake.calls.length, 1);
  assert.equal(created.fake.calls[0].signal.aborted, true);
  assert.equal(validMemberConversationProviderResultAuthority(created.authority), false);
  created.fake.release();
});

test("one authority permits at most one sequential or concurrent client call", async () => {
  const sequential = setup();
  const first = await sequential.adapter.execute(
    { authority: sequential.authority, request: sequential.request }, operation().value
  );
  assert.ok(first);
  assert.equal(await sequential.adapter.execute(
    { authority: sequential.authority, request: sequential.request }, operation().value
  ), null);
  assert.equal(sequential.fake.calls.length, 1);

  const concurrent = setup({ pending: true });
  const shared = operation();
  const winner = concurrent.adapter.execute(
    { authority: concurrent.authority, request: concurrent.request }, shared.value
  );
  const loser = concurrent.adapter.execute(
    { authority: concurrent.authority, request: concurrent.request }, shared.value
  );
  assert.equal(await loser, null);
  while (concurrent.fake.calls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(concurrent.fake.calls.length, 1);
  concurrent.fake.release();
  assert.ok(await winner);
  assert.equal(concurrent.fake.calls.length, 1);
});

test("shared abort cancels the client, suppresses late results, and cleans listeners", async () => {
  const created = setup({ pending: true });
  const shared = operation();
  const pending = created.adapter.execute(
    { authority: created.authority, request: created.request }, shared.value
  );
  while (created.fake.calls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(getEventListeners(shared.controller.signal, "abort").length, 1);
  shared.controller.abort();
  assert.equal(await pending, null);
  assert.equal(created.fake.calls[0].signal.aborted, true);
  assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
  assert.equal(validMemberConversationProviderResultAuthority(created.authority), false);
  assert.equal(await created.adapter.execute(
    { authority: created.authority, request: created.request }, operation().value
  ), null);
  assert.equal(created.fake.calls.length, 1);
  created.fake.release();
});

test("shared outer deadline bounds the client and expired operations never contact", async () => {
  const expired = setup();
  const expiredController = new AbortController();
  const expiredOperation = Object.freeze({
    outerDeadlineNs: process.hrtime.bigint() - 1n,
    signal: expiredController.signal,
  });
  assert.equal(await expired.adapter.execute(
    { authority: expired.authority, request: expired.request }, expiredOperation
  ), null);
  assert.equal(expired.fake.calls.length, 0);
  assert.equal(validMemberConversationProviderResultAuthority(expired.authority), false);

  const bounded = setup({ pending: true });
  const shared = operation(5);
  assert.equal(await bounded.adapter.execute(
    { authority: bounded.authority, request: bounded.request }, shared.value
  ), null);
  assert.equal(bounded.fake.calls.length, 1);
  assert.equal(bounded.fake.calls[0].signal.aborted, true);
  assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
  assert.equal(validMemberConversationProviderResultAuthority(bounded.authority), false);
  bounded.fake.release();
});

test("source is offline and production remains null, unwired, and import-free", () => {
  const root = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "src", "goals-coach",
    "member-conversation-openai-responses-adapter.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'](?:openai|node-fetch|https?|net|tls)["']\)/);
  assert.doesNotMatch(source, /process\.env|Authorization|Bearer|fetch\(/);
  for (const relative of [
    "server.js",
    "src/goals-coach/gymmaster-member-conversation-turn-startup.js",
    "src/goals-coach/member-conversation-provider-dispatch-composition.js",
    "src/goals-coach/member-conversation-provider-orchestrator.js",
  ]) {
    const production = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(production, /member-conversation-openai-responses-adapter/);
    assert.doesNotMatch(production, /deterministic-member-conversation-openai-responses-client/);
  }
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});
