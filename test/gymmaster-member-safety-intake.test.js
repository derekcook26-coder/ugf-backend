"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const {
  ANSWER_FIELDS, MEMBER_SAFETY_INTAKE_FLAG, MEMBER_SAFETY_NOTICE_VERSION,
  memberSafetyIntakeEnabled, parseSafetyIntake, safetyIntakeRequestHash,
} = require("../src/goals-coach/gymmaster-member-safety-intake");
const { createGymMasterMemberSafetyIntakeStartup } = require("../src/goals-coach/gymmaster-member-safety-intake-startup");
const { composeGymMasterMemberSafetyIntakeRoutes } = require("../src/goals-coach/gymmaster-member-safety-intake-route-composition");
const { buildGymMasterSessionCookie, createGymMasterMemberSessionService } = require("../src/goals-coach/gymmaster-member-session");
const { createApplicationJsonParser } = require("../src/goals-coach/transcription-route");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");
const { runMigration: migrate009 } = require("../migrate_009");
const { runMigration: migrate010 } = require("../migrate_010");
const { runMigration: migrate011 } = require("../migrate_011");
const { runMigration: migrate012 } = require("../migrate_012");
const { runMigration: migrate013 } = require("../migrate_013");
const { runMigration: migrate014 } = require("../migrate_014");
const { runMigration: migrate015 } = require("../migrate_015");
const { runMigration: migrate016 } = require("../migrate_016");
const { jsonRequest, startApp } = require("./helpers/http-app");

const origin = "https://ultimategoalsfitness.com";
const secret = "s".repeat(32);
const hashKey = "h".repeat(32);
const forbidden = /email|name|gymmaster.?id|member.?id|mapping.?id|auth.?subject|client.?request|request.?hash|urgentwarningsigns|painorstiffness|recentsurgery|neurological|notified|diagnos|clearance/i;
const noLimits = { read: (_q, _s, n) => n(), mutation: (_q, _s, n) => n() };

function answers(overrides = {}) {
  return Object.assign({
    urgentWarningSigns: false,
    painOrStiffness: false,
    painSeverity: null,
    injuryOrInstability: false,
    recentSurgery: false,
    surgeryCleared: null,
    medicalOrExerciseRestriction: false,
    restrictionAllowsSafeExercise: null,
    neurologicalSymptoms: false,
    otherUnsafeConcern: false,
  }, overrides);
}
function body(number, overrides = {}, envelope = {}) {
  return { clientRequestId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, noticeVersion: MEMBER_SAFETY_NOTICE_VERSION, answers: answers(overrides), ...envelope };
}
function urgentAnswers() {
  const value = Object.fromEntries(ANSWER_FIELDS.map((field) => [field, null]));
  value.urgentWarningSigns = true;
  return value;
}
function environment(overrides = {}) {
  return {
    GOALS_COACH_MEMBER_LOGIN_ENABLED: "true", GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin,
    GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL: "https://ugf.gymmasteronline.com/portal/api/v1/login",
    GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
    GOALS_COACH_GYMMASTER_MEMBER_API_KEY: "unused", GYMMASTER_API_KEY: "test", GYMMASTER_SITE: "ugf",
    GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: secret, [MEMBER_SAFETY_INTAKE_FLAG]: "true",
    GOALS_COACH_MEMBER_SAFETY_HASH_CURRENT_VERSION: "key-1",
    GOALS_COACH_MEMBER_SAFETY_HASH_KEYS_JSON: JSON.stringify({ "key-1": hashKey }), ...overrides,
  };
}
function cookie(subject) {
  const token = createGymMasterMemberSessionService({ secret }).issue({ authProvider: "gymmaster", authSubject: subject, expiresInSeconds: 900 });
  return buildGymMasterSessionCookie(token).split(";")[0];
}
async function fixture(t, options = {}) {
  const disposable = await createDisposableDatabase({ ownerEditableWorkoutSessions: true });
  t.after(() => disposable.close());
  await migrate009({ pool: disposable.pool });
  await migrate010({ pool: disposable.pool });
  await migrate011({ pool: disposable.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } });
  await migrate012({ pool: disposable.pool });
  await migrate013({ pool: disposable.pool });
  await migrate014({ pool: disposable.pool });
  await migrate015({ pool: disposable.pool });
  await migrate016({ pool: disposable.pool });
  const members = [];
  for (const [suffix, subject] of [["one", "gymmaster:30001"], ["two", "gymmaster:30002"]]) {
    const seeded = await seedMemberAndPlan(disposable.pool, `safety-v2-${suffix}`);
    const mapping = (await disposable.pool.query(`INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot, active, provisioning_method, provisioning_reference)
      VALUES ($1, 'gymmaster', $2, 'synthetic@example.test', TRUE, 'owner_approved_script', 'safety-v2-test') RETURNING *`, [seeded.member.id, subject])).rows[0];
    members.push({ seeded, mapping, subject });
  }
  let providerCalls = 0;
  const app = express();
  app.use(createApplicationJsonParser());
  const startup = createGymMasterMemberSafetyIntakeStartup({
    environment: environment(options.environment), db: disposable.pool,
    fetchImpl: options.fetchImpl || (async (url) => { providerCalls += 1; return { ok: true, async json() { return { members: [{ memberid: Number(new URL(url).searchParams.get("memberid")), stopatgate: false, membership: [{ expired: false }] }] }; } }; }),
    ...(options.productionRateLimits ? {} : { rateLimits: options.rateLimits || noLimits }),
  });
  composeGymMasterMemberSafetyIntakeRoutes(app, startup);
  app.use(goalsCoachErrorHandler);
  const running = await startApp(app); t.after(() => running.close());
  return { disposable, members, running, providerCalls: () => providerCalls };
}
function request(running, subject, options = {}) {
  return jsonRequest(running.url, "/goalscoach/member/safety-intake", { ...options, headers: { Origin: origin, Cookie: cookie(subject), ...(options.headers || {}) } });
}
function assertPrivate(value) { assert.doesNotMatch(JSON.stringify(value), forbidden); }
async function protectedCounts(pool) {
  return (await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM coach_plans) plans,
    (SELECT COUNT(*)::int FROM coaching_conversations) conversations,
    (SELECT COUNT(*)::int FROM coaching_concerns) concerns,
    (SELECT COUNT(*)::int FROM coaching_reviews) reviews,
    (SELECT COUNT(*)::int FROM goals_coach_tracked_workout_sessions) workouts`)).rows[0];
}
function assertPublic(result, status) {
  assert.deepEqual(Object.keys(result).sort(), ["activationPermitted", "externalCallsPermitted", "message", "nextAction", "status", "validUntil"]);
  assert.equal(result.status, status); assert.equal(result.activationPermitted, false); assert.equal(result.externalCallsPermitted, false); assertPrivate(result);
}

test("safety intake remains exact-disabled without startup database or provider work", async (t) => {
  assert.equal(memberSafetyIntakeEnabled("true"), true);
  for (const value of [undefined, true, "True", " true", "true "]) assert.equal(memberSafetyIntakeEnabled(value), false);
  let calls = 0;
  const app = express();
  const startup = createGymMasterMemberSafetyIntakeStartup({ environment: environment({ [MEMBER_SAFETY_INTAKE_FLAG]: undefined }), db: { query() { calls += 1; }, connect() { calls += 1; } }, fetchImpl: async () => { calls += 1; } });
  composeGymMasterMemberSafetyIntakeRoutes(app, startup);
  const running = await startApp(app); t.after(() => running.close());
  assert.equal((await jsonRequest(running.url, "/goalscoach/member/safety-intake")).response.status, 404);
  assert.equal(calls, 0);
});

test("enabled safety intake fails closed when keyed provenance configuration is missing or invalid", () => {
  const db = { async query() { throw new Error("database must not be used during startup validation"); }, async connect() { throw new Error("database must not be used during startup validation"); } };
  const fetchImpl = async () => { throw new Error("provider must not be used during startup validation"); };
  for (const overrides of [
    { GOALS_COACH_MEMBER_SAFETY_HASH_CURRENT_VERSION: undefined, GOALS_COACH_MEMBER_SAFETY_HASH_KEYS_JSON: undefined },
    { GOALS_COACH_MEMBER_SAFETY_HASH_CURRENT_VERSION: "key-1", GOALS_COACH_MEMBER_SAFETY_HASH_KEYS_JSON: "{}" },
    { GOALS_COACH_MEMBER_SAFETY_HASH_CURRENT_VERSION: "key-1", GOALS_COACH_MEMBER_SAFETY_HASH_KEYS_JSON: JSON.stringify({ "key-1": "short" }) },
  ]) {
    const startup = createGymMasterMemberSafetyIntakeStartup({ environment: environment(overrides), db, fetchImpl });
    assert.equal(startup.status, "not_ready");
    assert.equal(startup.router, null);
    assert.equal(startup.activationPermitted, false);
    assert.equal(startup.externalCallsPermitted, false);
  }
});

test("v2 request is strict, complete, canonical, and rejects contradictions", () => {
  const parsed = parseSafetyIntake(body(1), MEMBER_SAFETY_NOTICE_VERSION);
  const hash = safetyIntakeRequestHash(parsed, hashKey); assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(safetyIntakeRequestHash(parseSafetyIntake(body(2), MEMBER_SAFETY_NOTICE_VERSION), hashKey), hash);
  const validChanges = {
    urgentWarningSigns: true,
    painOrStiffness: true,
    painSeverity: 3,
    injuryOrInstability: true,
    recentSurgery: true,
    surgeryCleared: false,
    medicalOrExerciseRestriction: true,
    restrictionAllowsSafeExercise: false,
    neurologicalSymptoms: true,
    otherUnsafeConcern: true,
  };
  for (const field of ANSWER_FIELDS) {
    const changed = body(3, { [field]: validChanges[field] });
    if (field === "painSeverity") {
      Object.assign(changed.answers, { painOrStiffness: true, painSeverity: 3 });
      changed.answers[field] = validChanges[field];
    }
    if (field === "surgeryCleared") changed.answers.recentSurgery = true;
    if (field === "restrictionAllowsSafeExercise") changed.answers.medicalOrExerciseRestriction = true;
    assert.notEqual(safetyIntakeRequestHash(parseSafetyIntake(changed, MEMBER_SAFETY_NOTICE_VERSION), hashKey), hash);
  }
  const incomplete = body(4); delete incomplete.answers.painSeverity;
  assert.throws(() => parseSafetyIntake(incomplete, MEMBER_SAFETY_NOTICE_VERSION), /Invalid safety intake answers/);
  assert.throws(() => parseSafetyIntake(body(5, {}, { extra: true }), MEMBER_SAFETY_NOTICE_VERSION), /Invalid safety intake request/);
});

test("route preserves CORS, authentication, active ownership, isolation, and headers", async (t) => {
  const { disposable, members, running, providerCalls } = await fixture(t);
  const wrong = await jsonRequest(running.url, "/goalscoach/member/safety-intake", { headers: { Origin: "https://wrong.test", Cookie: cookie(members[0].subject) } });
  assert.equal(wrong.response.status, 403); assertPrivate(wrong.body);
  const missing = await jsonRequest(running.url, "/goalscoach/member/safety-intake", { headers: { Origin: origin } });
  assert.equal(missing.response.status, 401); assertPrivate(missing.body);
  const callsBeforeForgery = providerCalls();
  const forged = await jsonRequest(running.url, "/goalscoach/member/safety-intake", {
    headers: { Origin: origin, Cookie: "gc_member_session=forged" },
  });
  assert.equal(forged.response.status, 401);
  assert.deepEqual(forged.body, { error: "MEMBER_AUTHENTICATION_REQUIRED" });
  assert.equal(forged.response.headers.get("cache-control"), "no-store");
  assert.equal(forged.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(providerCalls(), callsBeforeForgery);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_safety_intake_v2_assessments")).rows[0].count, 0);
  const empty = await request(running, members[0].subject); assert.equal(empty.response.status, 200); assertPublic(empty.body.safetyIntake, "not_submitted");
  assert.equal(empty.response.headers.get("cache-control"), "no-store"); assert.equal(empty.response.headers.get("x-content-type-options"), "nosniff");
  assertPublic((await request(running, members[1].subject)).body.safetyIntake, "not_submitted");
  await disposable.pool.query("UPDATE goals_coach_member_auth_mappings SET active = FALSE WHERE id = $1", [members[0].mapping.id]);
  assert.equal((await request(running, members[0].subject)).response.status, 401);
});

test("route returns all four outcomes, rejects incomplete and contradictory input, and leaks no answers", async (t) => {
  const { disposable, running, members } = await fixture(t); const subject = members[0].subject;
  const before = await protectedCounts(disposable.pool);
  const cases = [
    [10, {}, "SCREEN_COMPLETE"],
    [11, { painOrStiffness: true, painSeverity: 3 }, "MODIFICATION_REQUIRED"],
    [12, { painOrStiffness: true, painSeverity: 8 }, "MEDICAL_REVIEW_REQUIRED"],
    [13, urgentAnswers(), "URGENT_STOP"],
    [16, { recentSurgery: true, surgeryCleared: true }, "MODIFICATION_REQUIRED"],
    [17, { medicalOrExerciseRestriction: true, restrictionAllowsSafeExercise: true }, "MODIFICATION_REQUIRED"],
  ];
  for (const [number, overrides, outcome] of cases) {
    const requestBody = number === 13
      ? { clientRequestId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, noticeVersion: MEMBER_SAFETY_NOTICE_VERSION, answers: overrides }
      : body(number, overrides);
    const result = await request(running, subject, { method: "POST", body: requestBody });
    assert.equal(result.response.status, 201); assertPublic(result.body.safetyIntake, outcome); assert.equal(result.body.idempotentReplay, false);
  }
  const incomplete = body(14); delete incomplete.answers.painSeverity;
  assert.equal((await request(running, subject, { method: "POST", body: incomplete })).response.status, 400);
  assert.equal((await request(running, subject, { method: "POST", body: body(15, { painOrStiffness: false, painSeverity: 3 }) })).response.status, 400);
  assert.deepEqual(await protectedCounts(disposable.pool), before);
});

test("latest unexpired v2 governs, v1 stop is retained, rows are append-only, and replay is idempotent", async (t) => {
  const { disposable, members, running } = await fixture(t); const { mapping, subject } = members[0];
  await disposable.pool.query(`INSERT INTO goals_coach_member_safety_intake_submissions
    (auth_mapping_id, member_id, client_request_id, client_request_hash, notice_version,
     current_pain_or_concerning_symptoms, current_injury_concern, recent_surgery,
     medical_or_exercise_restriction, other_training_safety_concern, outcome, safety_stop, rule_version)
    VALUES ($1,$2,'00000000-0000-4000-8000-000000000100',$3,'GC-MEMBER-SAFETY-NOTICE-1',TRUE,FALSE,FALSE,FALSE,FALSE,'handoff_required',TRUE,'GC-MEMBER-SAFETY-INTAKE-1')`, [mapping.id, mapping.member_id, "a".repeat(64)]);
  assertPublic((await request(running, subject)).body.safetyIntake, "not_submitted");
  const original = body(101, { painOrStiffness: true, painSeverity: 3 });
  const first = await request(running, subject, { method: "POST", body: original }); assertPublic(first.body.safetyIntake, "MODIFICATION_REQUIRED");
  const replay = await request(running, subject, { method: "POST", body: original }); assert.equal(replay.response.status, 200); assert.equal(replay.body.idempotentReplay, true);
  assert.equal((await request(running, subject, { method: "POST", body: body(999, { painOrStiffness: true, painSeverity: 4 }, { clientRequestId: original.clientRequestId }) })).response.status, 409);
  const safe = await request(running, subject, { method: "POST", body: body(102) }); assertPublic(safe.body.safetyIntake, "SCREEN_COMPLETE");
  const rows = (await disposable.pool.query("SELECT id FROM goals_coach_member_safety_intake_v2_assessments WHERE member_id=$1 ORDER BY id", [mapping.member_id])).rows;
  assert.equal(rows.length, 2);
  await assert.rejects(disposable.pool.query("UPDATE goals_coach_member_safety_intake_v2_assessments SET outcome='URGENT_STOP' WHERE id=$1", [rows[0].id]), /append-only/);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_safety_intake_submissions WHERE member_id=$1 AND safety_stop=TRUE", [mapping.member_id])).rows[0].count, 1);
});

test("expired v2 requires a fresh check and rate limiting runs after authentication", async (t) => {
  const { disposable, members, running } = await fixture(t); const { mapping, subject } = members[0];
  await disposable.pool.query(`INSERT INTO goals_coach_member_safety_intake_v2_assessments
    (auth_mapping_id,member_id,client_request_id,client_request_hash,notice_version,
     outcome,rule_version,submitted_at,valid_until)
    VALUES ($1,$2,'00000000-0000-4000-8000-000000000110',$3,
      'GC-MEMBER-SAFETY-NOTICE-2','SCREEN_COMPLETE','GC-MEMBER-SAFETY-INTAKE-2',
      NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour')`,
  [mapping.id, mapping.member_id, "d".repeat(64)]);
  assertPublic((await request(running, subject)).body.safetyIntake, "not_submitted");
  let limited = 0;
  const limitedFixture = await fixture(t, { rateLimits: { read: noLimits.read, mutation: (_q, res) => { limited += 1; res.status(429).json({ error: "RATE_LIMITED" }); } } });
  assert.equal((await request(limitedFixture.running, limitedFixture.members[0].subject, { method: "POST", body: body(111) })).response.status, 429); assert.equal(limited, 1);
});

test("dependency failure stays fail-closed and exact-origin preflight stays isolated", async (t) => {
  const { running, members } = await fixture(t, { fetchImpl: async () => { throw new Error("synthetic dependency failure"); } });
  const preflight = await fetch(`${running.url}/goalscoach/member/safety-intake`, {
    method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  const response = await request(running, members[0].subject);
  assert.equal(response.response.status, 503); assert.equal(response.body.error, "MEMBER_ACCESS_TEMPORARILY_UNAVAILABLE"); assertPrivate(response.body);
  assert.equal((await jsonRequest(running.url, "/goalscoach/member/safety-intake/other", { headers: { Origin: origin } })).response.status, 404);
});

test("malformed, oversized, media-type, and query failures use concealed no-store responses", async (t) => {
  const { running, members } = await fixture(t); const headers = { Origin: origin, Cookie: cookie(members[0].subject) };
  const cases = [
    await fetch(`${running.url}/goalscoach/member/safety-intake`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{" }),
    await fetch(`${running.url}/goalscoach/member/safety-intake`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(5000) }) }),
    await fetch(`${running.url}/goalscoach/member/safety-intake`, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "unsafe" }),
  ];
  assert.deepEqual(cases.map((response) => response.status), [400, 413, 415]);
  const expectedBodies = [
    { error: "SAFETY_INTAKE_INVALID", message: "Invalid safety intake request." },
    { error: "SAFETY_INTAKE_BODY_TOO_LARGE", message: "The safety intake request is too large." },
    { error: "SAFETY_INTAKE_MEDIA_TYPE_UNSUPPORTED", message: "Safety intake requires application/json." },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const response = cases[index];
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const responseBody = await response.json();
    assert.deepEqual(responseBody, expectedBodies[index]); assertPrivate(responseBody);
  }
  const invalidQuery = await jsonRequest(running.url, "/goalscoach/member/safety-intake?memberId=1", { headers });
  assert.equal(invalidQuery.response.status, 400);
  assert.deepEqual(invalidQuery.body, { error: "SAFETY_INTAKE_INVALID", message: "Invalid safety intake query." });
  assert.equal(invalidQuery.response.headers.get("cache-control"), "no-store");
  assert.equal(invalidQuery.response.headers.get("x-content-type-options"), "nosniff");
  assertPrivate(invalidQuery.body);
});

test("inactive Gatekeeper membership is concealed before persistence", async (t) => {
  const { disposable, members, running } = await fixture(t, { fetchImpl: async () => ({ ok: true, async json() { return { members: [{ memberid: 30001, stopatgate: true, membership: [{ expired: true }] }] }; } }) });
  assert.equal((await request(running, members[0].subject)).response.status, 401);
  assert.equal((await request(running, members[0].subject, { method: "POST", body: body(300) })).response.status, 401);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_safety_intake_v2_assessments")).rows[0].count, 0);
});

test("production limiter is member-scoped and short-circuits before Gatekeeper and persistence", async (t) => {
  const { disposable, members, running, providerCalls } = await fixture(t, { productionRateLimits: true });
  for (let index = 0; index < 10; index += 1) assert.equal((await request(running, members[0].subject, { method: "POST", body: body(400 + index) })).response.status, 201);
  const calls = providerCalls();
  assert.equal((await request(running, members[0].subject, { method: "POST", body: body(410) })).response.status, 429);
  assert.equal(providerCalls(), calls);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_safety_intake_v2_assessments WHERE member_id=$1", [members[0].mapping.member_id])).rows[0].count, 10);
  assert.equal((await request(running, members[1].subject, { method: "POST", body: body(411) })).response.status, 201);
});
