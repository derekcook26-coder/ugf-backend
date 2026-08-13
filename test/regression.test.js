const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");

test("existing Railway proxy and member CORS behavior remains present", () => {
  assert.match(serverSource, /app\.set\("trust proxy", 1\)/);
  assert.match(serverSource, /ultimate-goals-fitness\.sintra\.site/);
  assert.match(serverSource, /ultimategoalsfitness\.com/);
  assert.match(serverSource, /sintra\\\.\(ai\|site\)/);
  assert.match(serverSource, /localhost\(:\\d\+\)\?/);
});

test("existing verification, GymMaster, JWT, onboarding, and plan routes remain present", () => {
  assert.match(serverSource, /app\.post\("\/verify-member"/);
  assert.match(serverSource, /\/members\?memberid=/);
  assert.match(serverSource, /function isMemberActive\(member\)/);
  assert.match(serverSource, /member\.stopatgate/);
  assert.match(serverSource, /jwt\.verify\(token, secret\)/);
  assert.match(serverSource, /app\.post\("\/coach-message"/);
  assert.match(serverSource, /app\.post\("\/generate-personalized-workout"/);
});

test("existing weekly check-ins, cron protection, Zapier, and GymMaster email safeguards remain present", () => {
  assert.match(serverSource, /app\.post\("\/weekly-checkin\/session"/);
  assert.match(serverSource, /app\.get\("\/weekly-checkin\/context"/);
  assert.match(serverSource, /app\.post\("\/weekly-checkin\/submit"/);
  assert.match(serverSource, /app\.post\("\/admin\/send-weekly-checkins"/);
  assert.match(serverSource, /app\.post\("\/admin\/retry-trainer-notifications"/);
  assert.match(serverSource, /x-cron-secret/);
  assert.match(serverSource, /process\.env\.CRON_SECRET/);
  assert.match(serverSource, /ZAPIER_TRAINER_SUMMARY_WEBHOOK/);
  assert.match(serverSource, /GYMMASTER_WEEKLY_EMAIL_ENABLED/);
});

test("production startup never imports the test-only responder", () => {
  assert.equal(serverSource.includes("fake-goals-coach-responder"), false);
  assert.equal(serverSource.includes("deterministic-alpha-responder"), false);
  assert.equal(serverSource.includes("test/helpers"), false);
  const productionFiles = [
    path.join(projectRoot, "src", "goals-coach", "member-routes.js"),
    path.join(projectRoot, "src", "goals-coach", "service.js"),
    path.join(projectRoot, "src", "goals-coach", "alpha-routes.js"),
    path.join(projectRoot, "src", "goals-coach", "alpha-service.js"),
  ];
  for (const file of productionFiles) {
    assert.equal(fs.readFileSync(file, "utf8").includes("fake-goals-coach-responder"), false);
    assert.equal(fs.readFileSync(file, "utf8").includes("deterministic-alpha-responder"), false);
  }
});

test("owner-only GymMaster login is conditionally composed and cannot replace existing member routes", () => {
  assert.match(serverSource, /createGymMasterOwnerOnlyStartup\(\{\s*db: db,\s*fetchImpl: fetch,\s*\}\)/);
  assert.match(serverSource, /composeGymMasterOwnerOnlyRoutes\(app, ownerOnlyStartup\)/);
  assert.match(serverSource, /req\.path === "\/goalscoach" \|\| req\.path\.startsWith\("\/goalscoach\/"\)/);
  assert.match(serverSource, /app\.use\(\s*"\/goals-coach"/);
  assert.equal(serverSource.includes('app.use("/goalscoach"'), false);
});

test("Phase 2 uses no required Clerk audience variable", () => {
  const authSource = fs.readFileSync(
    path.join(projectRoot, "src", "auth", "clerk-staff-auth.js"),
    "utf8"
  );
  assert.equal(authSource.includes("CLERK_JWT_AUDIENCE"), false);
  assert.equal(authSource.includes("audience:"), false);
});

test("weekly check-in member lookup supports GymMaster memberid", () => {
  const start = serverSource.indexOf('app.post("/weekly-checkin/session"');
  const end = serverSource.indexOf('app.get("/weekly-checkin/context"');
  const weeklySessionSource = serverSource.slice(start, end);

  assert.match(
    weeklySessionSource,
    /String\(m\.memberid \|\| m\.id \|\| m\.member_id \|\| ""\)\.trim\(\) === memberId/
  );
});


test("weekly check-in queries GymMaster by member ID", () => {
  const start = serverSource.indexOf('app.post("/weekly-checkin/session"');
  const end = serverSource.indexOf('app.get("/weekly-checkin/context"');
  const weeklySessionSource = serverSource.slice(start, end);

  assert.match(
    weeklySessionSource,
    /GYMMASTER_BASE \+ "\/members\?memberid=" \+ encodeURIComponent\(memberId\)/
  );
});

test("legacy protected conflicts use fixed concealed responses and log no raw member or provider state", () => {
  const planStart = serverSource.indexOf(
    'app.post("/generate-personalized-workout"'
  );
  const planEnd = serverSource.indexOf(
    "// ═══════════════════════════════════════════════════════════════════════════════",
    planStart
  );
  const planRoute = serverSource.slice(planStart, planEnd);
  assert.match(planRoute, /res\.status\(500\)\.json\(\{ error: "Plan generation failed" \}\)/);
  assert.doesNotMatch(planRoute, /console\.(?:error|log|warn)/);
  assert.match(planRoute, /route\.terminalState\.responseAllowed\(\)/);
  assert.match(planRoute, /res\.writableEnded/);
  assert.match(planRoute, /res\.headersSent/);

  const weeklyStart = serverSource.indexOf('app.post("/weekly-checkin/session"');
  const weeklyEnd = serverSource.indexOf('app.get("/weekly-checkin/context"');
  const weeklyRoute = serverSource.slice(weeklyStart, weeklyEnd);
  assert.match(
    weeklyRoute,
    /res\.status\(500\)\.json\(\{ error: "Verification service error\. Please try again\." \}\)/
  );
  assert.doesNotMatch(weeklyRoute, /console\.(?:error|log|warn)/);

  const legacySource = fs.readFileSync(
    path.join(projectRoot, "src", "goals-coach", "legacy-member-provisioning.js"),
    "utf8"
  );
  assert.doesNotMatch(legacySource, /console\.(?:error|log|warn)/);
  assert.doesNotMatch(legacySource, /provider response|prompt.*log|profile.*log/i);
});

test("nameless weekly rows stop before AI, write, notification attempt, or webhook", () => {
  const submitStart = serverSource.indexOf('app.post("/weekly-checkin/submit"');
  const submitEnd = serverSource.indexOf(
    "// ─── GET /admin/weekly-checkins",
    submitStart
  );
  const submitRoute = serverSource.slice(submitStart, submitEnd);
  const completePairCheck = submitRoute.indexOf("if (!completeNamePair(memberRow))");
  assert.equal(completePairCheck >= 0, true);
  for (const laterSideEffect of [
    "var analysis = await analyzeCheckin",
    '"INSERT INTO weekly_checkins "',
    "trainer_notification_attempts = trainer_notification_attempts + 1",
    "sendTrainerSummaryWebhook(webhookPayload)",
  ]) {
    assert.equal(
      submitRoute.indexOf(laterSideEffect) > completePairCheck,
      true,
      `${laterSideEffect} must remain after the null-name refusal`
    );
  }

  const retryStart = serverSource.indexOf(
    'app.post("/admin/retry-trainer-notifications"'
  );
  const retryEnd = serverSource.indexOf(
    "// ─── POST /verify-member",
    retryStart
  );
  const retryRoute = serverSource.slice(retryStart, retryEnd);
  const retryCheck = retryRoute.indexOf("if (!completeNamePair(row))");
  const skipped = retryRoute.indexOf("skipped++;", retryCheck);
  const continued = retryRoute.indexOf("continue;", skipped);
  const attempted = retryRoute.indexOf("attempted++;", continued);
  const attemptWrite = retryRoute.indexOf(
    "trainer_notification_attempts = trainer_notification_attempts + 1",
    attempted
  );
  const webhook = retryRoute.indexOf("sendTrainerSummaryWebhook(payload)", attempted);
  assert.equal(retryCheck >= 0, true);
  assert.equal(skipped > retryCheck && continued > skipped, true);
  assert.equal(attempted > continued, true);
  assert.equal(attemptWrite > attempted, true);
  assert.equal(webhook > attemptWrite, true);
});
