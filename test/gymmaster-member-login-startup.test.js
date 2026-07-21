"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MEMBER_LOGIN_ENABLE_FLAG,
  createGymMasterMemberLoginStartup,
  exactTrue,
  loadGymMasterMemberLoginConfiguration,
} = require("../src/goals-coach/gymmaster-member-login-startup");

function completeEnvironment(overrides = {}) {
  return {
    [MEMBER_LOGIN_ENABLE_FLAG]: "true",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: "https://ultimategoalsfitness.com",
    GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL: "https://ugf.gymmasteronline.com/portal/api/v1/login",
    GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
    GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "members-key",
    GYMMASTER_API_KEY: "gatekeeper-key",
    GYMMASTER_SITE: "ugf",
    GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: "a".repeat(32),
    ...overrides,
  };
}

test("member-login startup is disabled by default and never reports activation permission", () => {
  const startup = createGymMasterMemberLoginStartup({ environment: {} });
  assert.equal(startup.status, "disabled");
  assert.equal(startup.handler, null);
  assert.equal(startup.activationPermitted, false);
  assert.equal(startup.externalCallsPermitted, false);
});

test("member-login startup rejects incomplete or unsafe configuration", () => {
  const configuration = loadGymMasterMemberLoginConfiguration(completeEnvironment({
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: "http://ultimategoalsfitness.com",
    GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "",
  }));
  assert.equal(configuration.valid, false);
  assert.ok(configuration.blockers.includes("exact_https_member_login_origin_required"));
  assert.ok(configuration.blockers.includes("member_api_key_required"));
});

test("ready startup only composes injected services and performs no external work", () => {
  let fetchCalls = 0;
  let dbCalls = 0;
  const startup = createGymMasterMemberLoginStartup({
    environment: completeEnvironment(),
    db: { query: async () => { dbCalls += 1; return { rows: [] }; } },
    fetchImpl: async () => { fetchCalls += 1; return { ok: false, json: async () => ({}) }; },
  });
  assert.equal(startup.status, "ready_for_separate_route_composition");
  assert.equal(typeof startup.handler, "function");
  assert.equal(startup.activationPermitted, false);
  assert.equal(startup.externalCallsPermitted, false);
  assert.equal(fetchCalls, 0);
  assert.equal(dbCalls, 0);
  assert.equal(JSON.stringify(startup.configuration).includes("members-key"), false);
  assert.equal(JSON.stringify(startup.configuration).includes("gatekeeper-key"), false);
});

test("only exact true enables member-login configuration review", () => {
  assert.equal(exactTrue("true"), true);
  for (const value of [undefined, "", "false", "1", true]) {
    assert.equal(exactTrue(value), false);
  }
});
