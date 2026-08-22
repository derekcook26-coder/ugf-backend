"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const migrations = ["005", "006", "007", "008", "009", "010", "011", "012", "013", "014"].map((n) => require(`../migrate_${n}`).runMigration);
const { MIGRATION_VERSION, Migration015Error, REQUIRED_MIGRATION_CHECKSUM, runMigration } = require("../migrate_015");
const { runRollback } = require("../rollback_015");
const { createGymMasterTwoHourSessionService } = require("../src/goals-coach/gymmaster-member-session");
const skip = typeof process.getuid === "function" && process.getuid() === 0 ? "requires unprivileged PostgreSQL 16" : false;
async function at014(t) {
  const db = await createRealDisposablePostgres({ phase1b: true }); t.after(() => db.close());
  for (const migration of migrations) await migration({ pool: db.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } });
  assert.match((await db.pool.query("SHOW server_version")).rows[0].server_version, /^16\./); return db;
}
async function member(pool, suffix = "1") {
  const m = (await pool.query("INSERT INTO coach_members(gymmaster_member_id,first_name,last_name) VALUES($1,'Test','Member') RETURNING id", [`91${suffix}`])).rows[0];
  const a = (await pool.query("INSERT INTO goals_coach_member_auth_mappings(member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference) VALUES($1,'gymmaster',$2,$3,TRUE,'administrative',$4) RETURNING id", [m.id, `gymmaster:91${suffix}`, `member${suffix}@example.test`, `test:${suffix}`])).rows[0]; return { memberId: String(m.id), mappingId: String(a.id), active: true };
}
test("Migration 015 applies, replays, and enforces exact 7200 seconds", { skip }, async (t) => {
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync("migration_014_goals_coach_member_today.sql")).digest("hex"), REQUIRED_MIGRATION_CHECKSUM);
  const db = await at014(t); assert.equal((await runMigration({ pool: db.pool })).status, "applied"); assert.equal((await runMigration({ pool: db.pool })).status, "already_applied");
  const owner = await member(db.pool); await assert.rejects(db.pool.query("INSERT INTO goals_coach_member_sessions(token_hash,auth_mapping_id,member_id,issued_at,expires_at) VALUES($1,$2,$3,NOW(),NOW()+INTERVAL '7199 seconds')", ["a".repeat(64), owner.mappingId, owner.memberId]), /goals_coach_member_sessions_check/);
});
test("Migration 015 refuses prerequisite and checksum mismatches", { skip }, async (t) => {
  const db = await at014(t); await db.pool.query("DELETE FROM app_schema_migrations WHERE version='014_goals_coach_member_today'"); await assert.rejects(runMigration({ pool: db.pool }), (e) => e instanceof Migration015Error && e.code === "required_migration_mismatch");
  await db.pool.query("INSERT INTO app_schema_migrations(version,checksum) VALUES('014_goals_coach_member_today',$1),('015_goals_coach_member_sessions','bad')", [REQUIRED_MIGRATION_CHECKSUM]); await assert.rejects(runMigration({ pool: db.pool }), (e) => e.code === "checksum_mismatch");
});
test("Migration 015 rollback refuses active sessions and succeeds after revocation", { skip }, async (t) => {
  const db = await at014(t); await runMigration({ pool: db.pool }); const owner = await member(db.pool); const service = createGymMasterTwoHourSessionService({ db: db.pool }); const token = await service.issue({ authProvider: "gymmaster", authSubject: "gymmaster:911" }, owner);
  await assert.rejects(runRollback({ pool: db.pool, skipConfirmation: true }), (e) => e.code === "active_sessions_present"); await service.revoke(token); assert.equal((await runRollback({ pool: db.pool, skipConfirmation: true })).status, "rolled_back");
});
test("Migration 015 rollback uses canonical version ordering, never applied_at chronology", { skip }, async (t) => {
  const db = await at014(t); await runMigration({ pool: db.pool });
  await db.pool.query("UPDATE app_schema_migrations SET applied_at='2030-01-01' WHERE version<'015'");
  await db.pool.query("UPDATE app_schema_migrations SET applied_at='2020-01-01' WHERE version=$1", [MIGRATION_VERSION]);
  await db.pool.query("INSERT INTO app_schema_migrations(version,checksum,applied_at) VALUES('16_noncanonical','test','2010-01-01')");
  await assert.rejects(runRollback({ pool: db.pool, skipConfirmation: true }), (e) => e.code === "noncanonical_migration_version");
  await db.pool.query("DELETE FROM app_schema_migrations WHERE version='16_noncanonical'");
  await db.pool.query("INSERT INTO app_schema_migrations(version,checksum,applied_at) VALUES('016_future','test','2010-01-01')");
  await assert.rejects(runRollback({ pool: db.pool, skipConfirmation: true }), (e) => e.code === "later_migration_applied");
  await db.pool.query("DELETE FROM app_schema_migrations WHERE version='016_future'");
  assert.equal((await runRollback({ pool: db.pool, skipConfirmation: true })).status, "rolled_back");
});
test("PostgreSQL serializes logout ahead of protected use and rejects replay", { skip }, async (t) => {
  const db = await at014(t); await runMigration({ pool: db.pool }); const owner = await member(db.pool); const service = createGymMasterTwoHourSessionService({ db: db.pool }); const token = await service.issue({ authProvider: "gymmaster", authSubject: "gymmaster:911" }, owner);
  const durable = (await db.pool.query("SELECT id FROM goals_coach_member_sessions WHERE token_hash=$1", [crypto.createHash("sha256").update(token).digest("hex")])).rows[0];
  const authenticated = await service.verify(token);
  assert.equal(authenticated.memberSessionId, String(durable.id));
  assert.equal(authenticated.mappingId, owner.mappingId);
  assert.equal(authenticated.memberId, owner.memberId);
  const lock = await db.pool.connect(); await lock.query("BEGIN"); await lock.query("SELECT id FROM goals_coach_member_sessions WHERE token_hash=$1 FOR UPDATE", [crypto.createHash("sha256").update(token).digest("hex")]);
  const revoke = service.revoke(token); const use = service.verify(token); await lock.query("COMMIT"); lock.release(); assert.equal(await revoke, true); await assert.rejects(use); await assert.rejects(service.verify(token));
});
