"use strict";

const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createTerminalState } = require("../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
  MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
  createMemberConversationOpenAICredentialAuthority,
  createMemberConversationOpenAICredentialResolver,
  resolveMemberConversationOpenAICredential,
  revokeMemberConversationOpenAICredentialAuthority,
  revokeMemberConversationOpenAICredentialLease,
  validMemberConversationOpenAICredentialAuthority,
  validMemberConversationOpenAICredentialLease,
  validMemberConversationOpenAICredentialResolver,
} = require("../src/goals-coach/member-conversation-openai-credential-resolver");
const {
  createDeterministicMemberConversationOpenAICredentialResolver,
} = require("./helpers/deterministic-member-conversation-openai-credential-resolver");

const attemptId = "10000000-0000-4000-8000-000000000001";

function authority() {
  const terminalState = createTerminalState();
  return {
    terminalState,
    value: createMemberConversationOpenAICredentialAuthority({
      version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
      attemptId,
      terminalState,
    }),
  };
}

function operation(authorityToken, milliseconds = 5000) {
  const controller = new AbortController();
  return {
    controller,
    value: Object.freeze({
      authority: authorityToken,
      outerDeadlineNs: process.hrtime.bigint() + BigInt(milliseconds) * 1000000n,
      signal: controller.signal,
    }),
  };
}

test("factory creates a frozen branded resolver without startup I/O", () => {
  let calls = 0;
  const resolver = createMemberConversationOpenAICredentialResolver({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
    resolve: () => { calls += 1; return "synthetic"; },
  });
  assert.ok(resolver);
  assert.equal(validMemberConversationOpenAICredentialResolver(resolver), true);
  assert.equal(Object.isFrozen(resolver), true);
  assert.deepEqual({ ...resolver }, {
    externalCallsPermitted: false,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
  });
  assert.equal(calls, 0);
});

test("lookalikes, unknown keys, forged terminal state, and malformed attempts fail", () => {
  const fake = createDeterministicMemberConversationOpenAICredentialResolver();
  assert.equal(validMemberConversationOpenAICredentialResolver(
    Object.freeze({ ...fake.resolver })
  ), false);
  assert.equal(createMemberConversationOpenAICredentialResolver({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_RESOLVER_VERSION,
    resolve: () => "synthetic",
    unknown: true,
  }), null);
  assert.equal(createMemberConversationOpenAICredentialAuthority({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
    attemptId,
    terminalState: Object.freeze({ isTerminal: () => false }),
  }), null);
  assert.equal(createMemberConversationOpenAICredentialAuthority({
    version: MEMBER_CONVERSATION_OPENAI_CREDENTIAL_AUTHORITY_VERSION,
    attemptId: "not-an-attempt",
    terminalState: createTerminalState(),
  }), null);
  assert.equal(fake.calls.length, 0);
});

test("one authority resolves one opaque exact-generation credential lease", async () => {
  const fake = createDeterministicMemberConversationOpenAICredentialResolver();
  const created = authority();
  const lease = await resolveMemberConversationOpenAICredential(
    fake.resolver, operation(created.value).value
  );
  assert.ok(lease);
  assert.equal(fake.calls.length, 1);
  assert.equal(validMemberConversationOpenAICredentialAuthority(created.value), true);
  assert.equal(validMemberConversationOpenAICredentialLease(lease, created.value), true);
  for (const token of [created.value, lease]) {
    assert.equal(Object.isFrozen(token), true);
    assert.deepEqual(Object.keys(token), []);
    assert.equal(JSON.stringify(token), "{}");
    assert.equal("credential" in token, false);
    assert.equal("attemptId" in token, false);
  }
  assert.deepEqual(Object.keys(fake.calls[0]), ["outerDeadlineNs", "signal"]);
  assert.equal(Object.values(fake.calls[0]).some(
    (value) => String(value).includes("synthetic-openai-credential")
  ), false);
});

test("sequential and concurrent reuse invokes the resolver at most once", async () => {
  const sequential = createDeterministicMemberConversationOpenAICredentialResolver();
  const firstAuthority = authority();
  assert.ok(await resolveMemberConversationOpenAICredential(
    sequential.resolver, operation(firstAuthority.value).value
  ));
  assert.equal(await resolveMemberConversationOpenAICredential(
    sequential.resolver, operation(firstAuthority.value).value
  ), null);
  assert.equal(sequential.calls.length, 1);

  const concurrent = createDeterministicMemberConversationOpenAICredentialResolver({
    pending: true,
  });
  const secondAuthority = authority();
  const shared = operation(secondAuthority.value);
  const first = resolveMemberConversationOpenAICredential(concurrent.resolver, shared.value);
  const second = resolveMemberConversationOpenAICredential(concurrent.resolver, shared.value);
  assert.equal(await second, null);
  while (concurrent.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  concurrent.release();
  assert.ok(await first);
  assert.equal(concurrent.calls.length, 1);
});

test("abort, terminal transition, and deadline suppress late resolution and clean listeners", async () => {
  for (const termination of ["abort", "terminal"]) {
    const fake = createDeterministicMemberConversationOpenAICredentialResolver({ pending: true });
    const created = authority();
    const shared = operation(created.value);
    const pending = resolveMemberConversationOpenAICredential(fake.resolver, shared.value);
    while (fake.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    if (termination === "abort") shared.controller.abort();
    else created.terminalState.terminate("synthetic_terminal", { responseAllowed: false });
    assert.equal(await pending, null);
    assert.equal(fake.calls[0].signal.aborted, true);
    assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
    fake.release();
  }

  const expiredFake = createDeterministicMemberConversationOpenAICredentialResolver();
  const expiredAuthority = authority();
  const expired = operation(expiredAuthority.value);
  assert.equal(await resolveMemberConversationOpenAICredential(expiredFake.resolver, {
    ...expired.value,
    outerDeadlineNs: process.hrtime.bigint() - 1n,
  }), null);
  assert.equal(expiredFake.calls.length, 0);
});

test("abort or revocation before the deferred resolver boundary performs zero resolution", async () => {
  for (const termination of ["abort", "authority"]) {
    const fake = createDeterministicMemberConversationOpenAICredentialResolver();
    const created = authority();
    const shared = operation(created.value);
    const pending = resolveMemberConversationOpenAICredential(fake.resolver, shared.value);
    if (termination === "abort") shared.controller.abort();
    else revokeMemberConversationOpenAICredentialAuthority(created.value);
    assert.equal(await pending, null);
    assert.equal(fake.calls.length, 0);
    assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
  }
});

test("malformed, throwing, cross-authority, and revoked leases fail closed", async () => {
  let coercions = 0;
  for (const options of [
    { credential: "" },
    { credential: " contains-space " },
    { credential: "x".repeat(513) },
    { credential: Object("synthetic-openai-credential") },
    { credential: { toString() { coercions += 1; throw new Error("must not coerce"); } } },
    { error: new Error("synthetic resolver failure") },
  ]) {
    const fake = createDeterministicMemberConversationOpenAICredentialResolver(options);
    const created = authority();
    assert.equal(await resolveMemberConversationOpenAICredential(
      fake.resolver, operation(created.value).value
    ), null);
  }
  assert.equal(coercions, 0);

  const fake = createDeterministicMemberConversationOpenAICredentialResolver();
  const first = authority();
  const second = authority();
  const lease = await resolveMemberConversationOpenAICredential(
    fake.resolver, operation(first.value).value
  );
  assert.equal(validMemberConversationOpenAICredentialLease(lease, second.value), false);
  assert.equal(revokeMemberConversationOpenAICredentialLease(lease), true);
  assert.equal(revokeMemberConversationOpenAICredentialLease(lease), false);
  assert.equal(validMemberConversationOpenAICredentialLease(lease, first.value), false);

  const next = authority();
  const nextLease = await resolveMemberConversationOpenAICredential(
    fake.resolver, operation(next.value).value
  );
  assert.equal(revokeMemberConversationOpenAICredentialAuthority(next.value), true);
  assert.equal(revokeMemberConversationOpenAICredentialAuthority(next.value), false);
  assert.equal(validMemberConversationOpenAICredentialAuthority(next.value), false);
  assert.equal(validMemberConversationOpenAICredentialLease(nextLease, next.value), false);
});

test("authority revocation promptly aborts and settles an in-flight resolution", async () => {
  const fake = createDeterministicMemberConversationOpenAICredentialResolver({ pending: true });
  const created = authority();
  const shared = operation(created.value);
  const pending = resolveMemberConversationOpenAICredential(fake.resolver, shared.value);
  while (fake.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(revokeMemberConversationOpenAICredentialAuthority(created.value), true);
  assert.equal(fake.calls[0].signal.aborted, true);
  assert.equal(await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("did_not_settle"), 50)),
  ]), null);
  assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
  fake.release();
});

test("a resolved lease is erased by later abort, terminal, deadline, or authority revocation",
  async () => {
    for (const termination of ["abort", "terminal", "authority"]) {
      const fake = createDeterministicMemberConversationOpenAICredentialResolver();
      const created = authority();
      const shared = operation(created.value);
      const lease = await resolveMemberConversationOpenAICredential(
        fake.resolver, shared.value
      );
      assert.equal(validMemberConversationOpenAICredentialLease(lease, created.value), true);
      if (termination === "abort") shared.controller.abort();
      else if (termination === "terminal") {
        created.terminalState.terminate("synthetic_terminal", { responseAllowed: false });
      } else revokeMemberConversationOpenAICredentialAuthority(created.value);
      assert.equal(validMemberConversationOpenAICredentialLease(lease, created.value), false);
      assert.equal(revokeMemberConversationOpenAICredentialLease(lease), false);
      assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
    }

    const fake = createDeterministicMemberConversationOpenAICredentialResolver();
    const created = authority();
    const shared = operation(created.value, 15);
    const lease = await resolveMemberConversationOpenAICredential(fake.resolver, shared.value);
    assert.ok(lease);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(validMemberConversationOpenAICredentialLease(lease, created.value), false);
    assert.equal(getEventListeners(shared.controller.signal, "abort").length, 0);
  });

test("test fake is isolated and production remains null and unwired", () => {
  const root = path.resolve(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  for (const relative of [
    "server.js",
    "src/goals-coach/gymmaster-member-conversation-turn-startup.js",
    "src/goals-coach/member-conversation-provider-dispatch-composition.js",
    "src/goals-coach/member-conversation-openai-responses-transport.js",
  ]) {
    const production = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(production, /member-conversation-openai-credential-resolver/);
    assert.doesNotMatch(production, /deterministic-member-conversation-openai-credential-resolver/);
  }
  const source = fs.readFileSync(path.join(root, "src", "goals-coach",
    "member-conversation-openai-credential-resolver.js"), "utf8");
  assert.doesNotMatch(source, /process\.env|OPENAI_API_KEY|require\(["'](?:https?|net|tls|openai)["']\)/);
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});
