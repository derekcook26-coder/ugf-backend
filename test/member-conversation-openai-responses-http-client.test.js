"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { getEventListeners } = require("node:events");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
  createMemberConversationOpenAIHTTPClient,
} = require("../src/goals-coach/member-conversation-openai-http-client");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_CLIENT_VERSION,
  createMemberConversationOpenAIResponsesHTTPClient,
} = require("../src/goals-coach/member-conversation-openai-responses-http-client");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION,
  createMemberConversationOpenAIResponsesAdapter,
  validMemberConversationOpenAIResponsesClient,
} = require("../src/goals-coach/member-conversation-openai-responses-adapter");
const {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION,
} = require("../src/goals-coach/member-conversation-provider-output-policy");
const { createTerminalState } = require("../src/goals-coach/bounded-postgres-transaction");
const {
  createMemberConversationProviderResultAuthority,
  readMemberConversationProviderResult,
} = require("../src/goals-coach/member-conversation-provider-result");
const {
  createDeterministicMemberConversationOpenAICredentialResolver,
} = require("./helpers/deterministic-member-conversation-openai-credential-resolver");
const {
  createDeterministicMemberConversationOpenAIHTTPInterface,
} = require("./helpers/deterministic-member-conversation-openai-http-interface");
const {
  createDeterministicMemberConversationProviderRequest,
} = require("./helpers/deterministic-member-conversation-provider-request");

const attemptId = "10000000-0000-4000-8000-000000000001";
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function providerOutcome(options = {}) {
  const providerBody = options.body || {
    id: "resp_synthetic_1",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [{
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        annotations: [],
        text: JSON.stringify({ coaching: "Move with steady control." }),
      }],
    }],
  };
  const body = Buffer.from(JSON.stringify(providerBody), "utf8");
  return Object.freeze({
    body,
    complete: true,
    contacted: true,
    decompressedBytes: body.byteLength,
    headers: Object.freeze({
      "content-type": "application/json",
      "x-request-id": options.providerRequestId || "req_synthetic_1",
    }),
    kind: "response",
    redirected: false,
    statusCode: options.statusCode || 200,
  });
}

function created(options = {}) {
  const resolver = createDeterministicMemberConversationOpenAICredentialResolver(
    options.resolver || {}
  );
  const fake = createDeterministicMemberConversationOpenAIHTTPInterface({
    outcome: options.outcome || providerOutcome(),
    pending: options.pending,
  });
  const httpClient = createMemberConversationOpenAIHTTPClient({
    version: MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
    http: fake.http,
    origin: "https://api.openai.com",
    requestHeaderMaximumBytes: 4096,
    requestBodyMaximumBytes: 8192,
    responseHeaderMaximumBytes: 4096,
    responseBodyMaximumBytes: 8192,
    timeoutMilliseconds: 1000,
    finalizationReserveMilliseconds: 100,
  });
  const client = createMemberConversationOpenAIResponsesHTTPClient({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_CLIENT_VERSION,
    resolver: resolver.resolver,
    httpClient,
  });
  return { client, fake, resolver };
}

function request(signal) {
  return Object.freeze({
    body: Object.freeze({ model: "synthetic-model", input: [] }),
    clientRequestId: attemptId,
    regionPolicy: "synthetic-region",
    signal,
  });
}

function operation(signal, milliseconds = 5000) {
  return Object.freeze({
    outerDeadlineNs: process.hrtime.bigint() + BigInt(milliseconds) * 1000000n,
    signal,
  });
}

test("offline bridge is branded and rejects dependency lookalikes", () => {
  const value = created().client;
  assert.equal(validMemberConversationOpenAIResponsesClient(value), true);
  assert.equal(value.externalCallsPermitted, true);
  assert.equal(value.runtimeWired, false);
  assert.equal(createMemberConversationOpenAIResponsesHTTPClient({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_CLIENT_VERSION,
    resolver: {}, httpClient: {},
  }), null);
});

test("resolves one credential, performs one bounded request, and parses provenance", async () => {
  const value = created();
  const controller = new AbortController();
  const result = await value.client.createResponse(
    request(controller.signal), operation(controller.signal)
  );
  assert.deepEqual(result, {
    output: { coaching: "Move with steady control." },
    providerRequestId: "req_synthetic_1",
    providerResponseId: "resp_synthetic_1",
  });
  assert.equal(value.resolver.calls.length, 1);
  assert.equal(value.fake.calls.length, 1);
  assert.equal(value.fake.calls[0].authorizationPresent, true);
  assert.equal(value.fake.calls[0].clientRequestId, attemptId);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("the genuine adapter consumes the bridge and emits one private provider result", async () => {
  const value = created();
  const developerPrompt = "Return concise coaching that respects deterministic safety.";
  const responseSchema = Object.freeze({
    type: "object", additionalProperties: false,
    required: Object.freeze(["coaching"]),
    properties: Object.freeze({
      coaching: Object.freeze({ type: "string", maxLength: 800 }),
    }),
  });
  const prepared = createDeterministicMemberConversationProviderRequest({
    developerPromptSha256: digest(developerPrompt),
    responseSchemaSha256: digest(JSON.stringify(responseSchema)),
  });
  const authority = createMemberConversationProviderResultAuthority({
    request: prepared.request,
    terminalState: createTerminalState(),
  });
  const adapter = createMemberConversationOpenAIResponsesAdapter({
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION,
    client: value.client,
    policy: {
      model: "synthetic-model-1",
      developerPromptVersion: "synthetic-prompt-1",
      developerPromptSha256: digest(developerPrompt),
      developerPrompt,
      responseSchemaVersion: "synthetic-response-1",
      responseSchemaSha256: digest(JSON.stringify(responseSchema)),
      responseSchema,
      maxOutputTokens: 512,
      regionPolicy: "synthetic-region-1",
      outputPolicyVersion: MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION,
      finalizationReserveMilliseconds: 100,
      timeoutMilliseconds: 1000,
    },
  });
  const controller = new AbortController();
  const result = await adapter.execute({ authority, request: prepared.request },
    operation(controller.signal));
  assert.ok(result);
  assert.deepEqual(readMemberConversationProviderResult(result, authority), {
    attemptId,
    coaching: "Move with steady control.",
    providerRequestId: "req_synthetic_1",
    providerResponseId: "resp_synthetic_1",
    providerResultDigestSha256: digest(JSON.stringify({
      coaching: "Move with steady control.",
    })),
    requestEnvelopeDigestSha256: digest(JSON.stringify(prepared.request)),
    version: "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-1",
  });
  assert.equal(value.resolver.calls.length, 1);
  assert.equal(value.fake.calls.length, 1);
});

test("malformed or unbound provider responses fail closed after one call", async () => {
  for (const outcome of [
    providerOutcome({ providerRequestId: "bad id" }),
    providerOutcome({ body: {
      id: "resp", object: "response", status: "incomplete", error: null,
      incomplete_details: { reason: "max_output_tokens" }, output: [],
    } }),
    providerOutcome({ body: {
      id: "resp", object: "response", status: "completed", error: null,
      incomplete_details: null, output: [{
        type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", annotations: [], text: "not-json" }],
      }],
    } }),
    providerOutcome({ statusCode: 500 }),
  ]) {
    const value = created({ outcome });
    const controller = new AbortController();
    assert.equal(await value.client.createResponse(
      request(controller.signal), operation(controller.signal)
    ), null);
    assert.equal(value.resolver.calls.length, 1);
    assert.equal(value.fake.calls.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("pre-aborted and expired operations perform no credential or HTTP call", async () => {
  const value = created();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await value.client.createResponse(
    request(controller.signal), operation(controller.signal)
  ), null);
  assert.equal(value.resolver.calls.length, 0);
  assert.equal(value.fake.calls.length, 0);

  const another = created();
  const active = new AbortController();
  assert.equal(await another.client.createResponse(
    request(active.signal), operation(active.signal, -1)
  ), null);
  assert.equal(another.resolver.calls.length, 0);
  assert.equal(another.fake.calls.length, 0);
});

test("abort while HTTP is pending suppresses late settlement and cleans listeners", async () => {
  const value = created({ pending: true });
  const controller = new AbortController();
  const pending = value.client.createResponse(
    request(controller.signal), operation(controller.signal)
  );
  while (value.fake.calls.length === 0) await new Promise(setImmediate);
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(value.fake.calls.length, 1);
  assert.equal(value.fake.calls[0].signal.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  value.fake.release();
});
