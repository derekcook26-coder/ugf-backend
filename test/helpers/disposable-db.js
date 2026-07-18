const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const { runMigration } = require("../../migrate_002");
const { runMigration: runPhase1aMigration } = require("../../migrate_003");
const { runMigration: runPhase1bMigration } = require("../../migrate_004");

const projectRoot = path.resolve(__dirname, "../..");

function createPoolAdapter(database) {
  const client = {
    async query(sql, parameters) {
      if (parameters === undefined && /;\s*\S/.test(sql.trim())) {
        await database.exec(sql);
        return { rows: [], rowCount: 0 };
      }
      return database.query(sql, parameters || []);
    },
    release() {},
  };
  return {
    query: client.query,
    async connect() {
      return client;
    },
    async end() {},
  };
}

async function createDisposableDatabase(options = {}) {
  const database = new PGlite();
  const pool = createPoolAdapter(database);
  const migration001 = fs.readFileSync(
    path.join(projectRoot, "migration_001_checkin_tables.sql"),
    "utf8"
  );
  await database.exec(migration001);
  if (options.phase2 !== false) await runMigration({ pool });
  if (options.phase1a === true || options.phase1b === true) {
    await runPhase1aMigration({ pool });
  }
  if (options.phase1b === true) await runPhase1bMigration({ pool });
  return {
    database,
    pool,
    async close() {
      await database.close();
    },
  };
}

async function seedMemberAndPlan(pool, suffix = "1") {
  const member = await pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ($1, $2, $3) RETURNING *`,
    [`gm-${suffix}`, `Member${suffix}`, "Tester"]
  );
  const plan = await pool.query(
    `INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown)
     VALUES ($1, $2, '[]'::jsonb, $3) RETURNING *`,
    [member.rows[0].id, { plan: suffix }, `Plan ${suffix}`]
  );
  return { member: member.rows[0], plan: plan.rows[0] };
}

async function seedStaff(pool, suffix = "1", role = "coach", active = true) {
  const result = await pool.query(
    `INSERT INTO staff_users
      (auth_provider, auth_subject, email, display_name, role, active)
     VALUES ('clerk', $1, $2, $3, $4, $5)
     RETURNING *`,
    [`user_staff_${suffix}`, `staff${suffix}@example.test`, `Staff${suffix}`, role, active]
  );
  return result.rows[0];
}

async function seedAlphaMapping(pool, member, suffix = "1", active = true) {
  const result = await pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot,
       active, provisioning_method, provisioning_reference)
     VALUES ($1, 'clerk', $2, $3, $4, 'owner_approved_script', 'synthetic-test')
     RETURNING *`,
    [member.id, `user_alpha_${suffix}`, `alpha-${suffix}@example.test`, active]
  );
  return result.rows[0];
}

module.exports = {
  createDisposableDatabase,
  createPoolAdapter,
  seedAlphaMapping,
  seedMemberAndPlan,
  seedStaff,
};
