"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { checkoutClientOnce, createTerminalState, deadlineAfter, minimumDeadline, monotonicNow, runBoundedPostgresTransaction } = require("./src/goals-coach/bounded-postgres-transaction");
const MIGRATION_VERSION = "017_goals_coach_member_conversation_bindings";
const REQUIRED_MIGRATION_VERSION = "016_goals_coach_adaptive_safety_intake";
const REQUIRED_MIGRATION_CHECKSUM = "29daafbc808491b77fd15b3329674134e69cd790756a2154f0ad6bee6fbfc8d2";
const MIGRATION_FILE = path.join(__dirname, "migration_017_goals_coach_member_conversation_bindings.sql");
const MIGRATION_LOCK_KEY = "82720516";
const CONNECTION_MILLISECONDS = 5000, OVERALL_MILLISECONDS = 60000;
class Migration017Error extends Error { constructor(code, cause) { super("Migration 017 is unavailable for this database state"); this.name = "Migration017Error"; this.code = code; if (cause) this.cause = cause; } }
function checksum(sql) { return crypto.createHash("sha256").update(sql).digest("hex"); }
function createPool(connectionString, environment = process.env) { if (!connectionString) throw new Migration017Error("database_url_required"); return new Pool({ connectionString, ssl: environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 1 }); }
async function runMigration(options = {}) {
  const sql = fs.readFileSync(MIGRATION_FILE, "utf8"), sqlChecksum = checksum(sql);
  const pool = options.pool || createPool(options.connectionString || process.env.DATABASE_URL, options.environment), ownsPool = !options.pool;
  const now = options.monotonicNow || monotonicNow, terminalState = createTerminalState(), outerDeadlineNs = deadlineAfter(now(), options.overallMilliseconds || OVERALL_MILLISECONDS);
  try {
    const client = await checkoutClientOnce({ pool, deadlineNs: minimumDeadline(deadlineAfter(now(), options.connectionMilliseconds || CONNECTION_MILLISECONDS), outerDeadlineNs), terminalState, now });
    const tx = await runBoundedPostgresTransaction({ preAcquiredClient: client, terminalState, monotonicNow: now, outerDeadlineNs, phaseMilliseconds: options.overallMilliseconds || OVERALL_MILLISECONDS, async work({ query, remainingMilliseconds }) {
      await query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const required = await query("SELECT checksum FROM app_schema_migrations WHERE version=$1", [REQUIRED_MIGRATION_VERSION]);
      if (!required.rows.length || required.rows[0].checksum !== REQUIRED_MIGRATION_CHECKSUM) throw new Migration017Error("required_migration_mismatch");
      const existing = await query("SELECT checksum FROM app_schema_migrations WHERE version=$1", [MIGRATION_VERSION]);
      if (existing.rows.length) { if (existing.rows[0].checksum !== sqlChecksum) throw new Migration017Error("checksum_mismatch"); return { status: "already_applied", version: MIGRATION_VERSION, checksum: sqlChecksum }; }
      await query(sql);
      await query("INSERT INTO app_schema_migrations(version,checksum) VALUES($1,$2)", [MIGRATION_VERSION, sqlChecksum]);
      if (remainingMilliseconds() === null) throw new Migration017Error("deadline_before_commit");
      return { status: "applied", version: MIGRATION_VERSION, checksum: sqlChecksum };
    } });
    return tx.value;
  } catch (error) {
    for (let cause = error; cause; cause = cause.cause) if (cause instanceof Migration017Error) throw cause;
    throw new Migration017Error("migration_failed", error);
  } finally { if (ownsPool) await pool.end(); }
}
if (require.main === module) runMigration().then((result) => console.log(`[UGF] Migration ${result.version}: ${result.status}`)).catch(() => { console.error("[UGF] Migration 017 is unavailable for this database state"); process.exitCode = 1; });
module.exports = { CONNECTION_MILLISECONDS, MIGRATION_FILE, MIGRATION_VERSION, Migration017Error, OVERALL_MILLISECONDS, REQUIRED_MIGRATION_CHECKSUM, REQUIRED_MIGRATION_VERSION, checksum, runMigration };
