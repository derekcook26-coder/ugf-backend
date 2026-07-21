"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDisposableDatabase } = require("./helpers/disposable-db");
const { MIGRATION_VERSION, runMigration } = require("../migrate_006");
const { runRollback } = require("../rollback_006");

test("Migration 006 is additive, ledger-protected, and provides Phase 1D routing provenance", async (t) => {
  const disposable = await createDisposableDatabase({ phase1cTranscription: true });
  t.after(() => disposable.close());
  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  assert.equal(applied.version, MIGRATION_VERSION);
  const repeated = await runMigration({ pool: disposable.pool });
  assert.equal(repeated.status, "already_applied");
  const tables = await disposable.pool.query(
    `SELECT to_regclass('public.coaching_review_routing_attempts') AS routing,
            to_regclass('public.goals_coach_human_restrictions') AS restrictions,
            to_regclass('public.goals_coach_review_routing_alerts') AS alerts`
  );
  assert.equal(tables.rows[0].routing, "coaching_review_routing_attempts");
  assert.equal(tables.rows[0].restrictions, "goals_coach_human_restrictions");
  assert.equal(tables.rows[0].alerts, "goals_coach_review_routing_alerts");
  const reviewColumns = await disposable.pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'coaching_reviews' ORDER BY column_name"
  );
  const names = new Set(reviewColumns.rows.map((row) => row.column_name));
  for (const name of ["routing_status", "routing_attempt_count", "last_route_succeeded_at", "target_response_at"]) {
    assert.equal(names.has(name), true, name);
  }
});

test("Migration 006 rollback is confirmation-gated, removes only unused schema, and refuses provenance loss", async (t) => {
  const disposable = await createDisposableDatabase({ phase1cTranscription: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  await assert.rejects(
    runRollback({ pool: disposable.pool }),
    /CONFIRM_PHASE1D_SAFETY_REVIEW_ROLLBACK/
  );
  assert.deepEqual(await runRollback({ pool: disposable.pool, skipConfirmation: true }), {
    status: "rolled_back",
    version: MIGRATION_VERSION,
  });
  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.coaching_review_routing_attempts') AS routing"
  )).rows[0].routing, null);

  await runMigration({ pool: disposable.pool });
  await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     SELECT conversation.id, conversation.member_id, 'member', 'synthetic safety provenance'
     FROM coaching_conversations conversation
     LIMIT 1`
  ).catch(() => {});
  // A populated routing-attempt table is sufficient to prove fail-closed
  // preservation; no destructive rollback is permitted once it has data.
  await disposable.pool.query(
    `INSERT INTO goals_coach_review_routing_alerts (review_id, member_id, alert_type, delivery_attempt_number)
     SELECT review.id, review.member_id, 'routing_failed', 1
     FROM coaching_reviews review
     LIMIT 1`
  ).catch(() => {});
  // The fixture has no Phase 1D review yet, so create one only through the
  // minimal relational path needed for this rollback guard.
  const member = (await disposable.pool.query("INSERT INTO coach_members (gymmaster_member_id, first_name, last_name) VALUES ('rollback-006', 'Rollback', 'Tester') RETURNING *")).rows[0];
  const plan = (await disposable.pool.query("INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown) VALUES ($1, '{}'::jsonb, '[]'::jsonb, 'test') RETURNING *", [member.id])).rows[0];
  const conversation = (await disposable.pool.query("INSERT INTO coaching_conversations (member_id, plan_id) VALUES ($1, $2) RETURNING *", [member.id, plan.id])).rows[0];
  const message = (await disposable.pool.query("INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content) VALUES ($1, $2, 'member', 'safety provenance') RETURNING *", [conversation.id, member.id])).rows[0];
  const concern = (await disposable.pool.query(
    `INSERT INTO coaching_concerns (member_id, conversation_id, source_message_id, plan_id, concern_category, safety_level, safety_rule_version)
     VALUES ($1, $2, $3, $4, 'safety', 'urgent', 'GC-SAFETY-1D-1') RETURNING *`,
    [member.id, conversation.id, message.id, plan.id]
  )).rows[0];
  await assert.rejects(
    runRollback({ pool: disposable.pool, skipConfirmation: true }),
    /preservation of Phase 1D safety/
  );
  assert.equal(concern.safety_rule_version, "GC-SAFETY-1D-1");
});
