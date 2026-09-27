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
  createMemberConversationOpenAIResponsesAdapter,
  createMemberConversationOpenAIResponsesRequest,
} = require("../src/goals-coach/member-conversation-openai-responses-adapter");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_VERSION,
  createMemberConversationOpenAIResponsesTransport,
} = require("../src/goals-coach/member-conversation-openai-responses-transport");
const {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION,
} = require("../src/goals-coach/member-conversation-provider-output-policy");
const {
  validMemberConversationProviderTransport,
} = require("../src/goals-coach/member-conversation-provider-transport");
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

function policy() {
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
  };
}

function setup(clientOptions = {}, transportOverrides = {}) {
  const prepared = createDeterministicMemberConversationProviderRequest({
    developerPromptSha256: sha256(developerPrompt),
    responseSchemaSha256: sha256(JSON.stringify(responseSchema)),
  });
  const fake = createDeterministicMemberConversationOpenAIResponsesClient(clientOptions);
  const adapter = createMemberConversationOpenAIResponsesAdapter({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION,
    client: fake.client,
    policy: policy(),
  });
  const transport = createMemberConversationOpenAIResponsesTransport({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_VERSION,
    adapter,
    turnRequest: prepared.input.turnRequest,
    turnResponse: prepared.input.turnResponse,
    ...transportOverrides,
  });
  return { adapter, fake, prepared, transport };
}

function dispatchRequest(created, overrides = {}) {
  const request = created.prepared.request;
  return Object.freeze({
    attemptId: request.attemptId,
    clientRequestId: request.attemptId,
    contractVersion: created.prepared.input.turnRequest.contractVersion,
    conversation: created.prepared.input.turnRequest.conversation,
    model: request.model,
    provider: "openai",
    requestSignatureSha256: request.requestSignatureSha256,
    responseSchemaVersion: request.responseSchemaVersion,
    safetyRuleVersion: request.safetyRuleVersion,
    safetySourceRuleVersion: request.safetySourceRuleVersion,
    transportVersion: request.transportVersion,
    ...overrides,
  });
}

function operation(milliseconds = 5000) {
  const controller = new AbortController();
  const terminalState = createTerminalState();
  return {
    controller,
    terminalState,
    value: Object.freeze({
      outerDeadlineNs: process.hrtime.bigint() + BigInt(milliseconds) * 1000000n,
      signal: controller.signal,
      terminalState,
    }),
  };
}

test("factory creates the existing frozen branded transport without I/O", () => {
  const created = setup();
  assert.ok(created.transport);
  assert.equal(validMemberConversationProviderTransport(created.transport), true);
  assert.equal(Object.isFrozen(created.transport), true);
  assert.equal(created.fake.calls.length, 0);
  assert.deepEqual({ ...created.transport }, {
    dispatch: created.transport.dispatch,
    externalCallsPermitted: true,
    model: "synthetic-model-1",
    provider: "openai",
    providerFree: false,
    responseSchemaVersion: "synthetic-response-1",
    runtimeWired: false,
    version: "GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-1",
  });
});

test("factory rejects lookalikes, unknown keys, and mismatched turn provenance", () => {
  const created = setup();
  const base = {
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_VERSION,
    adapter: created.adapter,
    turnRequest: created.prepared.input.turnRequest,
    turnResponse: created.prepared.input.turnResponse,
  };
  assert.equal(createMemberConversationOpenAIResponsesTransport({
    ...base, adapter: Object.freeze({ ...created.adapter }),
  }), null);
  assert.equal(createMemberConversationOpenAIResponsesTransport({
    ...base, unknown: true,
  }), null);
  assert.equal(createMemberConversationOpenAIResponsesTransport({
    ...base,
    turnResponse: Object.freeze({
      ...created.prepared.input.turnResponse,
      requestId: "20000000-0000-4000-8000-000000000002",
    }),
  }), null);
  assert.equal(created.fake.calls.length, 0);
});

test("one exact dispatch emits strict RESPONSE-2 and provider provenance", async () => {
  const created = setup();
  const assignedAttempt = "10000000-0000-4000-8000-000000000099";
  const result = await created.transport.dispatch(dispatchRequest(created, {
    attemptId: assignedAttempt,
    clientRequestId: assignedAttempt,
  }), operation().value);
  assert.equal(created.fake.calls.length, 1);
  assert.equal(result.category, "succeeded");
  assert.equal(result.providerRequestId, "synthetic-openai-request-1");
  assert.equal(result.providerResponseId, "synthetic-openai-response-1");
  assert.equal(result.response.contractVersion, "GC-MEMBER-CONVERSATION-TURN-RESPONSE-2");
  assert.equal(result.response.requestId, created.prepared.input.turnRequest.requestId);
  assert.equal(result.response.coaching,
    "Use a controlled range and stop if symptoms change.");
  assert.deepEqual(result.response.result, created.prepared.input.turnResponse.result);
  assert.equal(created.fake.calls[0].clientRequestId, assignedAttempt);
});

test("definite provider rejection reaches the existing exact transport category", async () => {
  for (const terminalCategory of [
    "authentication_rejected", "rate_limited", "request_rejected",
  ]) {
    const created = setup({ result: {
      classification: terminalCategory,
      providerRequestId: "synthetic-openai-request-1",
    } });
    assert.deepEqual(await created.transport.dispatch(
      dispatchRequest(created), operation().value
    ), {
      category: "rejected",
      providerRequestId: "synthetic-openai-request-1",
      terminalCategory,
    });
    assert.equal(created.fake.calls.length, 1);
  }
});

test("turn binding and transport metadata drift fail before client contact", async () => {
  const created = setup();
  assert.equal(createMemberConversationOpenAIResponsesTransport({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_TRANSPORT_VERSION,
    adapter: created.adapter,
    request: created.prepared.request,
    turnRequest: { ...created.prepared.input.turnRequest,
      memberText: "Different safe text." },
    turnResponse: created.prepared.input.turnResponse,
  }), null);
  assert.equal(await created.transport.dispatch(
    dispatchRequest(created, { requestSignatureSha256: "f".repeat(64) }),
    operation().value
  ).then((value) => value.category), "not_contacted");
  assert.equal(await created.transport.dispatch(Object.freeze({
    ...dispatchRequest(created),
    conversation: Object.freeze({
      ...created.prepared.input.turnRequest.conversation,
      unknown: true,
    }),
  }), operation().value).then((value) => value.category), "not_contacted");
  assert.equal(created.fake.calls.length, 0);
});

test("one transport permits at most one sequential or concurrent provider call", async () => {
  const sequential = setup();
  assert.equal((await sequential.transport.dispatch(
    dispatchRequest(sequential), operation().value
  )).category, "succeeded");
  assert.equal((await sequential.transport.dispatch(
    dispatchRequest(sequential), operation().value
  )).category, "indeterminate");
  assert.equal(sequential.fake.calls.length, 1);

  const concurrent = setup({ pending: true });
  const shared = operation();
  const first = concurrent.transport.dispatch(dispatchRequest(concurrent), shared.value);
  const second = concurrent.transport.dispatch(dispatchRequest(concurrent), shared.value);
  assert.equal((await second).category, "indeterminate");
  while (concurrent.fake.calls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  concurrent.fake.release();
  assert.equal((await first).category, "succeeded");
  assert.equal(concurrent.fake.calls.length, 1);
});

test("abort and terminal revocation cancel the client and suppress late success", async () => {
  for (const terminate of ["signal", "terminal"]) {
    const created = setup({ pending: true });
    const shared = operation();
    const pending = created.transport.dispatch(dispatchRequest(created), shared.value);
    while (created.fake.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (terminate === "signal") shared.controller.abort();
    else shared.terminalState.terminate("synthetic_terminal", { responseAllowed: false });
    assert.equal((await pending).category, "indeterminate");
    assert.equal(created.fake.calls[0].signal.aborted, true);
    assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
    created.fake.release();
  }
});

test("expired operations and invalid provider output remain fail-closed", async () => {
  const expired = setup();
  const shared = operation();
  const value = Object.freeze({ ...shared.value,
    outerDeadlineNs: process.hrtime.bigint() - 1n });
  assert.equal((await expired.transport.dispatch(
    dispatchRequest(expired), value
  )).category, "not_contacted");
  assert.equal(expired.fake.calls.length, 0);

  const invalid = setup({ result: {
    providerRequestId: "request",
    providerResponseId: "response",
    output: { coaching: "Push through sharp pain." },
  } });
  assert.equal((await invalid.transport.dispatch(
    dispatchRequest(invalid), operation().value
  )).category, "indeterminate");
  assert.equal(invalid.fake.calls.length, 1);
});

test("integration remains offline, test-only, and absent from production startup", () => {
  const root = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "src", "goals-coach",
    "member-conversation-openai-responses-transport.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'](?:openai|node-fetch|https?|net|tls)["']\)/);
  assert.doesNotMatch(source, /process\.env|Authorization|Bearer|fetch\(/);
  for (const relative of [
    "server.js",
    "src/goals-coach/gymmaster-member-conversation-turn-startup.js",
    "src/goals-coach/member-conversation-provider-dispatch-composition.js",
    "src/goals-coach/member-conversation-provider-orchestrator.js",
  ]) {
    const production = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(production, /member-conversation-openai-responses-transport/);
  }
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});
