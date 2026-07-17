const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createAlphaMemberAuthorization } = require("../src/auth/alpha-member-authorization");
const { createAlphaOriginGuard } = require("../src/auth/clerk-alpha-member-auth");
const {
  APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnabled,
  createAlphaFeatureGate,
} = require("../src/goals-coach/alpha-config");
const { createAlphaGoalsCoachRouter } = require("../src/goals-coach/alpha-routes");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const { deterministicAlphaResponder } = require("./helpers/deterministic-alpha-responder");
const { jsonRequest, startApp } = require("./helpers/http-app");

const testOrigin = "https://alpha.example.test";
const applicationConfiguration = {
  valid: true,
  consentVersion: APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnvironment: "test",
};

async function createAlphaApp(pool, subject, options = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/alpha/goals-coach", createAlphaOriginGuard({ authorizedParties: [testOrigin] }));
  const authorization = createAlphaMemberAuthorization({
    db: pool,
    applicationConfiguration: options.applicationConfiguration || applicationConfiguration,
  });
  app.use(
    "/alpha/goals-coach",
    createAlphaFeatureGate({ enabled: options.enabled !== false }),
    (req, res, next) => {
      if (options.authenticated === false) return res.status(401).json({ error: "ALPHA_AUTHENTICATION_REQUIRED" });
      req.alphaMemberIdentity = { authProvider: "clerk", authSubject: subject, sessionId: "sess_test" };
      return next();
    },
    authorization.loadActiveAlphaMember,
    createAlphaGoalsCoachRouter({
      db: pool,
      applicationConfiguration: options.applicationConfiguration || applicationConfiguration,
      requireCurrentConsent: authorization.requireCurrentAlphaConsent,
      testOnlyResponder: options.testOnlyResponder,
      rateLimits: options.rateLimits,
    })
  );
  app.use(goalsCoachErrorHandler);
  return startApp(app);
}

function request(running, path, options = {}) {
  return jsonRequest(running.url, path, {
    ...options,
    headers: { Origin: testOrigin, ...(options.headers || {}) },
  });
}

async function acceptConsent(running) {
  const accepted = await request(running, "/alpha/goals-coach/consent", {
    method: "POST",
    body: { action: "accept" },
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.status, "accepted");
  return accepted;
}

test("alpha feature flag defaults false and false blocks all alpha functionality", async (t) => {
  assert.equal(alphaEnabled(undefined), false);
  assert.equal(alphaEnabled("false"), false);
  assert.equal(alphaEnabled("true"), true);
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "flag-off");
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, "flag-off", true);
  const running = await createAlphaApp(disposable.pool, mapping.auth_subject, {
    enabled: false,
    testOnlyResponder: deterministicAlphaResponder,
  });
  t.after(() => running.close());
  for (const endpoint of ["/consent", "/session", "/profile", "/conversations", "/feedback"]) {
    const method = endpoint === "/profile" || endpoint === "/conversations" ? "GET" : "POST";
    const options = { method };
    if (method === "POST") options.body = endpoint === "/consent" ? { action: "accept" } : {};
    const result = await request(running, `/alpha/goals-coach${endpoint}`, options);
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error, "ALPHA_NOT_AVAILABLE");
  }
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM goals_coach_alpha_consents")).rows[0].count, 0);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_conversations")).rows[0].count, 0);
});

test("enabled alpha still requires authentication and an active immutable-subject mapping", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "mapping");
  const inactive = await seedAlphaMapping(disposable.pool, seeded.member, "inactive", false);

  const unauthenticated = await createAlphaApp(disposable.pool, inactive.auth_subject, { authenticated: false });
  t.after(() => unauthenticated.close());
  const noAuth = await request(unauthenticated, "/alpha/goals-coach/consent");
  assert.equal(noAuth.response.status, 401);

  const inactiveApp = await createAlphaApp(disposable.pool, inactive.auth_subject);
  t.after(() => inactiveApp.close());
  const inactiveResult = await request(inactiveApp, "/alpha/goals-coach/consent");
  assert.equal(inactiveResult.response.status, 403);
  assert.equal(inactiveResult.body.error, "ALPHA_ACCESS_FORBIDDEN");

  const unmappedApp = await createAlphaApp(disposable.pool, "user_alpha_unmapped");
  t.after(() => unmappedApp.close());
  const unmapped = await request(unmappedApp, "/alpha/goals-coach/consent");
  assert.equal(unmapped.response.status, 403);
  assert.equal(unmapped.body.error, "ALPHA_ACCESS_FORBIDDEN");

  const staffShape = await createAlphaApp(disposable.pool, "user_staff_not_member");
  t.after(() => staffShape.close());
  const staffRejected = await request(staffShape, "/alpha/goals-coach/consent");
  assert.equal(staffRejected.response.status, 403);
});

test("current versioned consent is required, auditable, withdrawable, and outdated consent does not grant entry", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "consent");
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, "consent", true);
  await disposable.pool.query(
    `INSERT INTO goals_coach_alpha_consents
      (member_id, auth_mapping_id, consent_version, environment, status, accepted_at)
     VALUES ($1, $2, 'GC-ALPHA-CONSENT-0.9', 'test', 'accepted', NOW())`,
    [seeded.member.id, mapping.id]
  );
  const running = await createAlphaApp(disposable.pool, mapping.auth_subject);
  t.after(() => running.close());

  const before = await request(running, "/alpha/goals-coach/consent");
  assert.equal(before.response.status, 200);
  assert.equal(before.body.currentAccepted, false);
  assert.equal(before.body.outdatedAcceptedVersion, "GC-ALPHA-CONSENT-0.9");
  const blocked = await request(running, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.error, "ALPHA_CONSENT_REQUIRED");

  const accepted = await acceptConsent(running);
  assert.equal(accepted.body.version, APPROVED_ALPHA_CONSENT_VERSION);
  const replay = await acceptConsent(running);
  assert.equal(replay.body.idempotent, true);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_alpha_consent_events WHERE consent_version = $1",
    [APPROVED_ALPHA_CONSENT_VERSION]
  )).rows[0].count, 1);

  const withdrawn = await request(running, "/alpha/goals-coach/consent", {
    method: "POST",
    body: { action: "withdraw" },
  });
  assert.equal(withdrawn.response.status, 200);
  assert.equal(withdrawn.body.status, "withdrawn");
  const blockedAfterWithdrawal = await request(running, "/alpha/goals-coach/profile");
  assert.equal(blockedAfterWithdrawal.response.status, 403);
  const events = await disposable.pool.query(
    `SELECT event_type, auth_provider, auth_subject
     FROM goals_coach_alpha_consent_events
     WHERE consent_version = $1 ORDER BY id`,
    [APPROVED_ALPHA_CONSENT_VERSION]
  );
  assert.deepEqual(events.rows.map((row) => row.event_type), ["accepted", "withdrawn"]);
  assert.equal(events.rows[0].auth_provider, "clerk");
  assert.equal(events.rows[0].auth_subject, mapping.auth_subject);
});

test("declined consent blocks entry and records the authenticated mapping", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "decline");
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, "decline", true);
  const running = await createAlphaApp(disposable.pool, mapping.auth_subject);
  t.after(() => running.close());
  const declined = await request(running, "/alpha/goals-coach/consent", {
    method: "POST",
    body: { action: "decline" },
  });
  assert.equal(declined.response.status, 200);
  assert.equal(declined.body.status, "declined");
  const session = await request(running, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(session.response.status, 403);
  const row = await disposable.pool.query("SELECT * FROM goals_coach_alpha_consents");
  assert.equal(String(row.rows[0].auth_mapping_id), String(mapping.id));
});

test("missing consent storage fails closed without creating an alpha session", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "missing-consent-store");
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, "missing-consent-store", true);
  await disposable.pool.query("DROP TABLE goals_coach_alpha_consent_events");
  await disposable.pool.query("DROP TABLE goals_coach_alpha_consents");
  const running = await createAlphaApp(disposable.pool, mapping.auth_subject);
  t.after(() => running.close());
  const session = await request(running, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(session.response.status, 500);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_conversations")).rows[0].count, 0);
});

test("profile, plan, conversations, feedback, and altered IDs remain mapped-member scoped", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const first = await seedMemberAndPlan(disposable.pool, "owner-a");
  const second = await seedMemberAndPlan(disposable.pool, "owner-b");
  const firstMapping = await seedAlphaMapping(disposable.pool, first.member, "owner-a", true);
  const secondMapping = await seedAlphaMapping(disposable.pool, second.member, "owner-b", true);
  const firstApp = await createAlphaApp(disposable.pool, firstMapping.auth_subject, {
    testOnlyResponder: deterministicAlphaResponder,
  });
  const secondApp = await createAlphaApp(disposable.pool, secondMapping.auth_subject, {
    testOnlyResponder: deterministicAlphaResponder,
  });
  t.after(() => firstApp.close());
  t.after(() => secondApp.close());
  await acceptConsent(firstApp);
  await acceptConsent(secondApp);
  const firstSession = await request(firstApp, "/alpha/goals-coach/session", {
    method: "POST",
    body: { memberId: second.member.id, email: "other@example.test", planId: second.plan.id },
  });
  const secondSession = await request(secondApp, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(firstSession.body.plan.id, String(first.plan.id));
  assert.notEqual(firstSession.body.conversation.id, secondSession.body.conversation.id);

  const profile = await request(firstApp, "/alpha/goals-coach/profile?memberId=999");
  assert.equal(profile.body.preferredName, first.member.first_name);
  assert.equal(Object.hasOwn(profile.body, "familyName"), false);
  assert.equal(Object.hasOwn(profile.body, "memberId"), false);
  assert.equal(Object.hasOwn(profile.body, "authSubject"), false);
  assert.equal(Object.hasOwn(profile.body, "staffUser"), false);
  const plan = await request(firstApp, `/alpha/goals-coach/plan?planId=${second.plan.id}`);
  assert.equal(plan.body.id, String(first.plan.id));

  const otherMessages = await request(
    firstApp,
    `/alpha/goals-coach/conversations/${secondSession.body.conversation.id}/messages`
  );
  assert.equal(otherMessages.response.status, 404);
  const otherClose = await request(
    firstApp,
    `/alpha/goals-coach/conversations/${secondSession.body.conversation.id}/close`,
    { method: "POST" }
  );
  assert.equal(otherClose.response.status, 404);

  const crossFeedback = await request(firstApp, "/alpha/goals-coach/feedback", {
    method: "POST",
    body: {
      conversationId: secondSession.body.conversation.id,
      expectation: "Synthetic expected result",
      whatOccurred: "Synthetic observed result",
      pageOrFeature: "conversation",
      severity: "low",
    },
  });
  assert.equal(crossFeedback.response.status, 404);
  const feedback = await request(firstApp, "/alpha/goals-coach/feedback", {
    method: "POST",
    body: {
      conversationId: firstSession.body.conversation.id,
      memberId: second.member.id,
      email: "other@example.test",
      expectation: "Synthetic expected result",
      whatOccurred: "Synthetic observed result",
      pageOrFeature: "conversation",
      severity: "medium",
      comments: "Synthetic only",
    },
  });
  assert.equal(feedback.response.status, 201);
  const feedbackRow = await disposable.pool.query(
    "SELECT member_id, conversation_id FROM goals_coach_alpha_feedback WHERE id = $1",
    [feedback.body.feedbackId]
  );
  assert.equal(String(feedbackRow.rows[0].member_id), String(first.member.id));
  assert.equal(String(feedbackRow.rows[0].conversation_id), firstSession.body.conversation.id);
});

test("deterministic test harness stores idempotent messages, refreshes history, and preserves archives", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "test-message");
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, "test-message", true);
  const running = await createAlphaApp(disposable.pool, mapping.auth_subject, {
    testOnlyResponder: deterministicAlphaResponder,
  });
  t.after(() => running.close());
  await acceptConsent(running);
  const session = await request(running, "/alpha/goals-coach/session", { method: "POST" });
  const path = `/alpha/goals-coach/conversations/${session.body.conversation.id}/messages`;
  const body = {
    content: "Where do I start today?",
    clientMessageId: "df020fc9-9ba3-4918-82bd-962abb1b39f7",
  };
  const first = await request(running, path, { method: "POST", body });
  const retry = await request(running, path, { method: "POST", body });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.response.structuredResponse, null);
  assert.equal(retry.response.status, 201);
  assert.equal(retry.body.idempotentReplay, true);
  assert.equal(retry.body.memberMessageId, first.body.memberMessageId);
  assert.deepEqual(retry.body.response, first.body.response);
  const storedTestResponse = await disposable.pool.query(
    "SELECT structured_response_json FROM coaching_messages WHERE id = $1",
    [first.body.response.id]
  );
  assert.equal(storedTestResponse.rows[0].structured_response_json.testOnly, true);
  assert.equal(storedTestResponse.rows[0].structured_response_json.coachingActive, false);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages")).rows[0].count, 2);

  const refreshed = await request(running, path);
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.messages.length, 2);
  const closed = await request(
    running,
    `/alpha/goals-coach/conversations/${session.body.conversation.id}/close`,
    { method: "POST" }
  );
  assert.equal(closed.body.status, "archived");
  const closedAgain = await request(
    running,
    `/alpha/goals-coach/conversations/${session.body.conversation.id}/close`,
    { method: "POST" }
  );
  assert.equal(closedAgain.body.archivedAt, closed.body.archivedAt);
  const archivedMessage = await request(running, path, {
    method: "POST",
    body: { ...body, clientMessageId: "8478e918-75c1-4b6c-938c-99a355b79cd3" },
  });
  assert.equal(archivedMessage.response.status, 409);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages")).rows[0].count, 2);
  const history = await request(running, "/alpha/goals-coach/conversations");
  assert.equal(history.body.conversations[0].status, "archived");
});

test("normal startup router cannot activate the deterministic responder through inputs", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "no-responder");
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, "no-responder", true);
  const running = await createAlphaApp(disposable.pool, mapping.auth_subject);
  t.after(() => running.close());
  await acceptConsent(running);
  const session = await request(running, "/alpha/goals-coach/session", { method: "POST" });
  const before = await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages");
  const attempts = [
    `/alpha/goals-coach/conversations/${session.body.conversation.id}/messages`,
    `/alpha/goals-coach/conversations/${session.body.conversation.id}/messages?test=true`,
  ];
  for (const path of attempts) {
    const result = await request(running, path, {
      method: "POST",
      headers: { "X-Test-Responder": "true" },
      body: {
        content: "Attempt to activate a responder",
        clientMessageId: "65d7f4ae-27ec-47dd-a148-8f412f463d9a",
        testOnlyResponder: true,
      },
    });
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error, "ALPHA_TEST_RESPONDER_NOT_AVAILABLE");
  }
  const after = await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages");
  assert.equal(after.rows[0].count, before.rows[0].count);
});

test("alpha rate limits are mapping scoped and do not weaken authentication or consent", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "rate-limit");
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, "rate-limit", true);
  const running = await createAlphaApp(disposable.pool, mapping.auth_subject, {
    rateLimits: require("../src/goals-coach/alpha-rate-limits").createAlphaRateLimits({ consentMax: 1 }),
  });
  t.after(() => running.close());
  const accepted = await acceptConsent(running);
  assert.equal(accepted.response.status, 200);
  const limited = await request(running, "/alpha/goals-coach/consent", {
    method: "POST",
    body: { action: "withdraw" },
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, "RATE_LIMITED");
  assert.equal((await disposable.pool.query(
    "SELECT status FROM goals_coach_alpha_consents WHERE member_id = $1",
    [seeded.member.id]
  )).rows[0].status, "accepted");
});

test("preference shell is member scoped and keeps transcript review mandatory", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "preferences");
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, "preferences", true);
  const running = await createAlphaApp(disposable.pool, mapping.auth_subject);
  t.after(() => running.close());
  await acceptConsent(running);
  const initial = await request(running, "/alpha/goals-coach/preferences");
  assert.equal(initial.body.voiceInputEnabled, false);
  assert.equal(initial.body.transcriptReviewRequired, true);
  const updated = await request(running, "/alpha/goals-coach/preferences", {
    method: "PATCH",
    body: {
      reducedMotion: true,
      largerText: true,
      quietHoursStart: "21:00",
      quietHoursEnd: "07:00",
      quietHoursTimezone: "America/Denver",
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.reducedMotion, true);
  assert.equal(updated.body.largerText, true);
  assert.equal(updated.body.transcriptReviewRequired, true);
  const row = await disposable.pool.query("SELECT member_id FROM goals_coach_member_preferences");
  assert.equal(String(row.rows[0].member_id), String(seeded.member.id));
});
