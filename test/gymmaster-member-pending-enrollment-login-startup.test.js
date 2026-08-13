"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const {
  MEMBER_PENDING_ENROLLMENT_LOGIN_FLAG,
  createGymMasterMemberPendingEnrollmentLoginStartup,
  memberPendingEnrollmentLoginEnabled,
} = require("../src/goals-coach/gymmaster-member-pending-enrollment-login-startup");
const {
  MEMBER_PENDING_ENROLLMENT_LOGIN_PATH,
  composeGymMasterMemberPendingEnrollmentLoginRoute,
} = require("../src/goals-coach/gymmaster-member-pending-enrollment-login-route-composition");
const {
  OWNER_MEMBER_ID,
  OWNER_ONLY_ENABLE_FLAG,
  createGymMasterOwnerOnlyStartup,
} = require("../src/goals-coach/gymmaster-owner-only-startup");
const {
  composeGymMasterOwnerOnlyRoutes,
} = require("../src/goals-coach/gymmaster-owner-only-route-composition");
const {
  OWNER_WORKOUT_TRACKING_FLAG,
} = require("../src/goals-coach/owner-workout-tracking");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://ultimategoalsfitness.com";

function environment(overrides = {}) {
  return {
    [MEMBER_PENDING_ENROLLMENT_LOGIN_FLAG]: "true",
    GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "true",
    GOALS_COACH_MEMBER_LOGIN_ENABLED: "true",
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

function readyPendingStartup(completeAuthenticatedEnrollment) {
  return {
    status: "ready_for_existing_boundaries",
    service: { completeAuthenticatedEnrollment },
  };
}

test("pending-enrollment login startup and route are absent by default", async (t) => {
  assert.equal(memberPendingEnrollmentLoginEnabled("true"), true);
  for (const value of [undefined, "false", "True", " true", "true ", true]) {
    assert.equal(memberPendingEnrollmentLoginEnabled(value), false);
  }
  let calls = 0;
  const startup = createGymMasterMemberPendingEnrollmentLoginStartup({
    environment: {},
    db: { query: async () => { calls += 1; return { rows: [] }; } },
    fetchImpl: async () => { calls += 1; },
    pendingEnrollmentStartup: readyPendingStartup(async () => ({ active: true })),
  });
  assert.equal(startup.status, "disabled");
  assert.equal(startup.handler, null);
  assert.equal(startup.activationPermitted, false);
  assert.equal(startup.externalCallsPermitted, false);

  const app = express();
  assert.deepEqual(
    composeGymMasterMemberPendingEnrollmentLoginRoute(app, startup),
    { mounted: false, path: null }
  );
  const running = await startApp(app);
  t.after(() => running.close());
  const response = await jsonRequest(running.url, MEMBER_PENDING_ENROLLMENT_LOGIN_PATH, {
    method: "POST",
    headers: { Origin: origin },
  });
  assert.equal(response.response.status, 404);
  assert.equal(calls, 0);
});

test("pending-enrollment login route requires a ready pending service and valid shared login configuration", () => {
  const noPending = createGymMasterMemberPendingEnrollmentLoginStartup({
    environment: environment(),
    db: { query: async () => ({ rows: [] }) },
    fetchImpl: async () => { throw new Error("must not run at startup"); },
    pendingEnrollmentStartup: { status: "disabled", service: null },
  });
  assert.equal(noPending.status, "not_ready");
  assert.equal(noPending.handler, null);

  const invalidLogin = createGymMasterMemberPendingEnrollmentLoginStartup({
    environment: environment({ GOALS_COACH_MEMBER_LOGIN_ORIGIN: "http://invalid.test" }),
    db: { query: async () => ({ rows: [] }) },
    fetchImpl: async () => { throw new Error("must not run at startup"); },
    pendingEnrollmentStartup: readyPendingStartup(async () => ({ active: true })),
  });
  assert.equal(invalidLogin.status, "not_ready");
  assert.equal(invalidLogin.handler, null);
});

test("pending-enrollment login startup independently requires the lifecycle flag", async (t) => {
  let calls = 0;
  const startup = createGymMasterMemberPendingEnrollmentLoginStartup({
    environment: environment({
      GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false",
    }),
    db: {
      async query() {
        calls += 1;
        return { rows: [] };
      },
    },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not call providers while the lifecycle is disabled");
    },
    pendingEnrollmentStartup: readyPendingStartup(async () => {
      calls += 1;
      return { active: true };
    }),
  });
  assert.equal(startup.status, "not_ready");
  assert.equal(startup.handler, null);

  const app = express();
  assert.deepEqual(
    composeGymMasterMemberPendingEnrollmentLoginRoute(app, startup),
    { mounted: false, path: null }
  );
  const running = await startApp(app);
  t.after(() => running.close());
  const response = await jsonRequest(running.url, MEMBER_PENDING_ENROLLMENT_LOGIN_PATH, {
    method: "POST",
    headers: { Origin: origin },
    body: { email: "member@example.test", password: "hidden-password" },
  });
  assert.equal(response.response.status, 404);
  assert.equal(calls, 0);
});

test("dedicated route completes a pending identity, issues only a session cookie, and mounts no capability", async (t) => {
  const completed = [];
  let dbCalls = 0;
  let portalCalls = 0;
  let gatekeeperCalls = 0;
  const startup = createGymMasterMemberPendingEnrollmentLoginStartup({
    environment: environment(),
    db: {
      async query() {
        dbCalls += 1;
        return { rows: [] };
      },
    },
    fetchImpl: async (url) => {
      if (url.includes("/portal/api/v1/login")) {
        portalCalls += 1;
        return new Response(JSON.stringify({
          result: { token: "provider-token", expires: 900, memberid: 70001 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      gatekeeperCalls += 1;
      throw new Error("Gatekeeper must not run before successful local completion");
    },
    pendingEnrollmentStartup: readyPendingStartup(async (identity) => {
      completed.push(identity);
      return { active: true, mappingId: "9", memberId: "12" };
    }),
  });
  assert.equal(startup.status, "ready_for_separate_route_composition");
  assert.equal(startup.activationPermitted, false);
  assert.equal(startup.externalCallsPermitted, false);
  assert.equal(dbCalls, 0);
  assert.equal(portalCalls, 0);

  const app = express();
  app.use(express.json());
  assert.deepEqual(
    composeGymMasterMemberPendingEnrollmentLoginRoute(app, startup),
    { mounted: true, path: MEMBER_PENDING_ENROLLMENT_LOGIN_PATH }
  );
  const running = await startApp(app);
  t.after(() => running.close());

  const preflight = await jsonRequest(running.url, MEMBER_PENDING_ENROLLMENT_LOGIN_PATH, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.response.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.response.headers.get("access-control-allow-credentials"), "true");
  assert.match(preflight.response.headers.get("access-control-allow-methods"), /POST/);

  const wrongOrigin = await jsonRequest(running.url, MEMBER_PENDING_ENROLLMENT_LOGIN_PATH, {
    method: "POST",
    headers: { Origin: "https://wrong.example" },
    body: { email: "member@example.test", password: "hidden-password" },
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.deepEqual(wrongOrigin.body, { error: "MEMBER_LOGIN_ORIGIN_NOT_ALLOWED" });
  assert.equal(portalCalls, 0);

  const response = await jsonRequest(running.url, MEMBER_PENDING_ENROLLMENT_LOGIN_PATH, {
    method: "POST",
    headers: { Origin: origin },
    body: { email: " member@example.test ", password: "hidden-password" },
  });
  assert.equal(response.response.status, 204);
  assert.match(response.response.headers.get("set-cookie"), /^gc_member_session=/);
  assert.equal(response.response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].authSubject, "gymmaster:70001");
  assert.equal(JSON.stringify(completed[0]).includes("member@example.test"), false);
  assert.equal(portalCalls, 1);
  assert.equal(gatekeeperCalls, 0);
  assert.equal(dbCalls, 1);

  for (const path of [
    "/goalscoach/login",
    "/goalscoach/member/session",
    "/goalscoach/member/tracked-workout-sessions",
    "/goalscoach/member/safety-intake",
  ]) {
    const absent = await jsonRequest(running.url, path, {
      method: path.endsWith("login") ? "POST" : "GET",
      headers: { Origin: origin },
    });
    assert.equal(absent.response.status, 404, path);
  }
});

test("a pending-member cookie cannot access the real owner router or an enabled owner capability", async (t) => {
  const app = express();
  app.use(express.json());
  const pendingStartup = createGymMasterMemberPendingEnrollmentLoginStartup({
    environment: environment({
      [OWNER_ONLY_ENABLE_FLAG]: "true",
      [OWNER_MEMBER_ID]: "99999",
      [OWNER_WORKOUT_TRACKING_FLAG]: "true",
    }),
    db: { query: async () => ({ rows: [] }) },
    fetchImpl: async (url) => {
      assert.match(url, /\/portal\/api\/v1\/login/);
      return new Response(JSON.stringify({
        result: { token: "provider-token", expires: 900, memberid: 70001 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    pendingEnrollmentStartup: readyPendingStartup(async () => ({
      active: true,
      mappingId: "9",
      memberId: "12",
    })),
  });
  const ownerStartup = createGymMasterOwnerOnlyStartup({
    environment: environment({
      [OWNER_ONLY_ENABLE_FLAG]: "true",
      [OWNER_MEMBER_ID]: "99999",
      [OWNER_WORKOUT_TRACKING_FLAG]: "true",
    }),
    db: { query: async () => ({ rows: [] }) },
    fetchImpl: async () => {
      throw new Error("owner routes must validate the supplied session, not call a provider");
    },
  });
  assert.equal(pendingStartup.status, "ready_for_separate_route_composition");
  assert.equal(ownerStartup.status, "ready_for_separate_route_composition");
  assert.deepEqual(
    composeGymMasterMemberPendingEnrollmentLoginRoute(app, pendingStartup),
    { mounted: true, path: MEMBER_PENDING_ENROLLMENT_LOGIN_PATH }
  );
  assert.deepEqual(
    composeGymMasterOwnerOnlyRoutes(app, ownerStartup),
    { mounted: true, path: "/goalscoach" }
  );
  const running = await startApp(app);
  t.after(() => running.close());

  const login = await jsonRequest(running.url, MEMBER_PENDING_ENROLLMENT_LOGIN_PATH, {
    method: "POST",
    headers: { Origin: origin },
    body: { email: "member@example.test", password: "hidden-password" },
  });
  assert.equal(login.response.status, 204);
  const cookie = login.response.headers.get("set-cookie").split(";", 1)[0];

  for (const path of ["/goalscoach/session", "/goalscoach/workout-logs"]) {
    const denied = await jsonRequest(running.url, path, {
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(denied.response.status, 401, path);
    assert.deepEqual(denied.body, { error: "MEMBER_AUTHENTICATION_REQUIRED" }, path);
  }
});
