"use strict";

const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createTerminalState } = require("../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
  createMemberConversationOpenAICredentialAuthority,
  resolveMemberConversationOpenAICredential,
  revokeMemberConversationOpenAICredentialAuthority,
} = require("../src/goals-coach/member-conversation-openai-credential-resolver");
const {
  MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION,
  MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
  createMemberConversationOpenAIBoundedHTTPInterface,
  createMemberConversationOpenAIHTTPClient,
  executeMemberConversationOpenAIHTTPRequest,
  readMemberConversationOpenAIHTTPResponse,
  validMemberConversationOpenAIBoundedHTTPInterface,
  validMemberConversationOpenAIHTTPClient,
} = require("../src/goals-coach/member-conversation-openai-http-client");
const {
  createDeterministicMemberConversationOpenAICredentialResolver,
} = require("./helpers/deterministic-member-conversation-openai-credential-resolver");
const {
  createDeterministicMemberConversationOpenAIHTTPInterface,
} = require("./helpers/deterministic-member-conversation-openai-http-interface");

const attemptId = "10000000-0000-4000-8000-000000000001";

function client(options = {}) {
  const fake = options.fake || createDeterministicMemberConversationOpenAIHTTPInterface();
  const value = createMemberConversationOpenAIHTTPClient({
    version: MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
    http: fake.http,
    origin: "https://api.openai.com",
    requestHeaderMaximumBytes: 4096,
    requestBodyMaximumBytes: options.requestBodyMaximumBytes || 8192,
    responseHeaderMaximumBytes: options.responseHeaderMaximumBytes || 4096,
    responseBodyMaximumBytes: options.responseBodyMaximumBytes || 8192,
    timeoutMilliseconds: options.timeoutMilliseconds || 1000,
    finalizationReserveMilliseconds: 100,
  });
  return { fake, value };
}

async function authorized(milliseconds = 5000) {
  const terminalState = createTerminalState();
  const authority = createMemberConversationOpenAICredentialAuthority({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
    attemptId,
    terminalState,
  });
  const resolver = createDeterministicMemberConversationOpenAICredentialResolver();
  const controller = new AbortController();
  const outerDeadlineNs = process.hrtime.bigint() + BigInt(milliseconds) * 1000000n;
  const credentialLease = await resolveMemberConversationOpenAICredential(
    resolver.resolver, Object.freeze({ authority, outerDeadlineNs, signal: controller.signal })
  );
  return { authority, controller, credentialLease, outerDeadlineNs, terminalState };
}

function request(body = { synthetic: true }) {
  return Object.freeze({ body, clientRequestId: attemptId });
}

function operation(created) {
  return Object.freeze({
    authority: created.authority,
    credentialLease: created.credentialLease,
    outerDeadlineNs: created.outerDeadlineNs,
    signal: created.controller.signal,
  });
}

test("factories are branded, frozen, offline, and reject structural lookalikes", () => {
  let calls = 0;
  const http = createMemberConversationOpenAIBoundedHTTPInterface({
    version: MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION,
    request: () => { calls += 1; },
  });
  const created = client({ fake: { http, calls: [] } });
  assert.equal(validMemberConversationOpenAIBoundedHTTPInterface(http), true);
  assert.equal(validMemberConversationOpenAIHTTPClient(created.value), true);
  assert.equal(Object.isFrozen(created.value), true);
  assert.equal(calls, 0);
  assert.equal(validMemberConversationOpenAIBoundedHTTPInterface({ ...http }), false);
  assert.equal(validMemberConversationOpenAIHTTPClient({ ...created.value }), false);
  assert.equal(createMemberConversationOpenAIBoundedHTTPInterface({
    version: MEMBER_CONVERSATION_OPENAI_BOUNDED_HTTP_INTERFACE_VERSION,
    request() {}, extra: true,
  }), null);
});

test("construction rejects origin, retry, limits, and interface drift", () => {
  const fake = createDeterministicMemberConversationOpenAIHTTPInterface();
  const base = {
    version: MEMBER_CONVERSATION_OPENAI_HTTP_CLIENT_VERSION,
    http: fake.http, origin: "https://api.openai.com",
    requestHeaderMaximumBytes: 4096, requestBodyMaximumBytes: 8192,
    responseHeaderMaximumBytes: 4096, responseBodyMaximumBytes: 8192,
    timeoutMilliseconds: 1000, finalizationReserveMilliseconds: 100,
  };
  for (const changed of [
    { origin: "http://api.openai.com" }, { origin: "https://api.openai.com/v1" },
    { origin: "https://user@api.openai.com" }, { http: { ...fake.http } },
    { requestBodyMaximumBytes: 0 }, { timeoutMilliseconds: 25001 },
    { finalizationReserveMilliseconds: 1000 }, { extra: true },
  ]) assert.equal(createMemberConversationOpenAIHTTPClient({ ...base, ...changed }), null);
});

test("one call uses exact fixed boundary and returns a one-read opaque response", async () => {
  const created = await authorized();
  const built = client();
  const result = await executeMemberConversationOpenAIHTTPRequest(
    built.value, request(), operation(created)
  );
  assert.equal(result.classification, "complete");
  assert.equal(built.fake.calls.length, 1);
  assert.deepEqual({ ...built.fake.calls[0], signal: undefined }, {
    automaticRetries: false, authorizationPresent: true,
    body: '{"synthetic":true}', clientRequestId: attemptId,
    maximumAttempts: 1, method: "POST", origin: "https://api.openai.com",
    path: "/v1/responses", redirectLimit: 0, signal: undefined,
    tlsVerification: true,
  });
  assert.equal(JSON.stringify(result.response), "{}");
  const response = readMemberConversationOpenAIHTTPResponse(result.response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString("utf8"), '{"synthetic":true}');
  assert.equal(readMemberConversationOpenAIHTTPResponse(result.response), null);
});

test("sequential and concurrent reuse cannot make a second HTTP call", async () => {
  for (const concurrent of [false, true]) {
    const created = await authorized();
    const built = client();
    const first = executeMemberConversationOpenAIHTTPRequest(
      built.value, request(), operation(created)
    );
    const second = executeMemberConversationOpenAIHTTPRequest(
      built.value, request(), operation(created)
    );
    if (!concurrent) await first;
    const outcomes = await Promise.all([first, second]);
    assert.equal(built.fake.calls.length, 1);
    assert.equal(outcomes.filter((value) => value.classification === "complete").length, 1);
  }
});

test("lookalikes, cross-attempt requests, abort, and expiry make zero calls", async () => {
  const cases = [];
  const forged = await authorized();
  cases.push([request(), Object.freeze({
    ...operation(forged), authority: Object.freeze({ ...forged.authority }),
  })]);
  const mismatch = await authorized();
  cases.push([Object.freeze({ body: {}, clientRequestId: "20000000-0000-4000-8000-000000000002" }), operation(mismatch)]);
  const aborted = await authorized(); aborted.controller.abort();
  cases.push([request(), operation(aborted)]);
  const expired = await authorized(); expired.outerDeadlineNs = process.hrtime.bigint() - 1n;
  cases.push([request(), operation(expired)]);
  for (const [req, op] of cases) {
    const built = client();
    const result = await executeMemberConversationOpenAIHTTPRequest(built.value, req, op);
    assert.equal(result.classification, "not_contacted");
    assert.equal(built.fake.calls.length, 0);
  }
});

test("request and response bounds fail closed without retry", async () => {
  const tooLarge = await authorized();
  const requestBuilt = client({ requestBodyMaximumBytes: 1 });
  assert.equal((await executeMemberConversationOpenAIHTTPRequest(
    requestBuilt.value, request(), operation(tooLarge)
  )).classification, "not_contacted");
  assert.equal(requestBuilt.fake.calls.length, 0);

  for (const outcome of [
    { body: Buffer.alloc(9000), complete: true, contacted: true,
      decompressedBytes: 9000, headers: { "content-type": "application/json" },
      kind: "response", redirected: false, statusCode: 200 },
    { body: Buffer.from("{}"), complete: true, contacted: true,
      decompressedBytes: 2, headers: { "content-type": "text/plain" },
      kind: "response", redirected: false, statusCode: 200 },
    { body: Buffer.from("{}"), complete: true, contacted: true,
      decompressedBytes: 2, headers: { "content-type": "application/json" },
      kind: "response", redirected: true, statusCode: 302 },
  ]) {
    const created = await authorized();
    const fake = createDeterministicMemberConversationOpenAIHTTPInterface({ outcome });
    const built = client({ fake });
    assert.equal((await executeMemberConversationOpenAIHTTPRequest(
      built.value, request(), operation(created)
    )).classification, "indeterminate");
    assert.equal(fake.calls.length, 1);
  }
});

test("thrown, timeout, external abort, and revocation are indeterminate after contact", async () => {
  const thrown = await authorized();
  const failing = client({ fake: createDeterministicMemberConversationOpenAIHTTPInterface({ error: new Error("synthetic secret") }) });
  assert.equal((await executeMemberConversationOpenAIHTTPRequest(
    failing.value, request(), operation(thrown)
  )).classification, "indeterminate");
  assert.equal(failing.fake.calls.length, 1);

  for (const cancellation of ["abort", "revoke"]) {
    const created = await authorized();
    const fake = createDeterministicMemberConversationOpenAIHTTPInterface({ pending: true });
    const built = client({ fake, timeoutMilliseconds: 500 });
    const pending = executeMemberConversationOpenAIHTTPRequest(
      built.value, request(), operation(created)
    );
    while (fake.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    if (cancellation === "abort") created.controller.abort();
    else revokeMemberConversationOpenAICredentialAuthority(created.authority);
    assert.equal(fake.calls[0].signal.aborted, true);
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("HTTP cancellation did not settle promptly")), 100
      )),
    ]);
    assert.equal(result.classification, "indeterminate");
    assert.equal(getEventListeners(created.controller.signal, "abort").length, 0);
    fake.release();
  }
});

test("deferred pre-contact abort makes zero HTTP calls", async () => {
  const created = await authorized();
  const built = client();
  const pending = executeMemberConversationOpenAIHTTPRequest(
    built.value, request(), operation(created)
  );
  created.controller.abort();
  assert.equal((await pending).classification, "not_contacted");
  assert.equal(built.fake.calls.length, 0);
});

test("queued abort, authority revocation, and terminal transition win before contact", async () => {
  for (const cancellation of ["abort", "revoke", "terminal"]) {
    const created = await authorized();
    const built = client();
    const pending = executeMemberConversationOpenAIHTTPRequest(
      built.value, request(), operation(created)
    );
    queueMicrotask(() => {
      if (cancellation === "abort") created.controller.abort();
      else if (cancellation === "revoke") {
        revokeMemberConversationOpenAICredentialAuthority(created.authority);
      } else created.terminalState.terminate("synthetic_terminal");
    });
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Pre-contact cancellation did not settle")), 100
      )),
    ]);
    assert.equal(result.classification, "not_contacted");
    assert.equal(built.fake.calls.length, 0);
    assert.equal(getEventListeners(created.controller.signal, "abort").length, 0);
  }
});

test("production startup remains isolated and deterministic fake is test-only", () => {
  const sourceRoot = path.join(__dirname, "..", "src");
  for (const file of [
    path.join(sourceRoot, "server.js"),
    path.join(sourceRoot, "goals-coach", "member-conversation-turn.js"),
  ]) {
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes("member-conversation-openai-http-client"), false);
    assert.equal(source.includes("deterministic-member-conversation-openai-http-interface"), false);
  }
  assert.equal(fs.existsSync(path.join(sourceRoot, "goals-coach", "helpers",
    "deterministic-member-conversation-openai-http-interface.js")), false);
});
