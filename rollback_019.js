"use strict";

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
const {
  CONNECTION_MILLISECONDS,
  MIGRATION_FILE,
  MIGRATION_VERSION,
  OVERALL_MILLISECONDS,
  Migration019Error,
  checksum,
} = require("./migrate_019");

const ROLLBACK_FILE = path.join(__dirname, "rollback_019_goals_coach_member_conversation_provider_dispatch.sql");
const MIGRATION_LOCK_KEY = "82720519";
const CANONICAL_VERSION = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*$/;

function migrationOrdinal(version) {
  const match = typeof version === "string" ? CANONICAL_VERSION.exec(version) : null;
  if (!match || match[1] === "000") throw new Migration019Error("noncanonical_migration_version");
  return Number(match[1]);
}

function createPool(connectionString, environment = process.env) {
  if (!connectionString) throw new Migration019Error("database_url_required");
  return new Pool({
    connectionString,
    ssl: environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    max: 1,
  });
}

async function runRollback(options = {}) {
  if (!options.skipConfirmation
    && process.env.CONFIRM_GOALS_COACH_MEMBER_CONVERSATION_PROVIDER_DISPATCH_ROLLBACK !== "YES") {
    throw new Migration019Error("confirmation_required");
  }
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
        const applied = await query(
          "SELECT checksum FROM app_schema_migrations WHERE version=$1",
          [MIGRATION_VERSION]
        );
        if (!applied.rows.length) return { status: "not_applied", version: MIGRATION_VERSION };
        if (applied.rows[0].checksum !== checksum(fs.readFileSync(MIGRATION_FILE, "utf8"))) {
          throw new Migration019Error("checksum_mismatch");
        }
        const ledger = await query("SELECT version FROM app_schema_migrations");
        const currentOrdinal = migrationOrdinal(MIGRATION_VERSION);
        if (ledger.rows.some((row) => migrationOrdinal(row.version) > currentOrdinal)) {
          throw new Migration019Error("later_migration_applied");
        }
        await query("LOCK TABLE goals_coach_member_conversation_turn_dispatch_events IN ACCESS EXCLUSIVE MODE");
        await query("LOCK TABLE goals_coach_member_conversation_turn_reservations IN ACCESS EXCLUSIVE MODE");
        const reservationRows = await query(
          "SELECT 1 FROM goals_coach_member_conversation_turn_reservations LIMIT 1"
        );
        const eventRows = await query(
          "SELECT 1 FROM goals_coach_member_conversation_turn_dispatch_events LIMIT 1"
        );
        if (reservationRows.rows.length || eventRows.rows.length) {
          throw new Migration019Error("provider_dispatch_rows_exist");
        }
        await query(fs.readFileSync(ROLLBACK_FILE, "utf8"));
        await query("DELETE FROM app_schema_migrations WHERE version=$1", [MIGRATION_VERSION]);
        if (remainingMilliseconds() === null) throw new Migration019Error("deadline_before_commit");
        return { status: "rolled_back", version: MIGRATION_VERSION };
      },
    });
    return transaction.value;
  } catch (error) {
    for (let cause = error; cause; cause = cause.cause) {
      if (cause instanceof Migration019Error) throw cause;
    }
    throw new Migration019Error("rollback_failed", error);
  } finally {
    if (ownsPool) await pool.end();
  }
}

if (require.main === module) {
  runRollback()
    .then((result) => console.log(`[UGF] Migration ${result.version}: ${result.status}`))
    .catch(() => {
      console.error("[UGF] Migration 019 rollback is unavailable for this database state");
      process.exitCode = 1;
    });
}

module.exports = { migrationOrdinal, ROLLBACK_FILE, runRollback };
