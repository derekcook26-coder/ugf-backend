const assert = require("node:assert/strict");
const test = require("node:test");
const { createGoalsCoachService } = require("../src/goals-coach/service");
const { runRollback: runPhase1aRollback } = require("../rollback_003");
const { seedMemberAndPlan, seedStaff } = require("./helpers/disposable-db");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "embedded PostgreSQL refuses to run as root; run this suite as an unprivileged user"
  : false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function seedUnassignedReview(pool, seeded) {
  const conversation = await pool.query(
    "INSERT INTO coaching_conversations (member_id, plan_id) VALUES ($1, $2) RETURNING *",
    [seeded.member.id, seeded.plan.id]
  );
  const message = await pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Please review this') RETURNING *`,
    [conversation.rows[0].id, seeded.member.id]
  );
  const concern = await pool.query(
    `INSERT INTO coaching_concerns
      (member_id, conversation_id, source_message_id, plan_id, concern_category, safety_level)
     VALUES ($1, $2, $3, $4, 'other', 'routine') RETURNING *`,
    [seeded.member.id, conversation.rows[0].id, message.rows[0].id, seeded.plan.id]
  );
  const review = await pool.query(
    `INSERT INTO coaching_reviews
      (concern_id, member_id, conversation_id, plan_id, priority, review_category)
     VALUES ($1, $2, $3, $4, 'routine', 'other') RETURNING *`,
    [concern.rows[0].id, seeded.member.id, conversation.rows[0].id, seeded.plan.id]
  );
  return { conversation: conversation.rows[0], review: review.rows[0] };
}

test("simultaneous session creation returns one active conversation to both callers", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres();
  t.after(() => disposable.close());
  const version = await disposable.pool.query("SHOW server_version");
  assert.match(version.rows[0].server_version, /^16\./);
  const seeded = await seedMemberAndPlan(disposable.pool, "real-session-race");
  const service = createGoalsCoachService({ db: disposable.pool });
  const [first, second] = await Promise.all([
    service.startSession({ sub: seeded.member.gymmaster_member_id }),
    service.startSession({ sub: seeded.member.gymmaster_member_id }),
  ]);
  assert.equal(first.conversation.id, second.conversation.id);
  const count = await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM coaching_conversations
     WHERE member_id = $1 AND plan_id = $2 AND status = 'active'`,
    [seeded.member.id, seeded.plan.id]
  );
  assert.equal(count.rows[0].count, 1);
  const rolledBack = await runPhase1aRollback({ pool: disposable.pool, skipConfirmation: true });
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_conversations WHERE id = $1",
    [first.conversation.id]
  )).rows[0].count, 1);
});

test("concurrent duplicate staff messages store one message and one review event", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "real-message-race");
  const admin = await seedStaff(disposable.pool, "real-message-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "real-message-coach", "coach", true);
  await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $3)`,
    [seeded.member.id, coach.id, admin.id]
  );
  const data = await seedUnassignedReview(disposable.pool, seeded);
  await disposable.pool.query(
    "UPDATE coaching_reviews SET assigned_staff_user_id = $1, status = 'assigned' WHERE id = $2",
    [coach.id, data.review.id]
  );
  const service = createGoalsCoachService({ db: disposable.pool });
  const staffUser = { id: String(coach.id), role: "coach" };
  const input = {
    content: "One idempotent staff message",
    clientMessageId: "c0a4ac53-a435-486f-b23a-b60a6a3dc019",
  };
  const [first, second] = await Promise.all([
    service.addStaffMessage(staffUser, String(data.conversation.id), input),
    service.addStaffMessage(staffUser, String(data.conversation.id), input),
  ]);
  assert.equal(first.message.id, second.message.id);
  assert.deepEqual([first.idempotentReplay, second.idempotentReplay].sort(), [false, true]);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_messages WHERE client_message_id = $1",
    [input.clientMessageId]
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_review_events WHERE event_type = 'staff_message_added'"
  )).rows[0].count, 1);
});

for (const order of ["assign-first", "end-first"]) {
  test(`assignment termination race remains valid when ${order}`, { skip: skipForRoot }, async (t) => {
    const disposable = await createRealDisposablePostgres();
    t.after(() => disposable.close());
    const seeded = await seedMemberAndPlan(disposable.pool, `real-assignment-${order}`);
    const admin = await seedStaff(disposable.pool, `real-admin-${order}`, "admin", true);
    const coach = await seedStaff(disposable.pool, `real-coach-${order}`, "coach", true);
    const assignment = await disposable.pool.query(
      `INSERT INTO member_coach_assignments
        (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
       VALUES ($1, $2, 'primary', $3) RETURNING *`,
      [seeded.member.id, coach.id, admin.id]
    );
    const data = await seedUnassignedReview(disposable.pool, seeded);
    const service = createGoalsCoachService({ db: disposable.pool });
    const adminUser = { id: String(admin.id), role: "admin" };
    const assign = () => service.updateReview(adminUser, String(data.review.id), {
      action: "assign",
      staffUserId: String(coach.id),
    });
    const end = () => service.endAssignment(adminUser, String(assignment.rows[0].id));
    const operations = order === "assign-first"
      ? [assign(), delay(40).then(end)]
      : [end(), delay(40).then(assign)];
    const results = await Promise.allSettled(operations);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const finalAssignment = await disposable.pool.query(
      "SELECT status FROM member_coach_assignments WHERE id = $1",
      [assignment.rows[0].id]
    );
    const finalReview = await disposable.pool.query(
      "SELECT status, assigned_staff_user_id FROM coaching_reviews WHERE id = $1",
      [data.review.id]
    );
    const validAssignedState = finalAssignment.rows[0].status === "active"
      && String(finalReview.rows[0].assigned_staff_user_id) === String(coach.id)
      && finalReview.rows[0].status === "assigned";
    const validEndedState = finalAssignment.rows[0].status === "ended"
      && finalReview.rows[0].assigned_staff_user_id === null
      && finalReview.rows[0].status === "awaiting_review";
    assert.equal(validAssignedState || validEndedState, true);
  });
}
