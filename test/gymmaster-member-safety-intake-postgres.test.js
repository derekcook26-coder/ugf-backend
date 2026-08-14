"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MEMBER_SAFETY_NOTICE,
  MEMBER_SAFETY_NOTICE_VERSION,
  parseSafetyIntake,
  readEffectiveSafetyIntake,
  submitSafetyIntake,
} = require("../src/goals-coach/gymmaster-member-safety-intake");
const { runMigration: runPhase1cTranscriptionMigration } = require("../migrate_005");
const { runMigration: runPhase1dSafetyMigration } = require("../migrate_006");
const { runMigration: runOwnerWorkoutTrackingMigration } = require("../migrate_007");
const { runMigration: runOwnerEditableWorkoutSessionsMigration } = require("../migrate_008");
const { runMigration: runMemberSafetyIntakeMigration } = require("../migrate_009");
const { seedMemberAndPlan } = require("./helpers/disposable-db");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "embedded PostgreSQL refuses to run as root; run this test as an unprivileged user"
  : false;
const noticeVersion = MEMBER_SAFETY_NOTICE_VERSION;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function input(number, overrides = {}) {
  return parseSafetyIntake({
    clientRequestId:
      `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    noticeVersion,
    answers: {
      currentPainOrConcerningSymptoms: false,
      currentInjuryConcern: false,
      recentSurgery: false,
      medicalOrExerciseRestriction: false,
      otherTrainingSafetyConcern: false,
      ...overrides,
    },
  }, noticeVersion);
}

async function waitForBlockedMemberLocks(pool, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT pid
       FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND query LIKE '%FROM coach_members%'
       ORDER BY pid`,
      []
    );
    if (result.rows.length >= expected) return result.rows.map((row) => Number(row.pid));
    await delay(20);
  }
  throw new Error(
    `Expected ${expected} safety-intake transaction(s) to wait on the member lock`
  );
}

test(
  "PostgreSQL 16 serializes member submissions so a committed stop remains monotonic",
  { skip: skipForRoot },
  async (t) => {
    const disposable = await createRealDisposablePostgres({ phase1b: true });
    let blocker = null;
    const pendingSubmissions = [];
    t.after(async () => {
      if (blocker) {
        try { await blocker.query("ROLLBACK"); } catch (_) {}
        blocker.release();
      }
      await Promise.allSettled(pendingSubmissions);
      await disposable.close();
    });
    await runPhase1cTranscriptionMigration({ pool: disposable.pool });
    await runPhase1dSafetyMigration({ pool: disposable.pool });
    await runOwnerWorkoutTrackingMigration({ pool: disposable.pool });
    await runOwnerEditableWorkoutSessionsMigration({ pool: disposable.pool });
    await runMemberSafetyIntakeMigration({ pool: disposable.pool });

    const version = (await disposable.pool.query(
      "SHOW server_version"
    )).rows[0].server_version;
    assert.match(version, /^16\./);

    const seeded = await seedMemberAndPlan(
      disposable.pool,
      "member-safety-intake-concurrency"
    );
    const mapping = (await disposable.pool.query(
      `INSERT INTO goals_coach_member_auth_mappings
        (member_id, auth_provider, auth_subject, verified_email_snapshot, active,
         provisioning_method, provisioning_reference)
       VALUES ($1, 'gymmaster', 'gymmaster:39001', 'concurrency@example.test',
               TRUE, 'owner_approved_script', 'postgres-16-concurrency-test')
       RETURNING *`,
      [seeded.member.id]
    )).rows[0];
    const authorization = {
      active: true,
      mappingId: String(mapping.id),
      memberId: String(mapping.member_id),
    };

    blocker = await disposable.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM coach_members WHERE id = $1 FOR UPDATE",
      [seeded.member.id]
    );

    const positivePromise = submitSafetyIntake(
      disposable.pool,
      authorization,
      input(9001, { currentInjuryConcern: true })
    );
    pendingSubmissions.push(positivePromise);
    const firstWaiters = await waitForBlockedMemberLocks(
      disposable.pool,
      1
    );
    assert.equal(firstWaiters.length, 1);

    const negativePromise = submitSafetyIntake(
      disposable.pool,
      authorization,
      input(9002)
    );
    pendingSubmissions.push(negativePromise);
    const bothWaiters = await waitForBlockedMemberLocks(
      disposable.pool,
      2
    );
    assert.equal(bothWaiters.length, 2);

    await blocker.query("COMMIT");
    blocker.release();
    blocker = null;

    const [positive, negative] = await Promise.all([
      positivePromise,
      negativePromise,
    ]);
    assert.equal(positive.safetyIntake.status, "handoff_required");
    assert.equal(positive.safetyIntake.safetyStop, true);
    assert.equal(negative.safetyIntake.status, "handoff_required");
    assert.equal(negative.safetyIntake.safetyStop, true);

    const rows = await disposable.pool.query(
      `SELECT outcome, safety_stop
       FROM goals_coach_member_safety_intake_submissions
       WHERE member_id = $1
       ORDER BY id`,
      [seeded.member.id]
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.outcome, row.safety_stop]),
      [
        ["handoff_required", true],
        ["screen_complete", false],
      ]
    );
    const effective = await disposable.pool.query(
      `SELECT BOOL_OR(safety_stop) AS safety_stop
       FROM goals_coach_member_safety_intake_submissions
       WHERE member_id = $1`,
      [seeded.member.id]
    );
    assert.equal(effective.rows[0].safety_stop, true);
  }
);

test(
  "PostgreSQL 16 requires the current notice without clearing historical safety stops",
  { skip: skipForRoot },
  async (t) => {
    const disposable = await createRealDisposablePostgres({ phase1b: true });
    t.after(() => disposable.close());
    await runPhase1cTranscriptionMigration({ pool: disposable.pool });
    await runPhase1dSafetyMigration({ pool: disposable.pool });
    await runOwnerWorkoutTrackingMigration({ pool: disposable.pool });
    await runOwnerEditableWorkoutSessionsMigration({ pool: disposable.pool });
    await runMemberSafetyIntakeMigration({ pool: disposable.pool });
    assert.match((await disposable.pool.query("SHOW server_version")).rows[0].server_version, /^16\./);

    const authorizations = [];
    for (const [suffix, subject] of [["clear", "39002"], ["stop", "39003"]]) {
      const seeded = await seedMemberAndPlan(
        disposable.pool,
        `member-safety-notice-version-${suffix}`
      );
      const mapping = (await disposable.pool.query(
        `INSERT INTO goals_coach_member_auth_mappings
          (member_id, auth_provider, auth_subject, verified_email_snapshot, active,
           provisioning_method, provisioning_reference)
         VALUES ($1, 'gymmaster', $2, 'notice-version@example.test', TRUE,
                 'owner_approved_script', 'postgres-16-notice-version-test')
         RETURNING *`,
        [seeded.member.id, `gymmaster:${subject}`]
      )).rows[0];
      authorizations.push({
        active: true,
        mappingId: String(mapping.id),
        memberId: String(mapping.member_id),
      });
    }

    async function insertOld(authorization, number, safetyStop) {
      await disposable.pool.query(
        `INSERT INTO goals_coach_member_safety_intake_submissions
          (auth_mapping_id, member_id, client_request_id, client_request_hash,
           notice_version, current_pain_or_concerning_symptoms,
           current_injury_concern, recent_surgery,
           medical_or_exercise_restriction, other_training_safety_concern,
           outcome, safety_stop, rule_version)
         VALUES ($1, $2, $3, $4, 'GC-MEMBER-SAFETY-NOTICE-0',
                 $5, FALSE, FALSE, FALSE, FALSE, $6, $5,
                 'GC-MEMBER-SAFETY-INTAKE-1')`,
        [
          authorization.mappingId,
          authorization.memberId,
          `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
          (safetyStop ? "d" : "c").repeat(64),
          safetyStop,
          safetyStop ? "handoff_required" : "screen_complete",
        ]
      );
    }

    await insertOld(authorizations[0], 9101, false);
    assert.deepEqual(
      await readEffectiveSafetyIntake(
        disposable.pool,
        authorizations[0].memberId,
        noticeVersion
      ),
      {
        notice: MEMBER_SAFETY_NOTICE,
        noticeVersion,
        status: "not_submitted",
        safetyStop: null,
        readiness: { status: "SETUP_REQUIRED", nextAction: "COMPLETE_SAFETY_SETUP" },
        activationPermitted: false,
        externalCallsPermitted: false,
      }
    );
    const currentClear = await submitSafetyIntake(
      disposable.pool,
      authorizations[0],
      input(9102)
    );
    assert.equal(currentClear.safetyIntake.status, "screen_complete");
    assert.equal(currentClear.safetyIntake.safetyStop, false);

    await insertOld(authorizations[1], 9103, true);
    const oldStop = await readEffectiveSafetyIntake(
      disposable.pool,
      authorizations[1].memberId,
      noticeVersion
    );
    assert.equal(oldStop.status, "handoff_required");
    assert.equal(oldStop.safetyStop, true);
    const currentAfterStop = await submitSafetyIntake(
      disposable.pool,
      authorizations[1],
      input(9104)
    );
    assert.equal(currentAfterStop.safetyIntake.status, "handoff_required");
    assert.equal(currentAfterStop.safetyIntake.safetyStop, true);
  }
);
