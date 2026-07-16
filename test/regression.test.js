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
  const productionFiles = [
    path.join(projectRoot, "src", "goals-coach", "member-routes.js"),
    path.join(projectRoot, "src", "goals-coach", "service.js"),
  ];
  for (const file of productionFiles) {
    assert.equal(fs.readFileSync(file, "utf8").includes("fake-goals-coach-responder"), false);
  }
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

