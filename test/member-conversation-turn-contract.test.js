"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES,
  parseMemberConversationTurnRequest,
  parseMemberConversationTurnResponse,
  responseMatchesRequest,
} = require("../src/goals-coach/member-conversation-turn-contract");

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/member-conversation-turn-v1.json"), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

test("conversation turn corpus parses exact immutable request and response shapes", () => {
  const unsafe = parseMemberConversationTurnRequest(corpus.valid.unsafeRequest);
  const safe = parseMemberConversationTurnRequest(corpus.valid.safeRequest);
  assert.ok(Object.isFrozen(unsafe)); assert.ok(Object.isFrozen(safe.conversation));
  const blocked = parseMemberConversationTurnResponse(corpus.valid.responses.blocked);
  const unavailable = parseMemberConversationTurnResponse(corpus.valid.responses.unavailable);
  const clear = parseMemberConversationTurnResponse(corpus.valid.responses.safe);
  for (const response of [blocked, unavailable, clear]) assert.ok(Object.isFrozen(response.result.safety));
  assert.equal(responseMatchesRequest(unsafe, blocked), true);
  assert.equal(responseMatchesRequest(unsafe, unavailable), true);
  assert.equal(responseMatchesRequest(safe, clear), true);
  assert.equal(responseMatchesRequest(unsafe, clear), false);
});

test("request parser rejects expanded, malformed, stale, and inconsistent identity", () => {
  const cases = [];
  const extra = clone(corpus.valid.unsafeRequest); extra.memberId = "10482"; cases.push(extra);
  const mismatch = clone(corpus.valid.unsafeRequest); mismatch.idempotencyKey = "123e4567-e89b-42d3-a456-426614174001"; cases.push(mismatch);
  const stale = clone(corpus.valid.unsafeRequest); stale.conversation.version = 0; cases.push(stale);
  const provenance = clone(corpus.valid.unsafeRequest); provenance.conversation.provenance = "private_alpha"; cases.push(provenance);
  const padded = clone(corpus.valid.unsafeRequest); padded.memberText = " text "; cases.push(padded);
  const oversized = clone(corpus.valid.unsafeRequest); oversized.memberText = "a".repeat(MEMBER_CONVERSATION_TEXT_MAXIMUM_BYTES + 1); cases.push(oversized);
  for (const value of cases) assert.throws(() => parseMemberConversationTurnRequest(value), { code: "MEMBER_CONVERSATION_TURN_CONTRACT_INVALID" });
});

test("response parser rejects unknown and inconsistent safety states", () => {
  const base = corpus.valid.responses.blocked;
  const cases = [];
  const extra = clone(base); extra.coachReply = "unsafe expansion"; cases.push(extra);
  const mismatch = clone(base); mismatch.result.state = "safe_to_process"; cases.push(mismatch);
  const wrongRule = clone(base); wrongRule.result.safety.ruleVersion = "future"; cases.push(wrongRule);
  const wrongSource = clone(base); wrongSource.result.safety.sourceRuleVersion = "future"; cases.push(wrongSource);
  const wrongHash = clone(base); wrongHash.result.safety.requestHash = "0".repeat(64); cases.push(wrongHash);
  const crossTurn = clone(base); crossTurn.conversation.version = 2; cases.push(crossTurn);
  for (const value of cases.slice(0, 4)) assert.throws(() => parseMemberConversationTurnResponse(value));
  assert.equal(responseMatchesRequest(parseMemberConversationTurnRequest(corpus.valid.unsafeRequest), parseMemberConversationTurnResponse(cases[4])), false);
  assert.equal(responseMatchesRequest(parseMemberConversationTurnRequest(corpus.valid.unsafeRequest), parseMemberConversationTurnResponse(crossTurn)), false);
});
