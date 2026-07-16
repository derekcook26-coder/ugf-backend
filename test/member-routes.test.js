const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createGoalsCoachMemberRouter } = require("../src/goals-coach/member-routes");
const { createGoalsCoachRateLimits } = require("../src/goals-coach/rate-limits");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
  seedStaff,
} = require("./helpers/disposable-db");
const { fakeGoalsCoachResponder } = require("./helpers/fake-goals-coach-responder");
const { jsonRequest, startApp } = require("./helpers/http-app");

async function createMemberApp(pool, gymmasterMemberId, options = {}) {
  const app = express();
  app.use(express.json());
  const serviceOptions = {
    db: pool,
    requireMember(req, res, next) {
      req.memberClaims = { sub: gymmasterMemberId, firstName: options.claimFirstName || "BrowserName" };
      next();
    },
  };
  if (options.testOnlyResponder) serviceOptions.testOnlyResponder = options.testOnlyResponder;
  if (options.rateLimits) serviceOptions.rateLimits = options.rateLimits;
  app.use("/goals-coach", createGoalsCoachMemberRouter(serviceOptions));
  app.use(goalsCoachErrorHandler);
  return startApp(app);
}

test("production message route always returns 503 and stores nothing", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "production-503");
  const running = await createMemberApp(disposable.pool, seeded.member.gymmaster_member_id);
  t.after(() => running.close());

  const session = await jsonRequest(running.url, "/goals-coach/session", { method: "POST" });
  assert.equal(session.response.status, 200);
  const conversationId = session.body.conversation.id;
  const before = await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages");

  const attempts = [
    `/goals-coach/conversations/${conversationId}/messages`,
    `/goals-coach/conversations/${conversationId}/messages?fake=true`,
  ];
  for (const path of attempts) {
    const response = await jsonRequest(running.url, path, {
      method: "POST",
      headers: { "X-Test-Responder": "true", "X-Coaching-Mode": "fake" },
      body: {
        content: "Store this if fake mode can be activated",
        clientMessageId: "831b4372-6938-4e46-a53a-2e6b923255bb",
        fakeResponder: true,
      },
    });
    assert.equal(response.response.status, 503);
    assert.equal(response.body.error, "COACHING_NOT_READY");
  }

  const after = await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages");
  assert.equal(after.rows[0].count, before.rows[0].count);
});

test("member conversation and message cursors return stable recent-to-older pages without gaps", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "member-pagination");
  const conversations = [];
  for (let index = 0; index < 5; index += 1) {
    const plan = index === 0
      ? seeded.plan
      : (await disposable.pool.query(
          `INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown, created_at)
           VALUES ($1, '{}'::jsonb, '[]'::jsonb, $2, NOW() - ($3 * INTERVAL '1 day')) RETURNING *`,
          [seeded.member.id, `Plan page ${index}`, index]
        )).rows[0];
    const conversation = await disposable.pool.query(
      `INSERT INTO coaching_conversations
        (member_id, plan_id, status, archived_at, updated_at)
       VALUES ($1, $2, 'archived', NOW(), NOW() - ($3 * INTERVAL '1 minute'))
       RETURNING *`,
      [seeded.member.id, plan.id, index]
    );
    conversations.push(conversation.rows[0]);
  }
  const target = conversations[0];
  const insertedMessages = [];
  for (let index = 0; index < 5; index += 1) {
    const message = await disposable.pool.query(
      `INSERT INTO coaching_messages
        (conversation_id, member_id, sender_type, content, created_at)
       VALUES ($1, $2, 'member', $3, NOW() - ($4 * INTERVAL '1 minute'))
       RETURNING *`,
      [target.id, seeded.member.id, `message-${index}`, index]
    );
    insertedMessages.push(message.rows[0]);
  }
  const running = await createMemberApp(disposable.pool, seeded.member.gymmaster_member_id);
  t.after(() => running.close());

  const conversationIds = [];
  let conversationCursor = null;
  do {
    const page = await jsonRequest(
      running.url,
      `/goals-coach/conversations?limit=2${conversationCursor ? `&cursor=${conversationCursor}` : ""}`
    );
    assert.equal(page.response.status, 200);
    conversationIds.push(...page.body.conversations.map((item) => item.id));
    conversationCursor = page.body.nextCursor;
  } while (conversationCursor);
  assert.equal(conversationIds.length, 5);
  assert.equal(new Set(conversationIds).size, 5);

  const messageIds = [];
  let messageCursor = null;
  do {
    const page = await jsonRequest(
      running.url,
      `/goals-coach/conversations/${target.id}/messages?limit=2${messageCursor ? `&cursor=${messageCursor}` : ""}`
    );
    assert.equal(page.response.status, 200);
    messageIds.push(...page.body.messages.map((item) => item.id));
    messageCursor = page.body.nextCursor;
  } while (messageCursor);
  const expectedNewestFirst = insertedMessages.map((row) => String(row.id));
  assert.deepEqual(messageIds, expectedNewestFirst);
  assert.equal(new Set(messageIds).size, 5);
});

test("member session and close cycles use a dedicated member-scoped rate limit", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "member-rate-limit");
  const rateLimits = createGoalsCoachRateLimits({ memberSessionMax: 2, memberCloseMax: 2 });
  const running = await createMemberApp(disposable.pool, seeded.member.gymmaster_member_id, { rateLimits });
  t.after(() => running.close());

  for (let index = 0; index < 2; index += 1) {
    const session = await jsonRequest(running.url, "/goals-coach/session", { method: "POST" });
    assert.equal(session.response.status, 200);
    const closed = await jsonRequest(
      running.url,
      `/goals-coach/conversations/${session.body.conversation.id}/close`,
      { method: "POST" }
    );
    assert.equal(closed.response.status, 200);
  }
  const limited = await jsonRequest(running.url, "/goals-coach/session", { method: "POST" });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, "RATE_LIMITED");
});

test("test-harness responder stores deterministic messages and auto-assigns the active primary coach", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "test-responder");
  const admin = await seedStaff(disposable.pool, "route-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "route-coach", "coach", true);
  await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $3)`,
    [seeded.member.id, coach.id, admin.id]
  );
  const running = await createMemberApp(disposable.pool, seeded.member.gymmaster_member_id, {
    testOnlyResponder: fakeGoalsCoachResponder,
  });
  t.after(() => running.close());

  const session = await jsonRequest(running.url, "/goals-coach/session", { method: "POST" });
  assert.equal(session.body.coach.displayName, coach.display_name);
  assert.equal(session.body.coach.reference, `Coach ${coach.display_name}`);
  const sent = await jsonRequest(
    running.url,
    `/goals-coach/conversations/${session.body.conversation.id}/messages`,
    {
      method: "POST",
      body: {
        content: "I have sharp pain in this exercise",
        clientMessageId: "30875264-65a6-4cef-a4d4-c24db512b4ba",
      },
    }
  );
  assert.equal(sent.response.status, 201);
  assert.equal(sent.body.review.assignedStaffUserId, String(coach.id));
  assert.equal(sent.body.review.status, "assigned");

  const messages = await disposable.pool.query("SELECT * FROM coaching_messages ORDER BY id");
  assert.equal(messages.rows.length, 2);
  assert.equal(messages.rows[0].sender_type, "member");
  assert.equal(messages.rows[1].sender_type, "goals_coach");
  const concerns = await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_concerns");
  assert.equal(concerns.rows[0].count, 1);
});

test("review remains unassigned when no active primary coach exists and browser names are ignored", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "unassigned");
  const running = await createMemberApp(disposable.pool, seeded.member.gymmaster_member_id, {
    claimFirstName: "Derek",
    testOnlyResponder: fakeGoalsCoachResponder,
  });
  t.after(() => running.close());

  const session = await jsonRequest(running.url, "/goals-coach/session", { method: "POST" });
  assert.equal(session.body.coach.displayName, null);
  assert.equal(session.body.coach.reference, "one of our coaches");
  const sent = await jsonRequest(
    running.url,
    `/goals-coach/conversations/${session.body.conversation.id}/messages`,
    { method: "POST", body: { content: "This exercise hurts" } }
  );
  assert.equal(sent.body.review.assignedStaffUserId, null);
  assert.equal(sent.body.review.status, "awaiting_review");
});

test("conversation ownership is enforced and close is idempotent without deleting history", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const first = await seedMemberAndPlan(disposable.pool, "close-owner");
  const second = await seedMemberAndPlan(disposable.pool, "close-other");
  const ownerApp = await createMemberApp(disposable.pool, first.member.gymmaster_member_id, {
    testOnlyResponder: fakeGoalsCoachResponder,
  });
  const otherApp = await createMemberApp(disposable.pool, second.member.gymmaster_member_id);
  t.after(() => ownerApp.close());
  t.after(() => otherApp.close());

  const session = await jsonRequest(ownerApp.url, "/goals-coach/session", { method: "POST" });
  const conversationId = session.body.conversation.id;
  await jsonRequest(ownerApp.url, `/goals-coach/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { content: "Please remember this conversation" },
  });

  const otherRead = await jsonRequest(otherApp.url, `/goals-coach/conversations/${conversationId}/messages`);
  assert.equal(otherRead.response.status, 404);
  const otherClose = await jsonRequest(otherApp.url, `/goals-coach/conversations/${conversationId}/close`, { method: "POST" });
  assert.equal(otherClose.response.status, 404);

  const firstClose = await jsonRequest(ownerApp.url, `/goals-coach/conversations/${conversationId}/close`, { method: "POST" });
  assert.equal(firstClose.response.status, 200);
  assert.equal(firstClose.body.status, "archived");
  const archivedAt = firstClose.body.archivedAt;
  const secondClose = await jsonRequest(ownerApp.url, `/goals-coach/conversations/${conversationId}/close`, { method: "POST" });
  assert.equal(secondClose.response.status, 200);
  assert.equal(secondClose.body.status, "archived");
  assert.equal(String(secondClose.body.archivedAt), String(archivedAt));
  const messageCount = await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_messages WHERE conversation_id = $1",
    [conversationId]
  );
  assert.equal(messageCount.rows[0].count, 2);
});
