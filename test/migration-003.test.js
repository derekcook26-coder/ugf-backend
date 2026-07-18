const assert = require("node:assert/strict");
const test = require("node:test");
const { runMigration } = require("../migrate_003");
const { runRollback } = require("../rollback_003");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
  seedStaff,
} = require("./helpers/disposable-db");

test("migration 003 requires migration 002", async (t) => {
  const disposable = await createDisposableDatabase({ phase2: false });
  t.after(() => disposable.close());
  await assert.rejects(
    runMigration({ pool: disposable.pool }),
    /Migration 002 must be applied before Migration 003/
  );
});

test("migration 003 is additive, checksummed, idempotent, and reversible with populated Phase 2 data", async (t) => {
  const disposable = await createDisposableDatabase();
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, "migration-003-existing");
  const staff = await seedStaff(disposable.pool, "migration-003-existing", "admin", true);
  const conversation = await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  );
  const message = await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Synthetic existing message') RETURNING *`,
    [conversation.rows[0].id, seeded.member.id]
  );
  await disposable.pool.query(
    `INSERT INTO member_coach_assignments
      (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
     VALUES ($1, $2, 'primary', $2)`,
    [seeded.member.id, staff.id]
  );

  const before = {
    members: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_members")).rows[0].count,
    plans: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_plans")).rows[0].count,
    conversations: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_conversations")).rows[0].count,
    messages: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages")).rows[0].count,
    assignments: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM member_coach_assignments")).rows[0].count,
  };

  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  assert.match(applied.checksum, /^[a-f0-9]{64}$/);
  const reapplied = await runMigration({ pool: disposable.pool });
  assert.equal(reapplied.status, "already_applied");
  assert.equal(reapplied.checksum, applied.checksum);
  assert.equal((await disposable.pool.query(
    "SELECT checksum FROM app_schema_migrations WHERE version = '003_goals_coach_alpha_foundation'"
  )).rows[0].checksum, applied.checksum);

  for (const [table, expected] of [
    ["coach_members", before.members],
    ["coach_plans", before.plans],
    ["coaching_conversations", before.conversations],
    ["coaching_messages", before.messages],
    ["member_coach_assignments", before.assignments],
  ]) {
    assert.equal((await disposable.pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count, expected);
  }
  assert.equal(String(message.rows[0].id), String((await disposable.pool.query(
    "SELECT id FROM coaching_messages WHERE id = $1", [message.rows[0].id]
  )).rows[0].id));

  const rolledBack = await runRollback({ pool: disposable.pool, skipConfirmation: true });
  assert.equal(rolledBack.status, "rolled_back");
  for (const table of [
    "goals_coach_member_auth_mappings",
    "goals_coach_alpha_consents",
    "goals_coach_alpha_consent_events",
    "goals_coach_member_preferences",
    "goals_coach_alpha_feedback",
  ]) {
    assert.equal((await disposable.pool.query("SELECT to_regclass($1) AS name", [`public.${table}`])).rows[0].name, null);
  }
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_members")).rows[0].count, before.members);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_plans")).rows[0].count, before.plans);
  assert.equal((await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages")).rows[0].count, before.messages);
});

test("migration 003 enforces unambiguous mapping, member ownership, and append-only consent events", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  const first = await seedMemberAndPlan(disposable.pool, "migration-map-a");
  const second = await seedMemberAndPlan(disposable.pool, "migration-map-b");
  const firstMapping = await seedAlphaMapping(disposable.pool, first.member, "migration-map", true);

  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_member_auth_mappings
        (member_id, auth_provider, auth_subject, verified_email_snapshot,
         active, provisioning_method, provisioning_reference)
       VALUES ($1, 'clerk', $2, 'other@example.test', FALSE,
         'owner_approved_script', 'synthetic-test')`,
      [second.member.id, firstMapping.auth_subject]
    ),
    (error) => error.code === "23505"
  );
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_member_auth_mappings
        (member_id, auth_provider, auth_subject, verified_email_snapshot,
         active, provisioning_method, provisioning_reference)
       VALUES ($1, 'clerk', 'user_alpha_second_active', 'second@example.test', TRUE,
         'owner_approved_script', 'synthetic-test')`,
      [first.member.id]
    ),
    (error) => error.code === "23505"
  );

  const consent = await disposable.pool.query(
    `INSERT INTO goals_coach_alpha_consents
      (member_id, auth_mapping_id, consent_version, environment, status, accepted_at)
     VALUES ($1, $2, 'GC-ALPHA-CONSENT-1.0', 'test', 'accepted', NOW())
     RETURNING *`,
    [first.member.id, firstMapping.id]
  );
  const event = await disposable.pool.query(
    `INSERT INTO goals_coach_alpha_consent_events
      (consent_id, member_id, auth_mapping_id, auth_provider, auth_subject,
       consent_version, environment, event_type)
     VALUES ($1, $2, $3, 'clerk', $4, 'GC-ALPHA-CONSENT-1.0', 'test', 'accepted')
     RETURNING *`,
    [consent.rows[0].id, first.member.id, firstMapping.id, firstMapping.auth_subject]
  );
  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_alpha_consent_events SET event_type = 'withdrawn' WHERE id = $1",
      [event.rows[0].id]
    ),
    (error) => error.code === "23514"
  );
  await assert.rejects(
    disposable.pool.query("DELETE FROM goals_coach_alpha_consent_events WHERE id = $1", [event.rows[0].id]),
    (error) => error.code === "23514"
  );

  const secondMapping = await seedAlphaMapping(disposable.pool, second.member, "migration-map-b", true);
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_alpha_feedback
        (member_id, auth_mapping_id, expectation, what_occurred,
         page_or_feature, severity, environment)
       VALUES ($1, $2, 'Expected', 'Occurred', 'test', 'low', 'test')`,
      [first.member.id, secondMapping.id]
    ),
    (error) => error.code === "23503"
  );
});

test("migration 003 refuses a changed checksum and rollback refuses later migrations", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  await disposable.pool.query(
    "UPDATE app_schema_migrations SET checksum = 'changed' WHERE version = '003_goals_coach_alpha_foundation'"
  );
  await assert.rejects(runMigration({ pool: disposable.pool }), /different checksum/);
  await disposable.pool.query(
    `INSERT INTO app_schema_migrations (version, checksum, applied_at)
     SELECT '004_synthetic_later', 'synthetic', applied_at + INTERVAL '1 minute'
     FROM app_schema_migrations
     WHERE version = '003_goals_coach_alpha_foundation'`
  );
  await assert.rejects(
    runRollback({ pool: disposable.pool, skipConfirmation: true }),
    /Cannot roll back migration 003 while later migration 004_synthetic_later is applied/
  );
});

test("migration 003 rollback preserves PostgreSQL microsecond ordering without JavaScript Date precision", async (t) => {
  const selfOnly = await createDisposableDatabase({ phase1a: true });
  t.after(() => selfOnly.close());
  await selfOnly.pool.query(
    `UPDATE app_schema_migrations
     SET applied_at = CASE version
       WHEN '002_goals_coaching_foundation' THEN TIMESTAMPTZ '2026-07-17 11:59:59+00'
       WHEN '003_goals_coach_alpha_foundation' THEN TIMESTAMPTZ '2026-07-17 12:00:00.000100+00'
     END
     WHERE version IN ('002_goals_coaching_foundation', '003_goals_coach_alpha_foundation')`
  );
  const roundedSelf = await selfOnly.pool.query(
    "SELECT applied_at FROM app_schema_migrations WHERE version = '003_goals_coach_alpha_foundation'"
  );
  assert.equal(roundedSelf.rows[0].applied_at.getUTCMilliseconds(), 0);
  assert.equal(
    (await runRollback({ pool: selfOnly.pool, skipConfirmation: true })).status,
    "rolled_back"
  );

  const withLater = await createDisposableDatabase({ phase1a: true });
  t.after(() => withLater.close());
  await withLater.pool.query(
    `UPDATE app_schema_migrations
     SET applied_at = CASE version
       WHEN '002_goals_coaching_foundation' THEN TIMESTAMPTZ '2026-07-17 11:59:59+00'
       WHEN '003_goals_coach_alpha_foundation' THEN TIMESTAMPTZ '2026-07-17 12:00:00.000100+00'
     END
     WHERE version IN ('002_goals_coaching_foundation', '003_goals_coach_alpha_foundation')`
  );
  await withLater.pool.query(
    `INSERT INTO app_schema_migrations (version, checksum, applied_at)
     VALUES (
       '004_microsecond_later',
       'synthetic',
       TIMESTAMPTZ '2026-07-17 12:00:00.000900+00'
     )`
  );
  const rounded = await withLater.pool.query(
    `SELECT version, applied_at
     FROM app_schema_migrations
     WHERE version IN ('003_goals_coach_alpha_foundation', '004_microsecond_later')
     ORDER BY version`
  );
  assert.equal(rounded.rows[0].applied_at.getTime(), rounded.rows[1].applied_at.getTime());
  await assert.rejects(
    runRollback({ pool: withLater.pool, skipConfirmation: true }),
    /Cannot roll back migration 003 while later migration 004_microsecond_later is applied/
  );
});
