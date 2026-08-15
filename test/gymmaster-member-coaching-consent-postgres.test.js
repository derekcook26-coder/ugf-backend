"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const { seedMemberAndPlan } = require("./helpers/disposable-db");
const { runMigration: migrate005 } = require("../migrate_005");
const { runMigration: migrate006 } = require("../migrate_006");
const { runMigration: migrate007 } = require("../migrate_007");
const { runMigration: migrate008 } = require("../migrate_008");
const { runMigration: migrate009 } = require("../migrate_009");
const { runMigration: migrate010 } = require("../migrate_010");
const { runMigration: migrate011 } = require("../migrate_011");
const { runMigration: migrate012 } = require("../migrate_012");
const { runMigration: migrate013 } = require("../migrate_013");
const { MEMBER_COACHING_CONSENT_NOTICE_VERSION, parseCoachingConsent, submitCoachingConsent } = require("../src/goals-coach/gymmaster-member-coaching-consent");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0 ? "requires unprivileged PostgreSQL 16" : false;
async function database(t) {
  const db = await createRealDisposablePostgres({ phase1b: true }); t.after(() => db.close());
  await migrate005({ pool: db.pool }); await migrate006({ pool: db.pool }); await migrate007({ pool: db.pool }); await migrate008({ pool: db.pool }); await migrate009({ pool: db.pool }); await migrate010({ pool: db.pool }); await migrate011({ pool: db.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } }); await migrate012({ pool: db.pool }); await migrate013({ pool: db.pool });
  assert.match((await db.pool.query("SHOW server_version")).rows[0].server_version, /^16\./); return db;
}
function input(number, action) { return parseCoachingConsent({ clientRequestId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, noticeVersion: MEMBER_COACHING_CONSENT_NOTICE_VERSION, action }, MEMBER_COACHING_CONSENT_NOTICE_VERSION); }

test("PostgreSQL 16 preserves exact ownership, transitions, replay, and immutable history", { skip: skipForRoot }, async (t) => {
  const db = await database(t); const seeded = await seedMemberAndPlan(db.pool, "consent-real");
  const mapping = (await db.pool.query("INSERT INTO goals_coach_member_auth_mappings (member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference) VALUES ($1,'gymmaster','gymmaster:93001','synthetic@example.test',TRUE,'owner_approved_script','consent-real') RETURNING *", [seeded.member.id])).rows[0];
  const identity = { authProvider: "gymmaster", authSubject: "gymmaster:93001" }; const authorization = { active: true, mappingId: String(mapping.id), memberId: String(mapping.member_id) };
  const accepted = await submitCoachingConsent(db.pool, identity, authorization, input(93001, "accept")); assert.equal(accepted.consent.acceptedForCurrentNotice, true);
  const replay = await submitCoachingConsent(db.pool, identity, authorization, input(93001, "accept")); assert.equal(replay.created, false);
  await assert.rejects(submitCoachingConsent(db.pool, identity, authorization, input(93001, "decline")), (error) => error.code === "COACHING_CONSENT_IDEMPOTENCY_CONFLICT");
  await assert.rejects(submitCoachingConsent(db.pool, identity, authorization, input(93002, "decline")), (error) => error.code === "COACHING_CONSENT_WITHDRAW_REQUIRED");
  const withdrawn = await submitCoachingConsent(db.pool, identity, authorization, input(93003, "withdraw")); assert.equal(withdrawn.consent.status, "withdrawn");
  assert.equal((await db.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_coaching_consent_events WHERE member_id=$1", [mapping.member_id])).rows[0].count, 2);
  await assert.rejects(db.pool.query("DELETE FROM goals_coach_member_coaching_consent_events WHERE member_id=$1", [mapping.member_id]), /append-only/);
  assert.equal((await db.pool.query("SELECT COUNT(*)::int count FROM coach_plans WHERE member_id=$1", [mapping.member_id])).rows[0].count, 1);
});
