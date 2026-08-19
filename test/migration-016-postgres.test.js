"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const migrations = ["005", "006", "007", "008", "009", "010", "011", "012", "013", "014", "015"].map((n) => require(`../migrate_${n}`).runMigration);
const { MIGRATION_VERSION, Migration016Error, REQUIRED_MIGRATION_CHECKSUM, runMigration } = require("../migrate_016");
const { runRollback } = require("../rollback_016");
const skip = typeof process.getuid === "function" && process.getuid() === 0 ? "requires unprivileged PostgreSQL 16" : false;
async function at015(t) {
  const db = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => db.close());
  for (const migration of migrations) await migration({ pool: db.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } });
  assert.match((await db.pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
  return db;
}
test("Migration 016 applies, replays, and preserves v2 while permitting v3", { skip }, async (t) => {
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync("migration_015_goals_coach_member_sessions.sql")).digest("hex"), REQUIRED_MIGRATION_CHECKSUM);
  const db = await at015(t);
  assert.equal((await runMigration({ pool: db.pool })).status, "applied");
  assert.equal((await runMigration({ pool: db.pool })).status, "already_applied");
  const constraints = await db.pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='goals_coach_member_safety_intake_v2_assessments'::regclass AND contype='c'");
  const definitions = constraints.rows.map((row) => row.definition).join("\n");
  assert.match(definitions, /GC-MEMBER-SAFETY-NOTICE-2/);
  assert.match(definitions, /GC-MEMBER-SAFETY-NOTICE-3/);
  assert.match(definitions, /GC-MEMBER-SAFETY-INTAKE-3/);
  assert.match(definitions, /client_request_hash_key_version IS NOT NULL/);
  await assert.rejects(db.pool.query("INSERT INTO goals_coach_member_safety_intake_v2_assessments(auth_mapping_id,member_id,client_request_id,client_request_hash,notice_version,outcome,rule_version,valid_until) VALUES(1,1,'00000000-0000-4000-8000-000000000161',$1,'GC-MEMBER-SAFETY-NOTICE-2','SCREEN_COMPLETE','GC-MEMBER-SAFETY-INTAKE-3',NOW()+INTERVAL '1 hour')", ["a".repeat(64)]), /gc_member_safety_intake_version_pair_check/);
  await assert.rejects(db.pool.query("INSERT INTO goals_coach_member_safety_intake_v2_assessments(auth_mapping_id,member_id,client_request_id,client_request_hash,client_request_hash_key_version,notice_version,outcome,rule_version,valid_until) VALUES(1,1,'00000000-0000-4000-8000-000000000162',$1,'key-1','GC-MEMBER-SAFETY-NOTICE-3','SCREEN_COMPLETE','GC-MEMBER-SAFETY-INTAKE-2',NOW()+INTERVAL '1 hour')", ["b".repeat(64)]), /gc_member_safety_intake_version_pair_check/);
});
test("Migration 016 refuses prerequisite and checksum mismatches", { skip }, async (t) => {
  const db = await at015(t);
  await db.pool.query("DELETE FROM app_schema_migrations WHERE version='015_goals_coach_member_sessions'");
  await assert.rejects(runMigration({ pool: db.pool }), (error) => error instanceof Migration016Error && error.code === "required_migration_mismatch");
  await db.pool.query("INSERT INTO app_schema_migrations(version,checksum) VALUES('015_goals_coach_member_sessions',$1),('016_goals_coach_adaptive_safety_intake','bad')", [REQUIRED_MIGRATION_CHECKSUM]);
  await assert.rejects(runMigration({ pool: db.pool }), (error) => error.code === "checksum_mismatch");
});
test("Migration 016 rollback refuses v3 history and later migrations", { skip }, async (t) => {
  const db = await at015(t);
  await runMigration({ pool: db.pool });
  await db.pool.query("INSERT INTO app_schema_migrations(version,checksum) VALUES('017_future','test')");
  await assert.rejects(runRollback({ pool: db.pool, skipConfirmation: true }), (error) => error.code === "later_migration_applied");
  await db.pool.query("DELETE FROM app_schema_migrations WHERE version='017_future'");
  await db.pool.query("INSERT INTO coach_members(gymmaster_member_id,first_name,last_name) VALUES('916','Test','Member')");
  const member = (await db.pool.query("SELECT id FROM coach_members WHERE gymmaster_member_id='916'")).rows[0];
  const mapping = (await db.pool.query("INSERT INTO goals_coach_member_auth_mappings(member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference) VALUES($1,'gymmaster','gymmaster:916','member916@example.test',TRUE,'administrative','test:916') RETURNING id", [member.id])).rows[0];
  await db.pool.query("INSERT INTO goals_coach_member_safety_intake_v2_assessments(auth_mapping_id,member_id,client_request_id,client_request_hash,client_request_hash_key_version,notice_version,outcome,rule_version,valid_until) VALUES($1,$2,'00000000-0000-4000-8000-000000000016',$3,'key-1','GC-MEMBER-SAFETY-NOTICE-3','SCREEN_COMPLETE','GC-MEMBER-SAFETY-INTAKE-3',NOW()+INTERVAL '1 hour')", [mapping.id, member.id, "a".repeat(64)]);
  await assert.rejects(runRollback({ pool: db.pool, skipConfirmation: true }), (error) => error.code === "v3_rows_exist");
});
test("Migration 016 rollback restores v2-only constraints when no v3 history exists", { skip }, async (t) => {
  const db = await at015(t);
  await runMigration({ pool: db.pool });
  assert.equal((await runRollback({ pool: db.pool, skipConfirmation: true })).status, "rolled_back");
  assert.equal((await runRollback({ pool: db.pool, skipConfirmation: true })).status, "not_applied");
  const constraints = await db.pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='goals_coach_member_safety_intake_v2_assessments'::regclass AND contype='c'");
  assert.doesNotMatch(constraints.rows.map((row) => row.definition).join("\n"), /GC-MEMBER-SAFETY-NOTICE-3/);
});
