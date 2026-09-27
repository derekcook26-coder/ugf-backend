"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const {
  checkoutClientOnce,
  createTerminalState,
  deadlineAfter,
  minimumDeadline,
  monotonicNow,
  runBoundedPostgresTransaction,
} = require("./src/goals-coach/bounded-postgres-transaction");

const MIGRATION_VERSION = "020_goals_coach_member_conversation_provider_coaching_replay";
const REQUIRED_MIGRATION_VERSION = "019_goals_coach_member_conversation_provider_dispatch";
const REQUIRED_MIGRATION_CHECKSUM = "7cc38ee68646a166f4e9755ffe2d077438a3175ef82834565b0acc6dc9e7d469";
const MIGRATION_FILE = path.join(__dirname, "migration_020_goals_coach_member_conversation_provider_coaching_replay.sql");
const MIGRATION_LOCK_KEY = "82720520";
const CONNECTION_MILLISECONDS = 5000;
const OVERALL_MILLISECONDS = 60000;

class Migration020Error extends Error {
  constructor(code, cause) {
    super("Migration 020 is unavailable for this database state");
    this.name = "Migration020Error";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function checksum(sql) {
  const canonicalSql = typeof sql === "string" ? sql.replace(/\r\n/g, "\n") : sql;
  return crypto.createHash("sha256").update(canonicalSql).digest("hex");
}

function createPool(connectionString, environment = process.env) {
  if (!connectionString) throw new Migration020Error("database_url_required");
  return new Pool({
    connectionString,
    ssl: environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    max: 1,
  });
}

async function runMigration(options = {}) {
  const sql = fs.readFileSync(MIGRATION_FILE, "utf8");
  const sqlChecksum = checksum(sql);
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL, options.environment);
  const ownsPool = !options.pool;
  const now = options.monotonicNow || monotonicNow;
  const terminalState = createTerminalState();
  const outerDeadlineNs = deadlineAfter(now(), options.overallMilliseconds || OVERALL_MILLISECONDS);
  try {
    const client = await checkoutClientOnce({
      pool,
      deadlineNs: minimumDeadline(
        deadlineAfter(now(), options.connectionMilliseconds || CONNECTION_MILLISECONDS),
        outerDeadlineNs
      ),
      terminalState,
      now,
    });
    const transaction = await runBoundedPostgresTransaction({
      preAcquiredClient: client,
      terminalState,
      monotonicNow: now,
      outerDeadlineNs,
      phaseMilliseconds: options.overallMilliseconds || OVERALL_MILLISECONDS,
      async work({ query, remainingMilliseconds }) {
        await query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
        const required = await query(
          "SELECT checksum FROM app_schema_migrations WHERE version=$1",
          [REQUIRED_MIGRATION_VERSION]
        );
        if (!required.rows.length || required.rows[0].checksum !== REQUIRED_MIGRATION_CHECKSUM) {
          throw new Migration020Error("required_migration_mismatch");
        }
        const existing = await query(
          "SELECT checksum FROM app_schema_migrations WHERE version=$1",
          [MIGRATION_VERSION]
        );
        if (existing.rows.length) {
          if (existing.rows[0].checksum !== sqlChecksum) throw new Migration020Error("checksum_mismatch");
          return { status: "already_applied", version: MIGRATION_VERSION, checksum: sqlChecksum };
        }
        await query(sql);
        await query(
          "INSERT INTO app_schema_migrations(version,checksum) VALUES($1,$2)",
          [MIGRATION_VERSION, sqlChecksum]
        );
        if (remainingMilliseconds() === null) throw new Migration020Error("deadline_before_commit");
        return { status: "applied", version: MIGRATION_VERSION, checksum: sqlChecksum };
      },
    });
    return transaction.value;
  } catch (error) {
    for (let cause = error; cause; cause = cause.cause) {
      if (cause instanceof Migration020Error) throw cause;
    }
    throw new Migration020Error("migration_failed", error);
  } finally {
    if (ownsPool) await pool.end();
  }
}

if (require.main === module) {
  runMigration()
    .then((result) => console.log(`[UGF] Migration ${result.version}: ${result.status}`))
    .catch(() => {
      console.error("[UGF] Migration 020 is unavailable for this database state");
      process.exitCode = 1;
    });
}

module.exports = {
  CONNECTION_MILLISECONDS,
  MIGRATION_FILE,
  MIGRATION_VERSION,
  Migration020Error,
  OVERALL_MILLISECONDS,
  REQUIRED_MIGRATION_CHECKSUM,
  REQUIRED_MIGRATION_VERSION,
  checksum,
  runMigration,
};
