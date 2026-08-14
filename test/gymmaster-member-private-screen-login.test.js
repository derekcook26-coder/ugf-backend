"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const { createGymMasterMemberLoginRateLimiter } = require("../src/goals-coach/gymmaster-member-login-rate-limit");
const {
  MEMBER_PRIVATE_SCREEN_LOGIN_ENABLE_FLAG,
  createGymMasterMemberPrivateScreenLoginStartup,
  memberPrivateScreenLoginEnabled,
} = require("../src/goals-coach/gymmaster-member-private-screen-login-startup");
const {
  MEMBER_PRIVATE_SCREEN_LOGIN_PATH,
  composeGymMasterMemberPrivateScreenLoginRoute,
} = require("../src/goals-coach/gymmaster-member-private-screen-login-route-composition");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://ultimategoalsfitness.com";

function environment(overrides = {}) {
  return {
    [MEMBER_PRIVATE_SCREEN_LOGIN_ENABLE_FLAG]: "true",
    GOALS_COACH_MEMBER_LOGIN_ENABLED: "false",
    GOALS_COACH_MEMBER_PRIVATE_SCREEN_ENABLED: "false",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin,
    GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL:
      "https://ugf.gymmasteronline.com/portal/api/v1/login",
    GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL:
      "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
    GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "member-api-key",
    GYMMASTER_API_KEY: "gatekeeper-api-key",
    GYMMASTER_SITE: "ugf",
    GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: "s".repeat(32),
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const calls = { db: 0, portal: 0, gatekeeper: 0 };
  const db = overrides.db || {
    async query(sql) {
      calls.db += 1;
      assert.match(sql, /^SELECT/);
      assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/i);
      return { rows: [{
        mapping_id: "8",
        member_id: "9",
        provisioning_reference: "pending_enrollment:7",
        verified_email_snapshot: "member@example.test",
      }] };
    },
  };
  const fetchImpl = overrides.fetchImpl || (async (url) => {
    if (url.includes("/portal/api/v1/login")) {
      calls.portal += 1;
      return new Response(JSON.stringify({
        result: { token: "provider-token", expires: 900, memberid: 70001 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    calls.gatekeeper += 1;
    return new Response(JSON.stringify({
      members: [{ memberid: 70001, stopatgate: false, membership: [{ expired: false }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { calls, db, fetchImpl };
}

async function runningLogin(startup, t) {
  const app = express();
  app.use(express.json());
  composeGymMasterMemberPrivateScreenLoginRoute(app, startup);
  const running = await startApp(app);
  t.after(() => running.close());
  return running;
}

test("private-screen login is absent by default, parses only exact true, and performs no startup work", async (t) => {
  assert.equal(memberPrivateScreenLoginEnabled("true"), true);
  for (const value of [undefined, "false", "True", "TRUE", " true", "true ", true]) {
    assert.equal(memberPrivateScreenLoginEnabled(value), false);
  }
  let calls = 0;
  const startup = createGymMasterMemberPrivateScreenLoginStartup({
    environment: {},
    db: { query: async () => { calls += 1; } },
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(startup.status, "disabled");
  assert.deepEqual(composeGymMasterMemberPrivateScreenLoginRoute(express(), startup), {
    mounted: false, path: null,
  });
  const running = await runningLogin(startup, t);
  assert.equal((await jsonRequest(running.url, MEMBER_PRIVATE_SCREEN_LOGIN_PATH, {
    method: "POST", headers: { Origin: origin },
  })).response.status, 404);
  assert.equal(calls, 0);
});

test("invalid prerequisites fail closed without startup database or provider calls", () => {
  for (const override of [
    { GOALS_COACH_MEMBER_LOGIN_ORIGIN: "http://example.test" },
    { GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL: "https://example.test/login" },
    { GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "broken" },
    { GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: "short" },
  ]) {
    let calls = 0;
    const startup = createGymMasterMemberPrivateScreenLoginStartup({
      environment: environment(override),
      db: { query: async () => { calls += 1; } },
      fetchImpl: async () => { calls += 1; },
    });
    assert.equal(startup.status, "not_ready");
    assert.equal(startup.handler, null);
    assert.equal(calls, 0);
  }
});

test("exact-origin OPTIONS and successful POST issue only the existing secure session", async (t) => {
  const deps = dependencies();
  const startup = createGymMasterMemberPrivateScreenLoginStartup({
    environment: environment(), db: deps.db, fetchImpl: deps.fetchImpl,
  });
  assert.equal(startup.status, "ready_for_separate_route_composition");
  assert.deepEqual(deps.calls, { db: 0, portal: 0, gatekeeper: 0 });
  const running = await runningLogin(startup, t);
  const preflight = await jsonRequest(running.url, MEMBER_PRIVATE_SCREEN_LOGIN_PATH, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.response.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(preflight.response.headers.get("cache-control"), "no-store");
  assert.equal(preflight.response.headers.get("x-content-type-options"), "nosniff");

  const wrong = await jsonRequest(running.url, MEMBER_PRIVATE_SCREEN_LOGIN_PATH, {
    method: "POST", headers: { Origin: "https://wrong.example" },
    body: { email: "member@example.test", password: "not-returned" },
  });
  assert.equal(wrong.response.status, 403);
  assert.equal(wrong.response.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(deps.calls, { db: 0, portal: 0, gatekeeper: 0 });

  const success = await jsonRequest(running.url, MEMBER_PRIVATE_SCREEN_LOGIN_PATH, {
    method: "POST", headers: { Origin: origin },
    body: { email: "member@example.test", password: "not-returned" },
  });
  assert.equal(success.response.status, 204);
  assert.match(success.response.headers.get("set-cookie"), /^gc_member_session=.*; Path=\/goalscoach; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/);
  assert.equal(success.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(deps.calls, { db: 1, portal: 1, gatekeeper: 1 });
});

test("malformed, provider, mapping, exact-email, Gatekeeper, and dependency failures are generic", async (t) => {
  const cases = [
    { body: {}, expected: { db: 0, portal: 0, gatekeeper: 0 } },
    { portal: { result: { token: "", expires: 900, memberid: 70001 } }, expected: { db: 0, portal: 1, gatekeeper: 0 } },
    { portalStatus: 503, expected: { db: 0, portal: 1, gatekeeper: 0 } },
    { portal: { error: "invalid", result: null }, expected: { db: 0, portal: 1, gatekeeper: 0 } },
    { portal: { result: { token: "token", expires: 0, memberid: 70001 } }, expected: { db: 0, portal: 1, gatekeeper: 0 } },
    { rows: [], expected: { db: 1, portal: 1, gatekeeper: 0 } },
    { dbFailure: true, expected: { db: 1, portal: 1, gatekeeper: 0 } },
    { email: "mismatch@example.test", expected: { db: 1, portal: 1, gatekeeper: 0 } },
    { members: [], expected: { db: 1, portal: 1, gatekeeper: 1 } },
    { members: [{ memberid: 70001, stopatgate: true, membership: [{ expired: false }] }], expected: { db: 1, portal: 1, gatekeeper: 1 } },
    { members: [{ memberid: 70001, stopatgate: false, membership: [{ expired: true }] }], expected: { db: 1, portal: 1, gatekeeper: 1 } },
    { gatekeeperFailure: true, expected: { db: 1, portal: 1, gatekeeper: 1 } },
  ];
  for (const scenario of cases) {
    const calls = { db: 0, portal: 0, gatekeeper: 0 };
    const startup = createGymMasterMemberPrivateScreenLoginStartup({
      environment: environment(),
      db: { async query() { calls.db += 1; if (scenario.dbFailure) throw new Error("synthetic database failure"); return { rows: scenario.rows === undefined ? [{ mapping_id: "8", member_id: "9", provisioning_reference: "pending_enrollment:7", verified_email_snapshot: "member@example.test" }] : scenario.rows }; } },
      fetchImpl: async (url) => {
        if (url.includes("/portal/api/v1/login")) { calls.portal += 1; return new Response(JSON.stringify(scenario.portal || { result: { token: "token", expires: 900, memberid: 70001 } }), { status: scenario.portalStatus || 200 }); }
        calls.gatekeeper += 1;
        if (scenario.gatekeeperFailure) throw new Error("synthetic timeout");
        return new Response(JSON.stringify({ members: scenario.members === undefined ? [{ memberid: 70001, stopatgate: false, membership: [{ expired: false }] }] : scenario.members }), { status: 200 });
      },
    });
    const running = await runningLogin(startup, t);
    const result = await jsonRequest(running.url, MEMBER_PRIVATE_SCREEN_LOGIN_PATH, {
      method: "POST", headers: { Origin: origin },
      body: scenario.body || { email: scenario.email || "member@example.test", password: "hidden" },
    });
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, { error: "MEMBER_LOGIN_FAILED" });
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls, scenario.expected);
  }
});

test("rate limiting precedes repeated provider, database, and Gatekeeper work", async (t) => {
  const deps = dependencies();
  const startup = createGymMasterMemberPrivateScreenLoginStartup({
    environment: environment(), db: deps.db, fetchImpl: deps.fetchImpl,
    attemptLimiter: createGymMasterMemberLoginRateLimiter({ maximumAttempts: 1 }),
  });
  const running = await runningLogin(startup, t);
  const request = () => jsonRequest(running.url, MEMBER_PRIVATE_SCREEN_LOGIN_PATH, {
    method: "POST", headers: { Origin: origin },
    body: { email: "member@example.test", password: "hidden" },
  });
  assert.equal((await request()).response.status, 204);
  const limited = await request();
  assert.equal(limited.response.status, 429);
  assert.deepEqual(limited.body, { error: "MEMBER_LOGIN_RATE_LIMITED" });
  assert.equal(limited.response.headers.get("cache-control"), "no-store");
  assert.equal(limited.response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(deps.calls, { db: 1, portal: 1, gatekeeper: 1 });
});

test("Member Portal and Gatekeeper timeouts abort and remain generic", async (t) => {
  for (const stage of ["portal", "gatekeeper"]) {
    let aborted = false;
    const startup = createGymMasterMemberPrivateScreenLoginStartup({
      environment: environment(),
      memberPortalTimeoutMs: 10,
      gatekeeperTimeoutMs: 10,
      db: { async query() { return { rows: [{ mapping_id: "8", member_id: "9" }] }; } },
      fetchImpl: async (url, options) => {
        const isPortal = url.includes("/portal/api/v1/login");
        if ((stage === "portal" && isPortal) || (stage === "gatekeeper" && !isPortal)) {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("synthetic abort"));
            });
          });
        }
        return new Response(JSON.stringify({
          result: { token: "token", expires: 900, memberid: 70001 },
        }), { status: 200 });
      },
    });
    const running = await runningLogin(startup, t);
    const result = await jsonRequest(running.url, MEMBER_PRIVATE_SCREEN_LOGIN_PATH, {
      method: "POST", headers: { Origin: origin },
      body: { email: "member@example.test", password: "hidden" },
    });
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, { error: "MEMBER_LOGIN_FAILED" });
    assert.equal(aborted, true);
  }
});

test("private login cannot inherit owner diagnostics or pending-enrollment completion", async (t) => {
  let diagnostics = 0;
  let completions = 0;
  const startup = createGymMasterMemberPrivateScreenLoginStartup({
    environment: environment({ GOALS_COACH_OWNER_LOGIN_STAGE_DIAGNOSTIC: "true" }),
    db: { async query() { return { rows: [] }; } },
    fetchImpl: async () => new Response(JSON.stringify({
      result: { token: "token", expires: 900, memberid: 70001 },
    }), { status: 200 }),
    diagnosticSink: () => { diagnostics += 1; },
    completePendingEnrollment: async () => { completions += 1; return { active: true }; },
  });
  const running = await runningLogin(startup, t);
  const result = await jsonRequest(running.url, MEMBER_PRIVATE_SCREEN_LOGIN_PATH, {
    method: "POST", headers: { Origin: origin },
    body: { email: "member@example.test", password: "hidden" },
  });
  assert.equal(result.response.status, 401);
  assert.deepEqual(result.body, { error: "MEMBER_LOGIN_FAILED" });
  assert.equal(diagnostics, 0);
  assert.equal(completions, 0);
});

test("composition mounts no existing or unrelated Goals Coach route", async (t) => {
  const deps = dependencies();
  const startup = createGymMasterMemberPrivateScreenLoginStartup({
    environment: environment(), db: deps.db, fetchImpl: deps.fetchImpl,
  });
  const running = await runningLogin(startup, t);
  for (const [method, path] of [
    ["POST", "/goalscoach/member/pending-enrollment/login"],
    ["POST", "/goalscoach/member/login"],
    ["GET", "/goalscoach/member/session"],
    ["GET", "/goalscoach"],
    ["GET", "/alpha/goals-coach/session"],
    ["GET", "/goalscoach/member/private-screen"],
  ]) {
    const result = await jsonRequest(running.url, path, {
      method, headers: { Origin: origin },
    });
    assert.equal(result.response.status, 404, `${method} ${path}`);
  }
  assert.deepEqual(deps.calls, { db: 0, portal: 0, gatekeeper: 0 });
});
