"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGymMasterMemberPrivateScreenStartup } = require("../src/goals-coach/gymmaster-member-private-screen-startup");
const { createGymMasterMemberSafetyIntakeStartup } = require("../src/goals-coach/gymmaster-member-safety-intake-startup");
const { createGymMasterMemberCoachingConsentStartup } = require("../src/goals-coach/gymmaster-member-coaching-consent-startup");
const { createGymMasterMemberTodayStartup } = require("../src/goals-coach/gymmaster-member-today-startup");
const base = { GOALS_COACH_MEMBER_TWO_HOUR_SESSION_ENABLED: "true", GOALS_COACH_MEMBER_LOGIN_ORIGIN: "https://coach.example" };
test("all protected boundaries compose provider-free while two-hour sessions revalidate locally", () => {
  let providerCalls = 0, databaseCalls = 0;
  const db = { async query() { databaseCalls++; return { rows: [] }; }, async connect() { return { query: db.query, release() {} }; } };
  const fetchImpl = async () => { providerCalls++; throw new Error("provider must not be called"); };
  const cases = [
    [createGymMasterMemberPrivateScreenStartup, "GOALS_COACH_MEMBER_PRIVATE_SCREEN_ENABLED"],
    [createGymMasterMemberSafetyIntakeStartup, "GOALS_COACH_MEMBER_SAFETY_INTAKE_ALPHA_ENABLED"],
    [createGymMasterMemberCoachingConsentStartup, "GOALS_COACH_MEMBER_COACHING_CONSENT_ENABLED"],
    [createGymMasterMemberTodayStartup, "GOALS_COACH_MEMBER_TODAY_ENABLED"],
  ];
  for (const [create, flag] of cases) assert.equal(create({ db, fetchImpl, environment: { ...base, [flag]: "true" } }).status, "ready_for_separate_route_composition");
  assert.equal(providerCalls, 0); assert.equal(databaseCalls, 0);
});
