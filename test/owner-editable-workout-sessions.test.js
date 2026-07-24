"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  OWNER_EDITABLE_WORKOUT_SESSIONS_FLAG,
  createOwnerEditableWorkoutSessionsRouter,
  ownerEditableWorkoutSessionsEnabled,
} = require("../src/goals-coach/owner-editable-workout-sessions");
const { OWNER_WORKOUT_TRACKING_FLAG } = require("../src/goals-coach/owner-workout-tracking");
const {
  OWNER_MEMBER_ID,
  OWNER_ONLY_ENABLE_FLAG,
  createGymMasterOwnerOnlyStartup,
} = require("../src/goals-coach/gymmaster-owner-only-startup");
const {
  buildGymMasterSessionCookie,
  createGymMasterMemberSessionService,
} = require("../src/goals-coach/gymmaster-member-session");
const {
  composeGymMasterOwnerOnlyRoutes,
} = require("../src/goals-coach/gymmaster-owner-only-route-composition");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://ultimategoalsfitness.com";
const sessionSecret = "s".repeat(32);
const noRateLimits = {
  read: (_req, _res, next) => next(),
  mutation: (_req, _res, next) => next(),
};

function completeEnvironment(overrides = {}) {
  return {
    GOALS_COACH_MEMBER_LOGIN_ENABLED: "true",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin,
    GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL:
      "https://ugf.gymmasteronline.com/portal/api/v1/login",
    GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL:
      "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
    GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "members-key",
    GYMMASTER_API_KEY: "gatekeeper-key",
    GYMMASTER_SITE: "ugf",
    GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: sessionSecret,
    [OWNER_ONLY_ENABLE_FLAG]: "true",
    [OWNER_MEMBER_ID]: "10482",
    ...overrides,
  };
}

function signedCookie(subject = "gymmaster:10482") {
  const token = createGymMasterMemberSessionService({ secret: sessionSecret }).issue({
    authProvider: "gymmaster",
    authSubject: subject,
    expiresInSeconds: 900,
  });
  return buildGymMasterSessionCookie(token).split(";")[0];
}

async function mappedDatabase(t) {
  const disposable = await createDisposableDatabase({ ownerEditableWorkoutSessions: true });
  t.after(() => disposable.close());
  const owner = await seedMemberAndPlan(disposable.pool, "editable-owner");
  const other = await seedMemberAndPlan(disposable.pool, "editable-other");
  await disposable.pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot,
       active, provisioning_method, provisioning_reference)
     VALUES ($1, 'gymmaster', 'gymmaster:10482', 'owner@example.test',
             TRUE, 'owner_approved_script', 'editable-workout-test')`,
    [owner.member.id]
  );
  return { disposable, owner: owner.member, other: other.member };
}

async function startupApp(t, pool, overrides = {}) {
  let providerCalls = 0;
  const app = express();
  app.use(express.json());
  const startup = createGymMasterOwnerOnlyStartup({
    environment: completeEnvironment({
      [OWNER_EDITABLE_WORKOUT_SESSIONS_FLAG]: "true",
      ...overrides,
    }),
    db: pool,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("provider access is forbidden in editable workout tests");
    },
    workoutTrackingRateLimits: noRateLimits,
    editableWorkoutSessionsRateLimits: noRateLimits,
  });
  composeGymMasterOwnerOnlyRoutes(app, startup);
  app.use(goalsCoachErrorHandler);
  const running = await startApp(app);
  t.after(() => running.close());
  return {
    running,
    providerCalls: () => providerCalls,
  };
}

function ownerRequest(running, pathName, options = {}) {
  return jsonRequest(running.url, pathName, {
    ...options,
    headers: {
      Origin: origin,
      Cookie: signedCookie(),
      ...(options.headers || {}),
    },
  });
}

function validDraft(clientRequestId = "00000000-0000-4000-8000-000000008101") {
  return {
    clientRequestId,
    workoutName: "Strength",
    notes: "Owner-entered draft",
    exercises: [
      {
        order: 1,
        name: "Squat",
        state: "completed",
        notes: "Controlled reps",
        sets: [
          { order: 1, actualReps: 5, load: 100, unit: "lb", notes: "Solid" },
        ],
      },
      {
        order: 2,
        name: "Row",
        state: "skipped",
        notes: null,
        sets: [],
      },
    ],
  };
}

test("editable workout routes use an exact-string flag and disabled paths do zero work", async (t) => {
  assert.equal(ownerEditableWorkoutSessionsEnabled("true"), true);
  for (const value of [undefined, true, "True", "TRUE", " true", "true ", "1"]) {
    assert.equal(ownerEditableWorkoutSessionsEnabled(value), false);
  }

  let databaseCalls = 0;
  let providerCalls = 0;
  const database = {
    async query() {
      databaseCalls += 1;
      throw new Error("database must not be used");
    },
  };
  const startup = createGymMasterOwnerOnlyStartup({
    environment: completeEnvironment({
      [OWNER_WORKOUT_TRACKING_FLAG]: "true",
      [OWNER_EDITABLE_WORKOUT_SESSIONS_FLAG]: undefined,
    }),
    db: database,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("provider must not be used");
    },
    workoutTrackingRateLimits: noRateLimits,
  });
  const app = express();
  app.use(express.json());
  composeGymMasterOwnerOnlyRoutes(app, startup);
  const running = await startApp(app);
  t.after(() => running.close());

  for (const request of [
    { path: "/goalscoach/tracked-workout-sessions", method: "POST" },
    { path: "/goalscoach/tracked-workout-sessions", method: "GET" },
    { path: "/goalscoach/tracked-workout-sessions/1", method: "GET" },
    { path: "/goalscoach/tracked-workout-sessions/1/draft", method: "PUT" },
    { path: "/goalscoach/tracked-workout-sessions/1/complete", method: "POST" },
  ]) {
    const response = await jsonRequest(running.url, request.path, {
      method: request.method,
      headers: { Origin: origin },
      body: ["POST", "PUT"].includes(request.method) ? {} : undefined,
    });
    assert.equal(response.response.status, 404);
  }
  assert.equal(databaseCalls, 0);
  assert.equal(providerCalls, 0);
});

test("exact origin, signed session, exact owner subject, and active mapping are required", async (t) => {
  const { disposable } = await mappedDatabase(t);
  const { running, providerCalls } = await startupApp(t, disposable.pool);

  const wrongOrigin = await jsonRequest(
    running.url,
    "/goalscoach/tracked-workout-sessions",
    { headers: { Origin: "https://wrong.example", Cookie: signedCookie() } }
  );
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.error, "OWNER_ORIGIN_NOT_ALLOWED");

  const missingOrigin = await jsonRequest(
    running.url,
    "/goalscoach/tracked-workout-sessions",
    { headers: { Cookie: signedCookie() } }
  );
  assert.equal(missingOrigin.response.status, 403);

  const missingSession = await jsonRequest(
    running.url,
    "/goalscoach/tracked-workout-sessions",
    { headers: { Origin: origin } }
  );
  assert.equal(missingSession.response.status, 401);

  const tampered = await jsonRequest(
    running.url,
    "/goalscoach/tracked-workout-sessions",
    { headers: { Origin: origin, Cookie: `${signedCookie()}x` } }
  );
  assert.equal(tampered.response.status, 401);

  const nonOwner = await jsonRequest(
    running.url,
    "/goalscoach/tracked-workout-sessions",
    { headers: { Origin: origin, Cookie: signedCookie("gymmaster:10483") } }
  );
  assert.equal(nonOwner.response.status, 401);

  await disposable.pool.query(
    `UPDATE goals_coach_member_auth_mappings
     SET active = FALSE, deactivated_at = NOW(), deactivation_reason = 'test'
     WHERE auth_subject = 'gymmaster:10482'`
  );
  const inactiveMapping = await ownerRequest(
    running,
    "/goalscoach/tracked-workout-sessions"
  );
  assert.equal(inactiveMapping.response.status, 401);
  assert.equal(providerCalls(), 0);
});

test("manual creation is server-owned, strictly validated, and idempotent", async (t) => {
  const { disposable } = await mappedDatabase(t);
  const { running, providerCalls } = await startupApp(t, disposable.pool);
  const body = validDraft();

  const created = await ownerRequest(running, "/goalscoach/tracked-workout-sessions", {
    method: "POST",
    body,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.idempotentReplay, false);
  assert.equal(created.body.workoutSession.source, "manual");
  assert.equal(created.body.workoutSession.status, "draft");
  assert.equal(created.body.workoutSession.version, 1);
  assert.equal(created.body.workoutSession.exercises.length, 2);
  assert.equal(created.body.workoutSession.exercises[0].sets[0].load, 100);

  const replay = await ownerRequest(running, "/goalscoach/tracked-workout-sessions", {
    method: "POST",
    body,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.workoutSession.id, created.body.workoutSession.id);

  const conflictingRetry = await ownerRequest(
    running,
    "/goalscoach/tracked-workout-sessions",
    {
      method: "POST",
      body: { ...body, workoutName: "Different payload" },
    }
  );
  assert.equal(conflictingRetry.response.status, 409);
  assert.equal(conflictingRetry.body.error, "IDEMPOTENCY_CONFLICT");

  const ownershipFields = [
    { memberId: "1" },
    { member_id: "1" },
    { source: "manual" },
    { sourceSnapshot: {} },
    { planId: "1" },
    { conversationId: "1" },
    { authSubject: "gymmaster:10482" },
  ];
  for (const extra of ownershipFields) {
    const rejected = await ownerRequest(
      running,
      "/goalscoach/tracked-workout-sessions",
      { method: "POST", body: { ...validDraft(), ...extra } }
    );
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error, "UNKNOWN_FIELD");
  }

  for (const invalid of [
    {
      ...validDraft("00000000-0000-4000-8000-000000008111"),
      exercises: [{
        order: 1,
        name: "Squat",
        state: "completed",
        sets: [{ order: 1, actualReps: 5, load: 100 }],
      }],
    },
    {
      ...validDraft("00000000-0000-4000-8000-000000008112"),
      exercises: [{
        order: 1,
        name: "Squat",
        state: "completed",
        sets: [{ order: 1, actualReps: 5, unit: "lb" }],
      }],
    },
    {
      ...validDraft("00000000-0000-4000-8000-000000008113"),
      exercises: [{
        order: 1,
        name: "Squat",
        state: "completed",
        memberId: "1",
        sets: [{ order: 1, actualReps: 5 }],
      }],
    },
    {
      ...validDraft("00000000-0000-4000-8000-000000008114"),
      exercises: [{
        order: 1,
        name: "Squat",
        state: "completed",
        sets: [{ order: 1, actualReps: 5, memberId: "1" }],
      }],
    },
  ]) {
    const rejected = await ownerRequest(
      running,
      "/goalscoach/tracked-workout-sessions",
      { method: "POST", body: invalid }
    );
    assert.equal(rejected.response.status, 400);
  }

  const counts = await disposable.pool.query(
    `SELECT
      (SELECT COUNT(*)::int FROM goals_coach_tracked_workout_sessions) AS sessions,
      (SELECT COUNT(*)::int FROM goals_coach_tracked_workout_events
       WHERE event_type = 'created') AS created_events`
  );
  assert.equal(counts.rows[0].sessions, 1);
  assert.equal(counts.rows[0].created_events, 1);
  assert.equal(providerCalls(), 0);
});

test("draft replacement uses current version and completion is explicit and idempotent", async (t) => {
  const { disposable } = await mappedDatabase(t);
  const { running, providerCalls } = await startupApp(t, disposable.pool);
  const initial = validDraft("00000000-0000-4000-8000-000000008121");
  initial.exercises = [{
    order: 1,
    name: "Press",
    state: "planned",
    notes: null,
    sets: [],
  }];
  const created = await ownerRequest(running, "/goalscoach/tracked-workout-sessions", {
    method: "POST",
    body: initial,
  });
  const id = created.body.workoutSession.id;

  const premature = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${id}/complete`,
    { method: "POST", body: { version: 1 } }
  );
  assert.equal(premature.response.status, 409);
  assert.equal(
    premature.body.error,
    "TRACKED_WORKOUT_SESSION_HAS_PLANNED_EXERCISES"
  );

  const replacement = {
    version: 1,
    workoutName: "Press day complete",
    notes: "Final draft",
    exercises: [{
      order: 1,
      name: "Press",
      state: "completed",
      notes: null,
      sets: [{ order: 1, actualReps: 8, load: 50, unit: "lb", notes: null }],
    }],
  };
  const updated = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${id}/draft`,
    { method: "PUT", body: replacement }
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.workoutSession.version, 2);
  assert.equal(updated.body.workoutSession.workoutName, "Press day complete");

  const stale = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${id}/draft`,
    { method: "PUT", body: replacement }
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error, "TRACKED_WORKOUT_SESSION_VERSION_CONFLICT");
  assert.equal(stale.body.currentVersion, 2);

  const completed = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${id}/complete`,
    { method: "POST", body: { version: 2 } }
  );
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.idempotentReplay, false);
  assert.equal(completed.body.workoutSession.status, "completed");
  assert.equal(completed.body.workoutSession.version, 2);

  const completionReplay = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${id}/complete`,
    { method: "POST", body: { version: 2 } }
  );
  assert.equal(completionReplay.response.status, 200);
  assert.equal(completionReplay.body.idempotentReplay, true);

  const completedEdit = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${id}/draft`,
    { method: "PUT", body: { ...replacement, version: 2 } }
  );
  assert.equal(completedEdit.response.status, 409);
  assert.equal(completedEdit.body.error, "TRACKED_WORKOUT_SESSION_COMPLETED");

  const noDelete = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${id}`,
    { method: "DELETE" }
  );
  assert.equal(noDelete.response.status, 404);

  const history = await disposable.pool.query(
    `SELECT event_type, session_version
     FROM goals_coach_tracked_workout_events
     WHERE session_id = $1
     ORDER BY id`,
    [id]
  );
  assert.deepEqual(
    history.rows.map((row) => [row.event_type, Number(row.session_version)]),
    [["created", 1], ["draft_replaced", 2], ["completed", 2]]
  );
  const revisionCounts = await disposable.pool.query(
    `SELECT session_version, COUNT(*)::int AS count
     FROM goals_coach_tracked_workout_exercises
     WHERE session_id = $1
     GROUP BY session_version
     ORDER BY session_version`,
    [id]
  );
  assert.deepEqual(
    revisionCounts.rows.map((row) => [Number(row.session_version), row.count]),
    [[1, 1], [2, 1]]
  );
  await assert.rejects(
    disposable.pool.query(
      `UPDATE goals_coach_tracked_workout_sets
       SET actual_reps = 99
       WHERE session_id = $1 AND session_version = 2`,
      [id]
    ),
    /append-only/i
  );
  assert.equal(providerCalls(), 0);
});

test("list pagination is stable and every single-session route conceals other members", async (t) => {
  const { disposable, owner, other } = await mappedDatabase(t);
  const { running, providerCalls } = await startupApp(t, disposable.pool);
  const inserted = await disposable.pool.query(
    `INSERT INTO goals_coach_tracked_workout_sessions
      (member_id, client_request_id, client_request_hash, source,
       workout_name, created_at, updated_at)
     VALUES
      ($1, '00000000-0000-4000-8000-000000008131', $3, 'manual',
       'First', '2026-07-24T12:00:00.000Z', '2026-07-24T12:00:00.000Z'),
      ($1, '00000000-0000-4000-8000-000000008132', $3, 'manual',
       'Second', '2026-07-24T12:00:00.000Z', '2026-07-24T12:00:00.000Z'),
      ($1, '00000000-0000-4000-8000-000000008133', $3, 'manual',
       'Third', '2026-07-24T12:00:00.000Z', '2026-07-24T12:00:00.000Z'),
      ($2, '00000000-0000-4000-8000-000000008134', $3, 'manual',
       'Other private', '2026-07-24T13:00:00.000Z', '2026-07-24T13:00:00.000Z')
     RETURNING id, member_id, workout_name`,
    [owner.id, other.id, "e".repeat(64)]
  );
  const ownerRows = inserted.rows
    .filter((row) => String(row.member_id) === String(owner.id))
    .sort((left, right) => Number(BigInt(right.id) - BigInt(left.id)));
  const otherRow = inserted.rows.find(
    (row) => String(row.member_id) === String(other.id)
  );

  const firstPage = await ownerRequest(
    running,
    "/goalscoach/tracked-workout-sessions?limit=2"
  );
  assert.equal(firstPage.response.status, 200);
  assert.deepEqual(
    firstPage.body.workoutSessions.map((session) => session.id),
    ownerRows.slice(0, 2).map((row) => String(row.id))
  );
  assert.ok(firstPage.body.nextCursor);

  const secondPage = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions?limit=2&cursor=${
      encodeURIComponent(firstPage.body.nextCursor)
    }`
  );
  assert.deepEqual(
    secondPage.body.workoutSessions.map((session) => session.id),
    [String(ownerRows[2].id)]
  );
  assert.equal(secondPage.body.nextCursor, null);

  const detail = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${otherRow.id}`
  );
  assert.equal(detail.response.status, 404);
  assert.equal(detail.body.error, "TRACKED_WORKOUT_SESSION_NOT_FOUND");

  const update = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${otherRow.id}/draft`,
    {
      method: "PUT",
      body: { version: 1, workoutName: "No", notes: null, exercises: [] },
    }
  );
  assert.equal(update.response.status, 404);

  const complete = await ownerRequest(
    running,
    `/goalscoach/tracked-workout-sessions/${otherRow.id}/complete`,
    { method: "POST", body: { version: 1 } }
  );
  assert.equal(complete.response.status, 404);
  assert.equal(providerCalls(), 0);
});

test("the capability exposes only the five owner routes and imports no provider client", () => {
  const router = createOwnerEditableWorkoutSessionsRouter({
    db: {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release() {},
      }),
    },
    origin,
    authenticateSession: (_req, _res, next) => next(),
    authorizeOwner: () => true,
    mappingAuthorization: {
      authorizeIdentity: async () => ({ active: true, memberId: "1" }),
    },
    rateLimits: noRateLimits,
  });
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }));
  assert.deepEqual(routes, [
    { path: "/tracked-workout-sessions", methods: ["post"] },
    { path: "/tracked-workout-sessions", methods: ["get"] },
    { path: "/tracked-workout-sessions/:id", methods: ["get"] },
    { path: "/tracked-workout-sessions/:id/draft", methods: ["put"] },
    { path: "/tracked-workout-sessions/:id/complete", methods: ["post"] },
  ]);

  const source = fs.readFileSync(
    path.join(__dirname, "../src/goals-coach/owner-editable-workout-sessions.js"),
    "utf8"
  );
  assert.equal(source.includes("goals_coach_workout_sessions"), false);
  assert.equal(source.includes("openai"), false);
  assert.equal(source.includes("node-fetch"), false);
  assert.equal(source.includes("gymmaster-member-portal-client"), false);
  assert.equal(source.includes("/staff"), false);
  assert.equal(source.includes("/plans"), false);
  assert.equal(source.includes("/notifications"), false);
  assert.equal(source.includes("/conversations"), false);
  assert.equal(source.includes("router.delete"), false);
});
