"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGymMasterMemberLoginRateLimiter } = require("../src/goals-coach/gymmaster-member-login-rate-limit");

test("member login permits only a bounded number of attempts per client address", () => {
  let now = 0;
  const limiter = createGymMasterMemberLoginRateLimiter({
    maximumAttempts: 2,
    windowMs: 1000,
    now: () => now,
  });
  assert.equal(limiter.allow("203.0.113.10"), true);
  assert.equal(limiter.allow("203.0.113.10"), true);
  assert.equal(limiter.allow("203.0.113.10"), false);
  assert.equal(limiter.allow("203.0.113.11"), true);
  now = 1001;
  assert.equal(limiter.allow("203.0.113.10"), true);
});

test("member login refuses an absent or malformed client address", () => {
  const limiter = createGymMasterMemberLoginRateLimiter();
  assert.equal(limiter.allow(""), false);
  assert.equal(limiter.allow(null), false);
  assert.equal(limiter.allow("x".repeat(201)), false);
});
