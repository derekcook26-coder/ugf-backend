"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { MEMBER_COACHING_CONSENT_FLAG, MEMBER_COACHING_CONSENT_NOTICE, MEMBER_COACHING_CONSENT_NOTICE_VERSION, coachingConsentRequestHash, memberCoachingConsentEnabled, parseCoachingConsent } = require("../src/goals-coach/gymmaster-member-coaching-consent");
const { createGymMasterMemberCoachingConsentStartup } = require("../src/goals-coach/gymmaster-member-coaching-consent-startup");

const request = { clientRequestId: "00000000-0000-4000-8000-000000000013", noticeVersion: MEMBER_COACHING_CONSENT_NOTICE_VERSION, action: "accept" };

test("member coaching consent is exact-string disabled and isolated at startup", () => {
  assert.equal(MEMBER_COACHING_CONSENT_FLAG, "GOALS_COACH_MEMBER_COACHING_CONSENT_ENABLED");
  assert.equal(memberCoachingConsentEnabled("true"), true);
  for (const value of [undefined, "false", "TRUE", "1", true]) assert.equal(memberCoachingConsentEnabled(value), false);
  let calls = 0;
  const startup = createGymMasterMemberCoachingConsentStartup({ environment: {}, db: { query() { calls++; }, connect() { calls++; } }, fetchImpl() { calls++; } });
  assert.equal(startup.status, "disabled"); assert.equal(startup.router, null); assert.equal(calls, 0);
  const server = fs.readFileSync("server.js", "utf8");
  assert.doesNotMatch(server, /migrate_013/);
});

test("notice covers the approved truth-limited consent boundary", () => {
  for (const phrase of ["membership context", "current safety result", "current Goals Coach plan", "does not replace medical", "safety rules may pause", "AI service", "decline", "withdraw", "does not affect your gym membership", "not activated"]) assert.match(MEMBER_COACHING_CONSENT_NOTICE, new RegExp(phrase, "i"));
});

test("POST contract accepts only exact versioned structured choices", () => {
  assert.deepEqual(parseCoachingConsent(request, MEMBER_COACHING_CONSENT_NOTICE_VERSION), request);
  for (const bad of [
    { ...request, prose: "store me" },
    { ...request, action: "accepted" },
    { ...request, noticeVersion: "GC-ALPHA-CONSENT-1.0" },
    { ...request, clientRequestId: "not-a-uuid" },
  ]) assert.throws(() => parseCoachingConsent(bad, MEMBER_COACHING_CONSENT_NOTICE_VERSION));
});

test("idempotency hash binds action and notice but excludes request UUID", () => {
  assert.equal(coachingConsentRequestHash(request), coachingConsentRequestHash({ ...request, clientRequestId: "00000000-0000-4000-8000-000000000014" }));
  assert.notEqual(coachingConsentRequestHash(request), coachingConsentRequestHash({ ...request, action: "decline" }));
});
