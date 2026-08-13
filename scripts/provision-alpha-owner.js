const { Pool } = require("pg");
const {
  checkoutClientOnce,
  createTerminalState,
  deadlineAfter,
  monotonicNow,
  runBoundedPostgresTransaction,
} = require("../src/goals-coach/bounded-postgres-transaction");
const {
  canonicalGymMasterMemberId,
} = require("../src/goals-coach/gymmaster-member-provisioning-lock");

const ALLOWED_ACTIONS = ["create", "deactivate"];
const PENDING_ENROLLMENT_FLAG =
  "GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED";
const PROTECTED_FAILURE =
  "[UGF] Alpha owner provisioning is unavailable for this database state";
const CONNECTION_MILLISECONDS = 5000;
const TRANSACTION_MILLISECONDS = 5000;

function requiredEnvironment(name, environment) {
  const value = String(environment[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadProvisioningInput(environment = process.env) {
  const action = requiredEnvironment("GOALS_COACH_PROVISION_ACTION", environment);
  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new Error("GOALS_COACH_PROVISION_ACTION must be create or deactivate");
  }
  const memberId = requiredEnvironment("GOALS_COACH_PROVISION_MEMBER_ID", environment);
  if (!/^[1-9][0-9]*$/.test(memberId)) {
    throw new Error("GOALS_COACH_PROVISION_MEMBER_ID must be a positive internal member ID");
  }
  const authProvider = requiredEnvironment("GOALS_COACH_PROVISION_AUTH_PROVIDER", environment);
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(authProvider)) {
    throw new Error("GOALS_COACH_PROVISION_AUTH_PROVIDER is malformed");
  }
  const authSubject = requiredEnvironment("GOALS_COACH_PROVISION_AUTH_SUBJECT", environment);
  if (authProvider === "clerk" && !/^user_[A-Za-z0-9_-]+$/.test(authSubject)) {
    throw new Error("GOALS_COACH_PROVISION_AUTH_SUBJECT is not a valid immutable Clerk user subject");
  }
  if (authSubject.length > 200) throw new Error("GOALS_COACH_PROVISION_AUTH_SUBJECT is too long");

  if (action === "deactivate") {
    return {
      action,
      memberId,
      authProvider,
      authSubject,
      deactivationReason: requiredEnvironment("GOALS_COACH_PROVISION_DEACTIVATION_REASON", environment),
    };
  }

  const verifiedEmail = requiredEnvironment("GOALS_COACH_PROVISION_VERIFIED_EMAIL", environment).toLowerCase();
  if (verifiedEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(verifiedEmail)) {
    throw new Error("GOALS_COACH_PROVISION_VERIFIED_EMAIL is malformed");
  }
  return {
    action,
    memberId,
    authProvider,
    authSubject,
    verifiedEmail,
    provisioningReference: requiredEnvironment("GOALS_COACH_PROVISIONING_REFERENCE", environment),
    activate: String(environment.GOALS_COACH_PROVISION_ACTIVATE || "").trim() === "YES",
  };
}

function databaseSsl(environment = process.env) {
  return environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
}

function canonicalSchemaSql(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/::text/g, "");
}

async function provisionAlphaOwner(options = {}) {
  const environment = options.environment || process.env;
  if (environment[PENDING_ENROLLMENT_FLAG] !== "false") {
    throw new Error(PROTECTED_FAILURE);
  }
  const input = options.input || loadProvisioningInput(environment);
  const pool = options.pool || new Pool({
    connectionString: environment.DATABASE_URL,
    ssl: databaseSsl(environment),
    max: 1,
  });
  const ownsPool = !options.pool;
  const now = typeof options.monotonicNow === "function"
    ? options.monotonicNow
    : monotonicNow;
  const terminalState = options.terminalState || createTerminalState();
  const terminateForSignal = () => {
    terminalState.terminate("alpha_owner_process_signal");
  };
  process.once("SIGINT", terminateForSignal);
  process.once("SIGTERM", terminateForSignal);
  let client = null;
  let handedToTransaction = false;

  try {
    const checkoutDeadline = deadlineAfter(now(), CONNECTION_MILLISECONDS);
    client = await checkoutClientOnce({
      pool,
      deadlineNs: checkoutDeadline,
      terminalState,
      now,
    });
    const transactionStart = now();
    const transactionDeadline = deadlineAfter(
      transactionStart,
      TRANSACTION_MILLISECONDS
    );
    handedToTransaction = true;
    const result = await runBoundedPostgresTransaction({
      pool: { connect: async () => client },
      outerDeadlineNs: transactionDeadline,
      phaseMilliseconds: TRANSACTION_MILLISECONDS,
      terminalState,
      monotonicNow: now,
      work: async (transaction) => {
        await transaction.query(
          "LOCK TABLE goals_coach_member_pending_enrollments IN ACCESS EXCLUSIVE MODE"
        );
        const schema = await transaction.query(
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'goals_coach_member_pending_enrollments'
             AND column_name IN (
               'gymmaster_member_id', 'status', 'expires_at'
             )
           ORDER BY column_name`
        );
        const expectedColumns = [
          ["expires_at", "timestamp with time zone", "NO"],
          ["gymmaster_member_id", "text", "NO"],
          ["status", "text", "NO"],
        ];
        if (schema.rows.length !== expectedColumns.length || expectedColumns.some(
          ([columnName, dataType, nullable], index) => {
            const row = schema.rows[index];
            return !row
              || row.column_name !== columnName
              || row.data_type !== dataType
              || row.is_nullable !== nullable;
          }
        )) {
          throw new Error("protected schema refusal");
        }
        const constraints = await transaction.query(
          `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
           FROM pg_constraint constraint_row
           JOIN pg_class table_row
             ON table_row.oid = constraint_row.conrelid
           JOIN pg_namespace namespace_row
             ON namespace_row.oid = table_row.relnamespace
           WHERE namespace_row.nspname = 'public'
             AND table_row.relname =
                   'goals_coach_member_pending_enrollments'
             AND constraint_row.contype = 'c'
             AND constraint_row.convalidated = TRUE`
        );
        const definitions = new Set(
          constraints.rows.map((row) => canonicalSchemaSql(row.definition))
        );
        if (
          !definitions.has(
            "check ((status = any (array['pending', 'consumed', 'expired'])))"
          )
          || !definitions.has(
            "check ((((status = 'pending') and (auth_mapping_id is null) and (consumed_at is null) and (expired_at is null)) or ((status = 'consumed') and (auth_mapping_id is not null) and (consumed_at is not null) and (expired_at is null)) or ((status = 'expired') and (auth_mapping_id is null) and (consumed_at is null) and (expired_at is not null))))"
          )
        ) throw new Error("protected schema refusal");

        const member = await transaction.query(
          `SELECT id, gymmaster_member_id
           FROM coach_members
           WHERE id = $1
           FOR UPDATE`,
          [input.memberId]
        );
        if (member.rows.length !== 1) {
          throw new Error("protected member refusal");
        }
        const gymmasterMemberId = canonicalGymMasterMemberId(
          member.rows[0].gymmaster_member_id
        );
        const livePending = await transaction.query(
          `SELECT id
           FROM goals_coach_member_pending_enrollments
           WHERE gymmaster_member_id = $1
             AND status = 'pending'
             AND expires_at > transaction_timestamp()
           ORDER BY id
           LIMIT 2
           FOR UPDATE`,
          [gymmasterMemberId]
        );
        if (livePending.rows.length) throw new Error("protected pending refusal");

        const subjectMapping = await transaction.query(
          `SELECT * FROM goals_coach_member_auth_mappings
           WHERE auth_provider = $1 AND auth_subject = $2
           ORDER BY id
           FOR UPDATE`,
          [input.authProvider, input.authSubject]
        );
        if (subjectMapping.rows.length > 1) throw new Error("protected mapping refusal");
        if (subjectMapping.rows.length
          && String(subjectMapping.rows[0].member_id) !== String(input.memberId)) {
          throw new Error("protected identity refusal");
        }

        if (input.action === "deactivate") {
          if (!subjectMapping.rows.length) throw new Error("protected mapping refusal");
          const row = subjectMapping.rows[0];
          if (!row.active) {
            return { action: "deactivate", status: "already_inactive", mappingId: String(row.id), active: false };
          }
          const updated = await transaction.query(
            `UPDATE goals_coach_member_auth_mappings
             SET active = FALSE,
                 deactivated_at = NOW(),
                 deactivation_reason = $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING id, active`,
            [input.deactivationReason, row.id]
          );
          return {
            action: "deactivate",
            status: "deactivated",
            mappingId: String(updated.rows[0].id),
            active: updated.rows[0].active,
          };
        }

        const activeForMember = await transaction.query(
          `SELECT id, auth_subject FROM goals_coach_member_auth_mappings
           WHERE member_id = $1 AND auth_provider = $2 AND active = TRUE
           ORDER BY id
           FOR UPDATE`,
          [input.memberId, input.authProvider]
        );
        if (activeForMember.rows.length > 1) throw new Error("protected mapping refusal");
        if (activeForMember.rows.length
          && activeForMember.rows[0].auth_subject !== input.authSubject) {
          throw new Error("protected identity refusal");
        }

        if (subjectMapping.rows.length) {
          const row = subjectMapping.rows[0];
          if (String(row.verified_email_snapshot).toLowerCase() !== input.verifiedEmail) {
            throw new Error("protected email refusal");
          }
          if (input.activate && !row.active) {
            const activated = await transaction.query(
              `UPDATE goals_coach_member_auth_mappings
               SET active = TRUE,
                   deactivated_at = NULL,
                   deactivated_by_staff_user_id = NULL,
                   deactivation_reason = NULL,
                   updated_at = NOW()
               WHERE id = $1
               RETURNING id, active`,
              [row.id]
            );
            return {
              action: "create",
              status: "activated_existing",
              mappingId: String(activated.rows[0].id),
              active: activated.rows[0].active,
            };
          }
          return {
            action: "create",
            status: "already_exists",
            mappingId: String(row.id),
            active: row.active,
          };
        }

        const inserted = await transaction.query(
          `INSERT INTO goals_coach_member_auth_mappings
            (member_id, auth_provider, auth_subject, verified_email_snapshot,
             active, provisioning_method, provisioning_reference)
           VALUES ($1, $2, $3, $4, $5, 'owner_approved_script', $6)
           RETURNING id, active`,
          [
            input.memberId,
            input.authProvider,
            input.authSubject,
            input.verifiedEmail,
            input.activate,
            input.provisioningReference,
          ]
        );
        return {
          action: "create",
          status: "created",
          mappingId: String(inserted.rows[0].id),
          active: inserted.rows[0].active,
        };
      },
    });
    return result.value;
  } catch (error) {
    const protectedError = new Error(PROTECTED_FAILURE);
    protectedError.cause = error;
    throw protectedError;
  } finally {
    process.removeListener("SIGINT", terminateForSignal);
    process.removeListener("SIGTERM", terminateForSignal);
    if (client && !handedToTransaction) {
      try { client.release(); } catch (_) {}
    }
    if (ownsPool) await pool.end();
  }
}

/*
 * Operational exclusion: do not run this script while Migration 011, same-DB
 * pending-enrollment tests, or any enabled/live pending-enrollment workflow is
 * active. The exact-disabled pre-connect guard and pending-table-first lock are
 * the enforceable last line of defense; there is no automatic retry.
 */

if (require.main === module) {
  if (process.argv.length > 2) {
    console.error(PROTECTED_FAILURE);
    process.exitCode = 1;
  } else {
    provisionAlphaOwner()
      .then(() => console.log("[UGF] Alpha owner provisioning completed"))
      .catch(() => {
        console.error(PROTECTED_FAILURE);
        process.exitCode = 1;
      });
  }
}

module.exports = {
  CONNECTION_MILLISECONDS,
  PROTECTED_FAILURE,
  TRANSACTION_MILLISECONDS,
  loadProvisioningInput,
  provisionAlphaOwner,
};
