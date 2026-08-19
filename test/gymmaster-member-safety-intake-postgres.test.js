"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MEMBER_SAFETY_NOTICE_VERSION, parseSafetyIntake, readEffectiveSafetyIntake, submitSafetyIntake } = require("../src/goals-coach/gymmaster-member-safety-intake");
const { runMigration: migrate005 } = require("../migrate_005");
const { runMigration: migrate006 } = require("../migrate_006");
const { runMigration: migrate007 } = require("../migrate_007");
const { runMigration: migrate008 } = require("../migrate_008");
const { runMigration: migrate009 } = require("../migrate_009");
const { runMigration: migrate010 } = require("../migrate_010");
const { runMigration: migrate011 } = require("../migrate_011");
const { runMigration: migrate012 } = require("../migrate_012");
const { runMigration: migrate013 } = require("../migrate_013");
const { runMigration: migrate014 } = require("../migrate_014");
const { runMigration: migrate015 } = require("../migrate_015");
const { runMigration: migrate016 } = require("../migrate_016");
const { runRollback: rollback012 } = require("../rollback_012");
const { ANSWER_FIELDS } = require("../src/goals-coach/gymmaster-member-safety-intake");
const { seedMemberAndPlan } = require("./helpers/disposable-db");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0 ? "requires unprivileged PostgreSQL 16" : false;
const hashConfiguration = Object.freeze({ currentVersion: "key-1", keys: Object.freeze({ "key-1": "h".repeat(32) }) });
function baseline() { return { urgentWarningSigns: false, painOrStiffness: false, painSeverity: null, injuryOrInstability: false, recentSurgery: false, surgeryCleared: null, medicalOrExerciseRestriction: false, restrictionAllowsSafeExercise: null, neurologicalSymptoms: false, otherUnsafeConcern: false }; }
function input(number, overrides = {}) { return parseSafetyIntake({ clientRequestId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, noticeVersion: MEMBER_SAFETY_NOTICE_VERSION, answers: { ...baseline(), ...overrides } }, MEMBER_SAFETY_NOTICE_VERSION); }
function urgentInput(number) { const answers = Object.fromEntries(ANSWER_FIELDS.map((field) => [field, null])); answers.urgentWarningSigns = true; return parseSafetyIntake({ clientRequestId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, noticeVersion: MEMBER_SAFETY_NOTICE_VERSION, answers }, MEMBER_SAFETY_NOTICE_VERSION); }

async function database(t) {
  const db = await createRealDisposablePostgres({ phase1b: true }); t.after(() => db.close());
  await migrate005({ pool: db.pool }); await migrate006({ pool: db.pool }); await migrate007({ pool: db.pool }); await migrate008({ pool: db.pool });
  await migrate009({ pool: db.pool }); await migrate010({ pool: db.pool });
  await migrate011({ pool: db.pool, environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" } }); await migrate012({ pool: db.pool });
  await migrate013({ pool: db.pool }); await migrate014({ pool: db.pool }); await migrate015({ pool: db.pool }); await migrate016({ pool: db.pool });
  assert.match((await db.pool.query("SHOW server_version")).rows[0].server_version, /^16\./); return db;
}

async function waitForMemberLocks(pool, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = (await pool.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM coach_members%'")).rows;
    if (rows.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("expected blocked member locks");
}

test("PostgreSQL 16 preserves v1 history and uses latest unexpired immutable v2 assessment", { skip: skipForRoot }, async (t) => {
  const db = await database(t); const seeded = await seedMemberAndPlan(db.pool, "safety-v2-real");
  const mapping = (await db.pool.query("INSERT INTO goals_coach_member_auth_mappings (member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference) VALUES ($1,'gymmaster','gymmaster:92001','synthetic@example.test',TRUE,'owner_approved_script','safety-v2-real') RETURNING *", [seeded.member.id])).rows[0];
  const auth = { active: true, mappingId: String(mapping.id), memberId: String(mapping.member_id) };
  await db.pool.query("INSERT INTO goals_coach_member_safety_intake_submissions (auth_mapping_id,member_id,client_request_id,client_request_hash,notice_version,current_pain_or_concerning_symptoms,current_injury_concern,recent_surgery,medical_or_exercise_restriction,other_training_safety_concern,outcome,safety_stop,rule_version) VALUES ($1,$2,'00000000-0000-4000-8000-000000092001',$3,'GC-MEMBER-SAFETY-NOTICE-1',TRUE,FALSE,FALSE,FALSE,FALSE,'handoff_required',TRUE,'GC-MEMBER-SAFETY-INTAKE-1')", [mapping.id, mapping.member_id, "b".repeat(64)]);
  assert.equal((await readEffectiveSafetyIntake(db.pool, auth.memberId, MEMBER_SAFETY_NOTICE_VERSION)).status, "not_submitted");
  for (const [number, answers, outcome] of [
    [9202, { painOrStiffness: true, painSeverity: 3 }, "MODIFICATION_REQUIRED"],
    [9203, { painOrStiffness: true, painSeverity: 8 }, "MEDICAL_REVIEW_REQUIRED"],
    [9205, {}, "SCREEN_COMPLETE"],
  ]) assert.equal((await submitSafetyIntake(db.pool, auth, input(number, answers), hashConfiguration)).safetyIntake.status, outcome);
  assert.equal((await submitSafetyIntake(db.pool, auth, urgentInput(9204), hashConfiguration)).safetyIntake.status, "URGENT_STOP");
  const rotating = input(9299);
  const keyOne = { currentVersion: "key-1", keys: { "key-1": "a".repeat(32) } };
  const keyTwo = { currentVersion: "key-2", keys: { "key-1": "a".repeat(32), "key-2": "b".repeat(32) } };
  assert.equal((await submitSafetyIntake(db.pool, auth, rotating, keyOne)).created, true);
  assert.equal((await submitSafetyIntake(db.pool, auth, rotating, keyTwo)).created, false);
  assert.equal((await db.pool.query("SELECT client_request_hash_key_version FROM goals_coach_member_safety_intake_v2_assessments WHERE client_request_id=$1", [rotating.clientRequestId])).rows[0].client_request_hash_key_version, "key-1");
  assert.equal((await db.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_safety_intake_submissions WHERE member_id=$1", [mapping.member_id])).rows[0].count, 1);
  const first = (await db.pool.query("SELECT id FROM goals_coach_member_safety_intake_v2_assessments WHERE member_id=$1 ORDER BY id LIMIT 1", [mapping.member_id])).rows[0];
  await assert.rejects(db.pool.query("DELETE FROM goals_coach_member_safety_intake_v2_assessments WHERE id=$1", [first.id]), /append-only/);

  const expiredSeed = await seedMemberAndPlan(db.pool, "safety-v2-expired-real");
  const expiredMapping = (await db.pool.query("INSERT INTO goals_coach_member_auth_mappings (member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference) VALUES ($1,'gymmaster','gymmaster:92002','synthetic@example.test',TRUE,'owner_approved_script','safety-v2-expired-real') RETURNING *", [expiredSeed.member.id])).rows[0];
  await db.pool.query("INSERT INTO goals_coach_member_safety_intake_v2_assessments (auth_mapping_id,member_id,client_request_id,client_request_hash,notice_version,outcome,rule_version,submitted_at,valid_until) VALUES ($1,$2,'00000000-0000-4000-8000-000000092006',$3,'GC-MEMBER-SAFETY-NOTICE-2','SCREEN_COMPLETE','GC-MEMBER-SAFETY-INTAKE-2',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour')", [expiredMapping.id, expiredMapping.member_id, "c".repeat(64)]);
  assert.equal((await readEffectiveSafetyIntake(db.pool, String(expiredMapping.member_id), MEMBER_SAFETY_NOTICE_VERSION)).status, "not_submitted");
});

test("PostgreSQL 16 serializes concurrent V2 submissions on the member lock", { skip: skipForRoot }, async (t) => {
  const db = await database(t); const seeded = await seedMemberAndPlan(db.pool, "safety-v2-lock-real");
  const mapping = (await db.pool.query("INSERT INTO goals_coach_member_auth_mappings (member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference) VALUES ($1,'gymmaster','gymmaster:92003','synthetic@example.test',TRUE,'owner_approved_script','safety-v2-lock-real') RETURNING *", [seeded.member.id])).rows[0];
  const auth = { active: true, mappingId: String(mapping.id), memberId: String(mapping.member_id) };
  const blocker = await db.pool.connect(); await blocker.query("BEGIN"); await blocker.query("SELECT id FROM coach_members WHERE id=$1 FOR UPDATE", [mapping.member_id]);
  const urgent = submitSafetyIntake(db.pool, auth, urgentInput(9210), hashConfiguration);
  await waitForMemberLocks(db.pool, 1);
  const safe = submitSafetyIntake(db.pool, auth, input(9211), hashConfiguration);
  await waitForMemberLocks(db.pool, 2);
  await blocker.query("COMMIT"); blocker.release();
  assert.equal((await urgent).safetyIntake.status, "URGENT_STOP");
  assert.equal((await safe).safetyIntake.status, "SCREEN_COMPLETE");
  assert.equal((await db.pool.query("SELECT COUNT(*)::int count FROM goals_coach_member_safety_intake_v2_assessments WHERE member_id=$1", [mapping.member_id])).rows[0].count, 2);
});

test("PostgreSQL 16 bounds Migration 012 advisory-lock blocking and reuses the pool", { skip: skipForRoot }, async (t) => {
  const db = await database(t); const blocker = await db.pool.connect();
  await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(82720512)");
  await assert.rejects(migrate012({ pool: db.pool, overallMilliseconds: 100 }), (error) => error.code === "migration_failed");
  await blocker.query("ROLLBACK"); blocker.release();
  assert.equal((await db.pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
});

test("PostgreSQL 16 bounds Rollback 012 advisory-lock blocking and reuses the pool", { skip: skipForRoot }, async (t) => {
  const db = await database(t); const blocker = await db.pool.connect();
  await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(82720512)");
  await assert.rejects(rollback012({ pool: db.pool, skipConfirmation: true, overallMilliseconds: 100 }), (error) => error.code === "rollback_failed");
  await blocker.query("ROLLBACK"); blocker.release();
  assert.equal((await db.pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
});
