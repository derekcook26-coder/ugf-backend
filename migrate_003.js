const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const MIGRATION_VERSION = "003_goals_coach_alpha_foundation";
const REQUIRED_MIGRATION_VERSION = "002_goals_coaching_foundation";
const MIGRATION_FILE = path.join(__dirname, "migration_003_goals_coach_alpha_foundation.sql");
const MIGRATION_LOCK_KEY = 82720403;

function databaseSsl() {
  return process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
}

function createPool(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({ connectionString, ssl: databaseSsl(), max: 1 });
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

async function runMigration(options = {}) {
  const sql = fs.readFileSync(MIGRATION_FILE, "utf8");
  const sqlChecksum = checksum(sql);
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL);
  const ownsPool = !options.pool;
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query("BEGIN");
    const ledger = await client.query("SELECT to_regclass('public.app_schema_migrations') AS name");
    if (!ledger.rows[0].name) {
      throw new Error("Migration 002 must be applied before Migration 003");
    }

    const required = await client.query(
      "SELECT version FROM app_schema_migrations WHERE version = $1",
      [REQUIRED_MIGRATION_VERSION]
    );
    if (!required.rows.length) {
      throw new Error("Migration 002 must be applied before Migration 003");
    }

    const existing = await client.query(
      "SELECT checksum FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    );
    if (existing.rows.length) {
      if (existing.rows[0].checksum !== sqlChecksum) {
        throw new Error("Migration 003 was already applied with a different checksum");
      }
      await client.query("COMMIT");
      return { status: "already_applied", version: MIGRATION_VERSION, checksum: sqlChecksum };
    }

    await client.query(sql);
    await client.query(
      "INSERT INTO app_schema_migrations (version, checksum) VALUES ($1, $2)",
      [MIGRATION_VERSION, sqlChecksum]
    );
    await client.query("COMMIT");
    return { status: "applied", version: MIGRATION_VERSION, checksum: sqlChecksum };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Preserve the original migration error.
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
  runMigration()
    .then((result) => console.log(`[UGF] Migration ${result.version}: ${result.status}`))
    .catch((error) => {
      console.error(`[UGF] Migration ${MIGRATION_VERSION} failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { MIGRATION_VERSION, checksum, runMigration };
