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
    UGF_HELP_SUPPORT_ENDPOINT: "https://ultimategoalsfitness.com/wp-json/ugf/v1/help-followup",
    UGF_HELP_SUPPORT_SECRET: "test-only-support-secret-at-least-32-characters",
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
    { UGF_HELP_SUPPORT_ENDPOINT: "https://evil.example/wp-json/ugf/v1/help-followup" },
    { UGF_HELP_SUPPORT_SECRET: "short" },
  ]) {
    const startup = createProspectCallbackStartup({ environment: configuration(overrides), fetchImpl: async () => null });
    assert.equal(startup.status, "not_ready");
  }
});

test("submission validation accepts the approved sales and support topics", () => {
  assert.deepEqual(normalizeSubmission({
    firstName: "  Ana María ", lastName: "O’Neil-Smith", email: " ANA@EXAMPLE.COM ",
    phone: "+1 (605) 555-0123", location: "rapid_valley", consent: true, website: "",
  }), { firstName: "Ana María", lastName: "O’Neil-Smith", email: "ana@example.com", phone: "+16055550123", location: "rapid_valley", inquiryType: "callback" });
  assert.deepEqual(normalizeSubmission({
    firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123",
    location: "black_hawk", inquiryType: "free_week_trial", consent: true,
  }).inquiryType, "free_week_trial");
  for (const inquiryType of ["callback", "free_week_trial", "price_match", "account_help", "access_help", "membership_help", "facility_issue"]) {
    assert.equal(normalizeSubmission({
      firstName: "Ana", lastName: "Smith", email: "a@example.com", phone: "6055550123",
      location: "black_hawk", inquiryType, consent: true,
    }).inquiryType, inquiryType);
  }
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

test("confirmed nonmember sales inquiry creates a prospect and conceals classification", async (t) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = { url: new URL(url), options, text: options.body ? options.body.toString("utf8") : "" };
    calls.push(call);
    if (call.url.pathname === "/portal/api/v2/member/exists") return { status: 200, async json() { return { result: "Member not found" }; } };
    return { status: 200, async json() { return { result: "created", token: "private-token", memberid: 9182 }; } };
  };
  const { app, startup, composition } = await application(fetchImpl);
  assert.equal(startup.status, "ready_for_separate_route_composition");
  assert.equal(startup.externalCallsPermitted, true);
  assert.deepEqual(composition, { mounted: true, path: "/public/help/prospect" });
  const running = await startApp(app); t.after(() => running.close());
  const result = await submit(running.url, {
    firstName: "Derek", lastName: "Cook", email: "derek@example.com",
    phone: "605-555-0123", location: "rapid_valley", inquiryType: "free_week_trial", consent: true, website: "",
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.response.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(result.body, { ok: true, message: "Thanks. UGF staff will use the contact information you provided to follow up." });
  assert.equal(JSON.stringify(result.body).includes("9182"), false);
  assert.equal(JSON.stringify(result.body).includes("private-token"), false);
  assert.deepEqual(calls.map((call) => call.url.pathname), [
    "/portal/api/v2/member/exists", "/portal/api/v1/prospect/create",
  ]);
  assert.equal(calls[0].url.searchParams.get("email"), "derek@example.com");
  assert.equal(calls[0].url.searchParams.has("api_key"), false);
  assert.equal(calls[0].options.headers["X-GM-API-KEY"], API_KEY);
  assert.equal(calls[1].url.search, "");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["X-GM-API-KEY"], API_KEY);
  assert.match(calls[1].options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  for (const expected of ["Derek", "Cook", "derek@example.com", "6055550123", "companyid\"\r\n\r\n2"] ) {
    assert.equal(calls[1].text.includes(expected), true);
  }
  assert.equal(calls[1].text.includes(API_KEY), false);
  assert.equal(calls[1].text.includes("Website free-week trial request (new members only)."), true);
  for (const forbidden of ["memberid", "password", "credit", "billing"]) assert.equal(calls[1].text.includes(forbidden), false);
});

test("existing member and support topics route to staff feedback without creating prospects", async (t) => {
  for (const scenario of [
    { inquiryType: "price_match", exists: { result: { id: 42, current_member: true } }, label: "Existing member" },
    { inquiryType: "account_help", exists: { result: "Member not found" }, label: "Possible member" },
  ]) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      const call = { url: new URL(url), options, text: options.body ? options.body.toString("utf8") : "" };
      calls.push(call);
      if (call.url.pathname === "/portal/api/v2/member/exists") return { status: 200, async json() { return scenario.exists; } };
      if (call.url.pathname === "/wp-json/ugf/v1/help-followup") return { status: 200, async json() { return { ok: true }; } };
      throw new Error("prospect creation must not run");
    };
    const { app } = await application(fetchImpl);
    const running = await startApp(app); t.after(() => running.close());
    const result = await submit(running.url, {
      firstName: "Ana", lastName: "Smith", email: "ana@example.com", phone: "6055550123",
      location: "black_hawk", inquiryType: scenario.inquiryType, consent: true,
    });
    assert.equal(result.response.status, 201);
    assert.equal(calls.some((call) => call.url.pathname === "/portal/api/v1/prospect/create"), false);
    const feedback = calls.find((call) => call.url.pathname === "/wp-json/ugf/v1/help-followup");
    assert.ok(feedback);
    assert.equal(feedback.url.origin, "https://ultimategoalsfitness.com");
    assert.equal(feedback.options.headers["X-UGF-Help-Secret"], "test-only-support-secret-at-least-32-characters");
    const payload = JSON.parse(feedback.text);
    assert.equal(payload.recipient, "staff@ugf.club");
    assert.equal(payload.staffLabel, scenario.label);
    assert.equal(JSON.stringify(result.body).includes(scenario.label), false);
  }
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
