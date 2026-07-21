"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGymMasterMemberAccessAuthorizer } = require("../src/goals-coach/gymmaster-gatekeeper-membership");
const { createGymMasterMemberLoginHandler } = require("../src/goals-coach/gymmaster-member-login-route");
const { createGymMasterMemberLoginRateLimiter } = require("../src/goals-coach/gymmaster-member-login-rate-limit");
const { createGymMasterMemberLoginService } = require("../src/goals-coach/gymmaster-member-login");
const { createGymMasterMemberSessionService } = require("../src/goals-coach/gymmaster-member-session");

const ORIGIN = "https://ultimategoalsfitness.com";

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

function request() {
  return {
    ip: "203.0.113.10",
    body: { email: "member@example.com", password: "member-password" },
    get(name) { return name === "Origin" ? ORIGIN : undefined; },
  };
}

function createFlow(overrides = {}) {
  const loginService = createGymMasterMemberLoginService({
    enabled: true,
    memberApiKey: "members-key",
    loginClient: async () => ({ result: { token: "never-returned-provider-token", expires: 3600, memberid: 10482 } }),
    ...overrides.loginService,
  });
  const authorizeIdentity = createGymMasterMemberAccessAuthorizer({
    mappingAuthorizer: { authorizeIdentity: async () => ({ active: true, mappingId: "7", memberId: "10482" }) },
    membershipVerifier: { verifyActiveMember: async () => ({ active: true }) },
    ...overrides.access,
  });
  return createGymMasterMemberLoginHandler({
    enabled: true,
    origin: ORIGIN,
    loginService,
    authorizeIdentity: authorizeIdentity.authorizeIdentity,
    sessionService: createGymMasterMemberSessionService({
      secret: "a".repeat(32),
      now: () => new Date("2026-07-21T12:00:00Z"),
      randomBytes: () => Buffer.alloc(32, 7),
    }),
    attemptLimiter: createGymMasterMemberLoginRateLimiter({ now: () => 0 }),
    ...overrides.handler,
  });
}

test("proposed login flow permits only authenticated, mapped, active members and returns no provider secret", async () => {
  const res = response();
  await createFlow()(request(), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, undefined);
  assert.match(res.headers["Set-Cookie"], /^gc_member_session=/);
  assert.equal(res.headers["Set-Cookie"].includes("never-returned-provider-token"), false);
  assert.equal(res.headers["Set-Cookie"].includes("member-password"), false);
  assert.equal(res.headers["Set-Cookie"].includes("member@example.com"), false);
});

test("proposed login flow refuses a GymMaster-inactive member without a session", async () => {
  const res = response();
  const handler = createFlow({
    access: { membershipVerifier: { verifyActiveMember: async () => ({ active: false }) } },
  });
  await handler(request(), res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "MEMBER_LOGIN_FAILED" });
  assert.equal(res.headers["Set-Cookie"], undefined);
});
