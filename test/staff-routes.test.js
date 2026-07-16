const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createGoalsCoachStaffRouter } = require("../src/goals-coach/staff-routes");
const { createGoalsCoachRateLimits } = require("../src/goals-coach/rate-limits");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
  seedStaff,
} = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");

async function seedReview(pool, seeded, assignedStaffUserId = null, options = {}) {
  const conversation = await pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id, assigned_staff_user_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [seeded.member.id, seeded.plan.id, assignedStaffUserId]
  );
  const message = await pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'This movement hurts') RETURNING *`,
    [conversation.rows[0].id, seeded.member.id]
  );
  const concern = await pool.query(
    `INSERT INTO coaching_concerns
      (member_id, conversation_id, source_message_id, plan_id, concern_category,
       safety_level, stop_exercise, member_follow_up_required, member_follow_up_status)
     VALUES ($1, $2, $3, $4, 'pain', 'priority', TRUE, $5, $6) RETURNING *`,
    [
      seeded.member.id,
      conversation.rows[0].id,
      message.rows[0].id,
      seeded.plan.id,
      Boolean(options.memberFollowUpRequired),
      options.memberFollowUpRequired ? "pending" : "not_required",
    ]
  );
  const review = await pool.query(
    `INSERT INTO coaching_reviews
      (concern_id, member_id, conversation_id, plan_id, priority,
       review_category, status, assigned_staff_user_id,
       member_follow_up_required, member_follow_up_status)
     VALUES ($1, $2, $3, $4, 'priority', 'pain', $5, $6, $7, $8)
     RETURNING *`,
    [
      concern.rows[0].id,
      seeded.member.id,
      conversation.rows[0].id,
      seeded.plan.id,
      assignedStaffUserId ? "assigned" : "awaiting_review",
      assignedStaffUserId,
      Boolean(options.memberFollowUpRequired),
      options.memberFollowUpRequired ? "pending" : "not_required",
    ]
  );
  await pool.query(
    `INSERT INTO coaching_review_events (review_id, member_id, event_type)
     VALUES ($1, $2, 'created')`,
    [review.rows[0].id, seeded.member.id]
  );
  return { conversation: conversation.rows[0], review: review.rows[0] };
}

async function createStaffApp(pool, staffByKey, options = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const staff = staffByKey[req.get("X-Test-Staff")];
    if (!staff) return res.status(401).json({ error: "TEST_STAFF_REQUIRED" });
    req.staffUser = {
      id: String(staff.id),
      displayName: staff.display_name,
      role: staff.role,
    };
    return next();
  });
  const requireAdmin = (req, res, next) => (
    req.staffUser.role === "admin"
      ? next()
      : res.status(403).json({ error: "ADMIN_ACCESS_REQUIRED" })
  );
  app.use("/staff", createGoalsCoachStaffRouter({
    db: pool,
    requireAdmin,
    rateLimits: options.rateLimits,
  }));
  app.use(goalsCoachErrorHandler);
  return startApp(app);
}

function asStaff(key, extra = {}) {
  return { headers: { "X-Test-Staff": key }, ...extra };
}

test("coaches see only assigned reviews for members in active assignments; admins own the shared queue", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "staff-access");
  const unassignedMember = await seedMemberAndPlan(disposable.pool, "staff-unassigned");
  const admin = await seedStaff(disposable.pool, "staff-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "staff-coach-a", "coach", true);
  const otherCoach = await seedStaff(disposable.pool, "staff-coach-b", "coach", true);
  await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $3), ($1, $4, 'secondary', $3)`,
    [seeded.member.id, coach.id, admin.id, otherCoach.id]
  );
  const assigned = await seedReview(disposable.pool, seeded, coach.id);
  const unassigned = await seedReview(disposable.pool, unassignedMember, null);
  const running = await createStaffApp(disposable.pool, { admin, coach, otherCoach });
  t.after(() => running.close());

  const coachQueue = await jsonRequest(running.url, "/staff/coaching-reviews", asStaff("coach"));
  assert.deepEqual(coachQueue.body.reviews.map((review) => review.id), [String(assigned.review.id)]);
  const otherQueue = await jsonRequest(running.url, "/staff/coaching-reviews", asStaff("otherCoach"));
  assert.equal(otherQueue.body.reviews.length, 0);
  const otherDetail = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${assigned.review.id}`,
    asStaff("otherCoach")
  );
  assert.equal(otherDetail.response.status, 404);

  const coachUnassigned = await jsonRequest(
    running.url,
    "/staff/coaching-reviews?queue=unassigned",
    asStaff("coach")
  );
  assert.equal(coachUnassigned.response.status, 403);
  const adminUnassigned = await jsonRequest(
    running.url,
    "/staff/coaching-reviews?queue=unassigned",
    asStaff("admin")
  );
  assert.deepEqual(adminUnassigned.body.reviews.map((review) => review.id), [String(unassigned.review.id)]);
});

test("only admins assign reviews and target coaches must actively cover the member", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "staff-assign");
  const admin = await seedStaff(disposable.pool, "assign-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "assign-coach", "coach", true);
  const reviewData = await seedReview(disposable.pool, seeded, null);
  const running = await createStaffApp(disposable.pool, { admin, coach });
  t.after(() => running.close());

  const coachClaim = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${reviewData.review.id}`,
    asStaff("coach", {
      method: "PATCH",
      body: { action: "assign", staffUserId: String(coach.id) },
    })
  );
  assert.equal(coachClaim.response.status, 403);

  const adminBeforeAssignment = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${reviewData.review.id}`,
    asStaff("admin", {
      method: "PATCH",
      body: { action: "assign", staffUserId: String(coach.id) },
    })
  );
  assert.equal(adminBeforeAssignment.response.status, 409);
  assert.equal(adminBeforeAssignment.body.error, "ASSIGNEE_NOT_ACTIVE_FOR_MEMBER");

  const assignment = await jsonRequest(
    running.url,
    "/staff/member-coach-assignments",
    asStaff("admin", {
      method: "POST",
      body: {
        memberId: String(seeded.member.id),
        staffUserId: String(coach.id),
        assignmentType: "primary",
      },
    })
  );
  assert.equal(assignment.response.status, 201);
  const assigned = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${reviewData.review.id}`,
    asStaff("admin", {
      method: "PATCH",
      body: { action: "assign", staffUserId: String(coach.id) },
    })
  );
  assert.equal(assigned.response.status, 200);
  assert.equal(assigned.body.review.assignedStaffUserId, String(coach.id));
});

test("an assignment cannot end until its open review is reassigned or resolved", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "staff-end");
  const admin = await seedStaff(disposable.pool, "end-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "end-coach", "coach", true);
  const replacement = await seedStaff(disposable.pool, "end-replacement", "coach", true);
  const assignments = await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $4), ($1, $3, 'secondary', $4)
     RETURNING *`,
    [seeded.member.id, coach.id, replacement.id, admin.id]
  );
  const coachAssignment = assignments.rows.find((row) => String(row.staff_user_id) === String(coach.id));
  const reviewData = await seedReview(disposable.pool, seeded, coach.id);
  const running = await createStaffApp(disposable.pool, { admin, coach, replacement });
  t.after(() => running.close());

  const blockedEnd = await jsonRequest(
    running.url,
    `/staff/member-coach-assignments/${coachAssignment.id}`,
    asStaff("admin", { method: "PATCH", body: { action: "end" } })
  );
  assert.equal(blockedEnd.response.status, 409);
  assert.equal(blockedEnd.body.error, "REVIEW_REASSIGNMENT_REQUIRED");

  const reassigned = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${reviewData.review.id}`,
    asStaff("admin", {
      method: "PATCH",
      body: { action: "reassign", staffUserId: String(replacement.id) },
    })
  );
  assert.equal(reassigned.response.status, 200);
  assert.equal(reassigned.body.review.assignedStaffUserId, String(replacement.id));

  const ended = await jsonRequest(
    running.url,
    `/staff/member-coach-assignments/${coachAssignment.id}`,
    asStaff("admin", { method: "PATCH", body: { action: "end" } })
  );
  assert.equal(ended.response.status, 200);
  assert.equal(ended.body.assignment.status, "ended");
});

test("Phase 2 exposes no plan-apply or message/review-event mutation routes", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const admin = await seedStaff(disposable.pool, "no-routes-admin", "admin", true);
  const running = await createStaffApp(disposable.pool, { admin });
  t.after(() => running.close());

  for (const request of [
    { method: "POST", path: "/staff/plan-change-proposals/1/apply" },
    { method: "PATCH", path: "/staff/coaching-messages/1" },
    { method: "DELETE", path: "/staff/coaching-messages/1" },
    { method: "PATCH", path: "/staff/coaching-review-events/1" },
    { method: "DELETE", path: "/staff/coaching-review-events/1" },
  ]) {
    const result = await jsonRequest(running.url, request.path, asStaff("admin", { method: request.method }));
    assert.equal(result.response.status, 404);
  }
});

test("staff messages require idempotency keys, conceal member resources, and create one event", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "staff-message");
  const admin = await seedStaff(disposable.pool, "message-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "message-coach", "coach", true);
  const outsider = await seedStaff(disposable.pool, "message-outsider", "coach", true);
  await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $3)`,
    [seeded.member.id, coach.id, admin.id]
  );
  const reviewData = await seedReview(disposable.pool, seeded, coach.id);
  const running = await createStaffApp(disposable.pool, { admin, coach, outsider });
  t.after(() => running.close());

  const missingKey = await jsonRequest(
    running.url,
    `/staff/coaching-conversations/${reviewData.conversation.id}/messages`,
    asStaff("coach", { method: "POST", body: { content: "Checking in" } })
  );
  assert.equal(missingKey.response.status, 400);

  const outsiderAttempt = await jsonRequest(
    running.url,
    `/staff/coaching-conversations/${reviewData.conversation.id}/messages`,
    asStaff("outsider", {
      method: "POST",
      body: {
        content: "I should not see this",
        clientMessageId: "49c429e9-8cb2-4a17-b151-418305f3ea71",
      },
    })
  );
  assert.equal(outsiderAttempt.response.status, 404);

  const body = {
    content: "I made a note so we can follow up.",
    clientMessageId: "96de033f-b7f8-4228-a22b-9cd79e0da682",
  };
  const first = await jsonRequest(
    running.url,
    `/staff/coaching-conversations/${reviewData.conversation.id}/messages`,
    asStaff("coach", { method: "POST", body })
  );
  const retry = await jsonRequest(
    running.url,
    `/staff/coaching-conversations/${reviewData.conversation.id}/messages`,
    asStaff("coach", { method: "POST", body })
  );
  assert.equal(first.response.status, 201);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.idempotentReplay, true);
  assert.equal(retry.body.message.id, first.body.message.id);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_messages WHERE client_message_id = $1",
    [body.clientMessageId]
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_review_events WHERE event_type = 'staff_message_added'"
  )).rows[0].count, 1);
});

test("review start, required follow-up, and completion synchronize the linked concern", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "review-follow-up");
  const admin = await seedStaff(disposable.pool, "follow-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "follow-coach", "coach", true);
  await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $3)`,
    [seeded.member.id, coach.id, admin.id]
  );
  const reviewData = await seedReview(disposable.pool, seeded, coach.id, { memberFollowUpRequired: true });
  const running = await createStaffApp(disposable.pool, { admin, coach });
  t.after(() => running.close());

  const started = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${reviewData.review.id}`,
    asStaff("coach", { method: "PATCH", body: { action: "start" } })
  );
  assert.equal(started.response.status, 200);
  assert.equal(started.body.review.status, "in_review");
  let concern = await disposable.pool.query(
    "SELECT * FROM coaching_concerns WHERE id = $1",
    [reviewData.review.concern_id]
  );
  assert.equal(concern.rows[0].status, "reviewing");

  const premature = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${reviewData.review.id}`,
    asStaff("coach", {
      method: "PATCH",
      body: { action: "resolve", resolutionNote: "Not actually followed up" },
    })
  );
  assert.equal(premature.response.status, 409);
  assert.equal(premature.body.error, "MEMBER_FOLLOW_UP_REQUIRED");

  const followedUp = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${reviewData.review.id}`,
    asStaff("coach", { method: "PATCH", body: { action: "complete_follow_up" } })
  );
  assert.equal(followedUp.response.status, 200);
  assert.equal(followedUp.body.review.memberFollowUpStatus, "completed");
  concern = await disposable.pool.query("SELECT * FROM coaching_concerns WHERE id = $1", [reviewData.review.concern_id]);
  assert.equal(concern.rows[0].member_follow_up_status, "completed");

  const resolved = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${reviewData.review.id}`,
    asStaff("coach", {
      method: "PATCH",
      body: { action: "resolve", resolutionNote: "Member follow-up completed" },
    })
  );
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.body.review.status, "resolved");
  concern = await disposable.pool.query("SELECT * FROM coaching_concerns WHERE id = $1", [reviewData.review.concern_id]);
  assert.equal(concern.rows[0].status, "resolved");
  assert.ok(concern.rows[0].resolved_at);

  const secondMember = await seedMemberAndPlan(disposable.pool, "review-no-action");
  await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $3)`,
    [secondMember.member.id, coach.id, admin.id]
  );
  const noActionData = await seedReview(disposable.pool, secondMember, coach.id);
  const noAction = await jsonRequest(
    running.url,
    `/staff/coaching-reviews/${noActionData.review.id}`,
    asStaff("coach", {
      method: "PATCH",
      body: { action: "no_action_needed", resolutionNote: "No plan change needed" },
    })
  );
  assert.equal(noAction.response.status, 200);
  assert.equal(noAction.body.review.status, "no_action_needed");
  const noActionConcern = await disposable.pool.query(
    "SELECT status FROM coaching_concerns WHERE id = $1",
    [noActionData.review.concern_id]
  );
  assert.equal(noActionConcern.rows[0].status, "resolved");
});

test("staff Coaching Review cursor pages are stable without duplicates or skipped records", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const admin = await seedStaff(disposable.pool, "page-admin", "admin", true);
  for (let index = 0; index < 5; index += 1) {
    const seeded = await seedMemberAndPlan(disposable.pool, `review-page-${index}`);
    const data = await seedReview(disposable.pool, seeded, null);
    await disposable.pool.query(
      `UPDATE coaching_reviews
       SET priority = $1, created_at = NOW() - ($2 * INTERVAL '1 minute')
       WHERE id = $3`,
      [index % 2 === 0 ? "priority" : "caution", index, data.review.id]
    );
  }
  const running = await createStaffApp(disposable.pool, { admin });
  t.after(() => running.close());

  const ids = [];
  let cursor = null;
  do {
    const page = await jsonRequest(
      running.url,
      `/staff/coaching-reviews?queue=unassigned&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      asStaff("admin")
    );
    assert.equal(page.response.status, 200);
    ids.push(...page.body.reviews.map((review) => review.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
});

test("protected staff mutations use a separate staff-scoped rate limit", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const admin = await seedStaff(disposable.pool, "rate-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "rate-coach", "coach", true);
  const rateLimits = createGoalsCoachRateLimits({ staffMutationMax: 2 });
  const running = await createStaffApp(disposable.pool, { admin, coach }, { rateLimits });
  t.after(() => running.close());

  for (let index = 0; index < 2; index += 1) {
    const seeded = await seedMemberAndPlan(disposable.pool, `rate-${index}`);
    const response = await jsonRequest(
      running.url,
      "/staff/member-coach-assignments",
      asStaff("admin", {
        method: "POST",
        body: {
          memberId: String(seeded.member.id),
          staffUserId: String(coach.id),
          assignmentType: "primary",
        },
      })
    );
    assert.equal(response.response.status, 201);
  }
  const seeded = await seedMemberAndPlan(disposable.pool, "rate-limited");
  const limited = await jsonRequest(
    running.url,
    "/staff/member-coach-assignments",
    asStaff("admin", {
      method: "POST",
      body: {
        memberId: String(seeded.member.id),
        staffUserId: String(coach.id),
        assignmentType: "primary",
      },
    })
  );
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, "RATE_LIMITED");
});
