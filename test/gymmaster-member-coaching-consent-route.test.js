"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const { createApplicationJsonParser } = require("../src/goals-coach/transcription-route");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const { createGymMasterMemberCoachingConsentStartup } = require("../src/goals-coach/gymmaster-member-coaching-consent-startup");
const { composeGymMasterMemberCoachingConsentRoutes } = require("../src/goals-coach/gymmaster-member-coaching-consent-route-composition");
const { MEMBER_COACHING_CONSENT_FLAG, MEMBER_COACHING_CONSENT_NOTICE_VERSION } = require("../src/goals-coach/gymmaster-member-coaching-consent");
const { buildGymMasterSessionCookie, createGymMasterMemberSessionService } = require("../src/goals-coach/gymmaster-member-session");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");
const { runMigration: migrate009 } = require("../migrate_009");
const { runMigration: migrate010 } = require("../migrate_010");
const { runMigration: migrate011 } = require("../migrate_011");
const { runMigration: migrate012 } = require("../migrate_012");
const { runMigration: migrate013 } = require("../migrate_013");

const origin = "https://ultimategoalsfitness.com"; const secret = "c".repeat(32);
const noLimits = { read: (_q, _s, next) => next(), mutation: (_q, _s, next) => next() };
const forbidden = /email|member.?id|mapping.?id|auth.?subject|request.?hash|gymmaster:|provision/i;
function environment(overrides = {}) { return { GOALS_COACH_MEMBER_LOGIN_ORIGIN: origin, GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members", GYMMASTER_API_KEY: "synthetic", GYMMASTER_SITE: "ugf", GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET: secret, [MEMBER_COACHING_CONSENT_FLAG]: "true", ...overrides }; }
function cookie(subject) { const token = createGymMasterMemberSessionService({ secret }).issue({ authProvider: "gymmaster", authSubject: subject, expiresInSeconds: 900 }); return buildGymMasterSessionCookie(token).split(";")[0]; }
function body(number, action = "accept", version = MEMBER_COACHING_CONSENT_NOTICE_VERSION) { return { clientRequestId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, noticeVersion: version, action }; }
function assertPrivate(value) { assert.doesNotMatch(JSON.stringify(value), forbidden); }
function assertHeaders(response) { assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); }
async function fixture(t, options = {}) {
  const db = await createDisposableDatabase({ ownerEditableWorkoutSessions: true }); t.after(() => db.close());
  await migrate009({ pool: db.pool }); await migrate010({ pool: db.pool }); await migrate011({ pool: db.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } }); await migrate012({ pool: db.pool }); await migrate013({ pool: db.pool });
  const members = [];
  for (const [suffix, subject] of [["one", "gymmaster:31001"], ["two", "gymmaster:31002"]]) { const seeded = await seedMemberAndPlan(db.pool, `consent-${suffix}`); const mapping = (await db.pool.query("INSERT INTO goals_coach_member_auth_mappings (member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference) VALUES ($1,'gymmaster',$2,'synthetic@example.test',TRUE,'owner_approved_script','consent-route') RETURNING *", [seeded.member.id, subject])).rows[0]; members.push({ subject, mapping }); }
  let gatekeeperCalls = 0;
  const fetchImpl = options.fetchImpl || (async (url) => { gatekeeperCalls += 1; const memberid = Number(new URL(url).searchParams.get("memberid")); return { ok: true, async json() { return { members: [{ memberid, stopatgate: false, membership: [{ expired: false }] }] }; } }; });
  const app = express(); app.use(createApplicationJsonParser());
  const startup = createGymMasterMemberCoachingConsentStartup({ environment: environment(options.environment), db: db.pool, fetchImpl, rateLimits: options.rateLimits || noLimits });
  const composed = composeGymMasterMemberCoachingConsentRoutes(app, startup); app.use(goalsCoachErrorHandler);
  const running = await startApp(app); t.after(() => running.close()); return { db, members, running, composed, gatekeeperCalls: () => gatekeeperCalls };
}
function request(f, subject, options = {}) { return jsonRequest(f.running.url, "/goalscoach/member/coaching-consent", { ...options, headers: { Origin: origin, Cookie: cookie(subject), ...(options.headers || {}) } }); }

test("GET, POST, and OPTIONS expose only the exact origin and privacy-safe contract", async (t) => {
  const f = await fixture(t); const subject = f.members[0].subject;
  const preflight = await fetch(`${f.running.url}/goalscoach/member/coaching-consent`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), origin); assert.equal(preflight.headers.get("access-control-allow-credentials"), "true"); assertHeaders(preflight);
  const wrong = await fetch(`${f.running.url}/goalscoach/member/coaching-consent`, { method: "OPTIONS", headers: { Origin: "https://wrong.test", "Access-Control-Request-Method": "POST" } }); assert.equal(wrong.status, 403); assert.equal(wrong.headers.get("access-control-allow-origin"), null); assertHeaders(wrong);
  const get = await request(f, subject); assert.equal(get.response.status, 200); assert.equal(get.body.consent.status, "not_recorded"); assert.equal(get.body.consent.activationPermitted, false); assertPrivate(get.body); assertHeaders(get.response);
  const post = await request(f, subject, { method: "POST", body: body(1) }); assert.equal(post.response.status, 201); assert.equal(post.body.consent.status, "accepted"); assert.equal(post.body.idempotentReplay, false); assertPrivate(post.body); assertHeaders(post.response);
  assert.equal((await jsonRequest(f.running.url, "/goalscoach/member/coaching-consent/other", { headers: { Origin: origin } })).response.status, 404);
});

test("wrong-origin and missing or forged sessions fail before limiter, parser, mapping, and Gatekeeper", async (t) => {
  let limited = 0; const limiter = (_q, _s, next) => { limited += 1; next(); }; const f = await fixture(t, { rateLimits: { read: limiter, mutation: limiter } });
  for (const headers of [{ Origin: "https://wrong.test", Cookie: cookie(f.members[0].subject) }, { Origin: origin }, { Origin: origin, Cookie: "gc_member_session=forged" }]) {
    const response = await fetch(`${f.running.url}/goalscoach/member/coaching-consent`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{" + "x".repeat(700) });
    assert.equal(response.status, headers.Origin === origin ? 401 : 403); assertHeaders(response); assertPrivate(await response.json());
  }
  assert.equal(limited, 0); assert.equal(f.gatekeeperCalls(), 0);
});

test("limiter precedes raw parsing, mapping, and Gatekeeper; mapping precedes Gatekeeper", async (t) => {
  let limited = 0; const f = await fixture(t, { rateLimits: { read: noLimits.read, mutation: (_q, res) => { limited += 1; res.status(429).json({ error: "RATE_LIMITED" }); } } });
  const response = await fetch(`${f.running.url}/goalscoach/member/coaching-consent`, { method: "POST", headers: { Origin: origin, Cookie: cookie(f.members[0].subject), "Content-Type": "application/json" }, body: "{" + "x".repeat(700) });
  assert.equal(response.status, 429); assert.equal(limited, 1); assert.equal(f.gatekeeperCalls(), 0);
  await f.db.pool.query("UPDATE goals_coach_member_auth_mappings SET active=FALSE WHERE id=$1", [f.members[0].mapping.id]);
  assert.equal((await request(f, f.members[0].subject)).response.status, 401); assert.equal(f.gatekeeperCalls(), 0);
});

test("parser owns exact 512-byte raw cap and exact malformed, media, and query responses", async (t) => {
  const f = await fixture(t); const headers = { Origin: origin, Cookie: cookie(f.members[0].subject) };
  const cases = [
    ["application/json", "{", 400, { error: "COACHING_CONSENT_INVALID", message: "Invalid coaching consent request." }],
    ["application/json", `${" ".repeat(513)}{}`, 413, { error: "COACHING_CONSENT_BODY_TOO_LARGE", message: "The coaching consent request is too large." }],
    ["application/json", `{"action":"accept","action":"accept","padding":"${"x".repeat(500)}"}`, 413, { error: "COACHING_CONSENT_BODY_TOO_LARGE", message: "The coaching consent request is too large." }],
    ["text/plain", "{}", 415, { error: "COACHING_CONSENT_MEDIA_TYPE_UNSUPPORTED", message: "Coaching consent requires application/json." }],
  ];
  for (const [type, raw, status, expected] of cases) { const response = await fetch(`${f.running.url}/goalscoach/member/coaching-consent`, { method: "POST", headers: { ...headers, "Content-Type": type }, body: raw }); assert.equal(response.status, status); assert.deepEqual(await response.json(), expected); assertHeaders(response); }
  for (const method of ["GET", "POST"]) { const result = await jsonRequest(f.running.url, "/goalscoach/member/coaching-consent?memberId=1", { method, headers, ...(method === "POST" ? { body: body(20) } : {}) }); assert.equal(result.response.status, 400); assert.deepEqual(result.body, { error: "COACHING_CONSENT_INVALID", message: "Invalid coaching consent request." }); assertHeaders(result.response); }
});

test("uniform concealed authorization and minimized dependency failure isolate members", async (t) => {
  const f = await fixture(t); await f.db.pool.query("UPDATE goals_coach_member_auth_mappings SET active=FALSE WHERE id=$1", [f.members[0].mapping.id]);
  const inactive = await request(f, f.members[0].subject); assert.equal(inactive.response.status, 401); assert.deepEqual(inactive.body, { error: "MEMBER_AUTHENTICATION_REQUIRED" });
  const unavailable = await fixture(t, { fetchImpl: async () => { throw new Error("synthetic"); } }); const failure = await request(unavailable, unavailable.members[0].subject); assert.equal(failure.response.status, 503); assert.deepEqual(failure.body, { error: "MEMBER_ACCESS_TEMPORARILY_UNAVAILABLE", message: "We can’t verify your access right now. Please try again later.", nextAction: "TRY_AGAIN_LATER" }); assertPrivate(failure.body);
  const other = await request(f, f.members[1].subject); assert.equal(other.response.status, 200); assert.equal(other.body.consent.status, "not_recorded");
});

test("replay is the original result after withdrawal and notice change; conflicts and cross-member reuse are isolated", async (t) => {
  const f = await fixture(t); const subject = f.members[0].subject; const acceptedBody = body(30);
  const accepted = await request(f, subject, { method: "POST", body: acceptedBody });
  assert.equal((await request(f, subject, { method: "POST", body: body(31, "withdraw") })).body.consent.status, "withdrawn");
  const replay = await request(f, subject, { method: "POST", body: acceptedBody }); assert.equal(replay.response.status, 200); assert.deepEqual(replay.body.consent, accepted.body.consent); assert.equal(replay.body.idempotentReplay, true);
  assert.equal((await request(f, subject, { method: "POST", body: { ...body(99, "decline"), clientRequestId: acceptedBody.clientRequestId } })).response.status, 409);
  const oldVersionReplay = { ...acceptedBody, noticeVersion: "GC-MEMBER-COACHING-CONSENT-1" }; assert.deepEqual((await request(f, subject, { method: "POST", body: oldVersionReplay })).body.consent, accepted.body.consent);
  const cross = await request(f, f.members[1].subject, { method: "POST", body: acceptedBody }); assert.equal(cross.response.status, 201); assert.equal((await f.db.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_coaching_consent_events")).rows[0].count, 3);
});

test("disabled startup mounts no consent or unrelated capability and performs zero work", async (t) => {
  let calls = 0; const app = express(); const startup = createGymMasterMemberCoachingConsentStartup({ environment: environment({ [MEMBER_COACHING_CONSENT_FLAG]: "false" }), db: { query() { calls += 1; }, connect() { calls += 1; } }, fetchImpl() { calls += 1; } });
  assert.deepEqual(composeGymMasterMemberCoachingConsentRoutes(app, startup), { mounted: false, path: null }); const running = await startApp(app); t.after(() => running.close());
  for (const path of ["/goalscoach/member/coaching-consent", "/goalscoach/member/safety-intake", "/goalscoach/member/workout-sessions", "/alpha/goals-coach"]) assert.equal((await fetch(`${running.url}${path}`)).status, 404);
  assert.equal(calls, 0);
});
