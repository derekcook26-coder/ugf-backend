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
    ownerLoginStageDiagnostic: overrides.ownerLoginStageDiagnostic,
    diagnosticSink: overrides.diagnosticSink,
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

test("proposed login flow refuses a non-owner before issuing a session when owner-only authorization is composed", async () => {
  const res = response();
  const handler = createFlow({
    handler: { authorizeOwner: async () => false },
  });
  await handler(request(), res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "MEMBER_LOGIN_FAILED" });
  assert.equal(res.headers["Set-Cookie"], undefined);
});

test("exactly enabled owner login diagnostic distinguishes fixed failure stages", async () => {
  const cases = [
    {
      stage: "member_portal_request_failure",
      overrides: { loginService: { loginClient: async () => { throw new Error("raw request failure"); } } },
    },
    {
      stage: "member_portal_non_success_response",
      overrides: {
        loginService: {
          loginClient: async () => {
            const error = new Error("raw status detail");
            error.memberPortalFailureStage = "member_portal_non_success_response";
            throw error;
          },
        },
      },
    },
    {
      stage: "member_portal_provider_failure",
      overrides: {
        loginService: {
          loginClient: async () => {
            const error = new Error("raw provider detail");
            error.memberPortalFailureStage = "member_portal_provider_failure";
            throw error;
          },
        },
      },
    },
    {
      stage: "member_portal_invalid_envelope",
      overrides: { loginService: { loginClient: async () => ({ error: null, result: null }) } },
    },
    {
      stage: "local_mapping",
      overrides: { access: { mappingAuthorizer: { authorizeIdentity: async () => ({ active: false }) } } },
    },
    {
      stage: "gatekeeper",
      overrides: { access: { membershipVerifier: { verifyActiveMember: async () => ({ active: false }) } } },
    },
    {
      stage: "owner_authorization",
      overrides: { handler: { authorizeOwner: async () => false } },
    },
  ];

  for (const { stage, overrides } of cases) {
    const output = [];
    const res = response();
    await createFlow({
      ...overrides,
      ownerLoginStageDiagnostic: "true",
      diagnosticSink: (line) => output.push(line),
    })(request(), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "MEMBER_LOGIN_FAILED" });
    assert.deepEqual(output, [`[UGF] goals_coach_owner_login_stage=${stage}`]);
  }
});

test("owner login diagnostic remains disabled for every non-exact flag value", async () => {
  for (const value of [undefined, "True", " true", "true ", "1", true]) {
    const output = [];
    const res = response();
    await createFlow({
      loginService: { loginClient: async () => { throw new Error("provider failure"); } },
      ownerLoginStageDiagnostic: value,
      diagnosticSink: (line) => output.push(line),
    })(request(), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "MEMBER_LOGIN_FAILED" });
    assert.deepEqual(output, []);
  }
});

test("owner login diagnostic output cannot contain sensitive login or provider values", async () => {
  const sensitiveValues = [
    "member-password",
    "member@example.com",
    "never-returned-provider-token",
    "members-key",
    "10482",
    "203.0.113.10",
  ];
  const output = [];
  const res = response();
  await createFlow({
    loginService: {
      loginClient: async () => {
        throw new Error(`raw ${sensitiveValues.join(" ")}`);
      },
    },
    ownerLoginStageDiagnostic: "true",
    diagnosticSink: (line) => output.push(line),
  })(request(), res);
  assert.deepEqual(output, ["[UGF] goals_coach_owner_login_stage=member_portal_request_failure"]);
  for (const sensitive of sensitiveValues) {
    assert.equal(output.join("\n").includes(sensitive), false);
  }
  assert.equal(JSON.stringify(res.body), JSON.stringify({ error: "MEMBER_LOGIN_FAILED" }));
});
