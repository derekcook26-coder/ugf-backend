"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_MAXIMUM_TOKENS,
  MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_CHARACTERS,
  MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
  createMemberConversationProviderRequest,
  memberConversationProviderRequestDigest,
  validMemberConversationProviderRequest,
} = require("../src/goals-coach/member-conversation-provider-request-envelope");
const {
  createDeterministicMemberConversationProviderRequest,
  deterministicMemberConversationProviderRequestInput,
} = require("./helpers/deterministic-member-conversation-provider-request");
const {
  createMemberConversationTurnResponse,
  parseMemberConversationTurnRequest,
} = require("../src/goals-coach/member-conversation-turn-contract");

function value(overrides = {}) {
  return deterministicMemberConversationProviderRequestInput(overrides);
}

test("factory returns one exact frozen privately branded transient request", () => {
  const created = createDeterministicMemberConversationProviderRequest();
  assert.equal(validMemberConversationProviderRequest(created.request), true);
  assert.equal(Object.isFrozen(created.request), true);
  assert.equal(Object.isFrozen(created.request.controls), true);
  assert.equal(Object.isFrozen(created.request.controls.tools), true);
  assert.match(created.digestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(created.request), [
    "version", "transportVersion", "attemptId", "model",
    "developerPromptVersion", "developerPromptSha256",
    "responseSchemaVersion", "responseSchemaSha256", "requestSignatureSha256",
    "safetyRuleVersion", "safetySourceRuleVersion", "memberTurn", "controls",
    "regionPolicy",
  ]);
  assert.equal("memberId" in created.request, false);
  assert.equal("sessionId" in created.request, false);
  assert.equal("conversation" in created.request, false);
  assert.equal("idempotencyKey" in created.request, false);
  assert.equal("credential" in created.request, false);
  assert.equal("dispatch" in created.request, false);
});

test("metadata lookalikes and unknown or stateful controls fail closed", () => {
  const request = createDeterministicMemberConversationProviderRequest().request;
  assert.equal(validMemberConversationProviderRequest(Object.freeze({ ...request })), false);
  assert.equal(createMemberConversationProviderRequest(value({ unknown: true })), null);
  const invalidControls = [
    { store: true }, { background: true }, { conversation: "provider-state" },
    { previousResponseId: "response-id" }, { metadata: {} },
    { stream: true }, { tools: [{ type: "web_search" }] }, { truncation: "auto" },
    { maxOutputTokens: 0 },
    { maxOutputTokens: MEMBER_CONVERSATION_PROVIDER_OUTPUT_MAXIMUM_TOKENS + 1 },
  ];
  for (const override of invalidControls) {
    assert.equal(createMemberConversationProviderRequest(value({
      controls: { ...request.controls, tools: [], ...override },
    })), null);
  }
});

test("versions, provenance, identifiers, digests, and member-turn bounds are exact", () => {
  const invalid = [
    { version: "GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2" },
    { transportVersion: "GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-2" },
    { attemptId: "not-a-uuid" }, { model: "moving model" },
    { developerPromptVersion: "" }, { developerPromptSha256: "a".repeat(63) },
    { responseSchemaVersion: "moving schema" }, { responseSchemaSha256: "B".repeat(64) },
    { regionPolicy: "" },
  ];
  for (const override of invalid) {
    assert.equal(createMemberConversationProviderRequest(value(override)), null);
  }
  const base = createDeterministicMemberConversationProviderRequest();
  const invalidMemberTurns = [
    "", " padded ",
    "x".repeat(MEMBER_CONVERSATION_PROVIDER_REQUEST_MAXIMUM_CHARACTERS + 1),
    "😀".repeat(201),
  ];
  for (const memberText of invalidMemberTurns) {
    assert.equal(createMemberConversationProviderRequest(value({
      turnRequest: { ...base.input.turnRequest, memberText },
      turnResponse: base.input.turnResponse,
    })), null);
  }
  assert.equal(createMemberConversationProviderRequest(value({
    memberTurn: "😀".repeat(200),
  })).memberTurn, "😀".repeat(200));
});

test("brand requires the exact safety-screened current turn and derives provenance", () => {
  const original = createDeterministicMemberConversationProviderRequest();
  const changedTurn = parseMemberConversationTurnRequest({
    ...original.input.turnRequest,
    memberText: "Sharp pain and new numbness.",
  });
  assert.equal(createMemberConversationProviderRequest(value({
    turnRequest: changedTurn,
    turnResponse: original.input.turnResponse,
  })), null);
  assert.equal(createMemberConversationProviderRequest(value({
    requestSignatureSha256: original.request.requestSignatureSha256,
  })), null);
  assert.equal(original.request.memberTurn, original.input.turnRequest.memberText);
  assert.equal(
    original.request.requestSignatureSha256,
    original.input.turnResponse.result.safety.requestHash
  );
  assert.equal(
    original.request.safetyRuleVersion,
    original.input.turnResponse.result.safety.ruleVersion
  );
  assert.equal(
    original.request.safetySourceRuleVersion,
    original.input.turnResponse.result.safety.sourceRuleVersion
  );
});

test("blocked and unavailable safety responses cannot create provider authority", () => {
  const base = createDeterministicMemberConversationProviderRequest();
  const blocked = createMemberConversationTurnResponse(base.input.turnRequest, {
    ruleVersion: "GC-MEMBER-CONVERSATION-SAFETY-1",
    sourceRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-RULES-1",
    classification: "pain_or_instability",
    action: "stop",
  });
  const unavailable = createMemberConversationTurnResponse(base.input.turnRequest, {
    ruleVersion: "GC-MEMBER-CONVERSATION-SAFETY-1",
    sourceRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-RULES-1",
    classification: "unavailable",
    action: "unavailable",
  });
  assert.equal(createMemberConversationProviderRequest(value({ turnResponse: blocked })), null);
  assert.equal(createMemberConversationProviderRequest(value({ turnResponse: unavailable })), null);
});

test("canonical digest binds every normalized field and ignores caller insertion order", () => {
  const original = createDeterministicMemberConversationProviderRequest();
  const reordered = createMemberConversationProviderRequest({
    regionPolicy: original.request.regionPolicy,
    turnResponse: original.input.turnResponse,
    turnRequest: original.input.turnRequest,
    responseSchemaSha256: original.request.responseSchemaSha256,
    responseSchemaVersion: original.request.responseSchemaVersion,
    developerPromptSha256: original.request.developerPromptSha256,
    developerPromptVersion: original.request.developerPromptVersion,
    model: original.request.model,
    attemptId: original.request.attemptId,
    controls: { ...original.request.controls, tools: [] },
    transportVersion: original.request.transportVersion,
    version: MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
  });
  assert.equal(memberConversationProviderRequestDigest(reordered), original.digestSha256);
  const changes = [
    { memberTurn: "Different synthetic turn." }, { model: "synthetic-model-2" },
    { developerPromptSha256: "d".repeat(64) },
    { responseSchemaSha256: "e".repeat(64) }, { regionPolicy: "synthetic-region-2" },
    { controls: { ...original.request.controls, tools: [], maxOutputTokens: 513 } },
  ];
  for (const override of changes) {
    const changed = createMemberConversationProviderRequest(value(override));
    assert.notEqual(memberConversationProviderRequestDigest(changed), original.digestSha256);
  }
  assert.equal(memberConversationProviderRequestDigest(Object.freeze({ ...original.request })), null);
});

test("deterministic helper is test-only and production remains null and unwired", () => {
  const root = path.resolve(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const startup = fs.readFileSync(path.join(
    root, "src", "goals-coach", "gymmaster-member-conversation-turn-startup.js"
  ), "utf8");
  const composition = fs.readFileSync(path.join(
    root, "src", "goals-coach", "member-conversation-provider-dispatch-composition.js"
  ), "utf8");
  assert.doesNotMatch(server, /member-conversation-provider-request-envelope/);
  assert.doesNotMatch(startup, /member-conversation-provider-request-envelope/);
  assert.doesNotMatch(composition, /member-conversation-provider-request-envelope/);
  assert.doesNotMatch(server, /deterministic-member-conversation-provider-request/);
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});
