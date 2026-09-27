"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
} = require("../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_ORCHESTRATOR_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesOrchestratorTransportV2,
} = require("../src/goals-coach/member-conversation-openai-responses-orchestrator-transport-v2");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
  validMemberConversationProviderTransport,
} = require("../src/goals-coach/member-conversation-provider-transport");
const {
  createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2,
} = require("./helpers/deterministic-member-conversation-openai-responses-http-transport-v2");
const {
  createDeterministicMemberConversationOpenAICredentialResolver,
} = require("./helpers/deterministic-member-conversation-openai-credential-resolver");

function response(statusCode = 200, body) {
  const payload = body === undefined ? {
    id: "resp_orchestrator_v2",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [{
      type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", annotations: [],
        text: JSON.stringify({ coaching: "Begin with a controlled range." }) }],
    }],
  } : body;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return Object.freeze({
    body: bytes, complete: true, contacted: true, decompressedBytes: bytes.length,
    headers: Object.freeze({ "content-type": "application/json",
      "x-request-id": "req_orchestrator_v2" }),
    kind: "response", redirected: false, statusCode,
  });
}

function setup(httpOptions = {}, resolverOptions = null) {
  const resolver = resolverOptions
    ? createDeterministicMemberConversationOpenAICredentialResolver(resolverOptions)
    : undefined;
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response(), ...httpOptions },
    ...(resolver ? { resolver } : {}),
  });
  const adapterOptions = fixture.adapterFixture.options;
  const input = {
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_ORCHESTRATOR_TRANSPORT_V2_VERSION,
    adapter: fixture.adapterFixture.adapter,
    httpClient: fixture.httpClient,
    origin: fixture.input.origin,
    promptCachePolicy: adapterOptions.promptCachePolicy,
    requestConfig: {
      developerPromptSha256: adapterOptions.developerPromptSha256,
      developerPromptVersion: adapterOptions.developerPromptVersion,
      regionPolicy: adapterOptions.regionPolicy,
      responseSchemaSha256: adapterOptions.responseSchemaSha256,
      responseSchemaVersion: adapterOptions.responseSchemaVersion,
    },
    resolver: fixture.resolver.resolver,
    turnRequest: fixture.created.input.turnRequest,
    turnResponse: fixture.created.input.turnResponse,
  };
  return { fixture, input,
    transport: createMemberConversationOpenAIResponsesOrchestratorTransportV2(input) };
}

function operation(overrides = {}) {
  return Object.freeze({
    outerDeadlineNs: deadlineAfter(monotonicNow(), 1000),
    signal: new AbortController().signal,
    terminalState: createTerminalState(),
    ...overrides,
  });
}

function dispatch(created, overrides = {}) {
  const request = created.fixture.created.request;
  const turn = created.fixture.created.input.turnRequest;
  return Object.freeze({
    attemptId: "10000000-0000-4000-8000-000000000099",
    clientRequestId: "10000000-0000-4000-8000-000000000099",
    contractVersion: turn.contractVersion,
    conversation: turn.conversation,
    model: request.model,
    provider: "openai",
    requestSignatureSha256: request.requestSignatureSha256,
    responseSchemaVersion: request.responseSchemaVersion,
    safetyRuleVersion: request.safetyRuleVersion,
    safetySourceRuleVersion: request.safetySourceRuleVersion,
    transportVersion: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
    ...overrides,
  });
}

test("factory returns the existing genuine provider transport without contact", () => {
  const created = setup();
  assert.equal(validMemberConversationProviderTransport(created.transport), true);
  assert.equal(created.transport.version, MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION);
  assert.equal(created.transport.runtimeWired, false);
  assert.equal(created.fixture.http.calls.length, 0);
  assert.equal(created.fixture.resolver.calls.length, 0);
});

test("one assigned attempt builds the V2 chain and emits strict RESPONSE-2", async () => {
  const created = setup();
  const result = await created.transport.dispatch(dispatch(created), operation());
  assert.equal(result.category, "succeeded");
  assert.equal(result.providerRequestId, "req_orchestrator_v2");
  assert.equal(result.providerResponseId, "resp_orchestrator_v2");
  assert.equal(result.response.contractVersion,
    "GC-MEMBER-CONVERSATION-TURN-RESPONSE-2");
  assert.equal(result.response.coaching, "Begin with a controlled range.");
  assert.equal(created.fixture.resolver.calls.length, 1);
  assert.equal(created.fixture.http.calls.length, 1);
  const wireBody = JSON.parse(created.fixture.http.calls[0].body.toString("utf8"));
  assert.equal(wireBody.model,
    created.fixture.adapterFixture.options.model);
  assert.equal(wireBody.prompt_cache_options.mode,
    "explicit");
  assert.equal(created.fixture.http.calls[0].clientRequestId,
    dispatch(created).attemptId);
});

test("bounded definite rejection crosses the existing orchestrator contract", async () => {
  const created = setup({ outcome: response(429, { error: "must not be exposed" }) });
  assert.deepEqual(await created.transport.dispatch(dispatch(created), operation()), {
    category: "rejected",
    providerRequestId: "req_orchestrator_v2",
    terminalCategory: "rate_limited",
  });
  assert.equal(created.fixture.http.calls.length, 1);
});

test("provable credential failure remains not_contacted with zero HTTP calls", async () => {
  const created = setup({}, { credential: "" });
  assert.deepEqual(await created.transport.dispatch(dispatch(created), operation()), {
    category: "not_contacted",
  });
  assert.equal(created.fixture.resolver.calls.length, 1);
  assert.equal(created.fixture.http.calls.length, 0);
});

test("identity drift and pre-contact cancellation fail with zero contact", async () => {
  const drift = setup();
  assert.deepEqual(await drift.transport.dispatch(dispatch(drift, {
    requestSignatureSha256: "f".repeat(64),
  }), operation()), { category: "not_contacted" });
  assert.equal(drift.fixture.resolver.calls.length, 0);
  assert.equal(drift.fixture.http.calls.length, 0);

  const aborted = setup();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await aborted.transport.dispatch(dispatch(aborted), operation({
    signal: controller.signal,
  })), { category: "not_contacted" });
  assert.deepEqual(await aborted.transport.dispatch(dispatch(aborted), operation()), {
    category: "indeterminate",
  });
  assert.equal(aborted.fixture.resolver.calls.length, 0);
  assert.equal(aborted.fixture.http.calls.length, 0);
});

test("proxy, prototype, and own AbortSignal overrides fail without observation or contact", async () => {
  const proxyCase = setup();
  let proxyReads = 0;
  const proxySignal = new Proxy(new AbortController().signal, {
    get() { proxyReads += 1; throw new Error("proxy signal observed"); },
  });
  assert.deepEqual(await proxyCase.transport.dispatch(dispatch(proxyCase), operation({
    signal: proxySignal,
  })), { category: "not_contacted" });
  assert.equal(proxyReads, 0);
  assert.equal(proxyCase.fixture.resolver.calls.length, 0);
  assert.equal(proxyCase.fixture.http.calls.length, 0);

  const prototypeCase = setup();
  const prototypeSignal = new AbortController().signal;
  Object.setPrototypeOf(prototypeSignal, Object.prototype);
  assert.deepEqual(await prototypeCase.transport.dispatch(dispatch(prototypeCase), operation({
    signal: prototypeSignal,
  })), { category: "not_contacted" });
  assert.equal(prototypeCase.fixture.resolver.calls.length, 0);
  assert.equal(prototypeCase.fixture.http.calls.length, 0);

  for (const key of ["aborted", "addEventListener", "removeEventListener"]) {
    const ownCase = setup();
    const signal = new AbortController().signal;
    let reads = 0;
    Object.defineProperty(signal, key, {
      configurable: true,
      enumerable: false,
      get() { reads += 1; throw new Error(`own ${key} observed`); },
    });
    assert.deepEqual(await ownCase.transport.dispatch(dispatch(ownCase), operation({ signal })), {
      category: "not_contacted",
    });
    assert.equal(reads, 0);
    assert.equal(ownCase.fixture.resolver.calls.length, 0);
    assert.equal(ownCase.fixture.http.calls.length, 0);
  }
});

test("one bridge permits no sequential or concurrent redispatch", async () => {
  const sequential = setup();
  assert.equal((await sequential.transport.dispatch(
    dispatch(sequential), operation()
  )).category, "succeeded");
  assert.deepEqual(await sequential.transport.dispatch(
    dispatch(sequential), operation()
  ), { category: "indeterminate" });
  assert.equal(sequential.fixture.http.calls.length, 1);

  const concurrent = setup();
  const [first, second] = await Promise.all([
    concurrent.transport.dispatch(dispatch(concurrent), operation()),
    concurrent.transport.dispatch(dispatch(concurrent), operation()),
  ]);
  assert.deepEqual([first.category, second.category].sort(),
    ["indeterminate", "succeeded"]);
  assert.equal(concurrent.fixture.http.calls.length, 1);
});

test("lookalikes, proxies, accessors, and unsafe turn drift are rejected without observation", () => {
  const created = setup();
  assert.equal(createMemberConversationOpenAIResponsesOrchestratorTransportV2({
    ...created.input, adapter: Object.freeze({ ...created.input.adapter }),
  }), null);
  assert.equal(createMemberConversationOpenAIResponsesOrchestratorTransportV2(
    new Proxy(created.input, { ownKeys() { throw new Error("observed"); } })
  ), null);
  let reads = 0;
  const requestConfig = { ...created.input.requestConfig };
  Object.defineProperty(requestConfig, "regionPolicy", {
    enumerable: true, get() { reads += 1; return "synthetic-region-2"; },
  });
  assert.equal(createMemberConversationOpenAIResponsesOrchestratorTransportV2({
    ...created.input, requestConfig,
  }), null);
  assert.equal(reads, 0);
  assert.equal(created.fixture.resolver.calls.length, 0);
  assert.equal(created.fixture.http.calls.length, 0);
});

test("factory rejects inconsistent adapter, request, region, and HTTP bindings", () => {
  for (const requestConfig of [
    { developerPromptSha256: "f".repeat(64) },
    { developerPromptVersion: "different-prompt-2" },
    { regionPolicy: "different-region-2" },
    { responseSchemaSha256: "f".repeat(64) },
    { responseSchemaVersion: "different_schema_2" },
  ]) {
    const created = setup();
    assert.equal(createMemberConversationOpenAIResponsesOrchestratorTransportV2({
      ...created.input,
      requestConfig: { ...created.input.requestConfig, ...requestConfig },
    }), null);
    assert.equal(created.fixture.resolver.calls.length, 0);
    assert.equal(created.fixture.http.calls.length, 0);
  }

  const origin = setup();
  assert.equal(createMemberConversationOpenAIResponsesOrchestratorTransportV2({
    ...origin.input,
    origin: "https://different.openai.test",
  }), null);
  assert.equal(origin.fixture.resolver.calls.length, 0);
  assert.equal(origin.fixture.http.calls.length, 0);
});

test("callable scalar leaves are rejected before parser coercion", () => {
  for (const target of ["request", "response"]) {
    const created = setup();
    let calls = 0;
    const callable = function callableLeaf() { calls += 1; return "coerced"; };
    callable.toString = () => { calls += 1; return "coerced"; };
    callable[Symbol.toPrimitive] = () => { calls += 1; return "coerced"; };
    const turnRequest = target === "request" ? {
      ...created.input.turnRequest,
      memberText: callable,
    } : created.input.turnRequest;
    const turnResponse = target === "response" ? {
      ...created.input.turnResponse,
      result: {
        ...created.input.turnResponse.result,
        safety: {
          ...created.input.turnResponse.result.safety,
          ruleVersion: callable,
        },
      },
    } : created.input.turnResponse;
    assert.equal(createMemberConversationOpenAIResponsesOrchestratorTransportV2({
      ...created.input, turnRequest, turnResponse,
    }), null);
    assert.equal(calls, 0);
    assert.equal(created.fixture.resolver.calls.length, 0);
    assert.equal(created.fixture.http.calls.length, 0);
  }
});

test("production startup and disabled composition do not import the bridge", () => {
  const root = path.resolve(__dirname, "..");
  const bridge = "member-conversation-openai-responses-orchestrator-transport-v2";
  for (const relative of ["server.js",
    "src/goals-coach/member-conversation-openai-production-composition.js"]) {
    assert.equal(fs.readFileSync(path.join(root, relative), "utf8").includes(bridge), false);
  }
});
