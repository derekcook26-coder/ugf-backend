"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const express = require("express");
const {
  PRIVATE_SCREEN_BODY,
  UNAUTHORIZED_BODY,
  UNAVAILABLE_BODY,
} = require("../src/goals-coach/gymmaster-member-private-screen");
const {
  composeGymMasterMemberPrivateScreenRoute,
} = require("../src/goals-coach/gymmaster-member-private-screen-route-composition");
const {
  createGymMasterMemberPrivateScreenStartup,
  memberPrivateScreenEnabled,
} = require("../src/goals-coach/gymmaster-member-private-screen-startup");
const {
  SESSION_COOKIE_NAME,
  createGymMasterMemberSessionService,
} = require("../src/goals-coach/gymmaster-member-session");
const { jsonRequest, startApp } = require("./helpers/http-app");

const now = new Date("2026-08-14T12:00:00Z");
const origin = "https://ultimategoalsfitness.com";
const secret = "private-screen-test-secret-value-123456789";

function environment(overrides = {}) {
  return {
    GOALS_COACH_MEMBER_PRIVATE_SCREEN_ENABLED: "true",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin,
    GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL:
      "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
    GYMMASTER_SITE: "ugf",
    GYMMASTER_API_KEY: "synthetic-gatekeeper-key",
    GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: secret,
    ...overrides,
  };
}

function token(identity = {}) {
  return createGymMasterMemberSessionService({ secret, now: () => now }).issue({
    authProvider: "gymmaster",
    authSubject: "gymmaster:10482",
    expiresInSeconds: 900,
    ...identity,
  });
}

function cookie(value = token()) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`;
}

function signedTokenWithClaims(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readyOptions(overrides = {}) {
  return {
    environment: environment(),
    now: () => now,
    db: {
      query: async () => ({ rows: [{ mapping_id: 9, member_id: 10482 }] }),
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        members: [{ memberid: 10482, stopatgate: false, membership: [{ expired: false }] }],
      }),
    }),
    ...overrides,
  };
}

async function appFor(options) {
  const app = express();
  const startup = createGymMasterMemberPrivateScreenStartup(options);
  const composition = composeGymMasterMemberPrivateScreenRoute(app, startup);
  return { app, startup, composition };
}

function assertPrivateHeaders(response, expectedOrigin = origin) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), expectedOrigin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
}

test("private screen is disabled by default and parses only the exact approved true string", async (t) => {
  for (const value of [undefined, "", "TRUE", " true", "true ", true, "1", "yes"]) {
    assert.equal(memberPrivateScreenEnabled(value), false);
  }
  assert.equal(memberPrivateScreenEnabled("true"), true);
  const { app, startup, composition } = await appFor(readyOptions({ environment: {} }));
  assert.equal(startup.status, "disabled");
  assert.deepEqual(composition, { mounted: false, path: null });
  const running = await startApp(app);
  t.after(() => running.close());
  assert.equal((await jsonRequest(running.url, "/goalscoach/member/private-screen")).response.status, 404);
});

test("missing or malformed prerequisites fail closed without database or provider startup calls", () => {
  const invalidEnvironments = [
    environment({ GOALS_COACH_MEMBER_LOGIN_ORIGIN: "http://example.com" }),
    environment({ GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "https://example.com/members" }),
    environment({ GYMMASTER_SITE: "" }),
    environment({ GYMMASTER_API_KEY: "" }),
    environment({ GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: "short" }),
  ];
  let databaseCalls = 0;
  let providerCalls = 0;
  for (const invalid of invalidEnvironments) {
    const startup = createGymMasterMemberPrivateScreenStartup({
      environment: invalid,
      db: { query: async () => { databaseCalls += 1; } },
      fetchImpl: async () => { providerCalls += 1; },
    });
    assert.equal(startup.status, "not_ready");
    assert.equal(startup.handlers, null);
  }
  assert.equal(createGymMasterMemberPrivateScreenStartup({ environment: environment() }).status, "not_ready");
  assert.equal(databaseCalls, 0);
  assert.equal(providerCalls, 0);
});

test("active mapped member receives the exact private shell with protected credentialed CORS", async (t) => {
  const { app } = await appFor(readyOptions());
  const running = await startApp(app);
  t.after(() => running.close());
  const result = await jsonRequest(running.url, "/goalscoach/member/private-screen", {
    headers: { Origin: origin, Cookie: cookie() },
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, PRIVATE_SCREEN_BODY);
  assertPrivateHeaders(result.response);
  assert.deepEqual(Object.keys(result.body), [
    "status", "message", "nextAction", "activationPermitted", "externalCallsPermitted",
  ]);
});

test("invalid sessions are concealed uniformly and dependencies are not called before authentication", async (t) => {
  let databaseCalls = 0;
  let providerCalls = 0;
  const options = readyOptions({
    db: { query: async () => { databaseCalls += 1; throw new Error("synthetic database failure"); } },
    fetchImpl: async () => { providerCalls += 1; throw new Error("synthetic provider failure"); },
  });
  const { app } = await appFor(options);
  const running = await startApp(app);
  t.after(() => running.close());
  const valid = token();
  const malformed = "not-a-session";
  const forged = `${valid.slice(0, -1)}x`;
  const expired = createGymMasterMemberSessionService({
    secret,
    now: () => new Date("2026-08-14T11:00:00Z"),
  }).issue({ authProvider: "gymmaster", authSubject: "gymmaster:10482", expiresInSeconds: 1 });
  for (const session of [null, malformed, forged, expired]) {
    const result = await jsonRequest(running.url, "/goalscoach/member/private-screen", {
      headers: { Origin: origin, ...(session ? { Cookie: cookie(session) } : {}) },
    });
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, UNAUTHORIZED_BODY);
    assertPrivateHeaders(result.response);
  }
  assert.equal(databaseCalls, 0);
  assert.equal(providerCalls, 0);
});

test("inactive, unmapped, mismatched, revoked, and wrong-provider identities are concealed as 401", async (t) => {
  const cases = [
    { rows: [] },
    { rows: [{ mapping_id: null, member_id: 10482 }] },
  ];
  for (const queryResult of cases) {
    const { app } = await appFor(readyOptions({ db: { query: async () => queryResult } }));
    const running = await startApp(app);
    t.after(() => running.close());
    const result = await jsonRequest(running.url, "/goalscoach/member/private-screen", {
      headers: { Origin: origin, Cookie: cookie() },
    });
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, UNAUTHORIZED_BODY);
    assertPrivateHeaders(result.response);
  }
  const validClaims = {
    v: 1,
    sid: "synthetic-private-screen-session-id",
    p: "gymmaster",
    s: "gymmaster:10482",
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(now.getTime() / 1000) + 900,
  };
  const wrongProvider = signedTokenWithClaims({ ...validClaims, p: "clerk" });
  const mismatchedSubject = signedTokenWithClaims({ ...validClaims, s: "gymmaster:10483" });
  for (const invalidToken of [wrongProvider, mismatchedSubject]) {
    const { app } = await appFor(readyOptions());
    const running = await startApp(app);
    t.after(() => running.close());
    const result = await jsonRequest(running.url, "/goalscoach/member/private-screen", {
      headers: { Origin: origin, Cookie: cookie(invalidToken) },
    });
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, UNAUTHORIZED_BODY);
    assertPrivateHeaders(result.response);
  }
});

test("inactive and unmatched Gatekeeper results are concealed as 401", async (t) => {
  for (const members of [
    [],
    [{ memberid: 10482, stopatgate: true, membership: [{ expired: false }] }],
    [{ memberid: 10483, stopatgate: false, membership: [{ expired: false }] }],
  ]) {
    const { app } = await appFor(readyOptions({
      fetchImpl: async () => ({ ok: true, json: async () => ({ members }) }),
    }));
    const running = await startApp(app);
    t.after(() => running.close());
    const result = await jsonRequest(running.url, "/goalscoach/member/private-screen", {
      headers: { Origin: origin, Cookie: cookie() },
    });
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, UNAUTHORIZED_BODY);
    assertPrivateHeaders(result.response);
  }
});

test("authenticated database and Gatekeeper failures receive only the minimized 503", async (t) => {
  const failures = [
    readyOptions({ db: { query: async () => { throw new Error("database diagnostic"); } } }),
    readyOptions({ fetchImpl: async () => { throw new Error("provider diagnostic"); } }),
  ];
  for (const options of failures) {
    const { app } = await appFor(options);
    const running = await startApp(app);
    t.after(() => running.close());
    const result = await jsonRequest(running.url, "/goalscoach/member/private-screen", {
      headers: { Origin: origin, Cookie: cookie() },
    });
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, UNAVAILABLE_BODY);
    assertPrivateHeaders(result.response);
    const serialized = JSON.stringify(result.body);
    for (const forbidden of ["mapping", "enrollment", "provider", "configuration", "stage", "diagnostic"]) {
      assert.equal(serialized.toLowerCase().includes(forbidden), false);
    }
  }
});

test("mapping deactivation takes effect on the next request", async (t) => {
  let active = true;
  const { app } = await appFor(readyOptions({
    db: { query: async () => ({ rows: active ? [{ mapping_id: 9, member_id: 10482 }] : [] }) },
  }));
  const running = await startApp(app);
  t.after(() => running.close());
  const request = () => jsonRequest(running.url, "/goalscoach/member/private-screen", {
    headers: { Origin: origin, Cookie: cookie() },
  });
  assert.equal((await request()).response.status, 200);
  active = false;
  const revoked = await request();
  assert.equal(revoked.response.status, 401);
  assert.deepEqual(revoked.body, UNAUTHORIZED_BODY);
  assertPrivateHeaders(revoked.response);
});

test("origin is rejected before session or dependency authorization", async (t) => {
  let databaseCalls = 0;
  let providerCalls = 0;
  const { app } = await appFor(readyOptions({
    db: { query: async () => { databaseCalls += 1; return { rows: [] }; } },
    fetchImpl: async () => { providerCalls += 1; return { ok: true, json: async () => ({ members: [] }) }; },
  }));
  const running = await startApp(app);
  t.after(() => running.close());
  for (const requestOrigin of [undefined, "https://example.com", `${origin}/`]) {
    const result = await jsonRequest(running.url, "/goalscoach/member/private-screen", {
      headers: { ...(requestOrigin ? { Origin: requestOrigin } : {}), Cookie: cookie() },
    });
    assert.equal(result.response.status, 403);
    assert.deepEqual(result.body, { error: "MEMBER_ORIGIN_NOT_ALLOWED" });
  }
  assert.equal(databaseCalls, 0);
  assert.equal(providerCalls, 0);
});

test("composition mounts only the exact private-screen GET route", async (t) => {
  const { app, composition } = await appFor(readyOptions());
  assert.deepEqual(composition, { mounted: true, path: "/goalscoach/member/private-screen" });
  const running = await startApp(app);
  t.after(() => running.close());
  for (const path of [
    "/goalscoach/member/session", "/goalscoach/login", "/goalscoach/workout-logs",
    "/goalscoach/tracked-workout-sessions", "/goalscoach/coaching", "/goalscoach/voice",
    "/goalscoach/safety", "/alpha/goals-coach", "/staff",
  ]) assert.equal((await jsonRequest(running.url, path)).response.status, 404, path);
  assert.equal((await jsonRequest(running.url, "/goalscoach/member/private-screen", {
    method: "POST", headers: { Origin: origin, Cookie: cookie() },
  })).response.status, 404);
});
