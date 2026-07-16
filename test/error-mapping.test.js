const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const { jsonRequest, startApp } = require("./helpers/http-app");

test("only the named assignment trigger maps to REVIEW_REASSIGNMENT_REQUIRED", async (t) => {
  const app = express();
  app.get("/staff/assignment", (req, res, next) => next({
    code: "23514",
    constraint: "member_coach_assignments_open_review_guard",
  }));
  app.get("/staff/message-check", (req, res, next) => next({
    code: "23514",
    constraint: "coaching_messages_content_check",
  }));
  app.get("/staff/follow-up-check", (req, res, next) => next({
    code: "23514",
    constraint: "coaching_reviews_member_follow_up_check",
  }));
  app.use(goalsCoachErrorHandler);
  const running = await startApp(app);
  t.after(() => running.close());

  const assignment = await jsonRequest(running.url, "/staff/assignment");
  assert.equal(assignment.body.error, "REVIEW_REASSIGNMENT_REQUIRED");
  for (const path of ["/staff/message-check", "/staff/follow-up-check"]) {
    const unrelated = await jsonRequest(running.url, path);
    assert.equal(unrelated.response.status, 409);
    assert.equal(unrelated.body.error, "CONSTRAINT_VIOLATION");
  }
});
