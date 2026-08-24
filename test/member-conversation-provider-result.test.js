"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createTerminalState,
  validTerminalState,
} = require("../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS,
  MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
  MEMBER_CONVERSATION_TURN_RESPONSE_VERSION,
  createMemberConversationProviderResult,
  createMemberConversationProviderResultAuthority,
  createMemberConversationTurnResponseV2,
  memberConversationTurnResponseV2Digest,
  parseMemberConversationTurnResponseV2,
  readMemberConversationProviderResult,
  revokeMemberConversationProviderResultAuthority,
  validMemberConversationProviderResult,
  validMemberConversationProviderResultAuthority,
} = require("../src/goals-coach/member-conversation-provider-result");
const {
  createDeterministicMemberConversationProviderRequest,
} = require("./helpers/deterministic-member-conversation-provider-request");
const {
  createDeterministicMemberConversationProviderResult,
} = require("./helpers/deterministic-member-conversation-provider-result");
const {
  createMemberConversationTurnResponse,
} = require("../src/goals-coach/member-conversation-turn-contract");

test("RESPONSE-2 factory derives exact local identity and deterministic safety", () => {
  const request = createDeterministicMemberConversationProviderRequest();
  const response = createMemberConversationTurnResponseV2(
    request.input.turnRequest,
    request.input.turnResponse,
    "Use a smooth range of motion."
  );
  assert.ok(response);
  assert.equal(response.contractVersion, MEMBER_CONVERSATION_TURN_RESPONSE_VERSION);
  assert.equal(response.requestContractVersion, request.input.turnRequest.contractVersion);
  assert.equal(response.requestId, request.input.turnRequest.requestId);
  assert.equal(response.idempotencyKey, request.input.turnRequest.idempotencyKey);
  assert.deepEqual(response.conversation, request.input.turnRequest.conversation);
  assert.deepEqual(response.result, request.input.turnResponse.result);
  assert.equal(Object.isFrozen(response), true);
  assert.match(memberConversationTurnResponseV2Digest(response), /^[0-9a-f]{64}$/);
  assert.deepEqual(parseMemberConversationTurnResponseV2({
    coaching: response.coaching,
    result: response.result,
    conversation: response.conversation,
    requestId: response.requestId,
    idempotencyKey: response.idempotencyKey,
    requestContractVersion: response.requestContractVersion,
    contractVersion: response.contractVersion,
  }), response);
});

test("RESPONSE-2 enforces coaching state, normalization, controls, and bounds", () => {
  const request = createDeterministicMemberConversationProviderRequest();
  const create = (coaching, turnResponse = request.input.turnResponse) =>
    createMemberConversationTurnResponseV2(request.input.turnRequest, turnResponse, coaching);
  for (const coaching of [
    "", " padded ", "line\twith tab", "e\u0301",
    "lone high \uD800 surrogate", "lone low \uDC00 surrogate",
    "x".repeat(MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS + 1),
    "😀".repeat(401),
  ]) assert.equal(create(coaching), null);
  const blocked = createMemberConversationTurnResponse(request.input.turnRequest, {
    ruleVersion: "GC-MEMBER-CONVERSATION-SAFETY-1",
    sourceRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-RULES-1",
    classification: "pain_or_instability",
    action: "stop",
  });
  assert.ok(create(null, blocked));
  assert.equal(create("Provider text must not override safety.", blocked), null);
  assert.throws(() => parseMemberConversationTurnResponseV2({
    ...create("Valid coaching."), unknown: true,
  }), { code: "MEMBER_CONVERSATION_PROVIDER_RESPONSE_INVALID" });
});

test("mismatched deterministic response cannot create RESPONSE-2", () => {
  const first = createDeterministicMemberConversationProviderRequest();
  const second = createDeterministicMemberConversationProviderRequest({
    memberTurn: "A different synthetic turn.",
  });
  assert.equal(createMemberConversationTurnResponseV2(
    first.input.turnRequest, second.input.turnResponse, "Valid coaching."
  ), null);
});

test("provider result and authority are opaque private tokens", () => {
  const created = createDeterministicMemberConversationProviderResult();
  assert.equal(validMemberConversationProviderResultAuthority(created.authority), true);
  assert.equal(validMemberConversationProviderResult(created.result, created.authority), true);
  for (const token of [created.authority, created.result]) {
    assert.equal(Object.isFrozen(token), true);
    assert.deepEqual(Object.keys(token), []);
    assert.equal(JSON.stringify(token), "{}");
    assert.equal("coaching" in token, false);
    assert.equal("attemptId" in token, false);
    assert.equal("providerRequestId" in token, false);
  }
  assert.match(created.value.requestEnvelopeDigestSha256, /^[0-9a-f]{64}$/);
  assert.match(created.value.providerResultDigestSha256, /^[0-9a-f]{64}$/);
});

test("lookalikes, unknown keys, malformed identifiers, and unsafe coaching fail", () => {
  const request = createDeterministicMemberConversationProviderRequest().request;
  const terminalState = createTerminalState();
  const forgedTerminalState = Object.freeze({ isTerminal: () => false });
  assert.equal(validTerminalState(terminalState), true);
  assert.equal(validTerminalState(forgedTerminalState), false);
  assert.equal(createMemberConversationProviderResultAuthority({
    request,
    terminalState: forgedTerminalState,
  }), null);
  const authority = createMemberConversationProviderResultAuthority({ request, terminalState });
  const base = {
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
    authority,
    coaching: "Valid synthetic coaching.",
    providerRequestId: "request-1",
    providerResponseId: "response-1",
  };
  assert.equal(validMemberConversationProviderResultAuthority(Object.freeze({})), false);
  assert.equal(createMemberConversationProviderResult({ ...base, unknown: true }), null);
  assert.equal(createMemberConversationProviderResult({ ...base, providerRequestId: "bad id" }), null);
  assert.equal(createMemberConversationProviderResult({ ...base, coaching: "text\u0000" }), null);
  const result = createMemberConversationProviderResult(base);
  assert.equal(validMemberConversationProviderResult(Object.freeze({}), authority), false);
  assert.equal(validMemberConversationProviderResult(result, Object.freeze({})), false);
});

test("cross-authority swaps fail and explicit generation revocation is permanent", () => {
  const first = createDeterministicMemberConversationProviderResult();
  const second = createDeterministicMemberConversationProviderResult();
  assert.equal(readMemberConversationProviderResult(first.result, second.authority), null);
  assert.equal(revokeMemberConversationProviderResultAuthority(first.authority), true);
  assert.equal(revokeMemberConversationProviderResultAuthority(first.authority), false);
  assert.equal(validMemberConversationProviderResultAuthority(first.authority), false);
  assert.equal(readMemberConversationProviderResult(first.result, first.authority), null);
  assert.equal(createMemberConversationProviderResult({
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
    authority: first.authority,
    coaching: "Late result.",
    providerRequestId: "request-late",
    providerResponseId: "response-late",
  }), null);
});

test("terminal abort or deadline revokes every later result operation", () => {
  for (const responseAllowed of [false, true]) {
    const created = createDeterministicMemberConversationProviderResult();
    created.terminalState.terminate("synthetic_terminal", { responseAllowed });
    assert.equal(validMemberConversationProviderResultAuthority(created.authority), false);
    assert.equal(validMemberConversationProviderResult(created.result, created.authority), false);
    assert.equal(readMemberConversationProviderResult(created.result, created.authority), null);
  }
});

test("result digest is canonical and bound to exact coaching and request envelope", () => {
  const first = createDeterministicMemberConversationProviderResult();
  const second = createDeterministicMemberConversationProviderResult({
    result: { coaching: "Different valid coaching." },
  });
  assert.notEqual(first.value.providerResultDigestSha256, second.value.providerResultDigestSha256);
  assert.equal(first.value.requestEnvelopeDigestSha256, second.value.requestEnvelopeDigestSha256);
  assert.equal(first.value.attemptId, second.value.attemptId);
});

test("test fake is isolated and production remains null and unwired", () => {
  const root = path.resolve(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const startup = fs.readFileSync(path.join(
    root, "src", "goals-coach", "gymmaster-member-conversation-turn-startup.js"
  ), "utf8");
  const composition = fs.readFileSync(path.join(
    root, "src", "goals-coach", "member-conversation-provider-dispatch-composition.js"
  ), "utf8");
  for (const source of [server, startup, composition]) {
    assert.doesNotMatch(source, /member-conversation-provider-result/);
    assert.doesNotMatch(source, /deterministic-member-conversation-provider-result/);
  }
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});
