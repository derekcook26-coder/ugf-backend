"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { checkoutClientOnce, createTerminalState, deadlineAfter, minimumDeadline, monotonicNow, runBoundedPostgresTransaction } = require("./src/goals-coach/bounded-postgres-transaction");
const { CONNECTION_MILLISECONDS, MIGRATION_FILE, MIGRATION_VERSION, OVERALL_MILLISECONDS, Migration013Error, checksum } = require("./migrate_013");
const ROLLBACK_FILE = path.join(__dirname, "rollback_013_goals_coach_member_coaching_consent.sql");
const MIGRATION_LOCK_KEY = "82720512";
function createPool(connectionString, environment = process.env) {
  if (!connectionString) throw new Migration013Error("database_url_required");
  return new Pool({ connectionString, ssl: environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 1 });
}
async function runRollback(options = {}) {
  if (!options.skipConfirmation && process.env.CONFIRM_GOALS_COACH_MEMBER_COACHING_CONSENT_ROLLBACK !== "YES") throw new Migration013Error("confirmation_required");
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL, options.environment); const ownsPool = !options.pool;
  const now = options.monotonicNow || monotonicNow; const terminalState = createTerminalState(); const outerDeadlineNs = deadlineAfter(now(), options.overallMilliseconds || OVERALL_MILLISECONDS);
  try {
    const client = await checkoutClientOnce({ pool, deadlineNs: minimumDeadline(deadlineAfter(now(), options.connectionMilliseconds || CONNECTION_MILLISECONDS), outerDeadlineNs), terminalState, now });
    const transaction = await runBoundedPostgresTransaction({ pool: { connect: async () => client }, terminalState, monotonicNow: now, outerDeadlineNs, phaseMilliseconds: options.overallMilliseconds || OVERALL_MILLISECONDS, async work({ query, remainingMilliseconds }) {
      await query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const applied = await query("SELECT checksum FROM app_schema_migrations WHERE version = $1", [MIGRATION_VERSION]);
      if (!applied.rows.length) return { status: "not_applied", version: MIGRATION_VERSION };
      if (applied.rows[0].checksum !== checksum(fs.readFileSync(MIGRATION_FILE, "utf8"))) throw new Migration013Error("checksum_mismatch");
      const later = await query(`SELECT candidate.version FROM app_schema_migrations current JOIN app_schema_migrations candidate ON candidate.applied_at > current.applied_at WHERE current.version = $1 ORDER BY candidate.applied_at, candidate.version LIMIT 1`, [MIGRATION_VERSION]);
      if (later.rows.length) throw new Migration013Error("later_migration_applied");
      const count = await query("SELECT COUNT(*)::int AS count FROM goals_coach_member_coaching_consent_events");
      if (count.rows[0].count !== 0) throw new Migration013Error("immutable_rows_present");
      await query(fs.readFileSync(ROLLBACK_FILE, "utf8"));
      await query("DELETE FROM app_schema_migrations WHERE version = $1", [MIGRATION_VERSION]);
      if (remainingMilliseconds() === null) throw new Migration013Error("deadline_before_commit");
      return { status: "rolled_back", version: MIGRATION_VERSION };
    } });
    return transaction.value;
  } catch (error) {
    for (let cause = error; cause; cause = cause.cause) if (cause instanceof Migration013Error) throw cause;
    throw new Migration013Error("rollback_failed", error);
  } finally { if (ownsPool) await pool.end(); }
}
module.exports = { runRollback };
