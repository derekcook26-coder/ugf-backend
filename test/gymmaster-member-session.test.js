"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAXIMUM_SESSION_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  buildGymMasterSessionCookie,
  createGymMasterMemberSessionAuthenticator,
  createGymMasterMemberSessionService,
  extractCookie,
} = require("../src/goals-coach/gymmaster-member-session");

const secret = "a".repeat(32);
let now = new Date("2026-07-21T12:00:00Z");

function sessions() {
  return createGymMasterMemberSessionService({
    secret,
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
  });
}

function identity(overrides = {}) {
  return { authProvider: "gymmaster", authSubject: "gymmaster:10482", expiresInSeconds: 3600, ...overrides };
}

test("GymMaster session is signed, short-lived, and contains only an immutable identity", () => {
  now = new Date("2026-07-21T12:00:00Z");
  const service = sessions();
  const token = service.issue(identity());
  const authenticated = service.verify(token);
  assert.deepEqual(authenticated, {
    authProvider: "gymmaster",
    authSubject: "gymmaster:10482",
    sessionId: Buffer.alloc(32, 7).toString("base64url"),
  });
  const payload = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
  assert.equal(payload.includes("token"), false);
  assert.equal(payload.includes("password"), false);
  assert.equal(payload.includes("member@example.com"), false);
});

test("GymMaster session expiry is capped below the provider-token lifetime", () => {
  now = new Date("2026-07-21T12:00:00Z");
  const service = sessions();
  const token = service.issue(identity({ expiresInSeconds: 3600 }));
  now = new Date("2026-07-21T12:15:00Z");
  assert.throws(() => service.verify(token), (error) => error.code === "GYMMASTER_MEMBER_SESSION_INVALID");
  assert.equal(MAXIMUM_SESSION_TTL_SECONDS, 900);
});

test("tampered tokens and malformed identities are rejected", () => {
  now = new Date("2026-07-21T12:00:00Z");
  const service = sessions();
  const token = service.issue(identity());
  assert.throws(() => service.verify(`${token}x`), (error) => error.code === "GYMMASTER_MEMBER_SESSION_INVALID");
  assert.throws(() => service.issue(identity({ authProvider: "clerk" })), /Verified GymMaster identity/);
  assert.throws(() => service.issue(identity({ authSubject: "gymmaster:0" })), /Verified GymMaster identity/);
});

test("cookie is host-only, secure, HTTP-only, strict, and scoped to Goals Coach", () => {
  const cookie = buildGymMasterSessionCookie("a.b");
  assert.equal(cookie, `${SESSION_COOKIE_NAME}=a.b; Path=/goalscoach; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
  assert.equal(extractCookie(`other=value; ${cookie}`), "a.b");
  assert.equal(extractCookie("not-a-cookie"), null);
});

test("session middleware supplies identity or emits a generic unauthorized result", () => {
  now = new Date("2026-07-21T12:00:00Z");
  const sessionService = sessions();
  const token = sessionService.issue(identity());
  const authenticate = createGymMasterMemberSessionAuthenticator({ sessionService });
  const request = { headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` } };
  let passed = false;
  authenticate(request, {}, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(request.alphaMemberIdentity.authSubject, "gymmaster:10482");

  let response;
  authenticate({ headers: {} }, { status(code) { response = { code }; return this; }, json(body) { response.body = body; } }, () => assert.fail("should not continue"));
  assert.deepEqual(response, { code: 401, body: { error: "MEMBER_AUTHENTICATION_REQUIRED" } });
});
