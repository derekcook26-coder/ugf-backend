"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const {
  WIDGETS_FLAG,
  createCache,
  createProviderClient,
  exactMemberPortalBaseUrl,
  validIsoDate,
  widgetsEnabled,
} = require("../src/goals-coach/gymmaster-public-widgets");
const { createGymMasterPublicWidgetsStartup } = require("../src/goals-coach/gymmaster-public-widgets-startup");
const { composeGymMasterPublicWidgetsRoutes } = require("../src/goals-coach/gymmaster-public-widgets-route-composition");
const { jsonRequest, startApp } = require("./helpers/http-app");

const ORIGIN = "https://ultimategoalsfitness.com";
const BASE_URL = "https://ugf.gymmasteronline.com/portal/api/v1/";
const API_KEY = "synthetic-member-portal-key";

function environment(overrides = {}) {
  return {
    [WIDGETS_FLAG]: "true",
    UGF_GYMMASTER_WIDGETS_ORIGIN: ORIGIN,
    GYMMASTER_MEMBER_PORTAL_API_BASE_URL: BASE_URL,
    GYMMASTER_MEMBER_PORTAL_API_KEY: API_KEY,
    ...overrides,
  };
}

function providerResponse(result) {
  return { status: 200, json: async () => ({ result, error: "" }) };
}

async function application(fetchImpl, overrides = {}) {
  const app = express();
  const startup = createGymMasterPublicWidgetsStartup({
    environment: environment(),
    fetchImpl,
    ...overrides,
  });
  const composition = composeGymMasterPublicWidgetsRoutes(app, startup);
  return { app, startup, composition };
}

test("widget gate, origin, and provider base URL are exact and fail closed", () => {
  for (const value of [undefined, "", "TRUE", " true", "true ", true, 1]) {
    assert.equal(widgetsEnabled(value), false);
  }
  assert.equal(widgetsEnabled("true"), true);
  assert.equal(exactMemberPortalBaseUrl(BASE_URL), BASE_URL);
  for (const value of [
    "http://ugf.gymmasteronline.com/portal/api/v1/",
    "https://evil.example/portal/api/v1/",
    "https://ugf.gymmasteronline.com/portal/api/v1/?debug=true",
    "https://user:pass@ugf.gymmasteronline.com/portal/api/v1/",
  ]) assert.equal(exactMemberPortalBaseUrl(value), null);
  assert.equal(createGymMasterPublicWidgetsStartup({ environment: {}, fetchImpl: async () => {} }).status, "disabled");
  for (const overrides of [
    { UGF_GYMMASTER_WIDGETS_ORIGIN: "http://ultimategoalsfitness.com" },
    { GYMMASTER_MEMBER_PORTAL_API_BASE_URL: "https://evil.example/portal/api/v1/" },
    { GYMMASTER_MEMBER_PORTAL_API_KEY: "" },
  ]) {
    assert.equal(createGymMasterPublicWidgetsStartup({
      environment: environment(overrides), fetchImpl: async () => {},
    }).status, "not_ready");
  }
});

test("disabled startup mounts no public routes and performs no provider work", async (t) => {
  let calls = 0;
  const app = express();
  const startup = createGymMasterPublicWidgetsStartup({
    environment: { [WIDGETS_FLAG]: "false" },
    fetchImpl: async () => { calls += 1; return providerResponse([]); },
  });
  const composition = composeGymMasterPublicWidgetsRoutes(app, startup);
  assert.deepEqual(composition, { mounted: false, paths: [] });
  const running = await startApp(app); t.after(() => running.close());
  const response = await jsonRequest(running.url, "/public/gymmaster/memberships");
  assert.equal(response.response.status, 404);
  assert.equal(calls, 0);
});

test("week accepts only a real ISO date", () => {
  assert.equal(validIsoDate("2026-08-24"), true);
  for (const value of ["2026-02-30", "08/24/2026", "2026-8-24", "", undefined]) {
    assert.equal(validIsoDate(value), false);
  }
});

test("provider uses the integration key only server-side and exact read-only paths", async () => {
  const calls = [];
  const provider = createProviderClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return providerResponse([]);
    },
  });
  await provider.schedule("2026-08-24");
  await provider.memberships();
  assert.equal(calls[0].url.pathname, "/portal/api/v1/booking/classes/schedule");
  assert.equal(calls[0].url.searchParams.get("week"), "2026-08-24");
  assert.equal(calls[0].url.searchParams.get("api_key"), API_KEY);
  assert.equal(calls[1].url.pathname, "/portal/api/v1/memberships");
  assert.equal(calls[1].url.searchParams.get("api_key"), API_KEY);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "error");
    assert.deepEqual(call.options.headers, { Accept: "application/json" });
    assert.equal(call.url.searchParams.has("token"), false);
  }
});

test("public routes return minimized branded data without keys, tokens, or provider details", async (t) => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/schedule")) {
      return providerResponse([{
        id: 71,
        name: "Yoga",
        classid: 9001,
        arrival: "2026-08-24",
        dayofweek: "Monday",
        starttime: "18:00",
        endtime: "19:00",
        availability: "Available",
        location: "Studio",
        description: "Mobility and balance",
        companyid: 2,
        companyname: "UGF Rapid Valley",
        max_students: 14,
        spacesfree: 5,
        staffid: "private-staff-id",
        staffname: "Private Name",
        staffphoto: "https://provider.example/private.jpg",
        online_instruction: "private instruction",
      }]);
    }
    return providerResponse([{
      id: 41,
      name: "Monthly Membership",
      description: "Month to month",
      price: "$42.60",
      price_tax: "$2.60",
      pricedescription: "Monthly payments",
      signupfee: "$21.30",
      signupfee_label: "Signup fee",
      hide_signupfee: false,
      divisionname: "Monthly memberships",
      promotional_period: "",
      promotional_price: "",
      promotion_period_description: "",
      sortorder: 2,
      companyids: [1, 2],
      programme_ref: "private-provider-reference",
      account_credit: "$0",
    }]);
  };
  const { app, startup, composition } = await application(fetchImpl);
  assert.equal(startup.status, "ready_for_separate_route_composition");
  assert.equal(startup.readOnly, true);
  assert.equal(startup.externalCallsPermitted, true);
  assert.deepEqual(composition.paths, ["/public/gymmaster/classes", "/public/gymmaster/memberships"]);
  const running = await startApp(app); t.after(() => running.close());

  const schedule = await jsonRequest(running.url, "/public/gymmaster/classes?week=2026-08-24", {
    headers: { Origin: ORIGIN },
  });
  assert.equal(schedule.response.status, 200);
  assert.equal(schedule.response.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(schedule.response.headers.get("access-control-allow-credentials"), null);
  assert.equal(schedule.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(schedule.response.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(schedule.body, {
    week: "2026-08-24",
    classes: [{
      id: 71, name: "Yoga", arrival: "2026-08-24", dayOfWeek: "Monday",
      startTime: "18:00", endTime: "19:00", availability: "Available",
      location: "Studio", description: "Mobility and balance", companyId: 2,
      companyName: "UGF Rapid Valley", capacity: 14, spacesFree: 5,
    }],
  });
  const memberships = await jsonRequest(running.url, "/public/gymmaster/memberships", {
    headers: { Origin: ORIGIN },
  });
  assert.equal(memberships.response.status, 200);
  assert.equal(memberships.body.signupUrl, "https://ugf.gymmasteronline.com/portal/signup?logo=0");
  assert.equal(memberships.body.memberships.length, 1);
  const serialized = JSON.stringify({ schedule: schedule.body, memberships: memberships.body });
  for (const forbidden of [API_KEY, "private-staff-id", "Private Name", "private-provider-reference", "token"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("unapproved origins receive no cross-origin browser permission", async (t) => {
  const { app } = await application(async () => providerResponse([]));
  const running = await startApp(app); t.after(() => running.close());
  const response = await jsonRequest(running.url, "/public/gymmaster/memberships", {
    headers: { Origin: "https://unapproved.example" },
  });
  assert.equal(response.response.status, 200);
  assert.equal(response.response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.response.headers.get("access-control-allow-credentials"), null);
});

test("invalid input and provider failures are concealed", async (t) => {
  const { app } = await application(async () => ({
    status: 500,
    json: async () => ({ error: "raw provider failure with account details" }),
  }));
  const running = await startApp(app); t.after(() => running.close());
  const invalid = await jsonRequest(running.url, "/public/gymmaster/classes?week=bad", {
    headers: { Origin: ORIGIN },
  });
  assert.equal(invalid.response.status, 400);
  assert.deepEqual(invalid.body, { error: "A valid week is required." });
  const failed = await jsonRequest(running.url, "/public/gymmaster/memberships", {
    headers: { Origin: ORIGIN },
  });
  assert.equal(failed.response.status, 503);
  assert.deepEqual(failed.body, { error: "Memberships are temporarily unavailable." });
  assert.equal(JSON.stringify(failed.body).includes("provider"), false);
});

test("cache coalesces repeated public reads within the documented TTL", async () => {
  let current = 1000;
  let calls = 0;
  const cache = createCache(() => current);
  const load = async () => { calls += 1; return [`value-${calls}`]; };
  assert.deepEqual(await cache.read("memberships", 120000, load), ["value-1"]);
  current += 119999;
  assert.deepEqual(await cache.read("memberships", 120000, load), ["value-1"]);
  current += 2;
  assert.deepEqual(await cache.read("memberships", 120000, load), ["value-2"]);
});
