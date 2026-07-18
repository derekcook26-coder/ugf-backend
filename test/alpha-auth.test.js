const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const {
  createAlphaMemberAuthenticator,
  createAlphaOriginGuard,
  parseExactAlphaOrigins,
} = require("../src/auth/clerk-alpha-member-auth");
const { createAlphaMemberAuthorization } = require("../src/auth/alpha-member-authorization");
const { jsonRequest, startApp } = require("./helpers/http-app");

function configuration() {
  return {
    environment: "production",
    authorizedParties: ["https://alpha.example.test"],
    secretKey: "test-secret-not-a-real-key",
    publishableKey: "pk_test_not_real",
    issuer: "https://alpha-clerk.example.test",
    audience: "goals-coach-alpha-api",
  };
}

function signedInState(overrides = {}) {
  const claims = {
    azp: "https://alpha.example.test",
    aud: "goals-coach-alpha-api",
    iss: "https://alpha-clerk.example.test",
    exp: Math.floor(Date.now() / 1000) + 60,
    fva: [1, 1],
    ...(overrides.claims || {}),
  };
  return {
    isAuthenticated: true,
    tokenType: overrides.tokenType || "session_token",
    toAuth() {
      return {
        userId: overrides.userId === undefined ? "user_alpha_valid" : overrides.userId,
        sessionId: overrides.sessionId === undefined ? "sess_alpha_valid" : overrides.sessionId,
        sessionClaims: claims,
      };
    },
  };
}

test("alpha origins are exact and production HTTPS only", () => {
  assert.deepEqual(
    parseExactAlphaOrigins("https://alpha.example.test,https://alpha2.example.test", "production"),
    ["https://alpha.example.test", "https://alpha2.example.test"]
  );
  assert.throws(() => parseExactAlphaOrigins("https://*.example.test", "production"));
  assert.throws(() => parseExactAlphaOrigins("https://alpha.example.test/", "production"));
  assert.throws(() => parseExactAlphaOrigins("http://alpha.example.test", "production"));
  assert.deepEqual(parseExactAlphaOrigins("http://localhost:3100", "test"), ["http://localhost:3100"]);
});

test("alpha origin guard accepts exact preflight and rejects public, staff, and unknown origins", async (t) => {
  const app = express();
  app.use("/alpha/goals-coach", createAlphaOriginGuard(configuration()));
  app.get("/alpha/goals-coach/profile", (req, res) => res.json({ ok: true }));
  const running = await startApp(app);
  t.after(() => running.close());

  const preflight = await jsonRequest(running.url, "/alpha/goals-coach/profile", {
    method: "OPTIONS",
    headers: { Origin: "https://alpha.example.test" },
  });
  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.response.headers.get("access-control-allow-origin"), "https://alpha.example.test");

  for (const origin of [
    "https://ultimate-goals-fitness.sintra.site",
    "https://staff.example.test",
    "https://unknown.example.test",
  ]) {
    const blocked = await jsonRequest(running.url, "/alpha/goals-coach/profile", {
      headers: { Origin: origin },
    });
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.body.error, "ALPHA_ORIGIN_NOT_ALLOWED");
  }

  const noOrigin = await jsonRequest(running.url, "/alpha/goals-coach/profile");
  assert.equal(noOrigin.response.status, 200);
});

test("alpha authentication validates the dedicated session claims and passes fixed verifier options", async (t) => {
  let capturedOptions;
  const app = express();
  app.use(createAlphaMemberAuthenticator({
    configuration: configuration(),
    clerkClient: {},
    authenticateRequest: async (input) => {
      capturedOptions = input.options;
      return signedInState();
    },
  }));
  app.get("/", (req, res) => res.json(req.alphaMemberIdentity));
  const running = await startApp(app);
  t.after(() => running.close());

  const result = await jsonRequest(running.url, "/");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.authProvider, "clerk");
  assert.equal(result.body.authSubject, "user_alpha_valid");
  assert.equal(capturedOptions.acceptsToken, "session_token");
  assert.equal(capturedOptions.audience, "goals-coach-alpha-api");
  assert.deepEqual(capturedOptions.authorizedParties, ["https://alpha.example.test"]);
});

for (const scenario of [
  { name: "invalid signature", throws: true },
  { name: "missing authorized party", state: signedInState({ claims: { azp: undefined } }) },
  { name: "wrong authorized party", state: signedInState({ claims: { azp: "https://staff.example.test" } }) },
  { name: "missing audience", state: signedInState({ claims: { aud: undefined } }) },
  { name: "wrong audience", state: signedInState({ claims: { aud: "staff-api" } }) },
  { name: "wrong issuer", state: signedInState({ claims: { iss: "https://staff-clerk.example.test" } }) },
  { name: "expired token", state: signedInState({ claims: { exp: Math.floor(Date.now() / 1000) - 1 } }) },
  { name: "missing subject", state: signedInState({ userId: null }) },
  { name: "malformed subject", state: signedInState({ userId: "staff-user" }) },
  { name: "missing session", state: signedInState({ sessionId: null }) },
  { name: "wrong token type", state: signedInState({ tokenType: "api_key" }) },
  { name: "missing MFA", state: signedInState({ claims: { fva: [1, -1] } }) },
]) {
  test(`alpha authentication fails closed for ${scenario.name}`, async (t) => {
    const app = express();
    app.use(createAlphaMemberAuthenticator({
      configuration: configuration(),
      clerkClient: {},
      authenticateRequest: async () => {
        if (scenario.throws) throw new Error("invalid signature");
        return scenario.state;
      },
    }));
    app.get("/", (req, res) => res.json({ ok: true }));
    const running = await startApp(app);
    t.after(() => running.close());
    const result = await jsonRequest(running.url, "/");
    assert.equal(result.response.status, 401);
  });
}

test("missing alpha Clerk configuration fails closed", async (t) => {
  const app = express();
  app.use(createAlphaMemberAuthenticator({
    configuration: {
      environment: "production",
      authorizedParties: [],
      secretKey: "",
      publishableKey: "",
      issuer: "",
      audience: "",
    },
  }));
  app.get("/", (req, res) => res.json({ ok: true }));
  const running = await startApp(app);
  t.after(() => running.close());
  const result = await jsonRequest(running.url, "/");
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error, "ALPHA_AUTH_NOT_CONFIGURED");
});

test("database authorization reloads the active immutable-subject mapping on every request", async () => {
  let active = true;
  let queryCount = 0;
  const authorization = createAlphaMemberAuthorization({
    applicationConfiguration: { valid: true, consentVersion: "GC-ALPHA-CONSENT-1.0", alphaEnvironment: "test" },
    db: {
      async query() {
        queryCount += 1;
        return active ? { rows: [{
          mapping_id: "9",
          member_id: "11",
          auth_provider: "clerk",
          auth_subject: "user_alpha_valid",
          first_name: "Synthetic",
          last_name: "Member",
        }] } : { rows: [] };
      },
    },
  });
  const req = { alphaMemberIdentity: { authProvider: "clerk", authSubject: "user_alpha_valid" } };
  const first = await new Promise((resolve) => {
    authorization.loadActiveAlphaMember(req, { status: () => ({ json: resolve }) }, () => resolve("next"));
  });
  assert.equal(first, "next");
  active = false;
  const second = await new Promise((resolve) => {
    authorization.loadActiveAlphaMember(
      req,
      { status: (status) => ({ json: (body) => resolve({ status, body }) }) },
      () => resolve("next")
    );
  });
  assert.equal(second.status, 403);
  assert.equal(second.body.error, "ALPHA_ACCESS_FORBIDDEN");
  assert.equal(queryCount, 2);
});
