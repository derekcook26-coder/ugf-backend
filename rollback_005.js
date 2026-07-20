const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { MIGRATION_VERSION, checksum } = require("./migrate_005");

const ROLLBACK_FILE = path.join(
  __dirname,
  "rollback_005_goals_coach_voice_transcription_provenance.sql"
);
const MIGRATION_FILE = path.join(
  __dirname,
  "migration_005_goals_coach_voice_transcription_provenance.sql"
);
const ROLLBACK_FIRST_LOCK_BOUNDARY =
  "-- PHASE1C_ROLLBACK_COACHING_TURNS_LOCK_ACQUIRED";
const ROLLBACK_ALL_LOCKS_BOUNDARY = "-- PHASE1C_ROLLBACK_LOCKS_ACQUIRED";
const MIGRATION_LOCK_KEY = 82720505;

function databaseSsl() {
  return process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
}

function createPool(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({ connectionString, ssl: databaseSsl(), max: 1 });
}

function splitRollbackSql(sql) {
  const firstBoundary = sql.indexOf(ROLLBACK_FIRST_LOCK_BOUNDARY);
  const allBoundary = sql.indexOf(ROLLBACK_ALL_LOCKS_BOUNDARY);
  if (
    firstBoundary < 0
    || allBoundary <= firstBoundary
    || sql.indexOf(
      ROLLBACK_FIRST_LOCK_BOUNDARY,
      firstBoundary + ROLLBACK_FIRST_LOCK_BOUNDARY.length
    ) >= 0
    || sql.indexOf(
      ROLLBACK_ALL_LOCKS_BOUNDARY,
      allBoundary + ROLLBACK_ALL_LOCKS_BOUNDARY.length
    ) >= 0
  ) {
    throw new Error("Rollback 005 lock boundary is invalid");
  }
  return Object.freeze({
    firstLockSql: sql.slice(
      0,
      firstBoundary + ROLLBACK_FIRST_LOCK_BOUNDARY.length
    ),
    secondLockSql: sql.slice(
      firstBoundary + ROLLBACK_FIRST_LOCK_BOUNDARY.length,
      allBoundary + ROLLBACK_ALL_LOCKS_BOUNDARY.length
    ),
    protectedSql: sql.slice(allBoundary + ROLLBACK_ALL_LOCKS_BOUNDARY.length),
  });
}

async function runRollback(options = {}) {
  if (
    !options.skipConfirmation
    && process.env.CONFIRM_PHASE1C_TRANSCRIPTION_ROLLBACK !== "YES"
  ) {
    throw new Error(
      "Set CONFIRM_PHASE1C_TRANSCRIPTION_ROLLBACK=YES to run this destructive rollback"
    );
  }
  const sql = fs.readFileSync(ROLLBACK_FILE, "utf8");
  const migrationChecksum = checksum(fs.readFileSync(MIGRATION_FILE, "utf8"));
  const rollbackSql = splitRollbackSql(sql);
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL);
  const ownsPool = !options.pool;
  const client = await pool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const ledger = await client.query(
      "SELECT to_regclass('public.app_schema_migrations') AS name"
    );
    if (!ledger.rows[0].name) {
      await client.query("ROLLBACK");
      return { status: "not_applied", version: MIGRATION_VERSION };
    }
    const applied = await client.query(
      "SELECT checksum FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    );
    if (!applied.rows.length) {
      await client.query("ROLLBACK");
      return { status: "not_applied", version: MIGRATION_VERSION };
    }
    if (applied.rows[0].checksum !== migrationChecksum) {
      throw new Error("Cannot roll back migration 005 with a different checksum");
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
      throw new Error(
        `Cannot roll back migration 005 while later migration ${later.rows[0].version} is applied`
      );
    }

    const backend = await client.query("SELECT pg_backend_pid()::int AS pid");
    const lockContext = Object.freeze({ backendPid: backend.rows[0].pid });
    if (typeof options.beforeTableLocks === "function") {
      await options.beforeTableLocks(lockContext);
    }
    await client.query(rollbackSql.firstLockSql);
    if (typeof options.afterFirstTableLock === "function") {
      await options.afterFirstTableLock(lockContext);
    }
    await client.query(rollbackSql.secondLockSql);
    if (typeof options.afterTableLocks === "function") {
      await options.afterTableLocks(lockContext);
    }
    await client.query(rollbackSql.protectedSql);
    await client.query(
      "DELETE FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION]
    );
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
