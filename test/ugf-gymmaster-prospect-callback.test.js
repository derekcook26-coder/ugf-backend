"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createProspectCallbackStartup } = require("../src/goals-coach/ugf-gymmaster-prospect-callback-startup");
const { composeProspectCallbackRoute } = require("../src/goals-coach/ugf-gymmaster-prospect-callback-route-composition");
const { normalizeSubmission } = require("../src/goals-coach/ugf-gymmaster-prospect-callback");
const { startApp } = require("./helpers/http-app");

const ORIGIN = "https://ultimategoalsfitness.com";
const API_KEY = "server-only-test-key";

function configuration(overrides = {}) {
  return {
    UGF_GYMMASTER_PROSPECT_CALLBACK_ENABLED: "true",
    UGF_GYMMASTER_PROSPECT_CALLBACK_ORIGIN: ORIGIN,
    UGF_GYMMASTER_PROSPECT_BLACK_HAWK_COMPANY_ID: "1",
    UGF_GYMMASTER_PROSPECT_RAPID_VALLEY_COMPANY_ID: "2",
    GYMMASTER_MEMBER_PORTAL_API_BASE_URL: "https://ugf.gymmasteronline.com/portal/api/v1/",
    GYMMASTER_MEMBER_PORTAL_API_KEY: API_KEY,
    ...overrides,
  };
}

async function application(fetchImpl, environment = configuration()) {
  const startup = createProspectCallbackStartup({ environment, fetchImpl });
  const app = express(); app.set("trust proxy", 1); app.use(express.json({ limit: "2kb" }));
  const composition = composeProspectCallbackRoute(app, startup);
  return { app, composition, startup };
}

async function submit(url, body, origin = ORIGIN) {
  const response = await fetch(`${url}/public/help/prospect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("prospect callback is exact-flag disabled and fails closed without configuration", async (t) => {
  const disabled = await application(async () => { throw new Error("must not run"); }, configuration({
    UGF_GYMMASTER_PROSPECT_CALLBACK_ENABLED: "TRUE",
  }));
  assert.equal(disabled.startup.status, "disabled");
  assert.deepEqual(disabled.composition, { mounted: false, path: null });
  const running = await startApp(disabled.app); t.after(() => running.close());
  assert.equal((await fetch(`${running.url}/public/help/prospect`, { method: "POST" })).status, 404);
  for (const overrides of [
    { UGF_GYMMASTER_PROSPECT_CALLBACK_ORIGIN: "https://evil.example" },
    { UGF_GYMMASTER_PROSPECT_BLACK_HAWK_COMPANY_ID: "0" },
    { UGF_GYMMASTER_PROSPECT_RAPID_VALLEY_COMPANY_ID: "1" },
    { GYMMASTER_MEMBER_PORTAL_API_BASE_URL: "https://example.com/portal/api/v1/" },
    { GYMMASTER_MEMBER_PORTAL_API_KEY: "short" },
  ]) {
    const startup = createProspectCallbackStartup({ environment: configuration(overrides), fetchImpl: async () => null });
    assert.equal(startup.status, "not_ready");
  }
});

test("submission validation accepts only four contact fields, consent, and an empty honeypot", () => {
  assert.deepEqual(normalizeSubmission({
    firstName: "  Ana María ", lastName: "O’Neil-Smith", email: " ANA@EXAMPLE.COM ",
    phone: "+1 (605) 555-0123", location: "rapid_valley", consent: true, website: "",
  }), { firstName: "Ana María", lastName: "O’Neil-Smith", email: "ana@example.com", phone: "+16055550123", location: "rapid_valley", inquiryType: "callback" });
  assert.deepEqual(normalizeSubmission({
    firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123",
    location: "black_hawk", inquiryType: "free_week_trial", consent: true,
  }).inquiryType, "free_week_trial");
  for (const invalid of [
    {},
    { firstName: "Ana", lastName: "Smith", email: "bad", phone: "6055550123", location: "black_hawk", consent: true },
    { firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "123", location: "black_hawk", consent: true },
    { firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123", location: "rapid_city", consent: true },
    { firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123", location: "black_hawk", consent: false },
    { firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123", location: "black_hawk", consent: true, website: "bot" },
    { firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123", location: "black_hawk", consent: true, memberId: 42 },
    { firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123", location: "black_hawk", inquiryType: "anything", consent: true },
  ]) assert.equal(normalizeSubmission(invalid), null);
});

test("approved callback sends minimized multipart data server-side and conceals provider identifiers", async (t) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options, text: options.body.toString("utf8") });
    return { status: 200, async json() { return { result: "created", token: "private-token", expires: 3600, memberid: 9182 }; } };
  };
  const { app, startup, composition } = await application(fetchImpl);
  assert.equal(startup.status, "ready_for_separate_route_composition");
  assert.equal(startup.externalCallsPermitted, true);
  assert.deepEqual(composition, { mounted: true, path: "/public/help/prospect" });
  const running = await startApp(app); t.after(() => running.close());
  const result = await submit(running.url, {
    firstName: "Derek", lastName: "Cook", email: "derek@example.com",
    phone: "605-555-0123", location: "rapid_valley", consent: true, website: "",
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.response.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(result.body, {
    ok: true,
    message: "Thanks. UGF staff will use the contact information you provided to follow up.",
  });
  const blackHawk = await submit(running.url, {
    firstName: "Taylor", lastName: "Hill", email: "taylor@example.com",
    phone: "605-555-0199", location: "black_hawk", inquiryType: "free_week_trial", consent: true,
  });
  assert.equal(blackHawk.response.status, 201);
  assert.equal(JSON.stringify(result.body).includes("9182"), false);
  assert.equal(JSON.stringify(result.body).includes("private-token"), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin, "https://ugf.gymmasteronline.com");
  assert.equal(calls[0].url.pathname, "/portal/api/v1/prospect/create");
  assert.equal(calls[0].url.search, "");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  for (const expected of [API_KEY, "Derek", "Cook", "derek@example.com", "6055550123", "companyid\"\r\n\r\n2"] ) {
    assert.equal(calls[0].text.includes(expected), true);
  }
  assert.equal(calls[1].text.includes("companyid\"\r\n\r\n1"), true);
  assert.equal(calls[1].text.includes("Website free-week trial request (new members only)."), true);
  for (const forbidden of ["memberid", "password", "credit", "billing"]) assert.equal(calls[0].text.includes(forbidden), false);
});

test("invalid, bot, cross-origin, and provider-failed requests are rejected or concealed", async (t) => {
  let calls = 0;
  const { app } = await application(async () => { calls += 1; throw new Error("private provider failure"); });
  const running = await startApp(app); t.after(() => running.close());
  const invalid = await submit(running.url, { firstName: "", consent: true });
  assert.equal(invalid.response.status, 400); assert.equal(calls, 0);
  const bot = await submit(running.url, {
    firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123", location: "black_hawk", consent: true, website: "spam",
  });
  assert.equal(bot.response.status, 400); assert.equal(calls, 0);
  const failed = await submit(running.url, {
    firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123", location: "black_hawk", consent: true,
  });
  assert.equal(failed.response.status, 503);
  assert.deepEqual(failed.body, { error: "Callback requests are temporarily unavailable. Please try again shortly." });
  const crossOrigin = await submit(running.url, {
    firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123", location: "black_hawk", consent: true,
  }, "https://evil.example");
  assert.equal(crossOrigin.response.headers.get("access-control-allow-origin"), null);
});
