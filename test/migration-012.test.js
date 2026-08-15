"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const { createDisposableDatabase } = require("./helpers/disposable-db");
const { runMigration: migrate009 } = require("../migrate_009");
const { runMigration: migrate010 } = require("../migrate_010");
const { runMigration: migrate011 } = require("../migrate_011");
const { MIGRATION_FILE, MIGRATION_VERSION, REQUIRED_MIGRATION_CHECKSUM, runMigration: migrate012 } = require("../migrate_012");
const { runRollback } = require("../rollback_012");

async function at011(t) {
  const db = await createDisposableDatabase({ ownerEditableWorkoutSessions: true }); t.after(() => db.close());
  await migrate009({ pool: db.pool }); await migrate010({ pool: db.pool });
  await migrate011({ pool: db.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } });
  return db;
}

test("Migration 012 is ordered, checksum-ledgered, explicit-only, and replayable", async (t) => {
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync("migration_011_goals_coach_nullable_member_names_and_post_login_provisioning.sql")).digest("hex"), REQUIRED_MIGRATION_CHECKSUM);
  assert.equal(fs.readFileSync("server.js", "utf8").includes("migrate_012"), false);
  const db = await at011(t); const applied = await migrate012({ pool: db.pool });
  assert.equal(applied.status, "applied"); assert.equal(applied.version, MIGRATION_VERSION);
  assert.equal(applied.checksum, crypto.createHash("sha256").update(fs.readFileSync(MIGRATION_FILE)).digest("hex"));
  assert.equal((await migrate012({ pool: db.pool })).status, "already_applied");
});

test("Migration 012 refuses missing exact 011 and rollback refuses immutable rows", async (t) => {
  const early = await createDisposableDatabase({ ownerEditableWorkoutSessions: true }); t.after(() => early.close());
  await assert.rejects(migrate012({ pool: early.pool }), (error) => error.code === "required_migration_mismatch");
  const db = await at011(t); await migrate012({ pool: db.pool });
  assert.equal((await runRollback({ pool: db.pool, skipConfirmation: true })).status, "rolled_back");
  await migrate012({ pool: db.pool });
  await db.pool.query("INSERT INTO coach_members (gymmaster_member_id, first_name, last_name) VALUES ('91201','Test','Member')");
  const member = (await db.pool.query("SELECT id FROM coach_members WHERE gymmaster_member_id='91201'")).rows[0];
  const mapping = (await db.pool.query("INSERT INTO goals_coach_member_auth_mappings (member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference) VALUES ($1,'gymmaster','gymmaster:91201','synthetic@example.test',TRUE,'owner_approved_script','m012-test') RETURNING id", [member.id])).rows[0];
  await db.pool.query("INSERT INTO goals_coach_member_safety_intake_v2_assessments (auth_mapping_id,member_id,client_request_id,client_request_hash,notice_version,outcome,rule_version,valid_until) VALUES ($1,$2,'00000000-0000-4000-8000-000000091201',$3,'GC-MEMBER-SAFETY-NOTICE-2','SCREEN_COMPLETE','GC-MEMBER-SAFETY-INTAKE-2',NOW()+INTERVAL '1 hour')", [mapping.id, member.id, "a".repeat(64)]);
  await assert.rejects(runRollback({ pool: db.pool, skipConfirmation: true }), (error) => error.code === "immutable_rows_present");
});

test("Migration 012 bounds checkout and discards uncertain clients", async () => {
  let lateReleased = false;
  const lateClient = { query() { throw new Error("must not query"); }, release() { lateReleased = true; } };
  await assert.rejects(migrate012({
    pool: { connect: () => new Promise((resolve) => setTimeout(() => resolve(lateClient), 30)) },
    overallMilliseconds: 10,
  }), (error) => error.code === "migration_failed");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(lateReleased, true);

  let discarded;
  const hanging = {
    query(sql) {
      if (sql === "BEGIN") return Promise.resolve({ rows: [] });
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("synthetic server timeout")), 30));
    },
    release(error) { discarded = error; },
  };
  await assert.rejects(migrate012({ pool: { connect: async () => hanging }, overallMilliseconds: 10 }), (error) => error.code === "migration_failed");
  assert.ok(discarded instanceof Error);
});

test("Migration 012 and rollback expose transaction-local timeout configuration", () => {
  const migration = fs.readFileSync("migrate_012.js", "utf8");
  const rollback = fs.readFileSync("rollback_012.js", "utf8");
  for (const source of [migration, rollback]) {
    assert.match(source, /runBoundedPostgresTransaction/);
    assert.match(source, /pg_advisory_xact_lock/);
  }
});

test("Rollback 012 bounds checkout, releases late clients, and discards uncertain clients", async () => {
  let lateReleased = false;
  const lateClient = { query() { throw new Error("must not query"); }, release() { lateReleased = true; } };
  await assert.rejects(runRollback({
    pool: { connect: () => new Promise((resolve) => setTimeout(() => resolve(lateClient), 30)) },
    skipConfirmation: true, overallMilliseconds: 10,
  }), (error) => error.code === "rollback_failed");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(lateReleased, true);

  let discarded;
  const uncertain = {
    query(sql) {
      if (sql === "BEGIN") return Promise.resolve({ rows: [] });
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("synthetic rollback query failure")), 30));
    },
    release(error) { discarded = error; },
  };
  await assert.rejects(runRollback({
    pool: { connect: async () => uncertain }, skipConfirmation: true, overallMilliseconds: 10,
  }), (error) => error.code === "rollback_failed");
  assert.ok(discarded instanceof Error);
});
