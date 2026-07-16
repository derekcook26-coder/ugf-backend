const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const {
  createStaffAuthenticator,
  createStaffOriginGuard,
  parseExactOrigins,
} = require("../src/auth/clerk-staff-auth");
const { createStaffAuthorization } = require("../src/auth/staff-authorization");
const { jsonRequest, startApp } = require("./helpers/http-app");

function authConfiguration() {
  return {
    environment: "production",
    authorizedParties: ["https://staff.example.test"],
    secretKey: "test-secret-not-a-real-key",
    publishableKey: "pk_test_not_real",
    issuer: "https://clerk.example.test",
  };
}

function signedInState(overrides = {}) {
  const claims = {
    azp: "https://staff.example.test",
    iss: "https://clerk.example.test",
    exp: Math.floor(Date.now() / 1000) + 60,
    ...(overrides.claims || {}),
  };
  return {
    isAuthenticated: true,
    tokenType: overrides.tokenType || "session_token",
    toAuth() {
      return {
        userId: overrides.userId === undefined ? "user_staff_valid" : overrides.userId,
        sessionId: overrides.sessionId === undefined ? "sess_valid" : overrides.sessionId,
        sessionClaims: claims,
      };
    },
  };
}

test("staff origins are exact and production HTTPS only", () => {
  assert.deepEqual(
    parseExactOrigins("https://staff.example.test,https://admin.example.test", "production"),
    ["https://staff.example.test", "https://admin.example.test"]
  );
  assert.throws(() => parseExactOrigins("https://*.example.test", "production"));
  assert.throws(() => parseExactOrigins("https://staff.example.test/", "production"));
  assert.throws(() => parseExactOrigins("http://staff.example.test", "production"));
  assert.deepEqual(parseExactOrigins("http://localhost:3000", "development"), ["http://localhost:3000"]);
});

test("staff origin guard handles approved preflights and rejects unexpected browser origins", async (t) => {
  const app = express();
  app.use("/staff", createStaffOriginGuard(authConfiguration()));
  app.get("/staff/session", (req, res) => res.json({ ok: true }));
  const running = await startApp(app);
  t.after(() => running.close());

  const allowedPreflight = await jsonRequest(running.url, "/staff/session", {
    method: "OPTIONS",
    headers: { Origin: "https://staff.example.test" },
  });
  assert.equal(allowedPreflight.response.status, 204);
  assert.equal(allowedPreflight.response.headers.get("access-control-allow-origin"), "https://staff.example.test");

  const blockedPreflight = await jsonRequest(running.url, "/staff/session", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example.test" },
  });
  assert.equal(blockedPreflight.response.status, 403);

  const blockedRequest = await jsonRequest(running.url, "/staff/session", {
    headers: { Origin: "https://evil.example.test" },
  });
  assert.equal(blockedRequest.response.status, 403);

  const serverRequestWithoutOrigin = await jsonRequest(running.url, "/staff/session");
  assert.equal(serverRequestWithoutOrigin.response.status, 200);
});

test("Clerk middleware accepts only a valid session token, issuer, expiration, subject, session, and azp", async (t) => {
  let capturedOptions;
  const app = express();
  app.use(createStaffAuthenticator({
    configuration: authConfiguration(),
    clerkClient: {},
    authenticateRequest: async (input) => {
      capturedOptions = input.options;
      return signedInState();
    },
  }));
  app.get("/", (req, res) => res.json(req.staffIdentity));
  const running = await startApp(app);
  t.after(() => running.close());

  const valid = await jsonRequest(running.url, "/");
  assert.equal(valid.response.status, 200);
  assert.equal(valid.body.authSubject, "user_staff_valid");
  assert.equal(capturedOptions.acceptsToken, "session_token");
  assert.deepEqual(capturedOptions.authorizedParties, ["https://staff.example.test"]);
  assert.equal(Object.hasOwn(capturedOptions, "audience"), false);
});

for (const scenario of [
  { name: "missing azp", state: signedInState({ claims: { azp: undefined } }) },
  { name: "unexpected azp", state: signedInState({ claims: { azp: "https://evil.example.test" } }) },
  { name: "wrong issuer", state: signedInState({ claims: { iss: "https://other.example.test" } }) },
  { name: "expired token", state: signedInState({ claims: { exp: Math.floor(Date.now() / 1000) - 1 } }) },
  { name: "missing subject", state: signedInState({ userId: null }) },
  { name: "missing session", state: signedInState({ sessionId: null }) },
  { name: "wrong token type", state: signedInState({ tokenType: "api_key" }) },
]) {
  test(`Clerk middleware fails closed for ${scenario.name}`, async (t) => {
    const app = express();
    app.use(createStaffAuthenticator({
      configuration: authConfiguration(),
      clerkClient: {},
      authenticateRequest: async () => scenario.state,
    }));
    app.get("/", (req, res) => res.json({ ok: true }));
    const running = await startApp(app);
    t.after(() => running.close());
    const result = await jsonRequest(running.url, "/");
    assert.equal(result.response.status, 401);
  });
}

test("missing Clerk configuration fails closed without affecting process startup", async (t) => {
  const app = express();
  app.use(createStaffAuthenticator({
    configuration: {
      environment: "production",
      authorizedParties: [],
      secretKey: "",
      publishableKey: "",
      issuer: "",
    },
  }));
  app.get("/", (req, res) => res.json({ ok: true }));
  const running = await startApp(app);
  t.after(() => running.close());
  const result = await jsonRequest(running.url, "/");
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error, "STAFF_AUTH_NOT_CONFIGURED");
});

test("PostgreSQL staff authorization checks active status on every request", async () => {
  let active = true;
  let queryCount = 0;
  const authorization = createStaffAuthorization({
    db: {
      async query() {
        queryCount += 1;
        return {
          rows: [{ id: "10", display_name: "Coach", role: "coach", active }],
        };
      },
    },
  });
  const req = { staffIdentity: { authProvider: "clerk", authSubject: "user_staff" } };

  const first = await new Promise((resolve) => {
    authorization.loadActiveStaff(req, { status: () => ({ json: resolve }) }, () => resolve("next"));
  });
  assert.equal(first, "next");
  active = false;
  const second = await new Promise((resolve) => {
    authorization.loadActiveStaff(req, { status: (status) => ({ json: (body) => resolve({ status, body }) }) }, () => resolve("next"));
  });
  assert.equal(second.status, 403);
  assert.equal(second.body.error, "STAFF_ACCESS_DISABLED");
  assert.equal(queryCount, 2);
});
