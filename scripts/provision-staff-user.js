const { Pool } = require("pg");

const SUBJECT_PATTERN = /^user_[A-Za-z0-9_-]+$/;
const ALLOWED_ROLES = new Set(["coach", "admin"]);
const FORBIDDEN_ARGUMENT_PATTERN = /token|secret|password|key/i;
const VALUE_ARGUMENTS = new Set(["subject", "email", "display-name", "role", "provider"]);

function parseArguments(argv) {
  const options = { activate: false, provider: "clerk" };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (FORBIDDEN_ARGUMENT_PATTERN.test(argument)) {
      throw new Error("Credential and secret arguments are not accepted");
    }
    if (argument === "--activate") {
      options.activate = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (!VALUE_ARGUMENTS.has(name)) throw new Error(`Unsupported argument: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }

  return options;
}

function validateOptions(options) {
  if (options.provider !== "clerk") throw new Error("Only the clerk provider is supported");
  if (!SUBJECT_PATTERN.test(String(options.subject || ""))) {
    throw new Error("A valid immutable Clerk user subject is required");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(options.email || ""))) {
    throw new Error("A valid staff email is required");
  }
  if (!String(options.displayName || "").trim()) throw new Error("A display name is required");
  if (!ALLOWED_ROLES.has(options.role)) throw new Error("Role must be coach or admin");
}

function databaseSsl() {
  return process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
}

async function provisionStaffUser(options, dependencies = {}) {
  validateOptions(options);
  if (!dependencies.pool && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = dependencies.pool || new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: databaseSsl(),
    max: 1,
  });
  const ownsPool = !dependencies.pool;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const byEmail = await client.query(
      "SELECT id, auth_provider, auth_subject FROM staff_users WHERE lower(email) = lower($1) FOR UPDATE",
      [options.email]
    );
    const bySubject = await client.query(
      "SELECT id, auth_provider, auth_subject, active FROM staff_users WHERE auth_provider = $1 AND auth_subject = $2 FOR UPDATE",
      [options.provider, options.subject]
    );

    if (byEmail.rows.length && (
      byEmail.rows[0].auth_provider !== options.provider
      || byEmail.rows[0].auth_subject !== options.subject
    )) {
      throw new Error("That email is already mapped to a different provider subject");
    }
    if (bySubject.rows.length && byEmail.rows.length && bySubject.rows[0].id !== byEmail.rows[0].id) {
      throw new Error("Provider subject and email resolve to different staff records");
    }

    let operation;
    let row;
    if (bySubject.rows.length) {
      const result = await client.query(
        `UPDATE staff_users
         SET email = $1,
             display_name = $2,
             role = $3,
             active = CASE WHEN $4 THEN TRUE ELSE active END,
             updated_at = NOW()
         WHERE auth_provider = $5 AND auth_subject = $6
         RETURNING id, role, active`,
        [options.email, options.displayName.trim(), options.role, options.activate, options.provider, options.subject]
      );
      operation = "updated_existing_mapping";
      row = result.rows[0];
    } else {
      const result = await client.query(
        `INSERT INTO staff_users
          (auth_provider, auth_subject, email, display_name, role, active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, role, active`,
        [options.provider, options.subject, options.email, options.displayName.trim(), options.role, options.activate]
      );
      operation = "created";
      row = result.rows[0];
    }

    await client.query("COMMIT");
    return {
      operation,
      staffUserId: String(row.id),
      provider: options.provider,
      role: row.role,
      active: row.active,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    if (ownsPool) await pool.end();
  }
}

if (require.main === module) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    validateOptions(options);
  } catch (error) {
    console.error(`[UGF] Staff provisioning refused: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  provisionStaffUser(options)
    .then((summary) => {
      console.log("[UGF] Staff provisioning complete", summary);
    })
    .catch((error) => {
      console.error("[UGF] Staff provisioning failed; no staff record was changed");
      process.exitCode = 1;
    });
}

module.exports = {
  SUBJECT_PATTERN,
  parseArguments,
  provisionStaffUser,
  validateOptions,
};
