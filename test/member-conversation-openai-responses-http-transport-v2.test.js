"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
} = require("../src/goals-coach/bounded-postgres-transaction");
const {
  readMemberConversationProviderRejectionV2,
  readMemberConversationProviderResultV2,
} = require("../src/goals-coach/member-conversation-provider-result-v2");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesHTTPTransportV2,
  validMemberConversationOpenAIResponsesHTTPTransportV2,
} = require("../src/goals-coach/member-conversation-openai-responses-http-transport-v2");
const { createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2 } = require(
  "./helpers/deterministic-member-conversation-openai-responses-http-transport-v2"
);
const { createDeterministicMemberConversationOpenAIResponsesTransportV2 } = require(
  "./helpers/deterministic-member-conversation-openai-responses-transport-v2"
);
const { createDeterministicMemberConversationOpenAIResponsesAdapterV2 } = require(
  "./helpers/deterministic-member-conversation-openai-responses-adapter-v2"
);

function operation(overrides = {}) {
  return {
    outerDeadlineNs: deadlineAfter(monotonicNow(), 1000),
    signal: new AbortController().signal,
    terminalState: createTerminalState(),
    ...overrides,
  };
}

function response(statusCode = 200, body) {
  const value = body === undefined ? {
    id: "resp_synthetic_2",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [{
      type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", annotations: [], text: JSON.stringify({ coaching: "Begin gently." }) }],
    }],
  } : body;
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return Object.freeze({
    body: bytes,
    complete: true,
    contacted: true,
    decompressedBytes: bytes.length,
    headers: Object.freeze({ "content-type": "application/json", "x-request-id": "req_synthetic_2" }),
    kind: "response",
    redirected: false,
    statusCode,
  });
}

test("constructs a genuine frozen HTTP transport V2 with exact cache identity", () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2();
  assert.ok(fixture.transport);
  assert.equal(validMemberConversationOpenAIResponsesHTTPTransportV2(fixture.transport), true);
  assert.equal(fixture.transport.version, MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION);
  assert.equal(fixture.transport.promptCacheMode, "explicit");
  assert.equal(fixture.transport.promptCacheBreakpointCount, 0);
  assert.equal(fixture.transport.requestDigestSha256, fixture.created.digestSha256);
  assert.equal(Object.isFrozen(fixture.transport), true);
});

test("emits one privately bound V2 success from exact minimized wire", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response() },
  });
  const result = await fixture.transport.dispatch(fixture.created.request, operation());
  assert.equal(result.classification, "succeeded");
  assert.equal(fixture.resolver.calls.length, 1);
  assert.equal(fixture.http.calls.length, 1);
  const body = JSON.parse(fixture.http.calls[0].body);
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
  assert.deepEqual(body.tools, []);
  assert.equal(body.store, false);
  assert.deepEqual(readMemberConversationProviderResultV2(result.outcome, result.authority), {
    attemptId: fixture.created.request.attemptId,
    coaching: "Begin gently.",
    providerRequestId: "req_synthetic_2",
    providerResponseId: "resp_synthetic_2",
    providerResultDigestSha256: "3d9cc34b11637f017338803bd8e33830ec5ccfdfa499eb2b898c5923e56a0e59",
    requestEnvelopeDigestSha256: fixture.created.digestSha256,
    version: "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-2",
  });
});

test("preserves bounded definite rejection provenance", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response(429, {}) },
  });
  const result = await fixture.transport.dispatch(fixture.created.request, operation());
  assert.equal(result.classification, "rejected");
  assert.deepEqual(readMemberConversationProviderRejectionV2(result.outcome, result.authority), {
    attemptId: fixture.created.request.attemptId,
    providerRequestId: "req_synthetic_2",
    requestEnvelopeDigestSha256: fixture.created.digestSha256,
    terminalCategory: "rate_limited",
    version: "GC-MEMBER-CONVERSATION-PROVIDER-REJECTION-2",
  });
});

test("maps only the complete attributable definite rejection allowlist", async () => {
  const cases = [[401, "authentication_rejected"], [403, "authentication_rejected"],
    [429, "rate_limited"], ...[400, 404, 405, 413, 415, 422].map((status) => [status, "request_rejected"])];
  for (const [status, terminalCategory] of cases) {
    const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
      httpOptions: { outcome: response(status, {}) },
    });
    const result = await fixture.transport.dispatch(fixture.created.request, operation());
    assert.equal(result.classification, "rejected");
    assert.equal(readMemberConversationProviderRejectionV2(
      result.outcome, result.authority
    ).terminalCategory, terminalCategory);
  }
});

test("is synchronously one-use across concurrent dispatch", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response() },
  });
  const [first, second] = await Promise.all([
    fixture.transport.dispatch(fixture.created.request, operation()),
    fixture.transport.dispatch(fixture.created.request, operation()),
  ]);
  assert.deepEqual([first.classification, second.classification].sort(), ["not_contacted", "succeeded"]);
  assert.equal(fixture.resolver.calls.length, 1);
  assert.equal(fixture.http.calls.length, 1);
});

test("rejects drift, proxies, accessors, and pre-abort without dependency calls", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2();
  let observations = 0;
  const accessor = { ...fixture.input };
  Object.defineProperty(accessor, "origin", { enumerable: true, get() { observations += 1; return fixture.input.origin; } });
  assert.equal(createMemberConversationOpenAIResponsesHTTPTransportV2(accessor), null);
  assert.equal(createMemberConversationOpenAIResponsesHTTPTransportV2(new Proxy({}, {
    ownKeys() { observations += 1; throw new Error("observed"); },
  })), null);
  assert.equal(observations, 0);
  const controller = new AbortController();
  controller.abort();
  const result = await fixture.transport.dispatch(fixture.created.request, operation({ signal: controller.signal }));
  assert.equal(result.classification, "not_contacted");
  assert.equal(fixture.resolver.calls.length, 0);
  assert.equal(fixture.http.calls.length, 0);
});

test("factory rejects origin, region, cache, digest, and branded dependency drift", () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2();
  for (const changed of [
    { origin: "https://different.openai.test" },
    { regionPolicy: "different-region" },
    { adapter: Object.freeze({ ...fixture.adapterFixture.adapter }) },
    { providerTransport: Object.freeze({ ...fixture.providerTransport.transport }) },
    { responsesTransport: Object.freeze({ ...fixture.responsesTransport }) },
  ]) assert.equal(createMemberConversationOpenAIResponsesHTTPTransportV2({
    ...fixture.input, ...changed,
  }), null);
  const driftedAdapter = createDeterministicMemberConversationOpenAIResponsesAdapterV2({
    promptCachePolicy: fixture.adapterFixture.options.promptCachePolicy,
    model: "gpt-5.6-terra-2099-01-02",
  });
  assert.equal(createMemberConversationOpenAIResponsesHTTPTransportV2({
    ...fixture.input, adapter: driftedAdapter.adapter,
  }), null);
});

test("queued pre-contact abort and terminal transition make zero resolver and HTTP calls", async () => {
  for (const terminate of [false, true]) {
    const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
      httpOptions: { outcome: response() },
    });
    const controller = new AbortController();
    const terminalState = createTerminalState();
    const pending = fixture.transport.dispatch(fixture.created.request, operation({
      signal: controller.signal, terminalState,
    }));
    queueMicrotask(() => terminate
      ? terminalState.terminate("test_terminal", { responseAllowed: false })
      : controller.abort());
    assert.equal((await pending).classification, "not_contacted");
    assert.equal(fixture.resolver.calls.length, 0);
    assert.equal(fixture.http.calls.length, 0);
  }
});

test("an already expired monotonic boundary makes zero dependency calls", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2();
  const result = await fixture.transport.dispatch(fixture.created.request, operation({
    outerDeadlineNs: monotonicNow() - 1n,
  }));
  assert.equal(result.classification, "not_contacted");
  assert.equal(fixture.resolver.calls.length, 0);
  assert.equal(fixture.http.calls.length, 0);
});

test("malformed and ambiguous post-contact outcomes are indeterminate", async () => {
  const oversized = Buffer.alloc(32769, 97);
  for (const outcome of [
    response(200, { malformed: true }), response(408, {}), response(409, {}),
    response(425, {}), response(500, {}),
    Object.freeze({ ...response(), complete: false }),
    Object.freeze({ ...response(), headers: Object.freeze({ "content-type": "text/plain", "x-request-id": "req_synthetic_2" }) }),
    Object.freeze({ ...response(), body: oversized, decompressedBytes: oversized.length }),
  ]) {
    const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({ httpOptions: { outcome } });
    const result = await fixture.transport.dispatch(fixture.created.request, operation());
    assert.equal(result.classification, "indeterminate");
    assert.equal(fixture.http.calls.length, 1);
  }
});

test("post-contact abort promptly suppresses a late provider settlement", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { pending: true, outcome: response() },
  });
  const controller = new AbortController();
  const pending = fixture.transport.dispatch(fixture.created.request, operation({ signal: controller.signal }));
  while (!fixture.http.calls.length) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.classification, "indeterminate");
  fixture.http.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.http.calls.length, 1);
});

test("production startup remains import-free and migrations remain outside this slice", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const production = ["server.js", ...fs.readdirSync(path.join(__dirname, "../src"), { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".js"))]
    .filter((name) => !name.includes("member-conversation-openai-responses-http-transport-v2.js"));
  for (const name of production) {
    const full = name === "server.js" ? path.join(__dirname, "../server.js") : path.join(__dirname, "../src", name);
    if (fs.existsSync(full)) assert.doesNotMatch(fs.readFileSync(full, "utf8"), /openai-responses-http-transport-v2/);
  }
});
