"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createTerminalState, deadlineAfter, monotonicNow } = require("../src/goals-coach/bounded-postgres-transaction");
const { createGymMasterMemberLoginHandler } = require("../src/goals-coach/gymmaster-member-login-route");
const {
  TWO_HOUR_SESSION_TTL_SECONDS, buildGymMasterTwoHourSessionCookie,
  clearGymMasterTwoHourSessionCookie, createGymMasterTwoHourSessionAuthenticator,
  createGymMasterTwoHourSessionService, createTwoHourSessionRequestContext,
  tokenHash, twoHourSessionEnabled,
} = require("../src/goals-coach/gymmaster-member-session");

function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function operation() { const terminalState = createTerminalState(); const started = monotonicNow(); return { terminalState, monotonicNow, outerDeadlineNs: deadlineAfter(started, 1000) }; }
const identity = { authProvider: "gymmaster", authSubject: "gymmaster:7" };
const member = { active: true, mappingId: "5", memberId: "9" };

function pool(operationQuery) {
  return {
    query: operationQuery,
    async connect() {
      return {
        async query(sql, values) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [] };
          return operationQuery(sql, values);
        },
        release() {},
      };
    },
  };
}

test("two-hour capability uses an exact disabled-by-default flag", () => {
  assert.equal(twoHourSessionEnabled(undefined), false);
  for (const value of ["TRUE", " true", "true ", "1", true]) assert.equal(twoHourSessionEnabled(value), false);
  assert.equal(twoHourSessionEnabled("true"), true);
  assert.equal(TWO_HOUR_SESSION_TTL_SECONDS, 7200);
});

test("opaque token is hashed, scoped, and accepted just before but not at expiry", async () => {
  let clock = new Date("2026-01-01T00:00:00.000Z"); let stored;
  const db = pool(async (sql, values) => {
    if (sql.includes("INSERT INTO")) { stored = { hash: values[0], issued: values[3] }; return { rows: [] }; }
    const expires = new Date(stored.issued.getTime() + 7200000);
    if (values[0] === stored.hash && values[1] < expires) return { rows: [{ member_session_id: "17", auth_mapping_id: "5", member_id: "9", auth_provider: "gymmaster", auth_subject: "gymmaster:7" }] };
    return { rows: [] };
  });
  const service = createGymMasterTwoHourSessionService({ db, now: () => clock, randomBytes: () => Buffer.alloc(32, 7) });
  const token = await service.issue({ authProvider: "gymmaster", authSubject: "gymmaster:7" }, { active: true, mappingId: "5", memberId: "9" });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(stored.hash, tokenHash(token)); assert.notEqual(stored.hash, token);
  assert.equal(buildGymMasterTwoHourSessionCookie(token), `gc_member_session=${token}; Path=/goalscoach; HttpOnly; Secure; SameSite=Strict; Max-Age=7200`);
  assert.equal(clearGymMasterTwoHourSessionCookie(), "gc_member_session=; Path=/goalscoach; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  clock = new Date("2026-01-01T01:59:59.999Z");
  assert.deepEqual(await service.verify(token), { authProvider: "gymmaster", authSubject: "gymmaster:7", mappingId: "5", memberId: "9", memberSessionId: "17" });
  clock = new Date("2026-01-01T02:00:00.000Z"); await assert.rejects(service.verify(token), /invalid or expired/);
  await assert.rejects(service.verify("malformed"), /invalid or expired/);
});

test("revocation is token-hash scoped and database errors fail closed", async () => {
  const calls = []; const db = pool(async (sql, values) => { calls.push({ sql, values }); if (sql.includes("UPDATE")) return { rows: [{ id: 1 }] }; return { rows: [] }; });
  const service = createGymMasterTwoHourSessionService({ db }); const token = Buffer.alloc(32, 3).toString("base64url");
  assert.equal(await service.revoke(token), true); assert.equal(calls[0].values[0], tokenHash(token));
  const failed = createGymMasterTwoHourSessionService({ db: pool(async () => { throw new Error("unavailable"); }) });
  await assert.rejects(failed.verify(token), /Bounded database transaction did not complete/);
});

test("issuance times out pool checkout and drains a client delivered late without BEGIN", async () => {
  const keepAlive = setTimeout(() => {}, 100); const checkout = deferred(); const releases = []; const service = createGymMasterTwoHourSessionService({ db: { connect: () => checkout.promise }, databaseMilliseconds: 5, randomBytes: () => Buffer.alloc(32, 1) });
  await assert.rejects(service.issue(identity, member)); checkout.resolve({ query() { throw new Error("must stay unused"); }, release(error) { releases.push(error); } }); await new Promise((resolve) => setImmediate(resolve)); clearTimeout(keepAlive);
  assert.deepEqual(releases, [undefined]);
});

test("issuance cancellation during an unresolved BEGIN discards the unsafe client", async () => {
  const begin = deferred(); const releases = []; const route = operation(); const service = createGymMasterTwoHourSessionService({ db: { async connect() { return { query(sql) { if (sql === "BEGIN") return begin.promise; throw new Error("must not continue"); }, release(error) { releases.push(error); if (error) begin.reject(error); } }; } }, randomBytes: () => Buffer.alloc(32, 2) });
  const pending = service.issue(identity, member, route); await new Promise((resolve) => setImmediate(resolve)); route.terminalState.terminate("request_aborted", { responseAllowed: false }); await assert.rejects(pending); assert.equal(releases.length, 1); assert.ok(releases[0] instanceof Error);
});

test("verification cancellation drains its server-bounded query, rolls back, and never authenticates", async () => {
  const active = deferred(); const queries = []; const releases = []; const route = operation(); const service = createGymMasterTwoHourSessionService({ db: { async connect() { return { query(sql) { queries.push(sql); if (sql.includes("UPDATE goals_coach_member_sessions session")) return active.promise; return Promise.resolve({ rows: [] }); }, release(error) { releases.push(error); } }; } } });
  const pending = service.verify(Buffer.alloc(32, 3).toString("base64url"), route); while (!queries.some((sql) => sql.includes("UPDATE goals_coach_member_sessions session"))) await new Promise((resolve) => setImmediate(resolve)); route.terminalState.terminate("request_aborted", { responseAllowed: false }); active.resolve({ rows: [{ member_session_id: "17", auth_mapping_id: "5", member_id: "9", auth_provider: "gymmaster", auth_subject: "gymmaster:7" }] }); await assert.rejects(pending);
  assert.equal(queries.includes("COMMIT"), false); assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1); assert.deepEqual(releases, [undefined]);
});

test("successful verification derives PostgreSQL timeouts from one deadline and safely releases", async () => {
  const queries = []; const releases = []; const service = createGymMasterTwoHourSessionService({ db: { async connect() { return { async query(sql, values) { queries.push({ sql, values }); if (sql.includes("UPDATE goals_coach_member_sessions session")) return { rows: [{ member_session_id: "17", auth_mapping_id: "5", member_id: "9", auth_provider: "gymmaster", auth_subject: "gymmaster:7" }] }; return { rows: [] }; }, release(error) { releases.push(error); } }; } } });
  assert.equal((await service.verify(Buffer.alloc(32, 4).toString("base64url"))).memberSessionId, "17"); const timeoutQueries = queries.filter(({ sql }) => sql.includes("set_config")); assert.ok(timeoutQueries.length >= 3); assert.ok(timeoutQueries.every(({ values }) => /^[1-9]\d*ms$/.test(values[0]))); assert.deepEqual(releases, [undefined]);
});

test("revocation failure rolls back before safely releasing a reusable client", async () => {
  const queries = []; const releases = []; const service = createGymMasterTwoHourSessionService({ db: { async connect() { return { async query(sql) { queries.push(sql); if (sql.includes("SET revoked_at")) throw new Error("synthetic failure"); return { rows: [] }; }, release(error) { releases.push(error); } }; } } });
  await assert.rejects(service.revoke(Buffer.alloc(32, 5).toString("base64url"))); assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1); assert.deepEqual(releases, [undefined]);
});

test("protected authenticator cancellation cannot call next or emit a late response", async () => {
  const verify = deferred(); const req = new EventEmitter(); req.headers = { cookie: `gc_member_session=${Buffer.alloc(32, 6).toString("base64url")}` }; req.complete = false; const res = new EventEmitter(); res.writableEnded = false; let responses = 0; res.status = () => ({ json() { responses += 1; } }); let nextCalls = 0;
  const authenticate = createGymMasterTwoHourSessionAuthenticator({ sessionService: { verify: () => verify.promise } }); const pending = authenticate(req, res, () => { nextCalls += 1; }); req.emit("aborted"); verify.resolve(identity); await pending; assert.equal(nextCalls, 0); assert.equal(responses, 0);
});

test("login issuance cancellation cannot set a cookie or return late success", async () => {
  const issued = deferred(); const req = new EventEmitter(); req.get = () => "https://coach.example"; req.ip = "127.0.0.1"; req.body = {}; req.complete = false; const res = new EventEmitter(); res.writableEnded = false; let headers = 0; let responses = 0; res.setHeader = () => { headers += 1; }; res.status = () => ({ json() { responses += 1; }, send() { responses += 1; } });
  const handler = createGymMasterMemberLoginHandler({ enabled: true, origin: "https://coach.example", loginService: { async authenticate() { return identity; } }, sessionService: { issue: () => issued.promise }, authorizeIdentity: async () => member, attemptLimiter: { allow: () => true }, createSessionOperationContext: createTwoHourSessionRequestContext });
  const pending = handler(req, res); await new Promise((resolve) => setImmediate(resolve)); req.emit("aborted"); issued.resolve(Buffer.alloc(32, 7).toString("base64url")); await pending; assert.equal(headers, 0); assert.equal(responses, 0);
});

test("context creation rejects already-terminal requests and responses and cleans every listener", () => {
  const cases = [
    [{ aborted: true }, {}], [{ destroyed: true }, {}], [{}, { writableEnded: true }], [{}, { destroyed: true }],
  ];
  for (const [requestState, responseState] of cases) {
    const req = Object.assign(new EventEmitter(), { complete: false }, requestState);
    const res = Object.assign(new EventEmitter(), { writableEnded: false }, responseState);
    const route = createTwoHourSessionRequestContext(req, res);
    assert.equal(route.terminalState.isTerminal(), true); assert.equal(route.responseAllowed(), false);
    route.cleanup();
    assert.equal(req.listenerCount("aborted"), 0); assert.equal(req.listenerCount("close"), 0);
    assert.equal(res.listenerCount("close"), 0); assert.equal(res.listenerCount("finish"), 0);
  }
});

test("login abort during provider authentication prevents authorization, issuance, and every late response", async () => {
  const authentication = deferred(); let authorizationCalls = 0; let issueCalls = 0;
  const req = Object.assign(new EventEmitter(), { get: () => "https://coach.example", ip: "127.0.0.1", body: {}, complete: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false }); let headers = 0; let responses = 0;
  res.setHeader = () => { headers += 1; }; res.status = () => ({ json() { responses += 1; }, send() { responses += 1; } });
  const handler = createGymMasterMemberLoginHandler({ enabled: true, origin: "https://coach.example", loginService: { authenticate: () => authentication.promise }, sessionService: { async issue() { issueCalls += 1; } }, authorizeIdentity: async () => { authorizationCalls += 1; return member; }, attemptLimiter: { allow: () => true }, createSessionOperationContext: createTwoHourSessionRequestContext });
  const pending = handler(req, res); assert.equal(req.listenerCount("aborted"), 1); req.emit("aborted"); authentication.resolve(identity); await pending;
  assert.equal(authorizationCalls, 0); assert.equal(issueCalls, 0); assert.equal(headers, 0); assert.equal(responses, 0);
  assert.equal(req.listenerCount("aborted"), 0); assert.equal(res.listenerCount("finish"), 0);
});

test("login abort during local authorization prevents issuance and every late response", async () => {
  const authorization = deferred(); let issueCalls = 0;
  const req = Object.assign(new EventEmitter(), { get: () => "https://coach.example", ip: "127.0.0.1", body: {}, complete: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false }); let headers = 0; let responses = 0;
  res.setHeader = () => { headers += 1; }; res.status = () => ({ json() { responses += 1; }, send() { responses += 1; } });
  const handler = createGymMasterMemberLoginHandler({ enabled: true, origin: "https://coach.example", loginService: { async authenticate() { return identity; } }, sessionService: { async issue() { issueCalls += 1; } }, authorizeIdentity: () => authorization.promise, attemptLimiter: { allow: () => true }, createSessionOperationContext: createTwoHourSessionRequestContext });
  const pending = handler(req, res); await new Promise((resolve) => setImmediate(resolve)); req.emit("aborted"); authorization.resolve(member); await pending;
  assert.equal(issueCalls, 0); assert.equal(headers, 0); assert.equal(responses, 0);
  assert.equal(req.listenerCount("aborted"), 0); assert.equal(res.listenerCount("finish"), 0);
});

test("response finish during issuance rolls back without insert commit, late response, or listener leak", async () => {
  const insert = deferred(); const queries = []; const releases = [];
  const req = Object.assign(new EventEmitter(), { complete: false }); const res = Object.assign(new EventEmitter(), { writableEnded: false });
  const route = createTwoHourSessionRequestContext(req, res);
  const service = createGymMasterTwoHourSessionService({ db: { async connect() { return { query(sql) { queries.push(sql); if (sql.includes("INSERT INTO goals_coach_member_sessions")) return insert.promise; return Promise.resolve({ rows: [] }); }, release(error) { releases.push(error); } }; } }, randomBytes: () => Buffer.alloc(32, 8) });
  const pending = service.issue(identity, member, route); while (!queries.some((sql) => sql.includes("INSERT INTO goals_coach_member_sessions"))) await new Promise((resolve) => setImmediate(resolve));
  res.emit("finish"); insert.resolve({ rows: [] }); await assert.rejects(pending); route.cleanup();
  assert.equal(queries.includes("COMMIT"), false); assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1); assert.deepEqual(releases, [undefined]);
  assert.equal(req.listenerCount("aborted"), 0); assert.equal(res.listenerCount("finish"), 0);
});

test("response finish during protected verification prevents success, next, and late error response", async () => {
  const verify = deferred(); const req = Object.assign(new EventEmitter(), { headers: { cookie: `gc_member_session=${Buffer.alloc(32, 9).toString("base64url")}` }, complete: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false }); let responses = 0; let nextCalls = 0;
  res.status = () => ({ json() { responses += 1; } });
  const authenticate = createGymMasterTwoHourSessionAuthenticator({ sessionService: { verify: () => verify.promise } });
  const pending = authenticate(req, res, () => { nextCalls += 1; }); res.emit("finish"); verify.resolve(identity); await pending;
  assert.equal(nextCalls, 0); assert.equal(responses, 0); assert.equal(res.listenerCount("finish"), 0); assert.equal(req.listenerCount("aborted"), 0);
});

async function assertAlreadyTerminalMissingCookie(requestState, responseState) {
  const req = Object.assign(new EventEmitter(), { headers: {}, complete: false }, requestState);
  const res = Object.assign(new EventEmitter(), { writableEnded: false }, responseState);
  let responses = 0; let verifies = 0; let nextCalls = 0; let headerWrites = 0;
  res.setHeader = () => { headerWrites += 1; };
  res.status = () => ({ json() { responses += 1; } });
  const authenticate = createGymMasterTwoHourSessionAuthenticator({ sessionService: { async verify() { verifies += 1; } } });
  await authenticate(req, res, () => { nextCalls += 1; });
  assert.equal(responses, 0); assert.equal(verifies, 0); assert.equal(nextCalls, 0); assert.equal(headerWrites, 0);
  assert.equal(req.listenerCount("aborted"), 0); assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("finish"), 0); assert.equal(res.listenerCount("close"), 0);
}

test("already-aborted missing-cookie authentication returns silently with complete cleanup", async () => {
  await assertAlreadyTerminalMissingCookie({ aborted: true }, {});
});

test("already-destroyed missing-cookie request returns silently with complete cleanup", async () => {
  await assertAlreadyTerminalMissingCookie({ destroyed: true }, {});
});

test("already-ended missing-cookie response returns silently with complete cleanup", async () => {
  await assertAlreadyTerminalMissingCookie({}, { writableEnded: true });
});

test("already-destroyed missing-cookie response returns silently with complete cleanup", async () => {
  await assertAlreadyTerminalMissingCookie({}, { destroyed: true });
});

test("nonterminal missing-cookie authentication preserves the concealed 401", async () => {
  const req = Object.assign(new EventEmitter(), { headers: {}, complete: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false }); let statusCode; let body; let verifies = 0; let nextCalls = 0;
  res.status = (value) => { statusCode = value; return { json(valueBody) { body = valueBody; } }; };
  const authenticate = createGymMasterTwoHourSessionAuthenticator({ sessionService: { async verify() { verifies += 1; } } });
  await authenticate(req, res, () => { nextCalls += 1; });
  assert.equal(statusCode, 401); assert.deepEqual(body, { error: "MEMBER_AUTHENTICATION_REQUIRED" }); assert.equal(verifies, 0); assert.equal(nextCalls, 0);
  assert.equal(req.listenerCount("aborted"), 0); assert.equal(res.listenerCount("finish"), 0);
});
