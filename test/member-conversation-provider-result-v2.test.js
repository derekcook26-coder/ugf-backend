"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createTerminalState } = require("../src/goals-coach/bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
  MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION,
  createMemberConversationProviderRejectionV2,
  createMemberConversationProviderResultAuthorityV2,
  createMemberConversationProviderResultV2,
  markMemberConversationProviderResultAuthorityV2Contacted,
  memberConversationProviderResultAuthorityV2MatchesRequest,
  readMemberConversationProviderRejectionV2,
  readMemberConversationProviderResultV2,
  revokeMemberConversationProviderResultAuthorityV2,
  validMemberConversationProviderResultAuthorityV2,
} = require("../src/goals-coach/member-conversation-provider-result-v2");
const {
  createDeterministicMemberConversationProviderRequestV2,
} = require("./helpers/deterministic-member-conversation-provider-request-v2");
const {
  createMemberConversationProviderResultAuthority,
  createMemberConversationProviderResult,
  readMemberConversationProviderResult,
} = require("../src/goals-coach/member-conversation-provider-result");
const {
  createDeterministicMemberConversationProviderRequest,
} = require("./helpers/deterministic-member-conversation-provider-request");

function fixture() {
  const created = createDeterministicMemberConversationProviderRequestV2();
  const terminalState = createTerminalState();
  const authority = createMemberConversationProviderResultAuthorityV2({
    request: created.request,
    terminalState,
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
  });
  return { authority, created, terminalState };
}

function success(overrides = {}) {
  return {
    coaching: "Move with control.\nStop if symptoms change.",
    providerRequestId: "req_synthetic",
    providerResponseId: "resp_synthetic",
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION,
    ...overrides,
  };
}

test("V2 authority is opaque, exact-request bound, and contact is one-use", () => {
  const value = fixture();
  assert.equal(validMemberConversationProviderResultAuthorityV2(value.authority), true);
  assert.equal(Object.getPrototypeOf(value.authority), null);
  assert.deepEqual(Object.keys(value.authority), []);
  assert.equal(JSON.stringify(value.authority), "{}");
  assert.equal(memberConversationProviderResultAuthorityV2MatchesRequest(
    value.authority, value.created.request
  ), true);
  assert.equal(markMemberConversationProviderResultAuthorityV2Contacted(value.authority), true);
  assert.equal(markMemberConversationProviderResultAuthorityV2Contacted(value.authority), false);
});

test("success is exact, opaque, one-read, and consumes the sole outcome", () => {
  const value = fixture();
  assert.equal(markMemberConversationProviderResultAuthorityV2Contacted(value.authority), true);
  const token = createMemberConversationProviderResultV2(value.authority, success());
  assert.ok(token);
  assert.deepEqual(Object.keys(token), []);
  const result = readMemberConversationProviderResultV2(token, value.authority);
  assert.equal(result.version, MEMBER_CONVERSATION_PROVIDER_RESULT_V2_VERSION);
  assert.equal(result.attemptId, value.created.request.attemptId);
  assert.equal(result.coaching, success().coaching);
  assert.equal(result.providerResultDigestSha256.length, 64);
  assert.equal(result.requestEnvelopeDigestSha256, value.created.digestSha256);
  assert.equal(readMemberConversationProviderResultV2(token, value.authority), null);
  assert.equal(createMemberConversationProviderRejectionV2(value.authority, {
    providerRequestId: "req_other",
    terminalCategory: "rate_limited",
    version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
  }), null);
});

test("rejection preserves only bounded one-read provenance", () => {
  const value = fixture();
  assert.equal(markMemberConversationProviderResultAuthorityV2Contacted(value.authority), true);
  const token = createMemberConversationProviderRejectionV2(value.authority, {
    providerRequestId: "req_rejected",
    terminalCategory: "authentication_rejected",
    version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
  });
  assert.ok(token);
  assert.deepEqual(readMemberConversationProviderRejectionV2(token, value.authority), {
    attemptId: value.created.request.attemptId,
    providerRequestId: "req_rejected",
    requestEnvelopeDigestSha256: value.created.digestSha256,
    terminalCategory: "authentication_rejected",
    version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
  });
  assert.equal(readMemberConversationProviderRejectionV2(token, value.authority), null);
});

test("pre-contact outcomes do not mutate authority; malformed post-contact revokes", () => {
  const pre = fixture();
  assert.equal(createMemberConversationProviderResultV2(pre.authority, success()), null);
  assert.equal(validMemberConversationProviderResultAuthorityV2(pre.authority), true);
  assert.equal(markMemberConversationProviderResultAuthorityV2Contacted(pre.authority), true);
  let traps = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { traps += 1; throw new Error("observed"); } });
  assert.equal(createMemberConversationProviderResultV2(pre.authority, proxy), null);
  assert.equal(traps, 0);
  assert.equal(validMemberConversationProviderResultAuthorityV2(pre.authority), false);
});

test("coaching and identifiers fail closed after contact", () => {
  const invalid = [
    { coaching: " leading" },
    { coaching: "trailing " },
    { coaching: "e\u0301" },
    { coaching: "\ud800" },
    { coaching: "bad\tcontrol" },
    { providerRequestId: "bad id" },
    { providerResponseId: "" },
  ];
  for (const override of invalid) {
    const value = fixture();
    markMemberConversationProviderResultAuthorityV2Contacted(value.authority);
    assert.equal(createMemberConversationProviderResultV2(
      value.authority, success(override)
    ), null);
    assert.equal(validMemberConversationProviderResultAuthorityV2(value.authority), false);
  }
});

test("coaching exact character and UTF-8 boundaries permit astral Unicode and LF", () => {
  const accepted = [
    "a".repeat(800),
    "é".repeat(800),
    `${"a".repeat(398)}😀\n${"b".repeat(399)}`,
  ];
  for (const coaching of accepted) {
    const value = fixture();
    markMemberConversationProviderResultAuthorityV2Contacted(value.authority);
    assert.ok(createMemberConversationProviderResultV2(
      value.authority, success({ coaching })
    ));
  }
  for (const coaching of ["a".repeat(801), "é".repeat(801), "😀".repeat(401)]) {
    const value = fixture();
    markMemberConversationProviderResultAuthorityV2Contacted(value.authority);
    assert.equal(createMemberConversationProviderResultV2(
      value.authority, success({ coaching })
    ), null);
  }
});

test("rejection categories and identifiers are exact and bounded", () => {
  for (const terminalCategory of [
    "authentication_rejected", "rate_limited", "request_rejected",
  ]) {
    const value = fixture();
    markMemberConversationProviderResultAuthorityV2Contacted(value.authority);
    assert.ok(createMemberConversationProviderRejectionV2(value.authority, {
      providerRequestId: "r".repeat(255),
      terminalCategory,
      version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
    }));
  }
  for (const override of [
    { terminalCategory: "server_error" },
    { providerRequestId: "bad id" },
    { providerRequestId: "r".repeat(256) },
  ]) {
    const value = fixture();
    markMemberConversationProviderResultAuthorityV2Contacted(value.authority);
    assert.equal(createMemberConversationProviderRejectionV2(value.authority, {
      providerRequestId: "req_rejected",
      terminalCategory: "rate_limited",
      version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
      ...override,
    }), null);
  }
});

test("success and rejection compete for exactly one contacted outcome", async () => {
  for (const successFirst of [true, false]) {
    const value = fixture();
    markMemberConversationProviderResultAuthorityV2Contacted(value.authority);
    const createSuccess = () => createMemberConversationProviderResultV2(
      value.authority, success()
    );
    const createRejection = () => createMemberConversationProviderRejectionV2(
      value.authority, {
        providerRequestId: "req_rejected",
        terminalCategory: "rate_limited",
        version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
      }
    );
    const outcomes = await Promise.all((successFirst
      ? [createSuccess, createRejection] : [createRejection, createSuccess])
      .map((create) => Promise.resolve().then(create)));
    assert.equal(outcomes.filter(Boolean).length, 1);
  }
});

test("explicit revocation and terminal transition invalidate unread child tokens", () => {
  const revoked = fixture();
  markMemberConversationProviderResultAuthorityV2Contacted(revoked.authority);
  const successToken = createMemberConversationProviderResultV2(
    revoked.authority, success()
  );
  assert.equal(revokeMemberConversationProviderResultAuthorityV2(revoked.authority), true);
  assert.equal(readMemberConversationProviderResultV2(
    successToken, revoked.authority
  ), null);

  const terminal = fixture();
  markMemberConversationProviderResultAuthorityV2Contacted(terminal.authority);
  const rejectionToken = createMemberConversationProviderRejectionV2(
    terminal.authority, {
      providerRequestId: "req_rejected",
      terminalCategory: "request_rejected",
      version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
    }
  );
  terminal.terminalState.terminate("synthetic");
  assert.equal(readMemberConversationProviderRejectionV2(
    rejectionToken, terminal.authority
  ), null);
});

test("cross-request and cross-attempt drift fail without mutating authority", () => {
  const value = fixture();
  const drifted = createDeterministicMemberConversationProviderRequestV2({
    attemptId: "00000000-0000-4000-8000-000000000099",
  });
  assert.equal(memberConversationProviderResultAuthorityV2MatchesRequest(
    value.authority, drifted.request
  ), false);
  assert.equal(validMemberConversationProviderResultAuthorityV2(value.authority), true);
  assert.equal(memberConversationProviderResultAuthorityV2MatchesRequest(
    value.authority, value.created.request
  ), true);
});

test("V1 authorities and tokens cannot cross the V2 boundary", () => {
  const v1Request = createDeterministicMemberConversationProviderRequest();
  const terminalState = createTerminalState();
  const v1Authority = createMemberConversationProviderResultAuthority({
    request: v1Request.request,
    terminalState,
  });
  const v2 = fixture();
  assert.equal(markMemberConversationProviderResultAuthorityV2Contacted(v1Authority), false);
  assert.equal(createMemberConversationProviderResultV2(v1Authority, success()), null);
  assert.equal(markMemberConversationProviderResultAuthorityV2Contacted(v2.authority), true);
  const v2Token = createMemberConversationProviderResultV2(v2.authority, success());
  assert.equal(readMemberConversationProviderResult(v2Token, v1Authority), null);
  const v1Token = createMemberConversationProviderResult({
    authority: v1Authority,
    coaching: "Move with control.",
    providerRequestId: "req_v1",
    providerResponseId: "resp_v1",
    version: "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-1",
  });
  assert.equal(readMemberConversationProviderResultV2(v1Token, v2.authority), null);
});

test("foreign rejection read does not consume the rightful token", () => {
  const owner = fixture();
  const foreign = fixture();
  markMemberConversationProviderResultAuthorityV2Contacted(owner.authority);
  const token = createMemberConversationProviderRejectionV2(owner.authority, {
    providerRequestId: "req_owner",
    terminalCategory: "rate_limited",
    version: MEMBER_CONVERSATION_PROVIDER_REJECTION_V2_VERSION,
  });
  assert.equal(readMemberConversationProviderRejectionV2(token, foreign.authority), null);
  assert.ok(readMemberConversationProviderRejectionV2(token, owner.authority));
});

test("cross-authority, terminal, revoked, V1, proxy, and accessor inputs fail closed", () => {
  const left = fixture();
  const right = fixture();
  markMemberConversationProviderResultAuthorityV2Contacted(left.authority);
  const token = createMemberConversationProviderResultV2(left.authority, success());
  assert.equal(readMemberConversationProviderResultV2(token, right.authority), null);
  assert.ok(readMemberConversationProviderResultV2(token, left.authority));

  const terminal = fixture();
  terminal.terminalState.terminate("synthetic");
  assert.equal(markMemberConversationProviderResultAuthorityV2Contacted(terminal.authority), false);

  const revoked = fixture();
  assert.equal(revokeMemberConversationProviderResultAuthorityV2(revoked.authority), true);
  assert.equal(revokeMemberConversationProviderResultAuthorityV2(revoked.authority), false);

  let getterCalls = 0;
  const input = {};
  for (const [key, current] of Object.entries({
    request: right.created.request,
    terminalState: right.terminalState,
    version: MEMBER_CONVERSATION_PROVIDER_RESULT_AUTHORITY_V2_VERSION,
  })) Object.defineProperty(input, key, key === "request" ? {
    enumerable: true, get() { getterCalls += 1; throw new Error("observed"); },
  } : { enumerable: true, value: current });
  assert.equal(createMemberConversationProviderResultAuthorityV2(input), null);
  assert.equal(getterCalls, 0);
});

test("V2 result implementation remains absent from production startup", () => {
  const root = path.resolve(__dirname, "..");
  for (const relative of [
    "server.js",
    "src/goals-coach/gymmaster-member-conversation-turn-startup.js",
    "src/goals-coach/member-conversation-provider-dispatch-composition.js",
    "src/goals-coach/member-conversation-provider-result.js",
  ]) assert.doesNotMatch(
    fs.readFileSync(path.join(root, relative), "utf8"),
    /member-conversation-provider-result-v2/
  );
});
