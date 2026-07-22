"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const {
  createGymMasterOwnerAuthorizer,
  createGymMasterOwnerOnlyRouter,
  ownerMemberId,
} = require("../src/goals-coach/gymmaster-owner-only-access");
const {
  OWNER_MEMBER_ID,
  OWNER_ONLY_ENABLE_FLAG,
  createGymMasterOwnerOnlyStartup,
  ownerOnlyEnabled,
} = require("../src/goals-coach/gymmaster-owner-only-startup");
const { jsonRequest, startApp } = require("./helpers/http-app");

function completeEnvironment(overrides = {}) {
  return {
    GOALS_COACH_MEMBER_LOGIN_ENABLED: "true",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: "https://ultimategoalsfitness.com",
    GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL: "https://ugf.gymmasteronline.com/portal/api/v1/login",
    GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
    GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "members-key",
    GYMMASTER_API_KEY: "gatekeeper-key",
    GYMMASTER_SITE: "ugf",
    GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: "a".repeat(32),
    [OWNER_ONLY_ENABLE_FLAG]: "true",
    [OWNER_MEMBER_ID]: "10482",
    ...overrides,
  };
}

test("owner authorization matches only one immutable GymMaster member subject", () => {
  const authorization = createGymMasterOwnerAuthorizer({ memberId: "10482" });
  assert.equal(authorization.authorizeOwner({ authProvider: "gymmaster", authSubject: "gymmaster:10482" }), true);
  assert.equal(authorization.authorizeOwner({ authProvider: "gymmaster", authSubject: "gymmaster:10483" }), false);
  assert.equal(authorization.authorizeOwner({ authProvider: "clerk", authSubject: "gymmaster:10482" }), false);
  assert.equal(ownerMemberId(" 10482 "), "10482");
  assert.equal(ownerMemberId("0"), null);
});

test("owner-only startup remains disabled by default and cannot perform external work", () => {
  const startup = createGymMasterOwnerOnlyStartup({ environment: {} });
  assert.equal(startup.status, "disabled");
  assert.equal(startup.router, null);
  assert.equal(startup.activationPermitted, false);
  assert.equal(startup.externalCallsPermitted, false);
});

test("owner-only startup accepts only the exact lowercase true flag", () => {
  assert.equal(ownerOnlyEnabled("true"), true);
  for (const value of ["True", " TRUE ", "true ", " true", "1", true, undefined]) {
    assert.equal(ownerOnlyEnabled(value), false);
    const startup = createGymMasterOwnerOnlyStartup({ environment: completeEnvironment({ [OWNER_ONLY_ENABLE_FLAG]: value }) });
    assert.equal(startup.status, "disabled");
    assert.equal(startup.router, null);
  }
});

test("ready owner-only startup only prepares an unmounted router and makes no external calls", () => {
  let fetchCalls = 0;
  let dbCalls = 0;
  const startup = createGymMasterOwnerOnlyStartup({
    environment: completeEnvironment(),
    db: { query: async () => { dbCalls += 1; return { rows: [] }; } },
    fetchImpl: async () => { fetchCalls += 1; return { ok: false, json: async () => ({}) }; },
  });
  assert.equal(startup.status, "ready_for_separate_route_composition");
  assert.equal(typeof startup.router, "function");
  assert.equal(startup.activationPermitted, false);
  assert.equal(startup.externalCallsPermitted, false);
  assert.equal(fetchCalls, 0);
  assert.equal(dbCalls, 0);
});

test("owner-only router exposes only the login and non-coaching session status routes", () => {
  const router = createGymMasterOwnerOnlyRouter({
    loginHandler: () => {},
    authenticateSession: () => {},
    authorizeOwner: () => true,
  });
  const paths = router.stack.map((layer) => layer.route && layer.route.path).filter(Boolean);
  assert.deepEqual(paths, ["/login", "/session"]);
});

test("owner-only router returns status only to the configured owner and has no coaching route", async (t) => {
  const app = express();
  app.use("/goalscoach", createGymMasterOwnerOnlyRouter({
    loginHandler: (_req, res) => res.status(401).json({ error: "MEMBER_LOGIN_FAILED" }),
    authenticateSession(req, _res, next) {
      req.alphaMemberIdentity = { authProvider: "gymmaster", authSubject: "gymmaster:10482" };
      next();
    },
    authorizeOwner: createGymMasterOwnerAuthorizer({ memberId: "10482" }).authorizeOwner,
  }));
  const running = await startApp(app);
  t.after(() => running.close());

  const status = await jsonRequest(running.url, "/goalscoach/session");
  assert.equal(status.response.status, 200);
  assert.deepEqual(status.body, {
    access: "owner_only",
    coaching: "not_available",
    activationPermitted: false,
    externalCallsPermitted: false,
  });

  const coaching = await jsonRequest(running.url, "/goalscoach/conversations", { method: "POST" });
  assert.equal(coaching.response.status, 404);
});
