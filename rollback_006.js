"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { MIGRATION_VERSION, checksum } = require("./migrate_006");

const ROLLBACK_FILE = path.join(__dirname, "rollback_006_goals_coach_safety_review_routing.sql");
const MIGRATION_FILE = path.join(__dirname, "migration_006_goals_coach_safety_review_routing.sql");
const MIGRATION_LOCK_KEY = 82720506;

function createPool(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    max: 1,
  });
}

async function runRollback(options = {}) {
  if (!options.skipConfirmation && process.env.CONFIRM_PHASE1D_SAFETY_REVIEW_ROLLBACK !== "YES") {
    throw new Error("Set CONFIRM_PHASE1D_SAFETY_REVIEW_ROLLBACK=YES to run this destructive rollback");
  }
  const rollbackSql = fs.readFileSync(ROLLBACK_FILE, "utf8");
  const migrationChecksum = checksum(fs.readFileSync(MIGRATION_FILE, "utf8"));
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL);
  const ownsPool = !options.pool;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const applied = await client.query(
      "SELECT checksum FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    );
    if (!applied.rows.length) {
      await client.query("ROLLBACK");
      return { status: "not_applied", version: MIGRATION_VERSION };
    }
    if (applied.rows[0].checksum !== migrationChecksum) {
      throw new Error("Cannot roll back migration 006 with a different checksum");
    }
    const later = await client.query(
      `SELECT candidate.version
       FROM app_schema_migrations current
       JOIN app_schema_migrations candidate ON candidate.applied_at > current.applied_at
       WHERE current.version = $1
       ORDER BY candidate.applied_at, candidate.version
       LIMIT 1`,
      [MIGRATION_VERSION]
    );
    if (later.rows.length) {
      throw new Error(`Cannot roll back migration 006 while later migration ${later.rows[0].version} is applied`);
    }
    await client.query(rollbackSql);
    await client.query("DELETE FROM app_schema_migrations WHERE version = $1", [MIGRATION_VERSION]);
    await client.query("COMMIT");
    return { status: "rolled_back", version: MIGRATION_VERSION };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]); } finally {
      client.release();
      if (ownsPool) await pool.end();
    }
  }
}

if (require.main === module) {
  runRollback()
    .then((result) => console.log(`[UGF] Migration ${result.version}: ${result.status}`))
    .catch((error) => { console.error(`[UGF] Rollback ${MIGRATION_VERSION} failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { runRollback };
