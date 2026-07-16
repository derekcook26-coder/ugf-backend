const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createGoalsCoachStaffRouter } = require("../src/goals-coach/staff-routes");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  createDisposableDatabase,
  seedMemberAndPlan,
  seedStaff,
} = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");

async function startStaffApp(pool, staffByKey) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const staff = staffByKey[req.get("X-Test-Staff")];
    if (!staff) return res.status(401).json({ error: "TEST_STAFF_REQUIRED" });
    req.staffUser = { id: String(staff.id), displayName: staff.display_name, role: staff.role };
    return next();
  });
  const requireAdmin = (req, res, next) => (
    req.staffUser.role === "admin" ? next() : res.status(403).json({ error: "ADMIN_ACCESS_REQUIRED" })
  );
  app.use("/staff", createGoalsCoachStaffRouter({ db: pool, requireAdmin }));
  app.use(goalsCoachErrorHandler);
  return startApp(app);
}

function requestAs(staffKey, method, body) {
  return { method, headers: { "X-Test-Staff": staffKey }, body };
}

async function seedContext(pool, suffix) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const conversation = await pool.query(
    "INSERT INTO coaching_conversations (member_id, plan_id) VALUES ($1, $2) RETURNING *",
    [seeded.member.id, seeded.plan.id]
  );
  const message = await pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Please consider this change') RETURNING *`,
    [conversation.rows[0].id, seeded.member.id]
  );
  return { ...seeded, conversation: conversation.rows[0], message: message.rows[0] };
}

async function seedObservation(pool, context, staff, status = "candidate", text = "Observation") {
  return (await pool.query(
    `INSERT INTO coaching_observations
      (member_id, category, observation_text, status, source_type,
       source_conversation_id, source_staff_user_id)
     VALUES ($1, 'lifestyle', $2, $3, 'staff', $4, $5) RETURNING *`,
    [context.member.id, text, status, context.conversation.id, staff.id]
  )).rows[0];
}

async function seedMilestone(pool, context, staff, status = "recorded", text = "Milestone") {
  const confirmed = status === "confirmed";
  return (await pool.query(
    `INSERT INTO coaching_milestones
      (member_id, milestone_type, milestone_text, status, source_type,
       source_conversation_id, source_staff_user_id,
       confirmed_by_staff_user_id, confirmed_at)
     VALUES ($1, 'consistency', $2, $3, 'staff', $4, $5, $6,
       CASE WHEN $6::bigint IS NULL THEN NULL ELSE NOW() END)
     RETURNING *`,
    [context.member.id, text, status, context.conversation.id, staff.id, confirmed ? staff.id : null]
  )).rows[0];
}

async function seedProposal(pool, context) {
  return (await pool.query(
    `INSERT INTO coaching_plan_change_proposals
      (member_id, conversation_id, request_message_id, source_plan_id,
       proposed_change_json, coaching_intent_json)
     VALUES ($1, $2, $3, $4, '{"change":"temporary"}'::jsonb, '{"pattern":"squat"}'::jsonb)
     RETURNING *`,
    [context.member.id, context.conversation.id, context.message.id, context.plan.id]
  )).rows[0];
}

test("observation routes enforce activate, confirm, correct, supersede, and retire lifecycles", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const context = await seedContext(disposable.pool, "observation-actions");
  const admin = await seedStaff(disposable.pool, "observation-admin", "admin", true);
  const running = await startStaffApp(disposable.pool, { admin });
  t.after(() => running.close());

  const activate = await seedObservation(disposable.pool, context, admin, "candidate", "activate");
  let response = await jsonRequest(running.url, `/staff/coaching-observations/${activate.id}`, requestAs("admin", "PATCH", { action: "activate" }));
  assert.equal(response.body.record.status, "active");

  const confirm = await seedObservation(disposable.pool, context, admin, "candidate", "confirm");
  response = await jsonRequest(running.url, `/staff/coaching-observations/${confirm.id}`, requestAs("admin", "PATCH", { action: "confirm" }));
  assert.equal(response.body.record.status, "confirmed");

  const retire = await seedObservation(disposable.pool, context, admin, "active", "retire");
  response = await jsonRequest(running.url, `/staff/coaching-observations/${retire.id}`, requestAs("admin", "PATCH", { action: "retire" }));
  assert.equal(response.body.record.status, "retired");

  const correct = await seedObservation(disposable.pool, context, admin, "confirmed", "incorrect");
  response = await jsonRequest(running.url, `/staff/coaching-observations/${correct.id}`, requestAs("admin", "PATCH", {
    action: "correct",
    correctedText: "Corrected observation",
    category: "work_schedule",
    sourceConversationId: String(context.conversation.id),
  }));
  assert.equal(response.response.status, 200);
  const corrected = await disposable.pool.query("SELECT * FROM coaching_observations WHERE id = $1", [response.body.record.id]);
  assert.equal(corrected.rows[0].observation_text, "Corrected observation");
  assert.equal(String(corrected.rows[0].supersedes_observation_id), String(correct.id));
  assert.equal((await disposable.pool.query("SELECT status FROM coaching_observations WHERE id = $1", [correct.id])).rows[0].status, "superseded");

  const superseded = await seedObservation(disposable.pool, context, admin, "candidate", "old");
  const replacement = await seedObservation(disposable.pool, context, admin, "active", "new");
  response = await jsonRequest(running.url, `/staff/coaching-observations/${superseded.id}`, requestAs("admin", "PATCH", {
    action: "supersede",
    replacementRecordId: String(replacement.id),
  }));
  assert.equal(response.response.status, 200);
  assert.equal((await disposable.pool.query("SELECT status FROM coaching_observations WHERE id = $1", [superseded.id])).rows[0].status, "superseded");

  const invalid = await jsonRequest(running.url, `/staff/coaching-observations/${retire.id}`, requestAs("admin", "PATCH", { action: "confirm" }));
  assert.equal(invalid.response.status, 409);
  assert.equal(invalid.body.error, "INVALID_LIFECYCLE_TRANSITION");
});

test("milestone routes enforce confirm, correct, supersede, and every withdraw transition", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const context = await seedContext(disposable.pool, "milestone-actions");
  const admin = await seedStaff(disposable.pool, "milestone-admin", "admin", true);
  const running = await startStaffApp(disposable.pool, { admin });
  t.after(() => running.close());

  const confirm = await seedMilestone(disposable.pool, context, admin, "recorded", "confirm");
  let response = await jsonRequest(running.url, `/staff/coaching-milestones/${confirm.id}`, requestAs("admin", "PATCH", { action: "confirm" }));
  assert.equal(response.body.record.status, "confirmed");

  for (const initialStatus of ["recorded", "confirmed"]) {
    const withdraw = await seedMilestone(disposable.pool, context, admin, initialStatus, `withdraw-${initialStatus}`);
    response = await jsonRequest(running.url, `/staff/coaching-milestones/${withdraw.id}`, requestAs("admin", "PATCH", { action: "withdraw" }));
    assert.equal(response.body.record.status, "withdrawn");
  }

  const correct = await seedMilestone(disposable.pool, context, admin, "confirmed", "incorrect milestone");
  response = await jsonRequest(running.url, `/staff/coaching-milestones/${correct.id}`, requestAs("admin", "PATCH", {
    action: "correct",
    correctedText: "Corrected milestone",
    milestoneType: "mobility",
    achievedOn: "2026-07-10",
    sourceConversationId: String(context.conversation.id),
  }));
  assert.equal(response.response.status, 200);
  const corrected = await disposable.pool.query("SELECT * FROM coaching_milestones WHERE id = $1", [response.body.record.id]);
  assert.equal(corrected.rows[0].milestone_text, "Corrected milestone");
  assert.equal(String(corrected.rows[0].supersedes_milestone_id), String(correct.id));

  const old = await seedMilestone(disposable.pool, context, admin, "recorded", "old");
  const replacement = await seedMilestone(disposable.pool, context, admin, "recorded", "replacement");
  response = await jsonRequest(running.url, `/staff/coaching-milestones/${old.id}`, requestAs("admin", "PATCH", {
    action: "supersede",
    replacementRecordId: String(replacement.id),
  }));
  assert.equal(response.response.status, 200);
  assert.equal((await disposable.pool.query("SELECT status FROM coaching_milestones WHERE id = $1", [old.id])).rows[0].status, "superseded");

  const invalid = await jsonRequest(running.url, `/staff/coaching-milestones/${confirm.id}`, requestAs("admin", "PATCH", { action: "confirm" }));
  assert.equal(invalid.response.status, 409);
});

test("plan proposal routes enforce approve, reject, and withdraw decisions only from proposed", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const context = await seedContext(disposable.pool, "proposal-actions");
  const admin = await seedStaff(disposable.pool, "proposal-admin", "admin", true);
  const running = await startStaffApp(disposable.pool, { admin });
  t.after(() => running.close());

  for (const [action, expected] of [["approve", "approved"], ["reject", "rejected"], ["withdraw", "withdrawn"]]) {
    const proposal = await seedProposal(disposable.pool, context);
    const response = await jsonRequest(running.url, `/staff/plan-change-proposals/${proposal.id}`, requestAs("admin", "PATCH", {
      action,
      note: action === "withdraw" ? undefined : `${action} after coaching review`,
    }));
    assert.equal(response.response.status, 200);
    assert.equal(response.body.record.status, expected);
  }
  const decided = await seedProposal(disposable.pool, context);
  await jsonRequest(running.url, `/staff/plan-change-proposals/${decided.id}`, requestAs("admin", "PATCH", {
    action: "approve",
    note: "approved once",
  }));
  const invalid = await jsonRequest(running.url, `/staff/plan-change-proposals/${decided.id}`, requestAs("admin", "PATCH", {
    action: "reject",
    note: "cannot decide twice",
  }));
  assert.equal(invalid.response.status, 409);
});

test("member-owned observation, milestone, and proposal records are concealed from unauthorized coaches", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const context = await seedContext(disposable.pool, "record-concealment");
  const admin = await seedStaff(disposable.pool, "conceal-admin", "admin", true);
  const outsider = await seedStaff(disposable.pool, "conceal-outsider", "coach", true);
  const observation = await seedObservation(disposable.pool, context, admin);
  const milestone = await seedMilestone(disposable.pool, context, admin);
  const proposal = await seedProposal(disposable.pool, context);
  const running = await startStaffApp(disposable.pool, { outsider });
  t.after(() => running.close());

  for (const request of [
    { path: `/staff/coaching-observations/${observation.id}`, body: { action: "confirm" } },
    { path: `/staff/coaching-milestones/${milestone.id}`, body: { action: "confirm" } },
    { path: `/staff/plan-change-proposals/${proposal.id}`, body: { action: "approve", note: "no access" } },
  ]) {
    const response = await jsonRequest(running.url, request.path, requestAs("outsider", "PATCH", request.body));
    assert.equal(response.response.status, 404);
  }
});
