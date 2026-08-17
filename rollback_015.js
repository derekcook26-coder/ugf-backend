"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { checkoutClientOnce, createTerminalState, deadlineAfter, minimumDeadline, monotonicNow, runBoundedPostgresTransaction } = require("./src/goals-coach/bounded-postgres-transaction");
const { CONNECTION_MILLISECONDS, MIGRATION_FILE, MIGRATION_VERSION, OVERALL_MILLISECONDS, Migration015Error, checksum } = require("./migrate_015");
const ROLLBACK_FILE = path.join(__dirname, "rollback_015_goals_coach_member_sessions.sql"), MIGRATION_LOCK_KEY = "82720514";
const CANONICAL_VERSION = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*$/;
function migrationOrdinal(version) {
  const match = typeof version === "string" ? CANONICAL_VERSION.exec(version) : null;
  if (!match || match[1] === "000") throw new Migration015Error("noncanonical_migration_version");
  return Number(match[1]);
}
function createPool(connectionString, environment = process.env) { if (!connectionString) throw new Migration015Error("database_url_required"); return new Pool({ connectionString, ssl: environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 1 }); }
async function runRollback(options = {}) {
  if (!options.skipConfirmation && process.env.CONFIRM_GOALS_COACH_MEMBER_SESSION_ROLLBACK !== "YES") throw new Migration015Error("confirmation_required");
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL, options.environment), ownsPool = !options.pool;
  const now = options.monotonicNow || monotonicNow, terminalState = createTerminalState(), outerDeadlineNs = deadlineAfter(now(), options.overallMilliseconds || OVERALL_MILLISECONDS);
  try { const client = await checkoutClientOnce({ pool, deadlineNs: minimumDeadline(deadlineAfter(now(), options.connectionMilliseconds || CONNECTION_MILLISECONDS), outerDeadlineNs), terminalState, now });
    const tx = await runBoundedPostgresTransaction({ preAcquiredClient: client, terminalState, monotonicNow: now, outerDeadlineNs, phaseMilliseconds: options.overallMilliseconds || OVERALL_MILLISECONDS, async work({ query, remainingMilliseconds }) {
      await query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const applied = await query("SELECT checksum FROM app_schema_migrations WHERE version=$1", [MIGRATION_VERSION]);
      if (!applied.rows.length) return { status: "not_applied", version: MIGRATION_VERSION };
      if (applied.rows[0].checksum !== checksum(fs.readFileSync(MIGRATION_FILE, "utf8"))) throw new Migration015Error("checksum_mismatch");
      const ledger = await query("SELECT version FROM app_schema_migrations");
      const currentOrdinal = migrationOrdinal(MIGRATION_VERSION);
      if (ledger.rows.some((row) => migrationOrdinal(row.version) > currentOrdinal)) {
        throw new Migration015Error("later_migration_applied");
      }
      const active = await query("SELECT 1 FROM goals_coach_member_sessions WHERE revoked_at IS NULL AND expires_at>NOW() LIMIT 1");
      if (active.rows.length) throw new Migration015Error("active_sessions_present");
      await query(fs.readFileSync(ROLLBACK_FILE, "utf8")); await query("DELETE FROM app_schema_migrations WHERE version=$1", [MIGRATION_VERSION]);
      if (remainingMilliseconds() === null) throw new Migration015Error("deadline_before_commit"); return { status: "rolled_back", version: MIGRATION_VERSION };
    } }); return tx.value;
  } catch (error) { for (let cause = error; cause; cause = cause.cause) if (cause instanceof Migration015Error) throw cause; throw new Migration015Error("rollback_failed", error); }
  finally { if (ownsPool) await pool.end(); }
}
module.exports = { migrationOrdinal, runRollback };
