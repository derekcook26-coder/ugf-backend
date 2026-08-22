"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const express = require("express");
const corpus = require("./fixtures/member-conversation-turn-v1.json");
const {
  MEMBER_CONVERSATION_TURN_FLAG,
  createConversationTurnRequestHandler,
  memberConversationTurnEnabled,
} = require("../src/goals-coach/gymmaster-member-conversation-turn");
const { createGymMasterMemberConversationTurnStartup } = require("../src/goals-coach/gymmaster-member-conversation-turn-startup");
const { createMemberConversationTurnSafetyClassifier } = require("../src/goals-coach/member-conversation-turn-safety");
const { createMemberConversationBindingService } = require("../src/goals-coach/member-conversation-binding-service");
const { composeGymMasterMemberConversationTurnRoute } = require("../src/goals-coach/gymmaster-member-conversation-turn-route-composition");
const { SESSION_COOKIE_NAME, TWO_HOUR_SESSION_FLAG } = require("../src/goals-coach/gymmaster-member-session");
const { createApplicationJsonParser } = require("../src/goals-coach/transcription-route");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://coach.example";
const now = new Date("2026-08-21T12:00:00Z");
const passRateLimit = (_req, _res, next) => next();
function deferred() { let resolve; const promise = new Promise((next) => { resolve = next; }); return { promise, resolve }; }
function mockExchange(body = corpus.valid.safeRequest) {
  let writes = 0; const statuses = []; const bodies = [];
  const req = Object.assign(new EventEmitter(), {
    query: {}, body: structuredClone(body), complete: true,
    aborted: false, destroyed: false,
    alphaMemberIdentity: {
      authProvider: "gymmaster", authSubject: "gymmaster:10482",
      mappingId: "9", memberId: "10482", memberSessionId: "17",
    },
  });
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, writableEnded: false, destroyed: false, closed: false,
    status(value) { writes += 1; statuses.push(value); return this; },
    json(value) { writes += 1; bodies.push(value); return this; },
  });
  return { req, res, statuses, bodies, writes: () => writes };
}
function environment(value = "true") {
  return {
    [MEMBER_CONVERSATION_TURN_FLAG]: value,
    [TWO_HOUR_SESSION_FLAG]: "true",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin,
  };
}
function cookie() {
  return `${SESSION_COOKIE_NAME}=${"s".repeat(43)}`;
}
function database(rows = [{ mapping_id: 9, member_id: 10482 }], events = {}) {
  return { async connect() { return { async query(sql) {
    events.queries?.push(String(sql));
    if (/^(?:BEGIN|COMMIT|ROLLBACK)|set_config\('/.test(String(sql))) return { rows: [] };
    if (String(sql).includes("UPDATE goals_coach_member_sessions session")) return { rows: [{
      member_session_id: 17, auth_mapping_id: 9, member_id: 10482,
      auth_provider: "gymmaster", auth_subject: "gymmaster:10482",
    }] };
    return { rows };
  }, release(error) { events.releases?.push(error); } }; } };
}
function provider(overrides = {}) {
  return {
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-1",
    cancellationMode: "abort_signal_required",
    persistencePermitted: false,
    externalCallsPermitted: false,
    async processTurn() { return { accepted: true }; },
    ...overrides,
  };
}
function conversationOwnership(overrides = {}) {
  return Object.freeze({
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-1",
    providerFree: true,
    readOnly: true,
    concealUnknown: true,
    exactConversationBinding: true,
    async authorize({ authMappingId, memberId, memberSessionId, conversation }, operation) {
      return authMappingId === "9" && memberId === "10482" && memberSessionId === "17"
        && operation && operation.signal && operation.terminalState
        && typeof operation.outerDeadlineNs === "bigint"
        && conversation.reference === corpus.valid.safeRequest.conversation.reference
        && conversation.version === 1 && conversation.provenance === "member_session" ? { owned: true } : null;
    },
    ...overrides,
  });
}
function currentMembership(overrides = {}) {
  return Object.freeze({
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-1", source: "gymmaster_gatekeeper",
    readOnly: true, currentRequestVerification: true,
    async verify({ memberId }) { return memberId === "10482" ? { active: true } : null; },
    ...overrides,
  });
}
function currentConsent(overrides = {}) {
  return Object.freeze({
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-1", noticeVersion: "GC-MEMBER-COACHING-CONSENT-1",
    providerFree: true, readOnly: true, currentAcceptedConsentRequired: true,
    async verify({ memberId }) { return memberId === "10482" ? { accepted: true } : null; },
    ...overrides,
  });
}
function currentSafetyEligibility(overrides = {}) {
  return Object.freeze({
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-1", noticeVersion: "GC-MEMBER-SAFETY-NOTICE-3",
    providerFree: true, readOnly: true, currentScreenCompleteRequired: true,
    async verify({ memberId }) { return memberId === "10482" ? { eligible: true } : null; },
    ...overrides,
  });
}
function prerequisites(overrides = {}) {
  return {
    currentMembership: currentMembership(), currentConsent: currentConsent(),
    currentSafetyEligibility: currentSafetyEligibility(), ...overrides,
  };
}
function idempotency() {
  const entries = new Map();
  return Object.freeze({
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-1",
    conflictMode: "reject_exact_key_signature_mismatch",
    replayMode: "replay_exact_result",
    persistenceMode: "required_external_dependency",
    async execute({ key, signature, operation }) {
      const existing = entries.get(key);
      if (existing && existing.signature !== signature) throw new Error("idempotency conflict");
      if (existing) return existing.promise;
      const promise = Promise.resolve().then(operation);
      entries.set(key, { signature, promise });
      try { return await promise; }
      catch (error) { entries.delete(key); throw error; }
    },
  });
}
function startup(overrides = {}) {
  return createGymMasterMemberConversationTurnStartup({
    environment: environment(), now: () => now, db: database(), conversationOwnership: conversationOwnership(), idempotency: idempotency(),
    provider: provider(), safetyClassifier: createMemberConversationTurnSafetyClassifier(),
    rateLimit: passRateLimit, ...prerequisites(), ...overrides,
  });
}
async function application(value) {
  const app = express(); app.use(createApplicationJsonParser()); const created = value || startup();
  const composition = composeGymMasterMemberConversationTurnRoute(app, created);
  return { app, startup: created, composition };
}

test("turn flag is exact and default or provider-null production startup mounts no route", async (t) => {
  for (const value of [undefined, "", "TRUE", " true", "true ", true]) assert.equal(memberConversationTurnEnabled(value), false);
  assert.equal(memberConversationTurnEnabled("true"), true);
  const disabled = createGymMasterMemberConversationTurnStartup({ environment: {}, db: database(), provider: provider() });
  const notReady = createGymMasterMemberConversationTurnStartup({ environment: environment(), db: database(), provider: null });
  assert.equal(disabled.status, "disabled"); assert.equal(notReady.status, "not_ready");
  const { app, composition } = await application(notReady); assert.deepEqual(composition, { mounted: false, path: null });
  const running = await startApp(app); t.after(() => running.close());
  assert.equal((await jsonRequest(running.url, "/goalscoach/member/conversation/turn", { method: "POST", body: corpus.valid.safeRequest })).response.status, 404);
  for (const dependency of ["currentMembership", "currentConsent", "currentSafetyEligibility"]) {
    assert.equal(startup({ [dependency]: null }).status, "not_ready", dependency);
  }
});

test("the exact turn path owns its post-authentication 2048-byte parser", async (t) => {
  const { app } = await application(); const running = await startApp(app); t.after(() => running.close());
  const oversizedWhitespace = `${JSON.stringify(corpus.valid.safeRequest)}${" ".repeat(3000)}`;
  const result = await fetch(`${running.url}/goalscoach/member/conversation/turn`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie(), "Content-Type": "application/json" },
    body: oversizedWhitespace,
  });
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), { error: "MEMBER_CONVERSATION_TURN_INVALID" });
});

test("authenticated exact-origin turn is read-only, minimized, and idempotent", async (t) => {
  const queries = []; const releases = [];
  let processCalls = 0;
  const deterministic = provider({ async processTurn() { processCalls += 1; return { accepted: true }; } });
  const { app } = await application(startup({ db: database(undefined, { queries, releases }), provider: deterministic }));
  const running = await startApp(app); t.after(() => running.close());
  for (let index = 0; index < 2; index += 1) {
    const result = await jsonRequest(running.url, "/goalscoach/member/conversation/turn", {
      method: "POST", headers: { Origin: origin, Cookie: cookie() }, body: corpus.valid.safeRequest,
    });
    assert.equal(result.response.status, 200); assert.deepEqual(result.body, corpus.valid.responses.safe);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(JSON.stringify(result.body).includes("10482"), false);
  }
  assert.equal(queries.filter((value) => value === "BEGIN READ ONLY").length, 2);
  assert.deepEqual(releases, [undefined, undefined, undefined, undefined]);
  assert.equal(processCalls, 1);
  const conflict = structuredClone(corpus.valid.safeRequest); conflict.memberText = "A different payload under the same key.";
  const rejected = await jsonRequest(running.url, "/goalscoach/member/conversation/turn", {
    method: "POST", headers: { Origin: origin, Cookie: cookie() }, body: conflict,
  });
  assert.equal(rejected.response.status, 503);
});

test("deterministic safety stops unsafe and ambiguous text before any provider method", async (t) => {
  let ownershipCalls = 0; let processCalls = 0;
  const turnProvider = provider({
    async processTurn() { processCalls += 1; return { accepted: true }; },
  });
  const { app } = await application(startup({
    conversationOwnership: conversationOwnership({ async authorize() { ownershipCalls += 1; return { owned: true }; } }),
    provider: turnProvider,
  }));
  const running = await startApp(app); t.after(() => running.close());
  for (const [index, memberText] of [
    corpus.valid.unsafeRequest.memberText,
    "My knee has concerning discomfort.",
    "I cannot tell whether this is pain.",
    "I feel dizzy right now.",
    "I have shortness of breath.",
    "My ankle is swelling and aching.",
    "My ankle is swollen.",
    "I have pins and needles in my foot.",
  ].entries()) {
    const request = structuredClone(corpus.valid.unsafeRequest);
    request.memberText = memberText;
    if (index) request.requestId = request.idempotencyKey = `018f47f2-a3b4-4c5d-8e6f-0123456789a${index}`;
    const result = await jsonRequest(running.url, "/goalscoach/member/conversation/turn", {
      method: "POST", headers: { Origin: origin, Cookie: cookie() }, body: request,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.state, "blocked");
    assert.equal(result.body.result.safety.action, "stop");
  }
  assert.equal(ownershipCalls, 8);
  assert.equal(processCalls, 0);
});

test("current membership, accepted consent, and safety eligibility fail closed before processing", async (t) => {
  for (const [name, override] of [
    ["membership", { currentMembership: currentMembership({ async verify() { return { active: false }; } }) }],
    ["consent", { currentConsent: currentConsent({ async verify() { return { accepted: false }; } }) }],
    ["safety", { currentSafetyEligibility: currentSafetyEligibility({ async verify() { return { eligible: false }; } }) }],
  ]) {
    let idempotencyCalls = 0; let processCalls = 0;
    const exactIdempotency = { ...idempotency(), async execute() { idempotencyCalls += 1; throw new Error("must not execute"); } };
    const { app } = await application(startup({
      ...override, idempotency: exactIdempotency,
      provider: provider({ async processTurn() { processCalls += 1; return { accepted: true }; } }),
    }));
    const running = await startApp(app); t.after(() => running.close());
    const result = await jsonRequest(running.url, "/goalscoach/member/conversation/turn", {
      method: "POST", headers: { Origin: origin, Cookie: cookie() }, body: corpus.valid.safeRequest,
    });
    assert.equal(result.response.status, 404, name);
    assert.equal(idempotencyCalls, 0, name);
    assert.equal(processCalls, 0, name);
  }
});

test("every idempotent replay is reparsed and rebound to the exact request", async (t) => {
  const invalid = [
    { memberId: "10482" },
    { response: { ...corpus.valid.responses.safe, memberId: "10482" } },
    { response: { ...corpus.valid.responses.safe, requestId: "018f47f2-a3b4-4c5d-8e6f-0123456789ff", idempotencyKey: "018f47f2-a3b4-4c5d-8e6f-0123456789ff" } },
    { response: { ...corpus.valid.responses.safe, result: { ...corpus.valid.responses.safe.result, safety: { ...corpus.valid.responses.safe.result.safety, requestHash: "0".repeat(64) } } } },
  ];
  for (const replay of invalid) {
    let processCalls = 0;
    const replaying = { ...idempotency(), async execute() { return replay; } };
    const { app } = await application(startup({
      idempotency: replaying,
      provider: provider({ async processTurn() { processCalls += 1; return { accepted: true }; } }),
    }));
    const running = await startApp(app); t.after(() => running.close());
    const result = await jsonRequest(running.url, "/goalscoach/member/conversation/turn", {
      method: "POST", headers: { Origin: origin, Cookie: cookie() }, body: corpus.valid.safeRequest,
    });
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, { error: "MEMBER_CONVERSATION_TURN_UNAVAILABLE" });
    assert.equal(processCalls, 0);
  }
});

test("origin, session, mapping, and conversation ownership fail closed", async (t) => {
  let ownershipCalls = 0;
  const { app } = await application(startup({
    conversationOwnership: conversationOwnership({ async authorize() { ownershipCalls += 1; return null; } }),
  }));
  const running = await startApp(app); t.after(() => running.close());
  const cases = [
    { headers: { Origin: "https://wrong.example", Cookie: cookie() }, expected: 403 },
    { headers: { Origin: origin }, expected: 401 },
    { headers: { Origin: origin, Cookie: `${SESSION_COOKIE_NAME}=forged` }, expected: 401 },
    { headers: { Origin: origin, Cookie: cookie() }, expected: 404 },
  ];
  for (const item of cases) {
    const result = await jsonRequest(running.url, "/goalscoach/member/conversation/turn", { method: "POST", headers: item.headers, body: corpus.valid.safeRequest });
    assert.equal(result.response.status, item.expected);
  }
  assert.equal(ownershipCalls, 1);
});

test("turn handler passes exact durable session provenance and conceals cross-session use", async () => {
  const calls = [];
  const ownership = conversationOwnership({
    async authorize(input, operation) {
      calls.push({ input, operation });
      return input.memberSessionId === "17" ? { owned: true } : null;
    },
  });
  const handler = createConversationTurnRequestHandler({
    ...prerequisites(),
    authorizeIdentity: async () => ({ active: true, mappingId: 9, memberId: 10482 }),
    conversationOwnership: ownership,
    idempotency: idempotency(), provider: provider(),
    safetyClassifier: createMemberConversationTurnSafetyClassifier(), timeoutMilliseconds: 100,
  });
  const accepted = mockExchange();
  await handler(accepted.req, accepted.res);
  assert.deepEqual(accepted.statuses, [200]);
  assert.deepEqual(Object.keys(calls[0].input).sort(), [
    "authMappingId", "conversation", "memberId", "memberSessionId",
  ]);
  assert.equal(calls[0].input.authMappingId, "9");
  assert.equal(calls[0].input.memberSessionId, "17");
  assert.deepEqual(Object.keys(calls[0].operation).sort(), [
    "outerDeadlineNs", "signal", "terminalState",
  ]);

  const denied = mockExchange();
  denied.req.alphaMemberIdentity = Object.freeze({
    ...denied.req.alphaMemberIdentity, memberSessionId: "18",
  });
  await handler(denied.req, denied.res);
  assert.deepEqual(denied.statuses, [404]);
  assert.deepEqual(denied.bodies, [{ error: "MEMBER_CONVERSATION_NOT_FOUND" }]);
});

test("binding ownership database failure and deadline are unavailable while abort stays silent", async () => {
  function handlerFor(pool, timeoutMilliseconds) {
    return createConversationTurnRequestHandler({
      ...prerequisites(),
      authorizeIdentity: async () => ({ active: true, mappingId: 9, memberId: 10482 }),
      conversationOwnership: createMemberConversationBindingService({ pool, timeoutMilliseconds }).ownership,
      idempotency: idempotency(), provider: provider(),
      safetyClassifier: createMemberConversationTurnSafetyClassifier(), timeoutMilliseconds,
    });
  }

  const failed = mockExchange();
  await handlerFor({ async connect() { throw new Error("synthetic database detail"); } }, 100)(failed.req, failed.res);
  assert.deepEqual(failed.statuses, [503]);
  assert.deepEqual(failed.bodies, [{ error: "MEMBER_CONVERSATION_TURN_UNAVAILABLE" }]);

  const deadline = mockExchange();
  const keepAlive = setTimeout(() => {}, 50);
  await handlerFor({ connect() { return new Promise(() => {}); } }, 5)(deadline.req, deadline.res);
  clearTimeout(keepAlive);
  assert.deepEqual(deadline.statuses, [503]);
  assert.deepEqual(deadline.bodies, [{ error: "MEMBER_CONVERSATION_TURN_UNAVAILABLE" }]);

  const checkout = deferred();
  const checkoutStarted = deferred();
  let releases = 0; let queries = 0;
  const aborted = mockExchange();
  aborted.req.complete = false;
  const pending = handlerFor({ connect() { checkoutStarted.resolve(); return checkout.promise; } }, 100)(aborted.req, aborted.res);
  await checkoutStarted.promise;
  aborted.req.aborted = true;
  aborted.req.emit("aborted");
  assert.equal(await pending, undefined);
  checkout.resolve({ query() { queries += 1; }, release() { releases += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted.writes(), 0);
  assert.equal(queries, 0);
  assert.equal(releases, 1);
  assert.equal(aborted.req.listenerCount("aborted"), 0);
  assert.equal(aborted.res.listenerCount("close"), 0);
});

test("unknown, cross-member, and stale conversations are concealed before every safety outcome", async (t) => {
  const cases = [
    { name: "unsafe unknown", text: corpus.valid.unsafeRequest.memberText, reference: "123e4567-e89b-42d3-a456-426614174011", version: 1 },
    { name: "ambiguous cross-member", text: "My knee has concerning discomfort.", reference: "123e4567-e89b-42d3-a456-426614174012", version: 1 },
    { name: "unavailable stale", text: "I cannot tell whether this is pain.", reference: corpus.valid.safeRequest.conversation.reference, version: 2 },
    { name: "safe unknown", text: corpus.valid.safeRequest.memberText, reference: "123e4567-e89b-42d3-a456-426614174013", version: 1 },
  ];
  let classifyCalls = 0; let processCalls = 0;
  const classifier = {
    ...createMemberConversationTurnSafetyClassifier(),
    async classify() { classifyCalls += 1; throw new Error("Safety must not attest an unowned conversation"); },
  };
  const { app } = await application(startup({
    conversationOwnership: conversationOwnership({ async authorize() { return null; } }),
    provider: provider({ async processTurn() { processCalls += 1; return { accepted: true }; } }),
    safetyClassifier: classifier,
  }));
  const running = await startApp(app); t.after(() => running.close());
  for (const [index, item] of cases.entries()) {
    const request = structuredClone(corpus.valid.safeRequest);
    request.requestId = request.idempotencyKey = `018f47f2-a3b4-4c5d-8e6f-0123456789b${index}`;
    request.memberText = item.text;
    request.conversation = { reference: item.reference, version: item.version, provenance: "member_session" };
    const result = await jsonRequest(running.url, "/goalscoach/member/conversation/turn", {
      method: "POST", headers: { Origin: origin, Cookie: cookie() }, body: request,
    });
    assert.equal(result.response.status, 404, item.name);
    assert.deepEqual(result.body, { error: "MEMBER_CONVERSATION_NOT_FOUND" }, item.name);
    assert.equal(JSON.stringify(result.body).includes("safety"), false, item.name);
  }
  assert.equal(classifyCalls, 0);
  assert.equal(processCalls, 0);
});

test("malformed, provider failure, and live deadline are generic and late settlement is silent", async (t) => {
  for (const [turnProvider, expected] of [
    [provider({ async processTurn() { throw new Error("synthetic provider detail"); } }), 503],
    [provider({ async processTurn() { return new Promise(() => {}); } }), 503],
  ]) {
    const { app } = await application(startup({ provider: turnProvider, timeoutMilliseconds: 5 }));
    const running = await startApp(app); t.after(() => running.close());
    const result = await jsonRequest(running.url, "/goalscoach/member/conversation/turn", { method: "POST", headers: { Origin: origin, Cookie: cookie() }, body: corpus.valid.safeRequest });
    assert.equal(result.response.status, expected); assert.deepEqual(result.body, { error: "MEMBER_CONVERSATION_TURN_UNAVAILABLE" });
  }
  const { app } = await application(); const running = await startApp(app); t.after(() => running.close());
  const expanded = structuredClone(corpus.valid.safeRequest); expanded.memberId = "10482";
  assert.equal((await jsonRequest(running.url, "/goalscoach/member/conversation/turn", { method: "POST", headers: { Origin: origin, Cookie: cookie() }, body: expanded })).response.status, 400);
});

test("credentialed preflight exposes only POST and Content-Type from the exact origin", async (t) => {
  const { app } = await application(); const running = await startApp(app); t.after(() => running.close());
  const preflight = await fetch(`${running.url}/goalscoach/member/conversation/turn`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST,OPTIONS");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type");
  assert.equal((await fetch(`${running.url}/goalscoach/member/conversation/turn`, { headers: { Origin: origin } })).status, 404);
});

test("request abort revokes response authority and aborts provider work before late settlement", async () => {
  const late = deferred(); let providerSignal; let writes = 0;
  const handler = createConversationTurnRequestHandler({
    ...prerequisites(),
    authorizeIdentity: async () => ({ active: true, mappingId: 9, memberId: 10482 }),
    conversationOwnership: conversationOwnership(),
    idempotency: idempotency(),
    provider: provider({
      async processTurn({ signal }) { providerSignal = signal; return late.promise; },
    }),
    safetyClassifier: createMemberConversationTurnSafetyClassifier(),
    timeoutMilliseconds: 100,
  });
  const req = Object.assign(new EventEmitter(), {
    query: {}, body: structuredClone(corpus.valid.safeRequest), complete: false,
    aborted: false, destroyed: false,
    alphaMemberIdentity: {
      authProvider: "gymmaster", authSubject: "gymmaster:10482",
      mappingId: "9", memberId: "10482", memberSessionId: "17",
    },
  });
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, writableEnded: false, destroyed: false, closed: false,
    status() { writes += 1; return this; }, json() { writes += 1; return this; },
  });
  const pending = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  req.aborted = true; req.emit("aborted");
  assert.equal(await pending, undefined);
  assert.equal(providerSignal.aborted, true);
  late.resolve({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("late authorization cannot advance into ownership after abort or deadline", async () => {
  for (const mode of ["abort", "deadline"]) {
    const authorization = deferred(); let ownershipCalls = 0;
    const exchange = mockExchange();
    const handler = createConversationTurnRequestHandler({
      ...prerequisites(),
      authorizeIdentity: async () => authorization.promise,
      conversationOwnership: conversationOwnership({ async authorize() { ownershipCalls += 1; return { owned: true }; } }),
      idempotency: idempotency(),
      provider: provider(),
      safetyClassifier: createMemberConversationTurnSafetyClassifier(),
      timeoutMilliseconds: 5,
    });
    const pending = handler(exchange.req, exchange.res);
    if (mode === "abort") {
      exchange.req.complete = false; exchange.req.aborted = true; exchange.req.emit("aborted");
      assert.equal(await pending, undefined);
    } else {
      const keepAlive = setTimeout(() => {}, 50);
      await pending;
      clearTimeout(keepAlive);
      assert.deepEqual(exchange.statuses, [503]);
      assert.deepEqual(exchange.bodies, [{ error: "MEMBER_CONVERSATION_TURN_UNAVAILABLE" }]);
    }
    authorization.resolve({ active: true, mappingId: 9, memberId: 10482 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ownershipCalls, 0);
    assert.equal(exchange.req.listenerCount("aborted"), 0);
    assert.equal(exchange.res.listenerCount("close"), 0);
  }
});

test("late ownership cannot advance into safety or processing after abort, deadline, or an unowned result", async () => {
  for (const mode of ["abort-true", "abort-false", "deadline-true", "deadline-false"]) {
    const ownership = deferred(); const ownershipStarted = deferred(); let processCalls = 0;
    const exchange = mockExchange();
    const handler = createConversationTurnRequestHandler({
      ...prerequisites(),
      authorizeIdentity: async () => ({ active: true, mappingId: 9, memberId: 10482 }),
      conversationOwnership: conversationOwnership({
        async authorize() { ownershipStarted.resolve(); return ownership.promise; },
      }),
      idempotency: idempotency(),
      provider: provider({ async processTurn() { processCalls += 1; return { accepted: true }; } }),
      safetyClassifier: createMemberConversationTurnSafetyClassifier(),
      timeoutMilliseconds: 5,
    });
    const pending = handler(exchange.req, exchange.res);
    await ownershipStarted.promise;
    if (mode.startsWith("abort")) {
      exchange.req.complete = false; exchange.req.aborted = true; exchange.req.emit("aborted");
      assert.equal(await pending, undefined);
    } else {
      const keepAlive = setTimeout(() => {}, 50);
      await pending;
      clearTimeout(keepAlive);
      assert.deepEqual(exchange.statuses, [503]);
      assert.deepEqual(exchange.bodies, [{ error: "MEMBER_CONVERSATION_TURN_UNAVAILABLE" }]);
    }
    ownership.resolve(mode.endsWith("false") ? null : { owned: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processCalls, 0);
    assert.equal(exchange.req.listenerCount("aborted"), 0);
    assert.equal(exchange.res.listenerCount("close"), 0);
  }
});

test("late prerequisite settlement cannot advance after abort or deadline", async () => {
  for (const prerequisite of ["currentMembership", "currentConsent", "currentSafetyEligibility"]) {
    for (const mode of ["abort", "deadline"]) {
      const late = deferred(); const started = deferred();
      let idempotencyCalls = 0; let processCalls = 0;
      const delayed = prerequisite === "currentMembership"
        ? currentMembership({ async verify() { started.resolve(); return late.promise; } })
        : prerequisite === "currentConsent"
          ? currentConsent({ async verify() { started.resolve(); return late.promise; } })
          : currentSafetyEligibility({ async verify() { started.resolve(); return late.promise; } });
      const exchange = mockExchange();
      const handler = createConversationTurnRequestHandler({
        ...prerequisites({ [prerequisite]: delayed }),
        authorizeIdentity: async () => ({ active: true, mappingId: 9, memberId: 10482 }),
        conversationOwnership: conversationOwnership(),
        idempotency: { ...idempotency(), async execute() { idempotencyCalls += 1; throw new Error("must not execute"); } },
        provider: provider({ async processTurn() { processCalls += 1; return { accepted: true }; } }),
        safetyClassifier: createMemberConversationTurnSafetyClassifier(), timeoutMilliseconds: 5,
      });
      const pending = handler(exchange.req, exchange.res); await started.promise;
      if (mode === "abort") {
        exchange.req.complete = false; exchange.req.aborted = true; exchange.req.emit("aborted");
        assert.equal(await pending, undefined);
      } else {
        const keepAlive = setTimeout(() => {}, 50); await pending; clearTimeout(keepAlive);
        assert.deepEqual(exchange.statuses, [503]);
      }
      late.resolve(prerequisite === "currentMembership" ? { active: true }
        : prerequisite === "currentConsent" ? { accepted: true } : { eligible: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(idempotencyCalls, 0, `${prerequisite}:${mode}`);
      assert.equal(processCalls, 0, `${prerequisite}:${mode}`);
      assert.equal(exchange.req.listenerCount("aborted"), 0);
      assert.equal(exchange.res.listenerCount("close"), 0);
    }
  }
});

test("production imports no fixture or deterministic provider and bootstrap receives only null-provider startup", () => {
  const paths = [path.join(__dirname, "../server.js"), ...fs.readdirSync(path.join(__dirname, "../src/goals-coach"))
    .filter((name) => name.includes("conversation-turn") && name.endsWith(".js"))
    .map((name) => path.join(__dirname, "../src/goals-coach", name))];
  for (const file of paths) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes("test/fixtures"), false);
    assert.equal(source.includes("member-conversation-turn-v1.json"), false);
  }
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?provider:\s*null[\s\S]*?\}\)/);
  assert.match(server, /createProductionMemberConversationAuthorizationAdapters/);
  assert.match(server, /conversationOwnership:\s*memberConversationAuthorization\.conversationOwnership/);
  assert.match(server, /currentMembership:\s*memberConversationAuthorization\.currentMembership/);
  assert.match(server, /currentConsent:\s*memberConversationAuthorization\.currentConsent/);
  assert.match(server, /currentSafetyEligibility:\s*memberConversationAuthorization\.currentSafetyEligibility/);
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /safetyClassifier:\s*null/);
  assert.match(server, /conversationStartup:\s*memberConversationTurnStartup/);
  assert.equal(server.slice(server.indexOf("var memberConversationTurnStartup ="), server.indexOf("composeGymMasterMemberConversationTurnRoute(app")).includes("phase1bStartup"), false);
});
