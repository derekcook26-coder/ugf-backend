"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const { createDisposableDatabase } = require("./helpers/disposable-db");
const { runMigration: migrate009 } = require("../migrate_009");
const { runMigration: migrate010 } = require("../migrate_010");
const { runMigration: migrate011 } = require("../migrate_011");
const { runMigration: migrate012 } = require("../migrate_012");
const { MIGRATION_FILE, MIGRATION_VERSION, REQUIRED_MIGRATION_CHECKSUM, runMigration: migrate013 } = require("../migrate_013");
const { runRollback } = require("../rollback_013");

async function at012(t) {
  const db = await createDisposableDatabase({ ownerEditableWorkoutSessions: true }); t.after(() => db.close());
  await migrate009({ pool: db.pool }); await migrate010({ pool: db.pool });
  await migrate011({ pool: db.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } }); await migrate012({ pool: db.pool });
  return db;
}
test("Migration 013 is exact-predecessor ordered, checksummed, replayable, and explicit-only", async (t) => {
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync("migration_012_goals_coach_safety_intake_v2.sql")).digest("hex"), REQUIRED_MIGRATION_CHECKSUM);
  assert.doesNotMatch(fs.readFileSync("server.js", "utf8"), /migrate_013/);
  const db = await at012(t); const result = await migrate013({ pool: db.pool });
  assert.equal(result.status, "applied"); assert.equal(result.version, MIGRATION_VERSION);
  assert.equal(result.checksum, crypto.createHash("sha256").update(fs.readFileSync(MIGRATION_FILE)).digest("hex"));
  assert.equal((await migrate013({ pool: db.pool })).status, "already_applied");
});
test("Migration 013 refuses an early database and empty rollback is guarded", async (t) => {
  const early = await createDisposableDatabase({ ownerEditableWorkoutSessions: true }); t.after(() => early.close());
  await assert.rejects(migrate013({ pool: early.pool }), (error) => error.code === "required_migration_mismatch");
  const db = await at012(t); await migrate013({ pool: db.pool });
  assert.equal((await runRollback({ pool: db.pool, skipConfirmation: true })).status, "rolled_back");
});
test("Migration and rollback bound checkout and release late clients", async () => {
  for (const operation of [
    (pool) => migrate013({ pool, overallMilliseconds: 10 }),
    (pool) => runRollback({ pool, overallMilliseconds: 10, skipConfirmation: true }),
  ]) {
    let released = false; const client = { query() { throw new Error("must not query"); }, release() { released = true; } };
    await assert.rejects(operation({ connect: () => new Promise((resolve) => setTimeout(() => resolve(client), 30)) }));
    await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(released, true);
  }
});
test("Migration 013 declares composite ownership, immutable history, and minimized data", () => {
  const sql = fs.readFileSync(MIGRATION_FILE, "utf8");
  assert.match(sql, /FOREIGN KEY \(auth_mapping_id, member_id\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /UNIQUE \(member_id, client_request_id\)/);
  for (const prohibited of ["password", "provider_payload", "health_data", "coaching_text", "plan_markdown", "response_content"]) assert.doesNotMatch(sql, new RegExp(prohibited, "i"));
});
