"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGymMasterMemberLoginHandler } = require("../src/goals-coach/gymmaster-member-login-route");

const ORIGIN = "https://ultimategoalsfitness.com";
const identity = {
  authProvider: "gymmaster",
  authSubject: "gymmaster:10482",
  memberId: "10482",
  expiresInSeconds: 3600,
};

function response() {
  return {
    headers: {},
    statusCode: null,
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

function request(overrides = {}) {
  return {
    body: { email: "member@example.com", password: "member-password" },
    ip: "203.0.113.10",
    get(name) { return name === "Origin" ? ORIGIN : undefined; },
    ...overrides,
  };
}

function handler(overrides = {}) {
  return createGymMasterMemberLoginHandler({
    enabled: true,
    origin: ORIGIN,
    loginService: { authenticate: async () => identity },
    sessionService: { issue: () => "signed-goals-coach-session" },
    authorizeIdentity: async () => ({ active: true }),
    attemptLimiter: { allow: () => true },
    ...overrides,
  });
}

test("GymMaster member-login route is absent until explicitly enabled", async () => {
  const res = response();
  await createGymMasterMemberLoginHandler()(request(), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "MEMBER_LOGIN_NOT_AVAILABLE" });
});

test("login issues a cookie only after verified identity has an active member mapping", async () => {
  const res = response();
  await handler()(request(), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, undefined);
  assert.match(res.headers["Set-Cookie"], /^gc_member_session=signed-goals-coach-session;/);
  assert.match(res.headers["Set-Cookie"], /HttpOnly; Secure; SameSite=Strict/);
});

test("wrong origins, inactive mappings, and provider failures never issue a session", async () => {
  const wrongOrigin = response();
  await handler()(request({ get: () => "https://evil.example" }), wrongOrigin);
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal(wrongOrigin.headers["Set-Cookie"], undefined);

  const inactive = response();
  await handler({ authorizeIdentity: async () => ({ active: false }) })(request(), inactive);
  assert.deepEqual(inactive.body, { error: "MEMBER_LOGIN_FAILED" });
  assert.equal(inactive.headers["Set-Cookie"], undefined);

  const failedProvider = response();
  await handler({ loginService: { authenticate: async () => { throw new Error("sensitive detail"); } } })(request(), failedProvider);
  assert.deepEqual(failedProvider.body, { error: "MEMBER_LOGIN_FAILED" });
  assert.equal(failedProvider.headers["Set-Cookie"], undefined);
});

test("login route refuses malformed or non-HTTPS origins during composition", async () => {
  const res = response();
  await handler({ origin: "http://ultimategoalsfitness.com" })(request(), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "MEMBER_LOGIN_NOT_AVAILABLE" });
});

test("login never forwards an attempt after the local rate limit is reached", async () => {
  let providerCalls = 0;
  const res = response();
  await handler({
    attemptLimiter: { allow: () => false },
    loginService: { authenticate: async () => { providerCalls += 1; return identity; } },
  })(request(), res);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { error: "MEMBER_LOGIN_RATE_LIMITED" });
  assert.equal(providerCalls, 0);
  assert.equal(res.headers["Set-Cookie"], undefined);
});
