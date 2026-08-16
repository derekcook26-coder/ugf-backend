"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { checkoutClientOnce, createTerminalState, deadlineAfter, minimumDeadline, monotonicNow, runBoundedPostgresTransaction } = require("./src/goals-coach/bounded-postgres-transaction");
const { CONNECTION_MILLISECONDS, MIGRATION_FILE, MIGRATION_VERSION, OVERALL_MILLISECONDS, Migration014Error, checksum } = require("./migrate_014");
const ROLLBACK_FILE = path.join(__dirname, "rollback_014_goals_coach_member_today.sql"), MIGRATION_LOCK_KEY = "82720513";
function createPool(connectionString, environment = process.env) { if (!connectionString) throw new Migration014Error("database_url_required"); return new Pool({ connectionString, ssl: environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 1 }); }
async function runRollback(options = {}) {
  if (!options.skipConfirmation && process.env.CONFIRM_GOALS_COACH_MEMBER_TODAY_ROLLBACK !== "YES") throw new Migration014Error("confirmation_required");
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL, options.environment), ownsPool = !options.pool;
  const now = options.monotonicNow || monotonicNow, terminalState = createTerminalState(), outerDeadlineNs = deadlineAfter(now(), options.overallMilliseconds || OVERALL_MILLISECONDS);
  try {
    const client = await checkoutClientOnce({ pool, deadlineNs: minimumDeadline(deadlineAfter(now(), options.connectionMilliseconds || CONNECTION_MILLISECONDS), outerDeadlineNs), terminalState, now });
    const transaction = await runBoundedPostgresTransaction({ preAcquiredClient: client, terminalState, monotonicNow: now, outerDeadlineNs, phaseMilliseconds: options.overallMilliseconds || OVERALL_MILLISECONDS, async work({ query, remainingMilliseconds }) {
      await query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const applied = await query("SELECT checksum FROM app_schema_migrations WHERE version = $1", [MIGRATION_VERSION]);
      if (!applied.rows.length) return { status: "not_applied", version: MIGRATION_VERSION };
      if (applied.rows[0].checksum !== checksum(fs.readFileSync(MIGRATION_FILE, "utf8"))) throw new Migration014Error("checksum_mismatch");
      const later = await query("SELECT candidate.version FROM app_schema_migrations current JOIN app_schema_migrations candidate ON candidate.applied_at > current.applied_at WHERE current.version = $1 ORDER BY candidate.applied_at, candidate.version LIMIT 1", [MIGRATION_VERSION]);
      if (later.rows.length) throw new Migration014Error("later_migration_applied");
      const count = await query("SELECT COUNT(*)::int AS count FROM goals_coach_member_today_attempts");
      if (count.rows[0].count !== 0) throw new Migration014Error("immutable_rows_present");
      await query(fs.readFileSync(ROLLBACK_FILE, "utf8")); await query("DELETE FROM app_schema_migrations WHERE version = $1", [MIGRATION_VERSION]);
      if (remainingMilliseconds() === null) throw new Migration014Error("deadline_before_commit"); return { status: "rolled_back", version: MIGRATION_VERSION };
    } }); return transaction.value;
  } catch (error) { for (let cause = error; cause; cause = cause.cause) if (cause instanceof Migration014Error) throw cause; throw new Migration014Error("rollback_failed", error); }
  finally { if (ownsPool) await pool.end(); }
}
if (require.main === module) { runRollback().then(() => console.log("[UGF] Member Today rollback completed.")).catch(() => { console.error("[UGF] Member Today rollback failed."); process.exitCode = 1; }); }
module.exports = { runRollback };
