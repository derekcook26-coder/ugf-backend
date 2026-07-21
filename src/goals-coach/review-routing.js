"use strict";

const { withTransaction } = require("./repository");

function boundedText(value, fallback) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.slice(0, 100) || fallback;
}

function boundedAttempts(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 2;
}

function createReviewRoutingService(options) {
  const db = options.db;
  const deliver = options.deliver;
  const backupDeliver = options.backupDeliver || null;
  const destinationType = boundedText(options.destinationType, "protected_review_queue");
  const backupDestinationType = boundedText(options.backupDestinationType, "protected_review_backup");
  const maxAttempts = boundedAttempts(options.maxAttempts);

  if (!db || typeof db.connect !== "function") {
    throw new Error("Review routing requires a database pool");
  }
  if (typeof deliver !== "function") {
    throw new Error("Review routing requires a delivery adapter");
  }

  async function createAlert(client, review, alertType, attemptNumber, errorCode) {
    await client.query(
      `INSERT INTO goals_coach_review_routing_alerts
        (review_id, member_id, alert_type, delivery_attempt_number, error_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (review_id, alert_type, delivery_attempt_number) DO NOTHING`,
      [review.id, review.member_id, alertType, attemptNumber, errorCode || null]
    );
  }

  async function createAttempt(review, type) {
    return withTransaction(db, async (client) => {
      const locked = await client.query("SELECT * FROM coaching_reviews WHERE id = $1 FOR UPDATE", [review.id]);
      if (!locked.rows.length) throw new Error("Review was not found for routing");
      const current = locked.rows[0];
      if (current.routing_status === "delivered") {
        return { alreadyDelivered: true, review: current };
      }
      const attemptNumber = Number(current.routing_attempt_count) + 1;
      if (attemptNumber > maxAttempts) {
        await createAlert(client, current, "routing_exhausted", Number(current.routing_attempt_count), current.routing_error_code);
        return { exhausted: true, review: current };
      }
      const inserted = await client.query(
        `INSERT INTO coaching_review_routing_attempts
          (review_id, member_id, attempt_number, destination_type, delivery_status, payload_summary_json)
         VALUES ($1, $2, $3, $4, 'attempted', $5)
         RETURNING *`,
        [
          current.id,
          current.member_id,
          attemptNumber,
          type,
          {
            priority: current.priority,
            category: current.review_category,
            reviewReference: String(current.id),
            synthetic: Boolean(options.synthetic),
          },
        ]
      );
      await client.query(
        `UPDATE coaching_reviews
         SET routing_status = 'attempting', routing_attempt_count = $1,
             route_destination_type = $2, last_route_attempt_at = NOW(), updated_at = NOW()
         WHERE id = $3`,
        [attemptNumber, type, current.id]
      );
      await client.query(
        `INSERT INTO coaching_review_events (review_id, member_id, event_type, event_details_json)
         VALUES ($1, $2, 'route_attempted', $3)`,
        [current.id, current.member_id, { attemptNumber, destinationType: type }]
      );
      return { review: current, attempt: inserted.rows[0] };
    });
  }

  async function invoke(deliveryAdapter, created) {
    try {
      // Deliberately minimized: no transcript, raw audio, health history, or auth data.
      return await deliveryAdapter({
        reviewId: String(created.review.id),
        priority: created.review.priority,
        category: created.review.review_category,
        createdAt: created.review.created_at,
      });
    } catch (error) {
      return { ok: false, errorCode: boundedText(error && error.code, "delivery_failed") };
    }
  }

  async function recordDelivery(created, delivery) {
    const receipt = delivery && delivery.ok && boundedText(delivery.receiptReference, "");
    return withTransaction(db, async (client) => {
      if (receipt) {
        const updated = await client.query(
          `UPDATE coaching_review_routing_attempts
           SET delivery_status = 'delivered', completed_at = NOW(), destination_receipt_reference = $1
           WHERE id = $2 AND delivery_status = 'attempted'
           RETURNING *`,
          [receipt, created.attempt.id]
        );
        if (!updated.rows.length) throw new Error("Routing attempt changed before delivery confirmation");
        await client.query(
          `UPDATE coaching_reviews
           SET routing_status = 'delivered', last_route_succeeded_at = NOW(), routing_error_code = NULL,
               status = CASE WHEN status IN ('new', 'awaiting_review', 'routing_failed') THEN 'routed' ELSE status END,
               updated_at = NOW()
           WHERE id = $1`,
          [created.review.id]
        );
        await client.query(
          `INSERT INTO coaching_review_events (review_id, member_id, event_type, event_details_json)
           VALUES ($1, $2, 'route_succeeded', $3)`,
          [created.review.id, created.review.member_id, {
            attemptNumber: created.attempt.attempt_number,
            destinationType: created.attempt.destination_type,
          }]
        );
        return { status: "delivered", receiptReference: receipt };
      }
      const errorCode = boundedText(delivery && delivery.errorCode, "delivery_unconfirmed");
      await client.query(
        `UPDATE coaching_review_routing_attempts
         SET delivery_status = 'failed', completed_at = NOW(), error_code = $1
         WHERE id = $2 AND delivery_status = 'attempted'`,
        [errorCode, created.attempt.id]
      );
      await client.query(
        `UPDATE coaching_reviews
         SET routing_status = 'failed', routing_error_code = $1,
             status = CASE WHEN status IN ('new', 'awaiting_review') THEN 'routing_failed' ELSE status END,
             updated_at = NOW()
         WHERE id = $2`,
        [errorCode, created.review.id]
      );
      await client.query(
        `INSERT INTO coaching_review_events (review_id, member_id, event_type, event_details_json)
         VALUES ($1, $2, 'route_failed', $3)`,
        [created.review.id, created.review.member_id, {
          attemptNumber: created.attempt.attempt_number,
          destinationType: created.attempt.destination_type,
          errorCode,
        }]
      );
      await createAlert(client, created.review, "routing_failed", created.attempt.attempt_number, errorCode);
      return { status: "failed", errorCode };
    });
  }

  async function route(review) {
    const primary = await createAttempt(review, destinationType);
    if (primary.alreadyDelivered) return { status: "already_delivered" };
    if (primary.exhausted) return { status: "exhausted", errorCode: primary.review.routing_error_code || null };
    const primaryResult = await recordDelivery(primary, await invoke(deliver, primary));
    if (primaryResult.status === "delivered" || !backupDeliver) return primaryResult;

    const fallback = await createAttempt(review, backupDestinationType);
    if (fallback.exhausted) return { status: "exhausted", errorCode: primaryResult.errorCode };
    if (fallback.alreadyDelivered) return { status: "already_delivered" };
    const fallbackResult = await recordDelivery(fallback, await invoke(backupDeliver, fallback));
    return fallbackResult.status === "delivered"
      ? { ...fallbackResult, fallbackUsed: true }
      : fallbackResult;
  }

  return Object.freeze({ route });
}

module.exports = { createReviewRoutingService };
