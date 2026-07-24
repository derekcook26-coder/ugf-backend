"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  OWNER_WORKOUT_TRACKING_FLAG,
  createOwnerWorkoutTrackingRouter,
  ownerWorkoutTrackingEnabled,
} = require("../src/goals-coach/owner-workout-tracking");
const {
  OWNER_MEMBER_ID,
  OWNER_ONLY_ENABLE_FLAG,
  createGymMasterOwnerOnlyStartup,
} = require("../src/goals-coach/gymmaster-owner-only-startup");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://ultimategoalsfitness.com";
const ownerIdentity = { authProvider: "gymmaster", authSubject: "gymmaster:10482" };
const noRateLimits = { read: (_req, _res, next) => next(), mutation: (_req, _res, next) => next() };

function completeEnvironment(overrides = {}) {
  return {
    GOALS_COACH_MEMBER_LOGIN_ENABLED: "true",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin,
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

async function mappedDatabase(t) {
  const disposable = await createDisposableDatabase({ ownerWorkoutTracking: true });
  t.after(() => disposable.close());
  const owner = await seedMemberAndPlan(disposable.pool, "owner-journal");
  const other = await seedMemberAndPlan(disposable.pool, "other-journal");
  await disposable.pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot,
       active, provisioning_method, provisioning_reference)
     VALUES ($1, 'gymmaster', 'gymmaster:10482', 'owner@example.test',
             TRUE, 'owner_approved_script', 'owner-workout-test')`,
    [owner.member.id]
  );
  return { disposable, owner: owner.member, other: other.member };
}

async function trackingApp(t, pool, identity = ownerIdentity) {
  const app = express();
  app.use(express.json());
  app.use("/goalscoach", createOwnerWorkoutTrackingRouter({
    db: pool,
    origin,
    rateLimits: noRateLimits,
    authenticateSession(req, _res, next) {
      req.alphaMemberIdentity = identity;
      next();
    },
    authorizeOwner(candidate) {
      return candidate.authProvider === "gymmaster"
        && candidate.authSubject === "gymmaster:10482";
    },
  }));
  app.use(goalsCoachErrorHandler);
  const running = await startApp(app);
  t.after(() => running.close());
  return running;
}

test("tracking is exact-string enabled and disabled routes do no database or provider work", () => {
  assert.equal(ownerWorkoutTrackingEnabled("true"), true);
  for (const value of [undefined, true, "True", "TRUE", " true", "true ", "1"]) {
    assert.equal(ownerWorkoutTrackingEnabled(value), false);
  }
  let dbCalls = 0;
  let providerCalls = 0;
  const startup = createGymMasterOwnerOnlyStartup({
    environment: completeEnvironment({ [OWNER_WORKOUT_TRACKING_FLAG]: undefined }),
    db: { query: async () => { dbCalls += 1; return { rows: [] }; } },
    fetchImpl: async () => { providerCalls += 1; },
  });
  const paths = startup.router.stack
    .map((layer) => layer.route && layer.route.path)
    .filter(Boolean);
  assert.deepEqual(paths, ["/login", "/session"]);
  assert.equal(dbCalls, 0);
  assert.equal(providerCalls, 0);
});

test("missing or inactive mapping and non-owner sessions are denied", async (t) => {
  const { disposable } = await mappedDatabase(t);
  await disposable.pool.query(
    "UPDATE goals_coach_member_auth_mappings SET active = FALSE, deactivated_at = NOW(), deactivation_reason = 'test' WHERE auth_subject = 'gymmaster:10482'"
  );
  let running = await trackingApp(t, disposable.pool);
  let response = await jsonRequest(running.url, "/goalscoach/workout-logs", {
    headers: { Origin: origin },
  });
  assert.equal(response.response.status, 401);

  running = await trackingApp(t, disposable.pool, {
    authProvider: "gymmaster", authSubject: "gymmaster:99999",
  });
  response = await jsonRequest(running.url, "/goalscoach/workout-logs", {
    headers: { Origin: origin },
  });
  assert.equal(response.response.status, 401);
});

test("invalid calendar date in list cursor returns 400 before database access", async (t) => {
  let dbCalls = 0;
  const running = await trackingApp(t, {
    async query() {
      dbCalls += 1;
      throw new Error("database must not be queried");
    },
  });
  const cursor = Buffer.from(JSON.stringify({
    performedOn: "2026-02-30",
    id: "1",
  })).toString("base64url");
  const response = await jsonRequest(
    running.url,
    `/goalscoach/workout-logs?cursor=${encodeURIComponent(cursor)}`,
    { headers: { Origin: origin } }
  );
  assert.equal(response.response.status, 400);
  assert.equal(response.body.error, "INVALID_REQUEST");
  assert.equal(dbCalls, 0);
});

test("wrong origin and unknown or ownership fields fail before journal writes", async (t) => {
  const { disposable } = await mappedDatabase(t);
  const running = await trackingApp(t, disposable.pool);
  const valid = {
    clientRequestId: "00000000-0000-4000-8000-000000000011",
    performedOn: "2026-07-23",
    workoutName: "Strength",
  };
  const wrongOrigin = await jsonRequest(running.url, "/goalscoach/workout-logs", {
    method: "POST", headers: { Origin: "https://wrong.example" }, body: valid,
  });
  assert.equal(wrongOrigin.response.status, 403);

  for (const extra of [
    { memberId: 1 }, { source: "browser" }, { actor: "owner" },
    { plan: 1 }, { conversation: 1 }, { provider: "x" }, { model: "x" },
  ]) {
    const rejected = await jsonRequest(running.url, "/goalscoach/workout-logs", {
      method: "POST", headers: { Origin: origin }, body: { ...valid, ...extra },
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error, "UNKNOWN_FIELD");
  }
  const count = await disposable.pool.query("SELECT COUNT(*)::int AS count FROM goals_coach_workout_logs");
  assert.equal(count.rows[0].count, 0);
});

test("workout logging is owner-scoped, validated, idempotent, and paginated", async (t) => {
  const { disposable, owner, other } = await mappedDatabase(t);
  const running = await trackingApp(t, disposable.pool);
  const body = {
    clientRequestId: "00000000-0000-4000-8000-000000000021",
    performedOn: "2026-07-23",
    workoutName: "Upper Body",
    durationMinutes: 45,
    notes: "Felt strong",
  };
  const first = await jsonRequest(running.url, "/goalscoach/workout-logs", {
    method: "POST", headers: { Origin: origin }, body,
  });
  const retry = await jsonRequest(running.url, "/goalscoach/workout-logs", {
    method: "POST", headers: { Origin: origin }, body: { ...body, workoutName: "Ignored retry" },
  });
  assert.equal(first.response.status, 200);
  assert.equal(retry.body.workoutLog.id, first.body.workoutLog.id);
  assert.equal(retry.body.workoutLog.workoutName, "Upper Body");

  await disposable.pool.query(
    `INSERT INTO goals_coach_workout_logs
      (member_id, client_request_id, performed_on, workout_name)
     VALUES ($1, '00000000-0000-4000-8000-000000000022', '2026-07-22', 'Owner second'),
            ($2, '00000000-0000-4000-8000-000000000023', '2026-07-24', 'Other private')`,
    [owner.id, other.id]
  );
  const page1 = await jsonRequest(running.url, "/goalscoach/workout-logs?limit=1", {
    headers: { Origin: origin },
  });
  assert.equal(page1.body.workoutLogs.length, 1);
  assert.ok(page1.body.nextCursor);
  const page2 = await jsonRequest(
    running.url,
    `/goalscoach/workout-logs?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    { headers: { Origin: origin } }
  );
  assert.deepEqual(page2.body.workoutLogs.map((row) => row.workoutName), ["Owner second"]);
  assert.equal(page2.body.nextCursor, null);

  for (const invalid of [
    { ...body, clientRequestId: "UPPER" },
    { ...body, performedOn: "2026-02-30" },
    { ...body, performedOn: "2100-01-01" },
    { ...body, durationMinutes: 0 },
    { ...body, workoutName: " padded " },
  ]) {
    const response = await jsonRequest(running.url, "/goalscoach/workout-logs", {
      method: "POST", headers: { Origin: origin }, body: invalid,
    });
    assert.equal(response.response.status, 400);
  }
});

test("achievement validation, idempotency, and cross-member workout concealment", async (t) => {
  const { disposable, owner, other } = await mappedDatabase(t);
  const running = await trackingApp(t, disposable.pool);
  const logs = await disposable.pool.query(
    `INSERT INTO goals_coach_workout_logs
      (member_id, client_request_id, performed_on, workout_name)
     VALUES ($1, '00000000-0000-4000-8000-000000000031', '2026-07-23', 'Owner'),
            ($2, '00000000-0000-4000-8000-000000000032', '2026-07-23', 'Other')
     RETURNING id, member_id`,
    [owner.id, other.id]
  );
  const ownerLog = logs.rows.find((row) => String(row.member_id) === String(owner.id));
  const otherLog = logs.rows.find((row) => String(row.member_id) === String(other.id));
  const body = {
    clientRequestId: "00000000-0000-4000-8000-000000000033",
    achievementType: "personal_record",
    title: "Deadlift",
    achievedOn: "2026-07-23",
    metricValue: 225,
    metricUnit: "lb",
    workoutLogId: Number(ownerLog.id),
  };
  const first = await jsonRequest(running.url, "/goalscoach/achievements", {
    method: "POST", headers: { Origin: origin }, body,
  });
  const retry = await jsonRequest(running.url, "/goalscoach/achievements", {
    method: "POST", headers: { Origin: origin }, body,
  });
  assert.equal(first.response.status, 200);
  assert.equal(retry.body.achievement.id, first.body.achievement.id);

  const crossMember = await jsonRequest(running.url, "/goalscoach/achievements", {
    method: "POST",
    headers: { Origin: origin },
    body: { ...body, clientRequestId: "00000000-0000-4000-8000-000000000034", workoutLogId: Number(otherLog.id) },
  });
  assert.equal(crossMember.response.status, 404);
  assert.equal(crossMember.body.error, "WORKOUT_LOG_NOT_FOUND");

  for (const invalid of [
    { ...body, clientRequestId: "00000000-0000-4000-8000-000000000035", metricUnit: undefined },
    { ...body, clientRequestId: "00000000-0000-4000-8000-000000000036", achievementType: "milestone" },
    { ...body, clientRequestId: "00000000-0000-4000-8000-000000000037", coachingMilestoneId: 1 },
  ]) {
    const response = await jsonRequest(running.url, "/goalscoach/achievements", {
      method: "POST", headers: { Origin: origin }, body: invalid,
    });
    assert.equal(response.response.status, 400);
  }
});
