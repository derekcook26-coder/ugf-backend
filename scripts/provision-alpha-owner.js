const { Pool } = require("pg");

const ALLOWED_ACTIONS = ["create", "deactivate"];

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

async function provisionAlphaOwner(options = {}) {
  const input = options.input || loadProvisioningInput(options.environment || process.env);
  const pool = options.pool || new Pool({
    connectionString: (options.environment || process.env).DATABASE_URL,
    ssl: databaseSsl(options.environment || process.env),
    max: 1,
  });
  const ownsPool = !options.pool;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const member = await client.query(
      "SELECT id FROM coach_members WHERE id = $1 FOR UPDATE",
      [input.memberId]
    );
    if (member.rows.length !== 1) {
      throw new Error("The exact internal member record was not found");
    }

    const subjectMapping = await client.query(
      `SELECT * FROM goals_coach_member_auth_mappings
       WHERE auth_provider = $1 AND auth_subject = $2
       FOR UPDATE`,
      [input.authProvider, input.authSubject]
    );
    if (subjectMapping.rows.length > 1) throw new Error("Ambiguous authentication-subject mapping detected");
    if (subjectMapping.rows.length
      && String(subjectMapping.rows[0].member_id) !== String(input.memberId)) {
      throw new Error("The immutable authentication subject is already mapped to a different member");
    }

    if (input.action === "deactivate") {
      if (!subjectMapping.rows.length) throw new Error("The requested authentication mapping was not found");
      const row = subjectMapping.rows[0];
      if (!row.active) {
        await client.query("COMMIT");
        return { action: "deactivate", status: "already_inactive", mappingId: String(row.id), active: false };
      }
      const updated = await client.query(
        `UPDATE goals_coach_member_auth_mappings
         SET active = FALSE,
             deactivated_at = NOW(),
             deactivation_reason = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, active`,
        [input.deactivationReason, row.id]
      );
      await client.query("COMMIT");
      return {
        action: "deactivate",
        status: "deactivated",
        mappingId: String(updated.rows[0].id),
        active: updated.rows[0].active,
      };
    }

    const activeForMember = await client.query(
      `SELECT id, auth_subject FROM goals_coach_member_auth_mappings
       WHERE member_id = $1 AND auth_provider = $2 AND active = TRUE
       FOR UPDATE`,
      [input.memberId, input.authProvider]
    );
    if (activeForMember.rows.length > 1) throw new Error("Ambiguous active member mapping detected");
    if (activeForMember.rows.length
      && activeForMember.rows[0].auth_subject !== input.authSubject) {
      throw new Error("The member already has a different active authentication subject");
    }

    if (subjectMapping.rows.length) {
      const row = subjectMapping.rows[0];
      if (String(row.verified_email_snapshot).toLowerCase() !== input.verifiedEmail) {
        throw new Error("Refusing to overwrite the existing verified-email snapshot");
      }
      if (input.activate && !row.active) {
        const activated = await client.query(
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
        await client.query("COMMIT");
        return {
          action: "create",
          status: "activated_existing",
          mappingId: String(activated.rows[0].id),
          active: activated.rows[0].active,
        };
      }
      await client.query("COMMIT");
      return {
        action: "create",
        status: "already_exists",
        mappingId: String(row.id),
        active: row.active,
      };
    }

    const inserted = await client.query(
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
    await client.query("COMMIT");
    return {
      action: "create",
      status: "created",
      mappingId: String(inserted.rows[0].id),
      active: inserted.rows[0].active,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Preserve the original provisioning error.
    }
    throw error;
  } finally {
    client.release();
    if (ownsPool) await pool.end();
  }
}

if (require.main === module) {
  if (process.argv.length > 2) {
    console.error("[UGF] Alpha owner provisioning accepts protected environment input only; command-line values are refused");
    process.exitCode = 1;
  } else {
    provisionAlphaOwner()
      .then((result) => console.log(`[UGF] Alpha owner mapping ${JSON.stringify(result)}`))
      .catch((error) => {
        console.error(`[UGF] Alpha owner provisioning failed: ${error.message}`);
        process.exitCode = 1;
      });
  }
}

module.exports = { loadProvisioningInput, provisionAlphaOwner };
