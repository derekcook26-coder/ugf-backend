"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createPublicHelpChatStartup } = require("../src/goals-coach/ugf-public-help-chat-startup");
const { composePublicHelpChatRoute } = require("../src/goals-coach/ugf-public-help-chat-route-composition");
const { startApp } = require("./helpers/http-app");

const ORIGIN = "https://ultimategoalsfitness.com";

function configuration(overrides = {}) {
  return {
    UGF_PUBLIC_HELP_CHAT_ENABLED: "true",
    UGF_PUBLIC_HELP_CHAT_ORIGIN: ORIGIN,
    UGF_HELP_MEMBERSHIP_URL: "https://ugf.gymmasteronline.com/portal/signup?logo=0",
    UGF_HELP_SCHEDULE_URL: `${ORIGIN}/class-schedule`,
    UGF_HELP_WORKOUT_URL: `${ORIGIN}/coachai`,
    UGF_HELP_MEMBER_PORTAL_URL: "https://ugf.gymmasteronline.com/portal/login",
    UGF_HELP_CONTACT_URL: `${ORIGIN}/contact`,
    ...overrides,
  };
}

async function request(url, question, origin = ORIGIN) {
  const response = await fetch(`${url}/public/help/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ question }),
  });
  return { response, body: await response.json() };
}

test("help chat is exact-flag disabled and mounts no route", async (t) => {
  const app = express(); app.use(express.json());
  const startup = createPublicHelpChatStartup({ environment: configuration({ UGF_PUBLIC_HELP_CHAT_ENABLED: "TRUE" }) });
  assert.equal(startup.status, "disabled");
  assert.deepEqual(composePublicHelpChatRoute(app, startup), { mounted: false, path: null });
  const running = await startApp(app); t.after(() => running.close());
  assert.equal((await fetch(`${running.url}/public/help/chat`, { method: "POST" })).status, 404);
});

test("unsafe origins and links fail closed before route composition", () => {
  for (const override of [
    { UGF_PUBLIC_HELP_CHAT_ORIGIN: "https://evil.example" },
    { UGF_HELP_CONTACT_URL: "https://evil.example/contact" },
    { UGF_HELP_MEMBER_PORTAL_URL: "http://ugf.gymmasteronline.com/portal/login" },
  ]) assert.equal(createPublicHelpChatStartup({ environment: configuration(override) }).status, "not_ready");
});

test("approved purchasing and account answers are fixed, minimized, and non-transactional", async (t) => {
  const app = express(); app.use(express.json({ limit: "2kb" }));
  const startup = createPublicHelpChatStartup({ environment: configuration() });
  assert.equal(startup.status, "ready_for_separate_route_composition");
  composePublicHelpChatRoute(app, startup);
  const running = await startApp(app); t.after(() => running.close());
  const purchase = await request(running.url, "How can I purchase a membership?");
  assert.equal(purchase.response.status, 200);
  assert.equal(purchase.body.category, "membership_purchase");
  assert.equal(purchase.body.link.url, configuration().UGF_HELP_MEMBERSHIP_URL);
  assert.equal(purchase.response.headers.get("cache-control"), "no-store");
  assert.equal(purchase.response.headers.get("access-control-allow-origin"), ORIGIN);
  const account = await request(running.url, "Can you change my account password?");
  assert.equal(account.body.category, "account_access");
  assert.match(account.body.answer, /cannot view or change an account/);
  assert.equal(JSON.stringify(account.body).includes("memberId"), false);
});

test("access hours answer uses the owner-approved schedule", async (t) => {
  const app = express(); app.use(express.json());
  composePublicHelpChatRoute(app, createPublicHelpChatStartup({ environment: configuration() }));
  const running = await startApp(app); t.after(() => running.close());
  const hours = await request(running.url, "When is staff onsite and is member access 24/7?");
  assert.equal(hours.body.category, "access_hours");
  assert.match(hours.body.answer, /24\/7 access, 365 days a year/);
  assert.match(hours.body.answer, /Monday–Friday from 9 AM–2 PM and 3 PM–6 PM/);
  assert.equal(hours.body.needsStaff, false);
});

test("unknown and billing questions require staff without collecting sensitive data", async (t) => {
  const app = express(); app.use(express.json());
  composePublicHelpChatRoute(app, createPublicHelpChatStartup({ environment: configuration() }));
  const running = await startApp(app); t.after(() => running.close());
  const billing = await request(running.url, "I need a refund for a card charge");
  assert.equal(billing.body.category, "billing_support");
  assert.equal(billing.body.needsStaff, true);
  assert.match(billing.body.answer, /Do not enter card or bank information/);
  const unknown = await request(running.url, "Tell me something not in the approved answers");
  assert.equal(unknown.body.category, "staff_help");
  assert.equal(unknown.body.needsStaff, true);
});

test("unapproved origins receive no browser permission and invalid bodies are rejected", async (t) => {
  const app = express(); app.use(express.json());
  composePublicHelpChatRoute(app, createPublicHelpChatStartup({ environment: configuration() }));
  const running = await startApp(app); t.after(() => running.close());
  const wrongOrigin = await request(running.url, "class schedule", "https://evil.example");
  assert.equal(wrongOrigin.response.headers.get("access-control-allow-origin"), null);
  const response = await fetch(`${running.url}/public/help/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ question: "help", memberId: 42 }),
  });
  assert.equal(response.status, 400);
});
