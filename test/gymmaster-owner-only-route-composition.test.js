"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const {
  composeGymMasterOwnerOnlyRoutes,
  exactOwnerOnlyOrigin,
} = require("../src/goals-coach/gymmaster-owner-only-route-composition");
const { jsonRequest, startApp } = require("./helpers/http-app");

test("owner-only route composition remains absent unless startup is fully ready", async (t) => {
  const app = express();
  const result = composeGymMasterOwnerOnlyRoutes(app, {
    status: "disabled",
    router: null,
    origin: null,
  });
  assert.deepEqual(result, { mounted: false, path: null });

  const running = await startApp(app);
  t.after(() => running.close());
  const response = await jsonRequest(running.url, "/goalscoach/login", { method: "POST" });
  assert.equal(response.response.status, 404);
});

test("owner-only route composition accepts one exact HTTPS origin only", async (t) => {
  assert.equal(exactOwnerOnlyOrigin("https://ultimategoalsfitness.com"), "https://ultimategoalsfitness.com");
  for (const value of ["http://ultimategoalsfitness.com", "https://ultimategoalsfitness.com/", "https://ultimategoalsfitness.com/goalscoach", "https://*.ultimategoalsfitness.com", "https://ultimategoalsfitness.com?x=1"]) {
    assert.equal(exactOwnerOnlyOrigin(value), null);
  }

  const app = express();
  const result = composeGymMasterOwnerOnlyRoutes(app, {
    status: "ready_for_separate_route_composition",
    origin: "https://ultimategoalsfitness.com",
    router: express.Router().get("/session", (_req, res) => res.json({ ok: true })),
  });
  assert.deepEqual(result, { mounted: true, path: "/goalscoach" });

  const running = await startApp(app);
  t.after(() => running.close());
  const allowed = await jsonRequest(running.url, "/goalscoach/session", {
    headers: { Origin: "https://ultimategoalsfitness.com" },
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.response.headers.get("access-control-allow-origin"), "https://ultimategoalsfitness.com");

  const rejected = await jsonRequest(running.url, "/goalscoach/session", {
    headers: { Origin: "https://example.com" },
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.response.headers.get("access-control-allow-origin"), null);
});
