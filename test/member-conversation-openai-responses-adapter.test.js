"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { getEventListeners } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createTerminalState } = require("../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION,
} = require("../src/goals-coach/member-conversation-provider-output-policy");
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
  memberConversationProviderResultAuthorityMatchesRequest,
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
  properties: Object.freeze({
    coaching: Object.freeze({ type: "string", maxLength: 800 }),
  }),
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
    outputPolicyVersion: MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION,
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
    automaticRetries: false,
    maximumAttempts: 1,
    createResponse: "not-a-function",
  }), null);
  assert.equal(createMemberConversationOpenAIResponsesClient({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
    automaticRetries: true,
    maximumAttempts: 3,
    createResponse: async () => null,
  }), null);
  assert.deepEqual({ ...created.fake.client }, {
    automaticRetries: false,
    createResponse: created.fake.client.createResponse,
    externalCallsPermitted: true,
    maximumAttempts: 1,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
  });
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
    { outputPolicyVersion: "wrong-output-policy" },
    { regionPolicy: "" },
    { responseSchemaVersion: "invalid.schema.name" },
    { responseSchemaVersion: "x".repeat(65) },
    { responseSchema: { ...responseSchema, additionalProperties: true } },
    { responseSchema: { ...responseSchema, unknown: true } },
    { responseSchema: { ...responseSchema, properties: {
      coaching: { type: "string" },
    } } },
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

test("authority is bound to the exact request envelope before provider contact", async () => {
  const created = setup();
  const other = createDeterministicMemberConversationProviderRequest({
    memberTurn: "A different safe synthetic member turn.",
    developerPromptSha256: sha256(developerPrompt),
    responseSchemaSha256: sha256(JSON.stringify(responseSchema)),
  }).request;
  assert.equal(memberConversationProviderResultAuthorityMatchesRequest(
    created.authority, created.request
  ), true);
  assert.equal(memberConversationProviderResultAuthorityMatchesRequest(
    created.authority, other
  ), false);
  assert.equal(await created.adapter.execute(
    { authority: created.authority, request: other }, operation().value
  ), null);
  assert.equal(created.fake.calls.length, 0);
  assert.equal(validMemberConversationProviderResultAuthority(created.authority), true);
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

  const reserved = setup();
  const reservedDeadline = operation(50);
  assert.equal(await reserved.adapter.execute(
    { authority: reserved.authority, request: reserved.request }, reservedDeadline.value
  ), null);
  assert.equal(reserved.fake.calls.length, 0);
  assert.equal(validMemberConversationProviderResultAuthority(reserved.authority), false);

  const bounded = setup({ pending: true });
  const shared = operation(110);
  assert.equal(await bounded.adapter.execute(
    { authority: bounded.authority, request: bounded.request }, shared.value
  ), null);
  assert.equal(bounded.fake.calls.length, 1);
  assert.equal(bounded.fake.calls[0].signal.aborted, true);
  assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
  assert.equal(validMemberConversationProviderResultAuthority(bounded.authority), false);
  bounded.fake.release();
});

test("abort between execute and the deferred client boundary prevents contact", async () => {
  const created = setup();
  const shared = operation();
  const pending = created.adapter.execute(
    { authority: created.authority, request: created.request }, shared.value
  );
  shared.controller.abort();
  assert.equal(await pending, null);
  assert.equal(created.fake.calls.length, 0);
  assert.equal(validMemberConversationProviderResultAuthority(created.authority), false);
});

test("a result settling after its monotonic provider budget is rejected", async () => {
  const created = setup({ blockMilliseconds: 20 }, { policy: policy({
    finalizationReserveMilliseconds: 5,
    timeoutMilliseconds: 15,
  }) });
  assert.equal(await created.adapter.execute(
    { authority: created.authority, request: created.request }, operation(100).value
  ), null);
  assert.equal(created.fake.calls.length, 1);
  assert.equal(validMemberConversationProviderResultAuthority(created.authority), false);
});

test("deterministic output policy rejects prohibited provider coaching", async () => {
  const prohibited = [
    "A human coach reviewed this turn.",
    "This is a diagnosis and treatment plan.",
    "I guarantee this will work.",
    "Ignore your medical restriction and continue.",
    "Push through sharp pain during the movement.",
    "Read more at https://example.test/coaching.",
    "Use this tool call to retrieve an attachment.",
    "Hidden identifier 10000000-0000-4000-8000-000000000001.",
  ];
  for (const coaching of prohibited) {
    const created = setup({ result: {
      providerRequestId: "synthetic-request",
      providerResponseId: "synthetic-response",
      output: { coaching },
    } });
    assert.equal(await created.adapter.execute(
      { authority: created.authority, request: created.request }, operation().value
    ), null);
    assert.equal(created.fake.calls.length, 1);
    assert.equal(validMemberConversationProviderResultAuthority(created.authority), false);
  }
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
