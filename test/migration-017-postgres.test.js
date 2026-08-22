"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const { seedMemberAndPlan } = require("./helpers/disposable-db");
const migrations = ["005", "006", "007", "008", "009", "010", "011", "012", "013", "014", "015", "016"].map((number) => require(`../migrate_${number}`).runMigration);
const { MIGRATION_VERSION, Migration017Error, REQUIRED_MIGRATION_CHECKSUM, runMigration } = require("../migrate_017");
const { runRollback } = require("../rollback_017");
const skip = typeof process.getuid === "function" && process.getuid() === 0 ? "requires unprivileged PostgreSQL 16" : false;

async function withTrackedMigrationBytes(work) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readExactTrackedMigration(file, options) {
    const name = path.basename(String(file));
    if (/^migration_0(?:0[5-9]|1[0-6])_[a-z0-9_]+\.sql$/.test(name)) {
      const bytes = execFileSync("git", ["show", `HEAD:${name}`], { cwd: path.resolve(__dirname, ".."), encoding: null });
      return options === "utf8" || options?.encoding === "utf8" ? bytes.toString("utf8") : bytes;
    }
    return originalReadFileSync.apply(fs, arguments);
  };
  try { return await work(); } finally { fs.readFileSync = originalReadFileSync; }
}

async function at016(t) {
  const database = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => database.close());
  await withTrackedMigrationBytes(async () => {
    for (const migration of migrations) await migration({ pool: database.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } });
  });
  assert.match((await database.pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
  return database;
}

async function owner(pool, suffix) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const mapping = (await pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
       (member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference)
     VALUES($1,'gymmaster',$2,$3,TRUE,'administrative',$4) RETURNING *`,
    [seeded.member.id, `gymmaster:${suffix}`, `${suffix}@example.test`, `test:${suffix}`]
  )).rows[0];
  const session = (await pool.query(
    `INSERT INTO goals_coach_member_sessions
       (token_hash,auth_mapping_id,member_id,issued_at,expires_at)
     VALUES($1,$2,$3,NOW(),NOW()+INTERVAL '7200 seconds') RETURNING *`,
    [crypto.createHash("sha256").update(`session-${suffix}`).digest("hex"), mapping.id, seeded.member.id]
  )).rows[0];
  const conversation = (await pool.query(
    "INSERT INTO coaching_conversations(member_id,plan_id) VALUES($1,$2) RETURNING *",
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  return { ...seeded, mapping, session, conversation };
}

async function insertBinding(pool, owned, reference) {
  return pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,conversation_version,provenance,coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES($1,1,'member_session',$2,$3,$4,$5) RETURNING *`,
    [reference, owned.conversation.id, owned.member.id, owned.mapping.id, owned.session.id]
  );
}

test("Migration 017 is ordered, checksummed, replayable, and does not backfill", { skip }, async (t) => {
  const predecessor = execFileSync("git", ["show", "HEAD:migration_016_goals_coach_adaptive_safety_intake.sql"], { encoding: null });
  assert.equal(crypto.createHash("sha256").update(predecessor).digest("hex"), REQUIRED_MIGRATION_CHECKSUM);
  assert.doesNotMatch(fs.readFileSync("server.js", "utf8"), /migrate_017|member_conversation_bindings/);
  const database = await at016(t);
  await owner(database.pool, "legacy");
  assert.equal((await runMigration({ pool: database.pool })).status, "applied");
  assert.equal((await runMigration({ pool: database.pool })).status, "already_applied");
  assert.equal((await database.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_conversation_bindings")).rows[0].count, 0);
  const columns = await database.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='goals_coach_member_conversation_bindings'
     ORDER BY ordinal_position`
  );
  assert.deepEqual(columns.rows.map((row) => row.column_name), [
    "id", "conversation_reference", "conversation_version", "provenance",
    "coaching_conversation_id", "member_id", "auth_mapping_id", "member_session_id", "created_at",
  ]);
});

test("Migration 017 enforces exact provenance, UUID uniqueness, and immutable rows", { skip }, async (t) => {
  const database = await at016(t);
  await runMigration({ pool: database.pool });
  const first = await owner(database.pool, "first");
  const inserted = (await insertBinding(database.pool, first, "00000000-0000-4000-8000-000000000171")).rows[0];
  assert.equal(inserted.conversation_version, 1);
  assert.equal(inserted.provenance, "member_session");
  const secondPlan = (await database.pool.query(
    `INSERT INTO coach_plans(member_id,profile_json,assessment_messages,plan_markdown)
     VALUES($1,'{}'::jsonb,'[]'::jsonb,'Second synthetic plan') RETURNING *`,
    [first.member.id]
  )).rows[0];
  const secondConversation = (await database.pool.query(
    "INSERT INTO coaching_conversations(member_id,plan_id) VALUES($1,$2) RETURNING *",
    [first.member.id, secondPlan.id]
  )).rows[0];
  await assert.rejects(database.pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES('00000000-0000-4000-8000-000000000171',$1,$2,$3,$4)`,
    [secondConversation.id, first.member.id, first.mapping.id, first.session.id]
  ), (error) => error.code === "23505");
  await assert.rejects(database.pool.query("UPDATE goals_coach_member_conversation_bindings SET conversation_version=1 WHERE id=$1", [inserted.id]), (error) => error.code === "55000");
  await assert.rejects(database.pool.query("DELETE FROM goals_coach_member_conversation_bindings WHERE id=$1", [inserted.id]), (error) => error.code === "55000");
  await assert.rejects(database.pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,conversation_version,provenance,coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES('00000000-0000-4000-8000-000000000172',2,'member_session',$1,$2,$3,$4)`,
    [first.conversation.id, first.member.id, first.mapping.id, first.session.id]
  ), /conversation_version_check/);
  await assert.rejects(database.pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,conversation_version,provenance,coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES('00000000-0000-4000-8000-000000000173',1,'provider',$1,$2,$3,$4)`,
    [first.conversation.id, first.member.id, first.mapping.id, first.session.id]
  ), /provenance_check/);
});

test("Migration 017 rejects cross-member conversation, mapping, and session bindings", { skip }, async (t) => {
  const database = await at016(t);
  await runMigration({ pool: database.pool });
  const first = await owner(database.pool, "owner-a");
  const second = await owner(database.pool, "owner-b");
  await assert.rejects(database.pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES('00000000-0000-4000-8000-000000000174',$1,$2,$3,$4)`,
    [first.conversation.id, second.member.id, second.mapping.id, second.session.id]
  ), (error) => error.code === "23503");
  await assert.rejects(database.pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES('00000000-0000-4000-8000-000000000175',$1,$2,$3,$4)`,
    [first.conversation.id, first.member.id, second.mapping.id, first.session.id]
  ), (error) => error.code === "23503");
  await assert.rejects(database.pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES('00000000-0000-4000-8000-000000000176',$1,$2,$3,$4)`,
    [first.conversation.id, first.member.id, first.mapping.id, second.session.id]
  ), (error) => error.code === "23503");
});

test("Migration 017 refuses prerequisite and ledger checksum mismatches", { skip }, async (t) => {
  const database = await at016(t);
  await database.pool.query("DELETE FROM app_schema_migrations WHERE version='016_goals_coach_adaptive_safety_intake'");
  await assert.rejects(runMigration({ pool: database.pool }), (error) => error instanceof Migration017Error && error.code === "required_migration_mismatch");
  await database.pool.query("INSERT INTO app_schema_migrations(version,checksum) VALUES('016_goals_coach_adaptive_safety_intake',$1),($2,'bad')", [REQUIRED_MIGRATION_CHECKSUM, MIGRATION_VERSION]);
  await assert.rejects(runMigration({ pool: database.pool }), (error) => error.code === "checksum_mismatch");
});

test("Migration 017 rollback is guarded by rows and later migrations", { skip }, async (t) => {
  const database = await at016(t);
  await runMigration({ pool: database.pool });
  await database.pool.query("INSERT INTO app_schema_migrations(version,checksum) VALUES('018_future','test')");
  await assert.rejects(runRollback({ pool: database.pool, skipConfirmation: true }), (error) => error.code === "later_migration_applied");
  await database.pool.query("DELETE FROM app_schema_migrations WHERE version='018_future'");
  const first = await owner(database.pool, "rollback-row");
  await insertBinding(database.pool, first, "00000000-0000-4000-8000-000000000177");
  await assert.rejects(runRollback({ pool: database.pool, skipConfirmation: true }), (error) => error.code === "binding_rows_exist");
});

test("Migration 017 rollback removes an unused foundation and its session key", { skip }, async (t) => {
  const database = await at016(t);
  await runMigration({ pool: database.pool });
  assert.equal((await runRollback({ pool: database.pool, skipConfirmation: true })).status, "rolled_back");
  assert.equal((await runRollback({ pool: database.pool, skipConfirmation: true })).status, "not_applied");
  assert.equal((await database.pool.query("SELECT to_regclass('public.goals_coach_member_conversation_bindings') name")).rows[0].name, null);
  const key = await database.pool.query("SELECT 1 FROM pg_constraint WHERE conname='uq_goals_coach_member_sessions_id_member_mapping'");
  assert.equal(key.rowCount, 0);
});
