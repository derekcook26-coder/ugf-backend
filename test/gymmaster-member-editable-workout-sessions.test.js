"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const {
  MEMBER_EDITABLE_WORKOUT_SESSIONS_FLAG,
  memberEditableWorkoutSessionsEnabled,
} = require("../src/goals-coach/gymmaster-member-editable-workout-sessions");
const {
  createGymMasterMemberEditableWorkoutSessionsStartup,
} = require("../src/goals-coach/gymmaster-member-editable-workout-sessions-startup");
const {
  composeGymMasterMemberEditableWorkoutSessionsRoutes,
} = require("../src/goals-coach/gymmaster-member-editable-workout-sessions-route-composition");
const {
  buildGymMasterSessionCookie,
  createGymMasterMemberSessionService,
} = require("../src/goals-coach/gymmaster-member-session");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://ultimategoalsfitness.com";
const sessionSecret = "m".repeat(32);
const noRateLimits = {
  read: (_req, _res, next) => next(),
  mutation: (_req, _res, next) => next(),
};

function environment(overrides = {}) {
  return {
    GOALS_COACH_MEMBER_LOGIN_ENABLED: "true",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin,
    GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL: "https://ugf.gymmasteronline.com/portal/api/v1/login",
    GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
    GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "member-key",
    GYMMASTER_API_KEY: "gatekeeper-key",
    GYMMASTER_SITE: "ugf",
    GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: sessionSecret,
    [MEMBER_EDITABLE_WORKOUT_SESSIONS_FLAG]: "true",
    ...overrides,
  };
}

function cookie(subject) {
  const token = createGymMasterMemberSessionService({ secret: sessionSecret }).issue({
    authProvider: "gymmaster",
    authSubject: subject,
    expiresInSeconds: 900,
  });
  return buildGymMasterSessionCookie(token).split(";")[0];
}

async function fixture(t) {
  const disposable = await createDisposableDatabase({ ownerEditableWorkoutSessions: true });
  t.after(() => disposable.close());
  const first = await seedMemberAndPlan(disposable.pool, "member-editable-first");
  const second = await seedMemberAndPlan(disposable.pool, "member-editable-second");
  for (const [member, subject] of [[first.member, "gymmaster:20001"], [second.member, "gymmaster:20002"]]) {
    await disposable.pool.query(
      `INSERT INTO goals_coach_member_auth_mappings
       (member_id, auth_provider, auth_subject, verified_email_snapshot, active,
        provisioning_method, provisioning_reference)
       VALUES ($1, 'gymmaster', $2, 'member@example.test', TRUE,
               'owner_approved_script', 'member-editable-test')`,
      [member.id, subject]
    );
  }
  let providerCalls = 0;
  const app = express();
  app.use(express.json());
  const startup = createGymMasterMemberEditableWorkoutSessionsStartup({
    environment: environment(),
    db: disposable.pool,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("provider access is forbidden in member editable-workout tests");
    },
    editableWorkoutSessionsRateLimits: noRateLimits,
  });
  composeGymMasterMemberEditableWorkoutSessionsRoutes(app, startup);
  app.use(goalsCoachErrorHandler);
  const running = await startApp(app);
  t.after(() => running.close());
  return { running, providerCalls: () => providerCalls };
}

function memberRequest(running, pathName, subject, options = {}) {
  return jsonRequest(running.url, `/goalscoach/member${pathName}`, {
    ...options,
    headers: { Origin: origin, Cookie: cookie(subject), ...(options.headers || {}) },
  });
}

function draft(id = "00000000-0000-4000-8000-000000008201") {
  return {
    clientRequestId: id,
    workoutName: "Member manual workout",
    notes: "Member-created draft",
    exercises: [{
      order: 1,
      name: "Squat",
      state: "completed",
      notes: null,
      sets: [{ order: 1, actualReps: 8, load: null, unit: null, notes: null }],
    }],
  };
}

test("member editable-workout routes remain absent unless the new exact flag is enabled", async (t) => {
  assert.equal(memberEditableWorkoutSessionsEnabled("true"), true);
  for (const value of [undefined, true, "True", " true", "true ", "1"]) {
    assert.equal(memberEditableWorkoutSessionsEnabled(value), false);
  }
  let calls = 0;
  const app = express();
  const startup = createGymMasterMemberEditableWorkoutSessionsStartup({
    environment: environment({ [MEMBER_EDITABLE_WORKOUT_SESSIONS_FLAG]: undefined }),
    db: { query: async () => { calls += 1; } },
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(startup.status, "disabled");
  assert.deepEqual(composeGymMasterMemberEditableWorkoutSessionsRoutes(app, startup), { mounted: false, path: null });
  const running = await startApp(app);
  t.after(() => running.close());
  const response = await jsonRequest(running.url, "/goalscoach/member/tracked-workout-sessions", {
    headers: { Origin: origin },
  });
  assert.equal(response.response.status, 404);
  assert.equal(calls, 0);
});

test("active members can use only their own manual drafts without provider access", async (t) => {
  const { running, providerCalls } = await fixture(t);
  const wrongOrigin = await jsonRequest(running.url, "/goalscoach/member/tracked-workout-sessions", {
    headers: { Origin: "https://wrong.example", Cookie: cookie("gymmaster:20001") },
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.error, "MEMBER_ORIGIN_NOT_ALLOWED");

  const missingOrigin = await jsonRequest(running.url, "/goalscoach/member/session", {
    headers: { Cookie: cookie("gymmaster:20001") },
  });
  assert.equal(missingOrigin.response.status, 403);
  assert.equal(missingOrigin.body.error, "MEMBER_ORIGIN_NOT_ALLOWED");

  const session = await memberRequest(running, "/session", "gymmaster:20001");
  assert.equal(session.response.status, 200);
  assert.equal(session.body.access, "member_editable_workout_alpha");

  const created = await memberRequest(running, "/tracked-workout-sessions", "gymmaster:20001", {
    method: "POST", body: draft(),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.workoutSession.source, "manual");
  const id = created.body.workoutSession.id;

  const replay = await memberRequest(running, "/tracked-workout-sessions", "gymmaster:20001", {
    method: "POST", body: draft(),
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.workoutSession.id, id);

  const updated = await memberRequest(running, `/tracked-workout-sessions/${id}/draft`, "gymmaster:20001", {
    method: "PUT",
    body: {
      version: 1,
      workoutName: "Member manual workout — updated",
      notes: "Member-recorded execution draft",
      exercises: [{
        order: 1,
        name: "Squat",
        state: "completed",
        notes: null,
        sets: [{ order: 1, actualReps: 10, load: null, unit: null, notes: null }],
      }],
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.workoutSession.version, 2);

  const completed = await memberRequest(running, `/tracked-workout-sessions/${id}/complete`, "gymmaster:20001", {
    method: "POST",
    body: { version: 2 },
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.workoutSession.status, "completed");

  const concealed = await memberRequest(running, `/tracked-workout-sessions/${id}`, "gymmaster:20002");
  assert.equal(concealed.response.status, 404);
  assert.equal(concealed.body.error, "TRACKED_WORKOUT_SESSION_NOT_FOUND");
  assert.equal(providerCalls(), 0);
});
