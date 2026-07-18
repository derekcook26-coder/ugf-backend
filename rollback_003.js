const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { MIGRATION_VERSION } = require("./migrate_003");

const ROLLBACK_FILE = path.join(__dirname, "rollback_003_goals_coach_alpha_foundation.sql");
const MIGRATION_LOCK_KEY = 82720403;

function databaseSsl() {
  return process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
}

function createPool(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({ connectionString, ssl: databaseSsl(), max: 1 });
}

async function runRollback(options = {}) {
  if (!options.skipConfirmation && process.env.CONFIRM_PHASE1A_ROLLBACK !== "YES") {
    throw new Error("Set CONFIRM_PHASE1A_ROLLBACK=YES to run this destructive rollback");
  }

  const sql = fs.readFileSync(ROLLBACK_FILE, "utf8");
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL);
  const ownsPool = !options.pool;
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query("BEGIN");
    const ledger = await client.query("SELECT to_regclass('public.app_schema_migrations') AS name");
    if (!ledger.rows[0].name) {
      await client.query("ROLLBACK");
      return { status: "not_applied", version: MIGRATION_VERSION };
    }

    const applied = await client.query(
      "SELECT 1 FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    );
    if (!applied.rows.length) {
      await client.query("ROLLBACK");
      return { status: "not_applied", version: MIGRATION_VERSION };
    }

    const later = await client.query(
      `SELECT candidate.version
       FROM app_schema_migrations AS current
       JOIN app_schema_migrations AS candidate
         ON candidate.version <> current.version
        AND candidate.applied_at > current.applied_at
       WHERE current.version = $1
       ORDER BY candidate.applied_at, candidate.version
       LIMIT 1`,
      [MIGRATION_VERSION]
    );
    if (later.rows.length) {
      throw new Error(`Cannot roll back migration 003 while later migration ${later.rows[0].version} is applied`);
    }

    await client.query(sql);
    await client.query("DELETE FROM app_schema_migrations WHERE version = $1", [MIGRATION_VERSION]);
    await client.query("COMMIT");
    return { status: "rolled_back", version: MIGRATION_VERSION };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Preserve the original rollback error.
    }
    throw error;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
      if (ownsPool) await pool.end();
    }
  }
}

if (require.main === module) {
  runRollback()
    .then((result) => console.log(`[UGF] Migration ${result.version}: ${result.status}`))
    .catch((error) => {
      console.error(`[UGF] Rollback ${MIGRATION_VERSION} failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { runRollback };
