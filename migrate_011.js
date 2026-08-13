"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const {
  TIMEOUT_CONFIGURATION_SQL,
  checkoutClientOnce,
  createTerminalState,
  deadlineAfter,
  minimumDeadline,
  monotonicNow,
  positiveRemainingMilliseconds,
  timeoutValue,
} = require("./src/goals-coach/bounded-postgres-transaction");

const MIGRATION_VERSION =
  "011_goals_coach_nullable_member_names_and_post_login_provisioning";
const REQUIRED_MIGRATION_VERSION =
  "010_goals_coach_member_pending_enrollment";
const REQUIRED_MIGRATION_CHECKSUM =
  "8f4273dd0b5a699c2690030ac20e8d0db8f5e6bc51d60f61d0e58bc55c8df739";
const MIGRATION_FILE = path.join(
  __dirname,
  "migration_011_goals_coach_nullable_member_names_and_post_login_provisioning.sql"
);
const MIGRATION_ADVISORY_LOCK_KEY = "82720511";
const CONNECTION_MILLISECONDS = 5000;
const OVERALL_MILLISECONDS = 60000;
const TABLE_LOCK_MILLISECONDS = 5000;
const POST_LOCK_MILLISECONDS = 45000;
const PENDING_ENROLLMENT_FLAG =
  "GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED";
const STATEMENT_MARKER = "-- migrate_011_statement";

const TABLE_LOCKS = Object.freeze([
  "goals_coach_member_pending_enrollments",
  "coach_members",
  "goals_coach_member_auth_mappings",
  "goals_coach_member_provisioning_events",
]);

const NEW_CONSTRAINTS = Object.freeze([
  "ck_coach_members_name_pair",
  "uq_goals_coach_member_pending_event_provenance",
  "ck_goals_coach_member_pending_consumed_member",
  "fk_goals_coach_member_provisioning_event_pending",
  "ck_goals_coach_member_provisioning_event_completed_member",
]);

const PRESERVED_INDEXES = Object.freeze({
  uq_goals_coach_member_pending_enrollment_member:
    "create unique index uq_goals_coach_member_pending_enrollment_member on goals_coach_member_pending_enrollments using btree (member_id) where (status = 'pending')",
  uq_goals_coach_member_pending_enrollment_gymmaster:
    "create unique index uq_goals_coach_member_pending_enrollment_gymmaster on goals_coach_member_pending_enrollments using btree (gymmaster_member_id) where (status = 'pending')",
  idx_goals_coach_member_pending_enrollment_expiry:
    "create index idx_goals_coach_member_pending_enrollment_expiry on goals_coach_member_pending_enrollments using btree (expires_at, id) where (status = 'pending')",
  idx_goals_coach_member_provisioning_events_member:
    "create index idx_goals_coach_member_provisioning_events_member on goals_coach_member_provisioning_events using btree (member_id, created_at, id)",
});

class Migration011Error extends Error {
  constructor(code, cause) {
    super("Migration 011 is unavailable for this database state");
    this.name = "Migration011Error";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

function splitMigrationStatements(sql) {
  const headerAndStatements = sql.split(STATEMENT_MARKER);
  const statements = headerAndStatements.slice(1).map((statement) => statement.trim());
  if (!statements.length || statements.some((statement) => !statement.endsWith(";"))) {
    throw new Migration011Error("invalid_migration_file");
  }
  return statements;
}

function createPool(connectionString, environment = process.env) {
  if (!connectionString) throw new Migration011Error("database_url_required");
  return new Pool({
    connectionString,
    ssl: environment.PGSSLMODE === "disable"
      ? false
      : { rejectUnauthorized: false },
    max: 1,
  });
}

function exactDisabled(environment) {
  return environment[PENDING_ENROLLMENT_FLAG] === "false";
}

function createDeadlineTimer(deadlineNs, terminalState, now) {
  const remaining = positiveRemainingMilliseconds(deadlineNs, now());
  if (remaining === null) {
    terminalState.terminate("migration_overall_deadline");
    return () => {};
  }
  const timer = setTimeout(
    () => terminalState.terminate("migration_overall_deadline"),
    remaining
  );
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

function canonicalCatalogSql(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/public\./g, "")
    .replace(/::text/g, "");
}

function catalogObjects(rows) {
  const column = new Map();
  const constraint = new Map();
  const index = new Map();
  const trigger = new Map();
  for (const row of rows) {
    if (row.object_kind === "column") {
      column.set(`${row.table_name}.${row.object_name}`, row);
    } else if (row.object_kind === "constraint") {
      constraint.set(row.object_name, row);
    } else if (row.object_kind === "index") {
      index.set(row.object_name, row);
    } else if (row.object_kind === "trigger") {
      trigger.set(row.object_name, row);
    }
  }
  return { column, constraint, index, trigger };
}

function exactConstraint(objects, name, tableName, expectedDefinition) {
  const row = objects.constraint.get(name);
  return Boolean(
    row
    && row.table_name === tableName
    && row.validated === true
    && canonicalCatalogSql(row.definition) === expectedDefinition
  );
}

function preservedCatalogState(objects) {
  for (const [name, expectedDefinition] of Object.entries(PRESERVED_INDEXES)) {
    const row = objects.index.get(name);
    if (!row || canonicalCatalogSql(row.definition) !== expectedDefinition) return false;
  }
  const eventTrigger = objects.trigger.get(
    "trg_preserve_goals_coach_member_provisioning_event"
  );
  const pendingTrigger = objects.trigger.get(
    "trg_preserve_goals_coach_member_pending_enrollment_deletion"
  );
  const eventTriggerDefinition = canonicalCatalogSql(
    eventTrigger && eventTrigger.definition
  );
  if (
    !eventTrigger
    || eventTrigger.table_name !== "goals_coach_member_provisioning_events"
    || !["O", "A"].includes(eventTrigger.enabled)
    || ![
      "before delete or update on goals_coach_member_provisioning_events for each row execute function preserve_goals_coach_member_provisioning_event()",
      "before update or delete on goals_coach_member_provisioning_events for each row execute function preserve_goals_coach_member_provisioning_event()",
    ].some((expected) => eventTriggerDefinition.includes(expected))
    || !pendingTrigger
    || pendingTrigger.table_name !== "goals_coach_member_pending_enrollments"
    || !["O", "A"].includes(pendingTrigger.enabled)
    || !canonicalCatalogSql(pendingTrigger.definition).includes(
      "before delete on goals_coach_member_pending_enrollments for each row execute function preserve_goals_coach_member_pending_enrollment_deletion()"
    )
  ) return false;

  const definitionsByTable = new Map();
  for (const row of objects.constraint.values()) {
    if (!definitionsByTable.has(row.table_name)) {
      definitionsByTable.set(row.table_name, []);
    }
    definitionsByTable.get(row.table_name).push(canonicalCatalogSql(row.definition));
  }
  const has = (table, definition) => (
    definitionsByTable.get(table) || []
  ).includes(definition);
  return (
    has("coach_members", "unique (gymmaster_member_id)")
    && has(
      "goals_coach_member_pending_enrollments",
      "foreign key (member_id) references coach_members(id) on delete restrict"
    )
    && has(
      "goals_coach_member_pending_enrollments",
      "foreign key (auth_mapping_id, member_id) references goals_coach_member_auth_mappings(id, member_id) on delete restrict"
    )
    && has(
      "goals_coach_member_pending_enrollments",
      "unique (id, member_id, requested_by_staff_user_id, client_request_id)"
    )
    && has(
      "goals_coach_member_provisioning_events",
      "foreign key (pending_enrollment_id, member_id, staff_user_id, client_request_id) references goals_coach_member_pending_enrollments(id, member_id, requested_by_staff_user_id, client_request_id) on delete restrict"
    )
    && has(
      "goals_coach_member_provisioning_events",
      "foreign key (auth_mapping_id, member_id) references goals_coach_member_auth_mappings(id, member_id) on delete restrict"
    )
  );
}

function requiredCatalogState(rows) {
  const objects = catalogObjects(rows);
  const requiredColumns = [
    ["coach_members.gymmaster_member_id", "NO", "text"],
    ["coach_members.first_name", "NO", "text"],
    ["coach_members.last_name", "NO", "text"],
    ["goals_coach_member_pending_enrollments.member_id", "NO", "bigint"],
    ["goals_coach_member_provisioning_events.member_id", "NO", "bigint"],
  ];
  for (const [name, nullable, type] of requiredColumns) {
    const row = objects.column.get(name);
    if (!row || row.is_nullable !== nullable || row.data_type !== type) return false;
  }
  if (NEW_CONSTRAINTS.some((name) => objects.constraint.has(name))) return false;
  return preservedCatalogState(objects);
}

function appliedCatalogState(rows) {
  const objects = catalogObjects(rows);

  const requiredColumns = [
    ["coach_members.gymmaster_member_id", "NO", "text"],
    ["coach_members.first_name", "YES", "text"],
    ["coach_members.last_name", "YES", "text"],
    ["goals_coach_member_pending_enrollments.member_id", "YES", "bigint"],
    ["goals_coach_member_provisioning_events.member_id", "YES", "bigint"],
  ];
  for (const [name, nullable, type] of requiredColumns) {
    const row = objects.column.get(name);
    if (!row || row.is_nullable !== nullable || row.data_type !== type) return false;
  }

  return preservedCatalogState(objects)
    && exactConstraint(
      objects,
      "ck_coach_members_name_pair",
      "coach_members",
      "check (((first_name is null) = (last_name is null)))"
    )
    && exactConstraint(
      objects,
      "uq_goals_coach_member_pending_event_provenance",
      "goals_coach_member_pending_enrollments",
      "unique (id, requested_by_staff_user_id, client_request_id)"
    )
    && exactConstraint(
      objects,
      "ck_goals_coach_member_pending_consumed_member",
      "goals_coach_member_pending_enrollments",
      "check (((status <> 'consumed') or ((member_id is not null) and (auth_mapping_id is not null))))"
    )
    && exactConstraint(
      objects,
      "fk_goals_coach_member_provisioning_event_pending",
      "goals_coach_member_provisioning_events",
      "foreign key (pending_enrollment_id, staff_user_id, client_request_id) references goals_coach_member_pending_enrollments(id, requested_by_staff_user_id, client_request_id) on delete restrict"
    )
    && exactConstraint(
      objects,
      "ck_goals_coach_member_provisioning_event_completed_member",
      "goals_coach_member_provisioning_events",
      "check (((action <> 'mapping_completed') or (member_id is not null)))"
    );
}

const CATALOG_QUERY = `
  SELECT 'column'::text AS object_kind,
         table_name,
         column_name AS object_name,
         is_nullable,
         data_type,
         NULL::text AS definition,
         NULL::boolean AS validated,
         NULL::text AS enabled
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'coach_members'
       AND column_name IN ('gymmaster_member_id', 'first_name', 'last_name'))
      OR (table_name = 'goals_coach_member_pending_enrollments'
          AND column_name = 'member_id')
      OR (table_name = 'goals_coach_member_provisioning_events'
          AND column_name = 'member_id')
    )
  UNION ALL
  SELECT 'constraint', c.relname, con.conname, NULL, NULL,
         pg_get_constraintdef(con.oid), con.convalidated, NULL
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'coach_members',
      'goals_coach_member_pending_enrollments',
      'goals_coach_member_auth_mappings',
      'goals_coach_member_provisioning_events'
    )
  UNION ALL
  SELECT 'index', tablename, indexname, NULL, NULL, indexdef, TRUE, NULL
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename IN (
      'coach_members',
      'goals_coach_member_pending_enrollments',
      'goals_coach_member_auth_mappings',
      'goals_coach_member_provisioning_events'
    )
  UNION ALL
  SELECT 'trigger', c.relname, t.tgname, NULL, NULL,
         pg_get_triggerdef(t.oid), TRUE, t.tgenabled::text
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
    AND c.relname IN (
      'goals_coach_member_pending_enrollments',
      'goals_coach_member_provisioning_events'
    )`;

const DATA_PREFLIGHT_QUERY = `
  SELECT
    EXISTS (
      SELECT 1 FROM coach_members
      WHERE (first_name IS NULL) <> (last_name IS NULL)
    ) AS incomplete_name_pair,
    EXISTS (
      SELECT 1 FROM goals_coach_member_pending_enrollments p
      LEFT JOIN coach_members m ON m.id = p.member_id
      WHERE p.member_id IS NULL
         OR m.id IS NULL
         OR m.gymmaster_member_id <> p.gymmaster_member_id
    ) AS incompatible_pending,
    EXISTS (
      SELECT 1
      FROM goals_coach_member_auth_mappings mapping
      JOIN coach_members member ON member.id = mapping.member_id
      WHERE mapping.auth_provider = 'gymmaster'
        AND (
          mapping.auth_subject !~ '^gymmaster:[1-9][0-9]*$'
          OR substring(mapping.auth_subject FROM 11) <> member.gymmaster_member_id
        )
    ) AS incompatible_mapping,
    EXISTS (
      SELECT 1
      FROM goals_coach_member_provisioning_events event
      LEFT JOIN goals_coach_member_pending_enrollments pending
        ON pending.id = event.pending_enrollment_id
       AND pending.member_id = event.member_id
       AND pending.requested_by_staff_user_id = event.staff_user_id
       AND pending.client_request_id = event.client_request_id
      WHERE pending.id IS NULL
    ) AS incompatible_event,
    EXISTS (
      SELECT gymmaster_member_id
      FROM goals_coach_member_pending_enrollments
      WHERE status = 'pending'
      GROUP BY gymmaster_member_id HAVING count(*) > 1
    ) AS duplicate_live_gymmaster,
    EXISTS (
      SELECT member_id
      FROM goals_coach_member_pending_enrollments
      WHERE status = 'pending'
      GROUP BY member_id HAVING count(*) > 1
    ) AS duplicate_live_member`;

async function runMigration(options = {}) {
  const environment = options.environment || process.env;
  if (!exactDisabled(environment)) {
    throw new Migration011Error("feature_not_exact_disabled");
  }
  const sql = fs.readFileSync(MIGRATION_FILE, "utf8");
  const sqlChecksum = checksum(sql);
  const statements = splitMigrationStatements(sql);
  const pool = options.pool || createPool(
    options.connectionString || environment.DATABASE_URL,
    environment
  );
  const ownsPool = !options.pool;
  const now = typeof options.monotonicNow === "function"
    ? options.monotonicNow
    : monotonicNow;
  const terminalState = options.terminalState || createTerminalState();
  const checkoutDeadline = deadlineAfter(now(), CONNECTION_MILLISECONDS);
  let client;
  let released = false;
  let discarded = false;
  let began = false;
  let timeoutInstalled = false;
  let activePromise = null;
  let commitIssued = false;
  let committed = false;
  let clearOverallTimer = () => {};
  let overallDeadline;
  let lockDeadline;
  let postLockDeadline;
  let status = "applied";

  function release(discardError) {
    if (released || !client) return;
    released = true;
    if (discardError) discarded = true;
    client.release(discardError);
  }

  function discard(cause) {
    const error = cause instanceof Error
      ? cause
      : new Error("Discarding uncertain Migration 011 connection");
    try { release(error); } catch (_) {}
  }

  function remaining(deadlines) {
    return positiveRemainingMilliseconds(minimumDeadline(...deadlines), now());
  }

  async function issue(sqlText, params = [], optionsForQuery = {}) {
    if (activePromise) throw new Migration011Error("concurrent_query_refused");
    if (!optionsForQuery.cleanup && terminalState.isTerminal()) {
      throw new Migration011Error("terminal_before_sql");
    }
    try {
      activePromise = Promise.resolve(client.query(sqlText, params));
    } catch (error) {
      throw new Migration011Error("query_start_failed", error);
    }
    const unlisten = terminalState.subscribe(() => {
      if (!optionsForQuery.serverBounded) discard(new Error("Unbounded migration query crossed deadline"));
    });
    try {
      return await activePromise;
    } catch (error) {
      throw new Migration011Error("query_failed", error);
    } finally {
      unlisten();
      activePromise = null;
    }
  }

  async function configure(deadlines) {
    const milliseconds = remaining(deadlines);
    if (milliseconds === null || terminalState.isTerminal()) {
      terminalState.terminate("migration_deadline");
      throw new Migration011Error("deadline_before_timeout_configuration");
    }
    await issue(
      TIMEOUT_CONFIGURATION_SQL,
      [timeoutValue(milliseconds)],
      { serverBounded: timeoutInstalled }
    );
    timeoutInstalled = true;
    if (remaining(deadlines) === null || terminalState.isTerminal()) {
      terminalState.terminate("migration_deadline");
      throw new Migration011Error("deadline_after_timeout_configuration");
    }
  }

  async function protectedQuery(sqlText, params, deadlines) {
    await configure(deadlines);
    if (remaining(deadlines) === null || terminalState.isTerminal()) {
      throw new Migration011Error("deadline_before_protected_sql");
    }
    const result = await issue(sqlText, params, { serverBounded: true });
    if (remaining(deadlines) === null || terminalState.isTerminal()) {
      terminalState.terminate("migration_deadline");
      throw new Migration011Error("deadline_after_protected_sql");
    }
    return result;
  }

  try {
    client = await checkoutClientOnce({
      pool,
      deadlineNs: checkoutDeadline,
      terminalState,
      now,
    });
    overallDeadline = deadlineAfter(now(), OVERALL_MILLISECONDS);
    clearOverallTimer = createDeadlineTimer(overallDeadline, terminalState, now);
    if (remaining([overallDeadline]) === null || terminalState.isTerminal()) {
      throw new Migration011Error("deadline_before_begin");
    }
    await issue("BEGIN", [], { serverBounded: false });
    began = true;
    if (discarded) throw new Migration011Error("begin_unknown");
    await configure([overallDeadline]);

    await protectedQuery(
      `SELECT pg_advisory_xact_lock($1::bigint)`,
      [MIGRATION_ADVISORY_LOCK_KEY],
      [overallDeadline]
    );
    const predecessor = await protectedQuery(
      "SELECT checksum FROM app_schema_migrations WHERE version = $1",
      [REQUIRED_MIGRATION_VERSION],
      [overallDeadline]
    );
    if (
      predecessor.rows.length !== 1
      || predecessor.rows[0].checksum !== REQUIRED_MIGRATION_CHECKSUM
    ) {
      throw new Migration011Error("predecessor_checksum_mismatch");
    }
    const existing = await protectedQuery(
      "SELECT checksum FROM app_schema_migrations WHERE version = $1",
      [MIGRATION_VERSION],
      [overallDeadline]
    );
    if (existing.rows.length) {
      if (existing.rows.length !== 1 || existing.rows[0].checksum !== sqlChecksum) {
        throw new Migration011Error("migration_checksum_mismatch");
      }
      status = "already_applied";
    }
    lockDeadline = deadlineAfter(now(), TABLE_LOCK_MILLISECONDS);
    for (const table of TABLE_LOCKS) {
      await protectedQuery(
        `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`,
        [],
        [lockDeadline, overallDeadline]
      );
    }
    if (
      remaining([lockDeadline, overallDeadline]) === null
      || terminalState.isTerminal()
    ) {
      throw new Migration011Error("table_lock_deadline");
    }
    postLockDeadline = deadlineAfter(now(), POST_LOCK_MILLISECONDS);
    const postDeadlines = [postLockDeadline, overallDeadline];
    if (status === "already_applied") {
      const catalog = await protectedQuery(CATALOG_QUERY, [], postDeadlines);
      if (!appliedCatalogState(catalog.rows)) {
        throw new Migration011Error("applied_schema_drift");
      }
    } else {
      const catalog = await protectedQuery(CATALOG_QUERY, [], postDeadlines);
      if (!requiredCatalogState(catalog.rows)) {
        throw new Migration011Error("catalog_preflight_failed");
      }
      const data = await protectedQuery(DATA_PREFLIGHT_QUERY, [], postDeadlines);
      const dataRow = data.rows[0];
      if (
        !dataRow
        || dataRow.incomplete_name_pair
        || dataRow.incompatible_pending
        || dataRow.incompatible_mapping
        || dataRow.incompatible_event
        || dataRow.duplicate_live_gymmaster
        || dataRow.duplicate_live_member
      ) {
        throw new Migration011Error("data_preflight_failed");
      }
      for (const statement of statements) {
        await protectedQuery(statement, [], postDeadlines);
      }
      const postCatalog = await protectedQuery(CATALOG_QUERY, [], postDeadlines);
      if (!appliedCatalogState(postCatalog.rows)) {
        throw new Migration011Error("postcondition_failed");
      }
      await protectedQuery(
        "INSERT INTO app_schema_migrations (version, checksum) VALUES ($1, $2)",
        [MIGRATION_VERSION, sqlChecksum],
        postDeadlines
      );
    }

    const commitDeadlines = [postLockDeadline, overallDeadline];
    await configure(commitDeadlines);
    if (remaining(commitDeadlines) === null || terminalState.isTerminal()) {
      throw new Migration011Error("deadline_before_commit");
    }
    commitIssued = true;
    await issue("COMMIT", [], { serverBounded: true });
    committed = true;
    began = false;
    if (remaining(commitDeadlines) === null || terminalState.isTerminal()) {
      release();
      throw new Migration011Error("commit_after_deadline");
    }
    release();
    return Object.freeze({
      status,
      version: MIGRATION_VERSION,
      checksum: sqlChecksum,
    });
  } catch (error) {
    if (committed) {
      if (!released) release();
      throw error;
    }
    if (commitIssued) {
      discard(error);
      throw new Migration011Error("commit_unknown", error);
    }
    if (began && !discarded && !released && !activePromise) {
      if (!timeoutInstalled && terminalState.isTerminal()) {
        discard(error);
      } else {
        try {
          if (
            !terminalState.isTerminal()
            && overallDeadline
            && remaining([overallDeadline]) !== null
          ) {
            await configure([overallDeadline]);
          }
          await issue("ROLLBACK", [], {
            cleanup: true,
            serverBounded: timeoutInstalled,
          });
          began = false;
          release();
        } catch (rollbackError) {
          discard(rollbackError);
        }
      }
    } else if (!released) {
      if (client && !began && !activePromise) release();
      else discard(error);
    }
    if (error instanceof Migration011Error) throw error;
    throw new Migration011Error("migration_failed", error);
  } finally {
    clearOverallTimer();
    if (activePromise) {
      try { await activePromise; } catch (_) {}
    }
    if (!released && client) discard(new Error("Migration client state uncertain"));
    if (ownsPool) await pool.end();
  }
}

if (require.main === module) {
  runMigration()
    .then((result) => {
      console.log(`[UGF] Migration ${result.version}: ${result.status}`);
    })
    .catch(() => {
      console.error("[UGF] Migration 011 is unavailable for this database state");
      process.exitCode = 1;
    });
}

module.exports = {
  CONNECTION_MILLISECONDS,
  MIGRATION_FILE,
  MIGRATION_VERSION,
  OVERALL_MILLISECONDS,
  POST_LOCK_MILLISECONDS,
  REQUIRED_MIGRATION_CHECKSUM,
  REQUIRED_MIGRATION_VERSION,
  TABLE_LOCK_MILLISECONDS,
  TABLE_LOCKS,
  checksum,
  exactDisabled,
  runMigration,
  splitMigrationStatements,
};
