"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const {
  MAXIMUM_SAFETY_INTAKE_JSON_BYTES,
  MEMBER_SAFETY_INTAKE_FLAG,
  MEMBER_SAFETY_NOTICE,
  MEMBER_SAFETY_NOTICE_VERSION,
  memberSafetyIntakeEnabled,
  parseSafetyIntake,
  safetyIntakeRequestHash,
} = require("../src/goals-coach/gymmaster-member-safety-intake");
const {
  createGymMasterMemberSafetyIntakeStartup,
} = require("../src/goals-coach/gymmaster-member-safety-intake-startup");
const {
  composeGymMasterMemberSafetyIntakeRoutes,
} = require("../src/goals-coach/gymmaster-member-safety-intake-route-composition");
const {
  buildGymMasterSessionCookie,
  createGymMasterMemberSessionService,
} = require("../src/goals-coach/gymmaster-member-session");
const {
  createApplicationJsonParser,
} = require("../src/goals-coach/transcription-route");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const { runMigration: runSafetyIntakeMigration } = require("../migrate_009");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://ultimategoalsfitness.com";
const noticeVersion = MEMBER_SAFETY_NOTICE_VERSION;
const sessionSecret = "s".repeat(32);
const noRateLimits = {
  read: (_req, _res, next) => next(),
  mutation: (_req, _res, next) => next(),
};
const forbiddenPublicFields = /email|name|gymmaster.?id|member.?id|mapping.?id|auth.?(?:subject|provider)|enrollment|provider.?payload|configuration|client.?request.?id|request.?hash|currentpain|currentinjury|recentsurgery|medicalorexercise|othertrainingsafety|health.?narrative|stack|diagnostic/i;

function assertPrivacyMinimized(body, label) {
  assert.doesNotMatch(JSON.stringify(body), forbiddenPublicFields, label);
}

function environment(overrides = {}) {
  return {
    GOALS_COACH_MEMBER_LOGIN_ENABLED: "true",
    GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin,
    GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL:
      "https://ugf.gymmasteronline.com/portal/api/v1/login",
    GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL:
      "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
    GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "member-key",
    GYMMASTER_API_KEY: "gatekeeper-key",
    GYMMASTER_SITE: "ugf",
    GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: sessionSecret,
    [MEMBER_SAFETY_INTAKE_FLAG]: "true",
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

function requestId(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function answers(overrides = {}) {
  return {
    currentPainOrConcerningSymptoms: false,
    currentInjuryConcern: false,
    recentSurgery: false,
    medicalOrExerciseRestriction: false,
    otherTrainingSafetyConcern: false,
    ...overrides,
  };
}

function submission(number, answerOverrides = {}, bodyOverrides = {}) {
  return {
    clientRequestId: requestId(number),
    noticeVersion,
    answers: answers(answerOverrides),
    ...bodyOverrides,
  };
}

async function fixture(t, overrides = {}) {
  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  await runSafetyIntakeMigration({ pool: disposable.pool });
  const first = await seedMemberAndPlan(disposable.pool, "safety-route-first");
  const second = await seedMemberAndPlan(disposable.pool, "safety-route-second");
  const mappings = [];
  for (const [member, subject] of [
    [first.member, "gymmaster:30001"],
    [second.member, "gymmaster:30002"],
  ]) {
    mappings.push((await disposable.pool.query(
      `INSERT INTO goals_coach_member_auth_mappings
        (member_id, auth_provider, auth_subject, verified_email_snapshot, active,
         provisioning_method, provisioning_reference)
       VALUES ($1, 'gymmaster', $2, 'member@example.test', TRUE,
               'owner_approved_script', 'member-safety-intake-test')
       RETURNING *`,
      [member.id, subject]
    )).rows[0]);
  }
  let providerCalls = 0;
  let databaseCalls = 0;
  const instrumentedDb = {
    query(...args) {
      databaseCalls += 1;
      return disposable.pool.query(...args);
    },
    connect(...args) {
      databaseCalls += 1;
      return disposable.pool.connect(...args);
    },
  };
  const app = express();
  app.use(createApplicationJsonParser());
  const startup = createGymMasterMemberSafetyIntakeStartup({
    environment: environment(overrides.environment),
    db: instrumentedDb,
    fetchImpl: overrides.fetchImpl || (async (url) => {
      providerCalls += 1;
      const memberId = new URL(url).searchParams.get("memberid");
      return {
        ok: true,
        async json() {
          return { members: [{
            memberid: Number(memberId),
            stopatgate: false,
            membership: [{ expired: false }],
          }] };
        },
      };
    }),
    ...(overrides.useProductionRateLimits
      ? {}
      : { rateLimits: overrides.rateLimits || noRateLimits }),
  });
  composeGymMasterMemberSafetyIntakeRoutes(app, startup);
  app.use(goalsCoachErrorHandler);
  const running = await startApp(app);
  t.after(() => running.close());
  return {
    disposable,
    first,
    second,
    mappings,
    providerCalls: () => providerCalls,
    databaseCalls: () => databaseCalls,
    running,
  };
}

function memberRequest(running, pathName, subject, options = {}) {
  return jsonRequest(running.url, `/goalscoach/member${pathName}`, {
    ...options,
    headers: {
      Origin: origin,
      Cookie: cookie(subject),
      ...(options.headers || {}),
    },
  });
}

async function protectedTableCounts(pool) {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coach_plans) AS plans,
       (SELECT COUNT(*)::int FROM coaching_conversations) AS conversations,
       (SELECT COUNT(*)::int FROM coaching_concerns) AS concerns,
       (SELECT COUNT(*)::int FROM coaching_reviews) AS reviews,
       (SELECT COUNT(*)::int FROM goals_coach_tracked_workout_sessions) AS workouts`
  );
  return result.rows[0];
}

async function insertHistoricalSubmission(pool, mapping, options = {}) {
  const safetyStop = options.safetyStop === true;
  await pool.query(
    `INSERT INTO goals_coach_member_safety_intake_submissions
      (auth_mapping_id, member_id, client_request_id, client_request_hash,
       notice_version, current_pain_or_concerning_symptoms,
       current_injury_concern, recent_surgery,
       medical_or_exercise_restriction, other_training_safety_concern,
       outcome, safety_stop, rule_version)
     VALUES ($1, $2, $3, $4, 'GC-MEMBER-SAFETY-NOTICE-0',
             $5, FALSE, FALSE, FALSE, FALSE, $6, $5,
             'GC-MEMBER-SAFETY-INTAKE-1')`,
    [
      mapping.id,
      mapping.member_id,
      options.clientRequestId,
      options.requestHash,
      safetyStop,
      safetyStop ? "handoff_required" : "screen_complete",
    ]
  );
}

test("member safety intake is exact-flagged and absent with zero database or provider work", async (t) => {
  assert.equal(memberSafetyIntakeEnabled("true"), true);
  for (const value of [undefined, true, "True", " true", "true ", "1"]) {
    assert.equal(memberSafetyIntakeEnabled(value), false);
  }

  for (const safetyEnvironment of [
    { [MEMBER_SAFETY_INTAKE_FLAG]: undefined },
    {
      [MEMBER_SAFETY_INTAKE_FLAG]: "true",
      GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: undefined,
    },
  ]) {
    let databaseCalls = 0;
    let providerCalls = 0;
    const db = {
      async query() {
        databaseCalls += 1;
        throw new Error("database access is forbidden when safety intake is absent");
      },
      async connect() {
        databaseCalls += 1;
        throw new Error("database access is forbidden when safety intake is absent");
      },
    };
    const app = express();
    app.use(createApplicationJsonParser());
    const startup = createGymMasterMemberSafetyIntakeStartup({
      environment: environment(safetyEnvironment),
      db,
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error("provider access is forbidden when safety intake is absent");
      },
    });
    composeGymMasterMemberSafetyIntakeRoutes(app, startup);
    const running = await startApp(app);
    t.after(() => running.close());
    const get = await jsonRequest(
      running.url,
      "/goalscoach/member/safety-intake",
      { headers: { Origin: origin } }
    );
    const post = await jsonRequest(
      running.url,
      "/goalscoach/member/safety-intake",
      {
        method: "POST",
        headers: { Origin: origin },
        body: submission(1),
      }
    );
    assert.equal(get.response.status, 404);
    assert.equal(post.response.status, 404);
    assert.equal(databaseCalls, 0);
    assert.equal(providerCalls, 0);
  }
});

test("safety-intake hashing is canonical and covers the notice plus all five answers", () => {
  const base = parseSafetyIntake(submission(5), noticeVersion);
  const baseHash = safetyIntakeRequestHash(base);
  assert.match(baseHash, /^[a-f0-9]{64}$/);
  assert.equal(
    safetyIntakeRequestHash(parseSafetyIntake(submission(6), noticeVersion)),
    baseHash
  );
  for (const field of [
    "currentPainOrConcerningSymptoms",
    "currentInjuryConcern",
    "recentSurgery",
    "medicalOrExerciseRestriction",
    "otherTrainingSafetyConcern",
  ]) {
    const changed = parseSafetyIntake(
      submission(7, { [field]: true }),
      noticeVersion
    );
    assert.notEqual(safetyIntakeRequestHash(changed), baseHash, field);
  }
  assert.throws(
    () => parseSafetyIntake(
      { ...submission(8), noticeVersion: "unapproved-version" },
      noticeVersion
    ),
    /notice version is invalid/
  );
});

test("safety intake reuses exact origin, signed session, and active mapping ownership", async (t) => {
  const {
    disposable,
    mappings,
    providerCalls,
    running,
  } = await fixture(t);
  const wrongOrigin = await jsonRequest(
    running.url,
    "/goalscoach/member/safety-intake",
    {
      headers: {
        Origin: "https://wrong.example",
        Cookie: cookie("gymmaster:30001"),
      },
    }
  );
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.error, "MEMBER_ORIGIN_NOT_ALLOWED");
  assertPrivacyMinimized(wrongOrigin.body, "403 response");
  assert.equal(wrongOrigin.response.headers.get("cache-control"), "no-store");

  const missingSession = await jsonRequest(
    running.url,
    "/goalscoach/member/safety-intake",
    { headers: { Origin: origin } }
  );
  assert.equal(missingSession.response.status, 401);
  assert.equal(missingSession.body.error, "MEMBER_AUTHENTICATION_REQUIRED");
  assertPrivacyMinimized(missingSession.body, "401 response");

  const tampered = await jsonRequest(
    running.url,
    "/goalscoach/member/safety-intake",
    {
      headers: {
        Origin: origin,
        Cookie: "gc_member_session=tampered",
      },
    }
  );
  assert.equal(tampered.response.status, 401);
  assertPrivacyMinimized(tampered.body, "tampered-session 401 response");

  const empty = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001"
  );
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.body, {
    safetyIntake: {
      notice: MEMBER_SAFETY_NOTICE,
      noticeVersion,
      status: "not_submitted",
      safetyStop: null,
      readiness: { status: "SETUP_REQUIRED", nextAction: "COMPLETE_SAFETY_SETUP" },
      activationPermitted: false,
      externalCallsPermitted: false,
    },
  });
  assert.equal(empty.response.headers.get("cache-control"), "no-store");

  await disposable.pool.query(
    "UPDATE goals_coach_member_auth_mappings SET active = FALSE WHERE id = $1",
    [mappings[0].id]
  );
  const inactive = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001"
  );
  assert.equal(inactive.response.status, 401);
  assert.equal(inactive.body.error, "MEMBER_AUTHENTICATION_REQUIRED");
  assertPrivacyMinimized(inactive.body, "revoked-mapping 401 response");
  assert.equal(providerCalls() > 0, true);
});

test("safety intake accepts only the five required strict booleans and approved envelope", async (t) => {
  const { running } = await fixture(t);
  const invalidBodies = [
    {},
    submission(10, {}, { memberId: "1" }),
    submission(11, {}, { authMappingId: "1" }),
    submission(12, {}, { planId: "1" }),
    submission(13, {}, { ownerId: "1" }),
    submission(14, {}, { providerId: "1" }),
    submission(15, {}, { actorId: "1" }),
    submission(16, {}, { clientRequestId: "NOT-A-UUID" }),
    submission(17, {}, { noticeVersion: "unapproved-version" }),
    submission(18, {}, {
      answers: {
        ...answers(),
        currentPainOrConcerningSymptoms: "false",
      },
    }),
    submission(19, {}, {
      answers: {
        currentPainOrConcerningSymptoms: false,
        currentInjuryConcern: false,
        recentSurgery: false,
        medicalOrExerciseRestriction: false,
      },
    }),
    submission(20, {}, {
      answers: { ...answers(), freeText: "private health narrative" },
    }),
  ];
  for (const body of invalidBodies) {
    const response = await memberRequest(
      running,
      "/safety-intake",
      "gymmaster:30001",
      { method: "POST", body }
    );
    assert.equal(response.response.status, 400);
    assert.match(response.body.error, /^SAFETY_INTAKE_/);
    assertPrivacyMinimized(response.body, "400 response");
  }

  const query = await memberRequest(
    running,
    "/safety-intake?memberId=1",
    "gymmaster:30001"
  );
  assert.equal(query.response.status, 400);
  assert.equal(query.body.error, "SAFETY_INTAKE_INVALID");
  assertPrivacyMinimized(query.body, "query 400 response");

  const wrongMedia = await fetch(
    `${running.url}/goalscoach/member/safety-intake`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie("gymmaster:30001"),
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(submission(21)),
    }
  );
  assert.equal(wrongMedia.status, 415);
  const wrongMediaBody = await wrongMedia.json();
  assert.equal(wrongMediaBody.error, "SAFETY_INTAKE_MEDIA_TYPE_UNSUPPORTED");
  assertPrivacyMinimized(wrongMediaBody, "415 response");
});

test("safety intake is idempotent and its effective stop is monotonic across all rows", async (t) => {
  const {
    disposable,
    providerCalls,
    running,
  } = await fixture(t);
  const protectedBefore = await protectedTableCounts(disposable.pool);

  const negativeBody = submission(30);
  const negative = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001",
    { method: "POST", body: negativeBody }
  );
  assert.equal(negative.response.status, 201);
  assert.deepEqual(negative.body, {
    safetyIntake: {
      notice: MEMBER_SAFETY_NOTICE,
      noticeVersion,
      status: "screen_complete",
      safetyStop: false,
      readiness: { status: "COACHING_UNAVAILABLE", nextAction: "CHECK_BACK_LATER" },
      activationPermitted: false,
      externalCallsPermitted: false,
    },
    idempotentReplay: false,
  });
  assertPrivacyMinimized(negative.body, "screen-complete POST response");

  const reorderedReplay = {
    answers: {
      otherTrainingSafetyConcern: false,
      medicalOrExerciseRestriction: false,
      recentSurgery: false,
      currentInjuryConcern: false,
      currentPainOrConcerningSymptoms: false,
    },
    noticeVersion,
    clientRequestId: negativeBody.clientRequestId,
  };
  const replay = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001",
    { method: "POST", body: reorderedReplay }
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.safetyIntake.status, "screen_complete");
  assertPrivacyMinimized(replay.body, "idempotent POST response");

  const conflict = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001",
    {
      method: "POST",
      body: submission(
        31,
        { currentInjuryConcern: true },
        { clientRequestId: negativeBody.clientRequestId }
      ),
    }
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error, "SAFETY_INTAKE_IDEMPOTENCY_CONFLICT");

  const positive = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001",
    {
      method: "POST",
      body: submission(32, { currentPainOrConcerningSymptoms: true }),
    }
  );
  assert.equal(positive.response.status, 201);
  assert.equal(positive.body.safetyIntake.status, "handoff_required");
  assert.equal(positive.body.safetyIntake.safetyStop, true);
  assertPrivacyMinimized(positive.body, "handoff POST response");

  const laterNegative = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001",
    { method: "POST", body: submission(33) }
  );
  assert.equal(laterNegative.response.status, 201);
  assert.equal(laterNegative.body.safetyIntake.status, "handoff_required");
  assert.equal(laterNegative.body.safetyIntake.safetyStop, true);
  assertPrivacyMinimized(laterNegative.body, "monotonic-handoff POST response");

  const replayAfterStop = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001",
    { method: "POST", body: negativeBody }
  );
  assert.equal(replayAfterStop.response.status, 200);
  assert.equal(replayAfterStop.body.idempotentReplay, true);
  assert.equal(replayAfterStop.body.safetyIntake.status, "handoff_required");
  assertPrivacyMinimized(replayAfterStop.body, "handoff replay POST response");

  const effective = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001"
  );
  assert.deepEqual(effective.body, {
    safetyIntake: {
      notice: MEMBER_SAFETY_NOTICE,
      noticeVersion,
      status: "handoff_required",
      safetyStop: true,
      readiness: {
        status: "SAFETY_HANDOFF_REQUIRED",
        nextAction: "SAFETY_HANDOFF_REQUIRED",
        message: "Goals Coach cannot continue. No person has been notified; seek appropriate medical guidance before exercise.",
      },
      activationPermitted: false,
      externalCallsPermitted: false,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(effective.body),
    /submissionHistory|requestHash|clientRequestId|mappingId|memberId|planAvailable|planReady|planGeneration|medicalClearance/i
  );

  const otherMember = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30002"
  );
  assert.equal(otherMember.body.safetyIntake.status, "not_submitted");
  assert.equal(otherMember.body.safetyIntake.safetyStop, null);

  const rows = await disposable.pool.query(
    `SELECT outcome, safety_stop
     FROM goals_coach_member_safety_intake_submissions
     WHERE member_id = $1
     ORDER BY id`,
    [(await disposable.pool.query(
      "SELECT member_id FROM goals_coach_member_auth_mappings WHERE auth_subject = 'gymmaster:30001'"
    )).rows[0].member_id]
  );
  assert.deepEqual(
    rows.rows.map((row) => [row.outcome, row.safety_stop]),
    [
      ["screen_complete", false],
      ["handoff_required", true],
      ["screen_complete", false],
    ]
  );
  assert.deepEqual(await protectedTableCounts(disposable.pool), protectedBefore);
  assert.equal(providerCalls() > 0, true);
});

test("current notice completion is required while historical safety stops remain monotonic", async (t) => {
  const { disposable, mappings, running } = await fixture(t);
  await insertHistoricalSubmission(disposable.pool, mappings[0], {
    clientRequestId: requestId(340),
    requestHash: "a".repeat(64),
  });
  const oldAllClear = await memberRequest(running, "/safety-intake", "gymmaster:30001");
  assert.equal(oldAllClear.response.status, 200);
  assert.equal(oldAllClear.body.safetyIntake.status, "not_submitted");
  assert.equal(oldAllClear.body.safetyIntake.safetyStop, null);
  assert.deepEqual(oldAllClear.body.safetyIntake.readiness, {
    status: "SETUP_REQUIRED",
    nextAction: "COMPLETE_SAFETY_SETUP",
  });

  const currentAllClear = await memberRequest(running, "/safety-intake", "gymmaster:30001", {
    method: "POST",
    body: submission(341),
  });
  assert.equal(currentAllClear.response.status, 201);
  assert.equal(currentAllClear.body.safetyIntake.status, "screen_complete");
  assert.equal(currentAllClear.body.safetyIntake.safetyStop, false);

  await insertHistoricalSubmission(disposable.pool, mappings[1], {
    clientRequestId: requestId(342),
    requestHash: "b".repeat(64),
    safetyStop: true,
  });
  const oldStop = await memberRequest(running, "/safety-intake", "gymmaster:30002");
  assert.equal(oldStop.response.status, 200);
  assert.equal(oldStop.body.safetyIntake.status, "handoff_required");
  assert.equal(oldStop.body.safetyIntake.safetyStop, true);

  const currentAfterStop = await memberRequest(running, "/safety-intake", "gymmaster:30002", {
    method: "POST",
    body: submission(343),
  });
  assert.equal(currentAfterStop.response.status, 201);
  assert.equal(currentAfterStop.body.safetyIntake.status, "handoff_required");
  assert.equal(currentAfterStop.body.safetyIntake.safetyStop, true);
});

test("every individual positive answer records a fixed handoff-required safety stop", async (t) => {
  const { disposable, first, running } = await fixture(t);
  const fields = [
    "currentPainOrConcerningSymptoms",
    "currentInjuryConcern",
    "recentSurgery",
    "medicalOrExerciseRestriction",
    "otherTrainingSafetyConcern",
  ];
  for (let index = 0; index < fields.length; index += 1) {
    const response = await memberRequest(
      running,
      "/safety-intake",
      "gymmaster:30001",
      {
        method: "POST",
        body: submission(40 + index, { [fields[index]]: true }),
      }
    );
    assert.equal(response.response.status, 201);
    assert.equal(response.body.safetyIntake.status, "handoff_required");
    assert.equal(response.body.safetyIntake.safetyStop, true);
  }
  const rows = await disposable.pool.query(
    `SELECT outcome, safety_stop
     FROM goals_coach_member_safety_intake_submissions
     WHERE member_id = $1
     ORDER BY id`,
    [first.member.id]
  );
  assert.equal(rows.rows.length, fields.length);
  assert.equal(
    rows.rows.every((row) => (
      row.outcome === "handoff_required" && row.safety_stop === true
    )),
    true
  );
});

test("safety intake uses bounded JSON, fixed parser errors, and mutation rate limiting", async (t) => {
  let mutationLimitCalls = 0;
  const { running } = await fixture(t, {
    rateLimits: {
      read: (_req, _res, next) => next(),
      mutation: (_req, res) => {
        mutationLimitCalls += 1;
        return res.status(429).json({ error: "RATE_LIMITED" });
      },
    },
  });
  const limited = await memberRequest(
    running,
    "/safety-intake",
    "gymmaster:30001",
    { method: "POST", body: submission(50) }
  );
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, "RATE_LIMITED");
  assertPrivacyMinimized(limited.body, "429 response");
  assert.equal(mutationLimitCalls, 1);

  const malformed = await fetch(
    `${running.url}/goalscoach/member/safety-intake`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie("gymmaster:30001"),
        "Content-Type": "application/json",
      },
      body: '{"clientRequestId":',
    }
  );
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.deepEqual(malformedBody, {
    error: "SAFETY_INTAKE_INVALID",
    message: "Invalid safety intake request.",
  });
  assertPrivacyMinimized(malformedBody, "malformed 400 response");
  assert.equal(malformed.headers.get("cache-control"), "no-store");

  const oversized = await fetch(
    `${running.url}/goalscoach/member/safety-intake`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie("gymmaster:30001"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...submission(51),
        forbiddenPadding: "x".repeat(MAXIMUM_SAFETY_INTAKE_JSON_BYTES),
      }),
    }
  );
  assert.equal(oversized.status, 413);
  const oversizedBody = await oversized.json();
  assert.deepEqual(oversizedBody, {
    error: "SAFETY_INTAKE_BODY_TOO_LARGE",
    message: "The safety intake request is too large.",
  });
  assertPrivacyMinimized(oversizedBody, "413 response");
  assert.equal(oversized.headers.get("cache-control"), "no-store");
});

test("safety intake OPTIONS is exact-origin credentialed and isolated to its exact route", async (t) => {
  const { running } = await fixture(t);
  const preflight = await fetch(`${running.url}/goalscoach/member/safety-intake`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  const unrelated = await fetch(`${running.url}/goalscoach/member/unrelated`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(unrelated.status, 404);
  assert.equal(unrelated.headers.get("access-control-allow-origin"), null);
});

test("authenticated Gatekeeper dependency failure returns only the minimized 503", async (t) => {
  const { running } = await fixture(t, {
    fetchImpl: async () => { throw new Error("synthetic dependency failure"); },
  });
  const result = await memberRequest(running, "/safety-intake", "gymmaster:30001");
  assert.equal(result.response.status, 503);
  assert.deepEqual(result.body, {
    error: "MEMBER_ACCESS_TEMPORARILY_UNAVAILABLE",
    message: "We can’t verify your access right now. Please try again later.",
    nextAction: "TRY_AGAIN_LATER",
  });
  assertPrivacyMinimized(result.body, "503 response");
});

test("current inactive Gatekeeper membership conceals both safety-intake read and submission", async (t) => {
  let gatekeeperCalls = 0;
  const { disposable, first, running } = await fixture(t, {
    fetchImpl: async (url) => {
      gatekeeperCalls += 1;
      const memberId = Number(new URL(url).searchParams.get("memberid"));
      return {
        ok: true,
        json: async () => ({ members: [{
          memberid: memberId,
          stopatgate: true,
          membership: [{ expired: false }],
        }] }),
      };
    },
  });
  const read = await memberRequest(running, "/safety-intake", "gymmaster:30001");
  const write = await memberRequest(running, "/safety-intake", "gymmaster:30001", {
    method: "POST",
    body: submission(70, { currentInjuryConcern: true }),
  });
  for (const [label, response] of [["inactive GET", read], ["inactive POST", write]]) {
    assert.equal(response.response.status, 401, label);
    assert.deepEqual(response.body, { error: "MEMBER_AUTHENTICATION_REQUIRED" }, label);
    assertPrivacyMinimized(response.body, label);
  }
  assert.equal(gatekeeperCalls, 2);
  const stored = await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_member_safety_intake_submissions WHERE member_id = $1",
    [first.member.id]
  );
  assert.equal(stored.rows[0].count, 0);
});

test("production mutation limiter is session scoped and precedes mapping and Gatekeeper work", async (t) => {
  const {
    databaseCalls,
    providerCalls,
    running,
  } = await fixture(t, { useProductionRateLimits: true });

  for (let index = 0; index < 12; index += 1) {
    const invalidSession = await jsonRequest(
      running.url,
      "/goalscoach/member/safety-intake",
      { method: "POST", headers: { Origin: origin }, body: submission(100 + index) }
    );
    assert.equal(invalidSession.response.status, 401);
  }

  for (let index = 0; index < 10; index += 1) {
    const allowed = await memberRequest(running, "/safety-intake", "gymmaster:30001", {
      method: "POST",
      body: submission(200 + index),
    });
    assert.equal(allowed.response.status, 201, `member one request ${index + 1}`);
  }
  const callsAtLimit = {
    database: databaseCalls(),
    provider: providerCalls(),
  };
  const limited = await memberRequest(running, "/safety-intake", "gymmaster:30001", {
    method: "POST",
    body: submission(210),
  });
  assert.equal(limited.response.status, 429);
  assert.deepEqual(limited.body, { error: "RATE_LIMITED" });
  assertPrivacyMinimized(limited.body, "production 429 response");
  assert.deepEqual(
    { database: databaseCalls(), provider: providerCalls() },
    callsAtLimit,
    "limited request must stop before local mapping, transaction, and Gatekeeper work"
  );

  const otherMember = await memberRequest(running, "/safety-intake", "gymmaster:30002", {
    method: "POST",
    body: submission(211),
  });
  assert.equal(otherMember.response.status, 201);
  assert.equal(otherMember.body.safetyIntake.status, "screen_complete");
  assertPrivacyMinimized(otherMember.body, "other-member POST response");
  assert.equal(providerCalls(), callsAtLimit.provider + 1);
  assert.equal(databaseCalls() > callsAtLimit.database, true);

  const callsAfterOtherMember = {
    database: databaseCalls(),
    provider: providerCalls(),
  };
  const stillLimited = await memberRequest(running, "/safety-intake", "gymmaster:30001", {
    method: "POST",
    body: submission(212),
  });
  assert.equal(stillLimited.response.status, 429);
  assert.deepEqual(stillLimited.body, { error: "RATE_LIMITED" });
  assertPrivacyMinimized(stillLimited.body, "still-limited production 429 response");
  assert.deepEqual(
    { database: databaseCalls(), provider: providerCalls() },
    callsAfterOtherMember,
    "another member's request must not reset the exhausted member quota"
  );
});
