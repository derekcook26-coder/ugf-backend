"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDisposableDatabase, seedMemberAndPlan } = require("./helpers/disposable-db");
const { createReviewRoutingService } = require("../src/goals-coach/review-routing");

async function seedReview(pool, suffix) {
  const { member, plan } = await seedMemberAndPlan(pool, suffix);
  const conversation = await pool.query(
    "INSERT INTO coaching_conversations (member_id, plan_id) VALUES ($1, $2) RETURNING *",
    [member.id, plan.id]
  );
  const message = await pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'synthetic private-alpha safety test') RETURNING *`,
    [conversation.rows[0].id, member.id]
  );
  const concern = await pool.query(
    `INSERT INTO coaching_concerns
      (member_id, conversation_id, source_message_id, plan_id, concern_category, safety_level)
     VALUES ($1, $2, $3, $4, 'safety', 'urgent') RETURNING *`,
    [member.id, conversation.rows[0].id, message.rows[0].id, plan.id]
  );
  const review = await pool.query(
    `INSERT INTO coaching_reviews
      (concern_id, member_id, conversation_id, plan_id, priority, review_category, status)
     VALUES ($1, $2, $3, $4, 'urgent', 'safety', 'new') RETURNING *`,
    [concern.rows[0].id, member.id, conversation.rows[0].id, plan.id]
  );
  return review.rows[0];
}

test("confirmed protected delivery records a minimized receipt and never copies conversation content", async (t) => {
  const disposable = await createDisposableDatabase({ phase1dSafety: true });
  t.after(() => disposable.close());
  const review = await seedReview(disposable.pool, "routing-success");
  let delivered;
  const routing = createReviewRoutingService({
    db: disposable.pool,
    synthetic: true,
    deliver: async (payload) => { delivered = payload; return { ok: true, receiptReference: "synthetic-receipt-1" }; },
  });
  const result = await routing.route(review);
  assert.deepEqual(result, { status: "delivered", receiptReference: "synthetic-receipt-1" });
  assert.deepEqual(Object.keys(delivered).sort(), ["category", "createdAt", "priority", "reviewId"]);
  const attempt = await disposable.pool.query("SELECT * FROM coaching_review_routing_attempts WHERE review_id = $1", [review.id]);
  assert.equal(attempt.rows[0].delivery_status, "delivered");
  assert.equal(attempt.rows[0].destination_receipt_reference, "synthetic-receipt-1");
  const updated = await disposable.pool.query("SELECT * FROM coaching_reviews WHERE id = $1", [review.id]);
  assert.equal(updated.rows[0].routing_status, "delivered");
  assert.equal(updated.rows[0].status, "routed");
});

test("delivery failure is visible and creates a traceable failed routing attempt", async (t) => {
  const disposable = await createDisposableDatabase({ phase1dSafety: true });
  t.after(() => disposable.close());
  const review = await seedReview(disposable.pool, "routing-failure");
  const routing = createReviewRoutingService({
    db: disposable.pool,
    deliver: async () => ({ ok: false, errorCode: "synthetic_destination_unavailable" }),
  });
  const result = await routing.route(review);
  assert.deepEqual(result, { status: "failed", errorCode: "synthetic_destination_unavailable" });
  const updated = await disposable.pool.query("SELECT * FROM coaching_reviews WHERE id = $1", [review.id]);
  assert.equal(updated.rows[0].routing_status, "failed");
  assert.equal(updated.rows[0].status, "routing_failed");
  const events = await disposable.pool.query("SELECT event_type FROM coaching_review_events WHERE review_id = $1 ORDER BY id", [review.id]);
  assert.deepEqual(events.rows.map((row) => row.event_type), ["route_attempted", "route_failed"]);
  const alerts = await disposable.pool.query(
    "SELECT alert_type, delivery_attempt_number FROM goals_coach_review_routing_alerts WHERE review_id = $1",
    [review.id]
  );
  assert.deepEqual(alerts.rows, [{ alert_type: "routing_failed", delivery_attempt_number: 1 }]);
});

test("failed primary delivery uses one minimized backup attempt and stops after the configured cap", async (t) => {
  const disposable = await createDisposableDatabase({ phase1dSafety: true });
  t.after(() => disposable.close());
  const review = await seedReview(disposable.pool, "routing-backup");
  const seen = [];
  const routing = createReviewRoutingService({
    db: disposable.pool,
    maxAttempts: 2,
    deliver: async (payload) => { seen.push({ type: "primary", payload }); return { ok: false, errorCode: "primary_unavailable" }; },
    backupDeliver: async (payload) => { seen.push({ type: "backup", payload }); return { ok: true, receiptReference: "backup-receipt" }; },
  });
  assert.deepEqual(await routing.route(review), {
    status: "delivered",
    receiptReference: "backup-receipt",
    fallbackUsed: true,
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(Object.keys(seen[0].payload).sort(), ["category", "createdAt", "priority", "reviewId"]);
  assert.deepEqual((await disposable.pool.query(
    "SELECT attempt_number, destination_type, delivery_status FROM coaching_review_routing_attempts WHERE review_id = $1 ORDER BY attempt_number",
    [review.id]
  )).rows, [
    { attempt_number: 1, destination_type: "protected_review_queue", delivery_status: "failed" },
    { attempt_number: 2, destination_type: "protected_review_backup", delivery_status: "delivered" },
  ]);
  assert.deepEqual(await routing.route(review), { status: "already_delivered" });
  assert.equal(seen.length, 2);
});
