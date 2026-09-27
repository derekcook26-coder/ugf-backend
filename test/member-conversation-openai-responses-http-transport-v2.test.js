"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
} = require("../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
  createMemberConversationOpenAICredentialAuthority,
  resolveMemberConversationOpenAICredential,
  revokeMemberConversationOpenAICredentialAuthority,
} = require("../src/goals-coach/member-conversation-openai-credential-resolver");
const {
  executeMemberConversationOpenAIHTTPRequestV2,
} = require("../src/goals-coach/member-conversation-openai-http-client");
const {
  MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
  bindMemberConversationProviderResultAuthorityV2Operation,
  createMemberConversationProviderResultAuthorityV2,
  createMemberConversationProviderResultV2,
  revokeMemberConversationProviderResultAuthorityV2,
  validMemberConversationProviderResultAuthorityV2,
} = require("../src/goals-coach/member-conversation-provider-result-v2");
const {
  readMemberConversationProviderRejectionV2,
  readMemberConversationProviderResultV2,
} = require("../src/goals-coach/member-conversation-provider-result-v2");
const {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_HTTP_TRANSPORT_V2_VERSION,
  createMemberConversationOpenAIResponsesHTTPTransportV2Execution,
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
const { createDeterministicMemberConversationProviderRequestV2 } = require(
  "./helpers/deterministic-member-conversation-provider-request-v2"
);
const { createMemberConversationProviderTransportV2 } = require(
  "../src/goals-coach/member-conversation-provider-transport-v2"
);
const { MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION } = require(
  "../src/goals-coach/member-conversation-provider-request-envelope-v2"
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

async function directContext(options = {}) {
  const fixture = options.fixture || createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response() },
  });
  const signal = options.signal || new AbortController().signal;
  const leaseSignal = options.leaseSignal || signal;
  const outerDeadlineNs = deadlineAfter(monotonicNow(), 1000);
  const terminalState = options.terminalState || createTerminalState();
  const credentialAuthority = createMemberConversationOpenAICredentialAuthority({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
    attemptId: fixture.created.request.attemptId,
    terminalState: options.credentialTerminalState || terminalState,
  });
  const credentialLease = await resolveMemberConversationOpenAICredential(
    fixture.resolver.resolver,
    Object.freeze({ authority: credentialAuthority, outerDeadlineNs, signal: leaseSignal })
  );
  const resultAuthority = createMemberConversationProviderResultAuthorityV2({
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
    request: fixture.created.request,
    terminalState: options.resultTerminalState || terminalState,
  });
  assert.equal(bindMemberConversationProviderResultAuthorityV2Operation(
    resultAuthority, signal, outerDeadlineNs
  ), true);
  const wireRequest = fixture.input.responsesTransport.createWireRequest({ signal });
  const executionBinding = createMemberConversationOpenAIResponsesHTTPTransportV2Execution(
    fixture.transport, { authority: credentialAuthority, credentialLease,
      outerDeadlineNs, request: fixture.created.request, resultAuthority,
      signal, terminalState, wireRequest }
  );
  return { credentialAuthority, credentialLease, executionBinding, fixture,
    outerDeadlineNs, resultAuthority, signal, terminalState, wireRequest };
}

test("HTTP V2 binds lease, terminal state, operation snapshot, and approved origin", async () => {
  const leaseController = new AbortController();
  const operationController = new AbortController();
  const mismatchedLease = await directContext({
    leaseSignal: leaseController.signal, signal: operationController.signal,
  });
  let result = await executeMemberConversationOpenAIHTTPRequestV2(
    mismatchedLease.fixture.httpClient,
    Object.freeze({ body: mismatchedLease.wireRequest.body,
      clientRequestId: mismatchedLease.wireRequest.clientRequestId }),
    Object.freeze({ authority: mismatchedLease.credentialAuthority,
      credentialLease: mismatchedLease.credentialLease,
      executionBinding: mismatchedLease.executionBinding,
      outerDeadlineNs: mismatchedLease.outerDeadlineNs,
      request: mismatchedLease.fixture.created.request,
      resultAuthority: mismatchedLease.resultAuthority,
      signal: mismatchedLease.signal, terminalState: mismatchedLease.terminalState,
      wireRequest: mismatchedLease.wireRequest })
  );
  assert.equal(result.classification, "not_contacted");
  assert.equal(mismatchedLease.fixture.http.calls.length, 0);

  const credentialTerminalState = createTerminalState();
  const resultTerminalState = createTerminalState();
  const mismatchedTerminal = await directContext({
    credentialTerminalState, resultTerminalState, terminalState: resultTerminalState,
  });
  result = await executeMemberConversationOpenAIHTTPRequestV2(
    mismatchedTerminal.fixture.httpClient,
    Object.freeze({ body: mismatchedTerminal.wireRequest.body,
      clientRequestId: mismatchedTerminal.wireRequest.clientRequestId }),
    Object.freeze({ authority: mismatchedTerminal.credentialAuthority,
      credentialLease: mismatchedTerminal.credentialLease,
      executionBinding: mismatchedTerminal.executionBinding,
      outerDeadlineNs: mismatchedTerminal.outerDeadlineNs,
      request: mismatchedTerminal.fixture.created.request,
      resultAuthority: mismatchedTerminal.resultAuthority,
      signal: mismatchedTerminal.signal, terminalState: resultTerminalState,
      wireRequest: mismatchedTerminal.wireRequest })
  );
  assert.equal(result.classification, "not_contacted");
  assert.equal(mismatchedTerminal.fixture.http.calls.length, 0);

  const exact = await directContext();
  const substitute = createMemberConversationProviderResultAuthorityV2({
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
    request: exact.fixture.created.request, terminalState: exact.terminalState,
  });
  assert.equal(bindMemberConversationProviderResultAuthorityV2Operation(
    substitute, exact.signal, exact.outerDeadlineNs
  ), true);
  const mutableOperation = { authority: exact.credentialAuthority,
    credentialLease: exact.credentialLease, executionBinding: exact.executionBinding,
    outerDeadlineNs: exact.outerDeadlineNs,
    request: exact.fixture.created.request, resultAuthority: exact.resultAuthority,
    signal: exact.signal, terminalState: exact.terminalState,
    wireRequest: exact.wireRequest };
  const pending = executeMemberConversationOpenAIHTTPRequestV2(
    exact.fixture.httpClient,
    Object.freeze({ body: exact.wireRequest.body,
      clientRequestId: exact.wireRequest.clientRequestId }), mutableOperation
  );
  queueMicrotask(() => { mutableOperation.resultAuthority = substitute; });
  result = await pending;
  assert.equal(result.classification, "complete");
  assert.equal(exact.fixture.http.calls.length, 1);
  assert.ok(createMemberConversationProviderResultV2(exact.resultAuthority, {
    version: "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-2", coaching: "Begin gently.",
    providerRequestId: "req_exact", providerResponseId: "resp_exact",
  }));
  assert.equal(createMemberConversationProviderResultV2(substitute, {
    version: "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-2", coaching: "Begin gently.",
    providerRequestId: "req_substitute", providerResponseId: "resp_substitute",
  }), null);
  revokeMemberConversationProviderResultAuthorityV2(substitute);

  const drift = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    origin: "https://different.openai.test",
  });
  assert.ok(drift.transport);
  const originBound = await directContext();
  const alternate = await executeMemberConversationOpenAIHTTPRequestV2(
    drift.httpClient,
    Object.freeze({ body: originBound.wireRequest.body,
      clientRequestId: originBound.wireRequest.clientRequestId }),
    Object.freeze({ authority: originBound.credentialAuthority,
      credentialLease: originBound.credentialLease,
      executionBinding: originBound.executionBinding,
      outerDeadlineNs: originBound.outerDeadlineNs,
      request: originBound.fixture.created.request,
      resultAuthority: originBound.resultAuthority, signal: originBound.signal,
      terminalState: originBound.terminalState, wireRequest: originBound.wireRequest })
  );
  assert.equal(alternate.classification, "not_contacted");
  assert.equal(drift.http.calls.length, 0);
});

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

test("factory rejects genuine same-public-metadata dependency identity swaps", () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2();
  const secondAdapter = createDeterministicMemberConversationOpenAIResponsesAdapterV2();
  assert.ok(secondAdapter.adapter);
  assert.notEqual(secondAdapter.adapter, fixture.adapterFixture.adapter);
  assert.equal(createMemberConversationOpenAIResponsesHTTPTransportV2({
    ...fixture.input, adapter: secondAdapter.adapter,
  }), null);
  const secondProviderTransport = createMemberConversationProviderTransportV2({
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_V2_VERSION,
    provider: "openai",
    model: fixture.created.request.model,
    responseSchemaVersion: fixture.created.request.responseSchemaVersion,
    request: fixture.created.request,
    async dispatch() { return null; },
  });
  assert.ok(secondProviderTransport);
  assert.notEqual(secondProviderTransport, fixture.providerTransport.transport);
  assert.equal(createMemberConversationOpenAIResponsesHTTPTransportV2({
    ...fixture.input, providerTransport: secondProviderTransport,
  }), null);
});

test("request UUID versions one through five remain valid through exact HTTP dispatch", async () => {
  for (const version of [1, 2, 3, 4, 5]) {
    const adapterFixture = createDeterministicMemberConversationOpenAIResponsesAdapterV2();
    const created = createDeterministicMemberConversationProviderRequestV2({
      attemptId: `00000000-0000-${version}000-8000-000000000001`,
      developerPromptSha256: adapterFixture.options.developerPromptSha256,
      responseSchemaSha256: adapterFixture.options.responseSchemaSha256,
    });
    const responses = createDeterministicMemberConversationOpenAIResponsesTransportV2({
      adapterFixture, created,
    });
    const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
      responses, httpOptions: { outcome: response() },
    });
    const result = await fixture.transport.dispatch(created.request, operation());
    assert.equal(result.classification, "succeeded");
    assert.equal(fixture.resolver.calls.length, 1);
    assert.equal(fixture.http.calls.length, 1);
  }
});

test("HTTP V2 contact rejects cross-bound wire and result request authority", async () => {
  const left = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response() },
  });
  const rightAdapter = createDeterministicMemberConversationOpenAIResponsesAdapterV2();
  const rightCreated = createDeterministicMemberConversationProviderRequestV2({
    attemptId: "00000000-0000-4000-8000-000000000099",
    developerPromptSha256: rightAdapter.options.developerPromptSha256,
    responseSchemaSha256: rightAdapter.options.responseSchemaSha256,
  });
  const terminalState = createTerminalState();
  const signal = new AbortController().signal;
  const outerDeadlineNs = deadlineAfter(monotonicNow(), 1000);
  const credentialAuthority = createMemberConversationOpenAICredentialAuthority({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
    attemptId: left.created.request.attemptId,
    terminalState,
  });
  const credentialLease = await resolveMemberConversationOpenAICredential(
    left.resolver.resolver,
    Object.freeze({ authority: credentialAuthority, outerDeadlineNs, signal })
  );
  const resultAuthority = createMemberConversationProviderResultAuthorityV2({
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
    request: rightCreated.request,
    terminalState,
  });
  const wireRequest = left.input.responsesTransport.createWireRequest({ signal });
  const result = await executeMemberConversationOpenAIHTTPRequestV2(
    left.httpClient,
    Object.freeze({ body: wireRequest.body, clientRequestId: wireRequest.clientRequestId }),
    Object.freeze({ authority: credentialAuthority, credentialLease, outerDeadlineNs,
      request: rightCreated.request, resultAuthority, signal, wireRequest })
  );
  assert.equal(result.classification, "not_contacted");
  assert.equal(left.http.calls.length, 0);
  assert.equal(validMemberConversationProviderResultAuthorityV2(resultAuthority), true);
  revokeMemberConversationOpenAICredentialAuthority(credentialAuthority);
});

test("HTTP V2 requires exact result-authority operation binding before contact", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response() },
  });
  const terminalState = createTerminalState();
  const signal = new AbortController().signal;
  const outerDeadlineNs = deadlineAfter(monotonicNow(), 1000);
  const credentialAuthority = createMemberConversationOpenAICredentialAuthority({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
    attemptId: fixture.created.request.attemptId,
    terminalState,
  });
  const credentialLease = await resolveMemberConversationOpenAICredential(
    fixture.resolver.resolver,
    Object.freeze({ authority: credentialAuthority, outerDeadlineNs, signal })
  );
  const resultAuthority = createMemberConversationProviderResultAuthorityV2({
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
    request: fixture.created.request,
    terminalState,
  });
  const wireRequest = fixture.input.responsesTransport.createWireRequest({ signal });
  const result = await executeMemberConversationOpenAIHTTPRequestV2(
    fixture.httpClient,
    Object.freeze({ body: wireRequest.body, clientRequestId: wireRequest.clientRequestId }),
    Object.freeze({ authority: credentialAuthority, credentialLease, outerDeadlineNs,
      request: fixture.created.request, resultAuthority, signal, wireRequest })
  );
  assert.equal(result.classification, "not_contacted");
  assert.equal(fixture.http.calls.length, 0);
  revokeMemberConversationOpenAICredentialAuthority(credentialAuthority);
});

test("HTTP V2 rejects accessor body substitution without observation or contact", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response() },
  });
  const terminalState = createTerminalState();
  const signal = new AbortController().signal;
  const outerDeadlineNs = deadlineAfter(monotonicNow(), 1000);
  const credentialAuthority = createMemberConversationOpenAICredentialAuthority({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
    attemptId: fixture.created.request.attemptId,
    terminalState,
  });
  const credentialLease = await resolveMemberConversationOpenAICredential(
    fixture.resolver.resolver,
    Object.freeze({ authority: credentialAuthority, outerDeadlineNs, signal })
  );
  const resultAuthority = createMemberConversationProviderResultAuthorityV2({
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
    request: fixture.created.request,
    terminalState,
  });
  const wireRequest = fixture.input.responsesTransport.createWireRequest({ signal });
  let observations = 0;
  const request = { clientRequestId: wireRequest.clientRequestId };
  Object.defineProperty(request, "body", {
    enumerable: true,
    get() {
      observations += 1;
      return observations === 1 ? wireRequest.body : { model: "attacker-controlled" };
    },
  });
  const result = await executeMemberConversationOpenAIHTTPRequestV2(
    fixture.httpClient, request,
    Object.freeze({ authority: credentialAuthority, credentialLease, outerDeadlineNs,
      request: fixture.created.request, resultAuthority, signal, wireRequest })
  );
  assert.equal(result.classification, "not_contacted");
  assert.equal(observations, 0);
  assert.equal(fixture.http.calls.length, 0);
  revokeMemberConversationOpenAICredentialAuthority(credentialAuthority);
});

test("HTTP V2 binds the branded wire to the exact operation signal", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response() },
  });
  const terminalState = createTerminalState();
  const wireController = new AbortController();
  const operationController = new AbortController();
  const outerDeadlineNs = deadlineAfter(monotonicNow(), 1000);
  const credentialAuthority = createMemberConversationOpenAICredentialAuthority({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
    attemptId: fixture.created.request.attemptId,
    terminalState,
  });
  const credentialLease = await resolveMemberConversationOpenAICredential(
    fixture.resolver.resolver,
    Object.freeze({ authority: credentialAuthority, outerDeadlineNs,
      signal: operationController.signal })
  );
  const resultAuthority = createMemberConversationProviderResultAuthorityV2({
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
    request: fixture.created.request,
    terminalState,
  });
  const wireRequest = fixture.input.responsesTransport.createWireRequest({
    signal: wireController.signal,
  });
  wireController.abort();
  const result = await executeMemberConversationOpenAIHTTPRequestV2(
    fixture.httpClient,
    Object.freeze({ body: wireRequest.body, clientRequestId: wireRequest.clientRequestId }),
    Object.freeze({ authority: credentialAuthority, credentialLease, outerDeadlineNs,
      request: fixture.created.request, resultAuthority,
      signal: operationController.signal, wireRequest })
  );
  assert.equal(result.classification, "not_contacted");
  assert.equal(fixture.http.calls.length, 0);
  revokeMemberConversationOpenAICredentialAuthority(credentialAuthority);
});

test("overridden prototype and own AbortSignal operations fail before dependencies", async () => {
  for (const mutate of [
    (signal) => Object.setPrototypeOf(signal, Object.create(AbortSignal.prototype)),
    (signal) => Object.defineProperty(signal, "addEventListener", {
      configurable: true, value() {}, writable: true,
    }),
    (signal) => Object.defineProperty(signal, "aborted", {
      configurable: true, value: false, writable: true,
    }),
  ]) {
    const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2();
    const signal = new AbortController().signal;
    mutate(signal);
    const result = await fixture.transport.dispatch(fixture.created.request, operation({ signal }));
    assert.equal(result.classification, "not_contacted");
    assert.equal(fixture.resolver.calls.length, 0);
    assert.equal(fixture.http.calls.length, 0);
  }
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

test("deterministic output safety policy rejects prohibited coaching", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { outcome: response(200, {
      id: "resp_synthetic_unsafe", object: "response", status: "completed",
      error: null, incomplete_details: null,
      output: [{ type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", annotations: [],
          text: JSON.stringify({ coaching: "Continue through pain." }) }] }],
    }) },
  });
  const result = await fixture.transport.dispatch(fixture.created.request, operation());
  assert.equal(result.classification, "indeterminate");
  assert.equal(result.authority, null);
  assert.equal(result.outcome, null);
  assert.equal(fixture.http.calls.length, 1);
});

test("abort after dispatch revokes unconsumed success and rejection capabilities", async () => {
  for (const outcome of [response(), response(429, {})]) {
    const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
      httpOptions: { outcome },
    });
    const controller = new AbortController();
    const result = await fixture.transport.dispatch(
      fixture.created.request, operation({ signal: controller.signal })
    );
    assert.ok(["succeeded", "rejected"].includes(result.classification));
    controller.abort();
    assert.equal(result.classification === "succeeded"
      ? readMemberConversationProviderResultV2(result.outcome, result.authority)
      : readMemberConversationProviderRejectionV2(result.outcome, result.authority), null);
  }
});

test("result reads synchronously reject an elapsed monotonic deadline", async () => {
  for (const outcome of [response(), response(429, {})]) {
    const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
      httpOptions: { outcome },
    });
    const outerDeadlineNs = deadlineAfter(monotonicNow(), 100);
    const result = await fixture.transport.dispatch(
      fixture.created.request, operation({ outerDeadlineNs })
    );
    assert.ok(["succeeded", "rejected"].includes(result.classification));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    assert.equal(result.classification === "succeeded"
      ? readMemberConversationProviderResultV2(result.outcome, result.authority)
      : readMemberConversationProviderRejectionV2(result.outcome, result.authority), null);
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

test("post-entry AbortSignal mutation cannot bypass cancellation or cleanup", async () => {
  const fixture = createDeterministicMemberConversationOpenAIResponsesHTTPTransportV2({
    httpOptions: { pending: true, outcome: response() },
  });
  const controller = new AbortController();
  const pending = fixture.transport.dispatch(fixture.created.request, operation({
    signal: controller.signal,
  }));
  while (!fixture.http.calls.length) await new Promise((resolve) => setImmediate(resolve));
  Object.defineProperties(controller.signal, {
    aborted: { configurable: true, value: false },
    addEventListener: {
      configurable: true,
      value() { throw new Error("overridden addEventListener observed"); },
    },
    removeEventListener: {
      configurable: true,
      value() { throw new Error("overridden removeEventListener observed"); },
    },
  });
  controller.abort();
  assert.equal((await pending).classification, "indeterminate");
  fixture.http.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.http.calls.length, 1);
});

test("production startup remains import-free and migrations remain outside this slice", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const production = ["server.js", ...fs.readdirSync(path.join(__dirname, "../src"), { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".js"))]
    .filter((name) => !name.includes("member-conversation-openai-responses-http-transport-v2.js")
      && !name.includes("member-conversation-openai-responses-orchestrator-transport-v2.js")
      && !name.includes("member-conversation-openai-http-client.js"));
  for (const name of production) {
    const full = name === "server.js" ? path.join(__dirname, "../server.js") : path.join(__dirname, "../src", name);
    if (fs.existsSync(full)) assert.doesNotMatch(fs.readFileSync(full, "utf8"), /openai-responses-http-transport-v2/);
  }
});
