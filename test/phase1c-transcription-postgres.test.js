const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { runMigration } = require("../migrate_005");
const { runRollback } = require("../rollback_005");
const { createTranscriptionService } = require("../src/goals-coach/transcription-service");
const {
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const {
  createDeterministicTranscriptionAdapter,
} = require("./helpers/deterministic-transcription-adapter");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");

const skipForRoot = typeof process.getuid === "function" && process.getuid() === 0
  ? "embedded PostgreSQL refuses to run as root; run this suite as an unprivileged user"
  : false;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function trackSettlement(promise) {
  let settled = false;
  promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  return Object.freeze({ promise, isSettled: () => settled });
}

async function captureRejection(promise) {
  let result;
  let error;
  try {
    result = await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `Expected rejection, received ${JSON.stringify(result)}`);
  return error;
}

async function waitForRelationLock(pool, expected) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const lock = await pool.query(
      `SELECT locks.pid::int AS pid, locks.mode, locks.granted
       FROM pg_locks AS locks
       JOIN pg_class AS relation ON relation.oid = locks.relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = $1
         AND locks.pid = $2
         AND locks.mode = $3
         AND locks.granted = $4`,
      [expected.relation, expected.pid, expected.mode, expected.granted]
    );
    if (lock.rows.length === 1) return lock.rows[0];
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Timed out waiting for ${expected.mode} on ${expected.relation} `
      + `for backend ${expected.pid} (granted=${expected.granted})`
  );
}

async function countRelationLocks(pool, expected) {
  return Number((await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_locks AS locks
     JOIN pg_class AS relation ON relation.oid = locks.relation
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = $1
       AND locks.pid = $2
       AND locks.mode = $3
       AND locks.granted = $4`,
    [expected.relation, expected.pid, expected.mode, expected.granted]
  )).rows[0].count);
}

async function releaseClients(clients) {
  for (const client of clients) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // The disposable database may already be stopped after a failed assertion.
    }
    client.release();
  }
}

async function seedFixture(pool, suffix) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const mapping = await seedAlphaMapping(pool, seeded.member, suffix, true);
  const conversation = (await pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  return {
    ...seeded,
    mapping,
    conversation,
    member: {
      mappingId: String(mapping.id),
      memberId: String(seeded.member.id),
      authProvider: mapping.auth_provider,
      authSubject: mapping.auth_subject,
    },
  };
}

function input(fixture, requestId = crypto.randomUUID()) {
  return {
    member: fixture.member,
    authenticatedSessionId: "synthetic-real-postgres-session",
    conversationId: String(fixture.conversation.id),
    planId: String(fixture.plan.id),
    requestId,
    retry: false,
    audio: Buffer.from("synthetic-real-postgres-audio"),
    mimeType: "audio/webm;codecs=opus",
  };
}

async function insertPendingAttempt(pool, fixture) {
  return (await pool.query(
    `INSERT INTO goals_coach_transcription_attempts
      (id, request_id, attempt_number, member_id, auth_mapping_id,
       auth_session_digest, conversation_id, plan_id, mime_type,
       audio_byte_count, audio_digest, provider_identifier, model_identifier,
       provider_started_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7,
       'audio/webm;codecs=opus', 64, $8,
       'synthetic-provider', 'synthetic-model', NOW())
     RETURNING *`,
    [
      crypto.randomUUID(),
      crypto.randomUUID(),
      fixture.member.memberId,
      fixture.mapping.id,
      "a".repeat(64),
      fixture.conversation.id,
      fixture.plan.id,
      "b".repeat(64),
    ]
  )).rows[0];
}

async function insertMemberMessage(pool, fixture, content) {
  return (await pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', $3) RETURNING *`,
    [fixture.conversation.id, fixture.member.memberId, content]
  )).rows[0];
}

async function insertLinkedTurn(pool, fixture, memberMessageId, transcriptionAttemptId) {
  return (await pool.query(
    `INSERT INTO goals_coach_coaching_turns
      (member_id, conversation_id, plan_id, member_message_id,
       provider_identifier, model_identifier, prompt_version,
       structured_output_version, safety_rule_version, request_id,
       attempt_number, input_method, context_digest, transcription_attempt_id)
     VALUES ($1, $2, $3, $4, 'synthetic-provider', 'synthetic-model',
       'synthetic-prompt', 'synthetic-output', 'synthetic-safety', $5,
       1, 'voice', $6, $7)
     RETURNING *`,
    [
      fixture.member.memberId,
      fixture.conversation.id,
      fixture.plan.id,
      memberMessageId,
      crypto.randomUUID(),
      "c".repeat(64),
      transcriptionAttemptId,
    ]
  )).rows[0];
}

async function insertUnlinkedTurn(pool, fixture, memberMessageId) {
  return (await pool.query(
    `INSERT INTO goals_coach_coaching_turns
      (member_id, conversation_id, plan_id, member_message_id,
       provider_identifier, model_identifier, prompt_version,
       structured_output_version, safety_rule_version, request_id,
       attempt_number, input_method, context_digest)
     VALUES ($1, $2, $3, $4, 'synthetic-provider', 'synthetic-model',
       'synthetic-prompt', 'synthetic-output', 'synthetic-safety', $5,
       1, 'voice', $6)
     RETURNING *`,
    [
      fixture.member.memberId,
      fixture.conversation.id,
      fixture.plan.id,
      memberMessageId,
      crypto.randomUUID(),
      "d".repeat(64),
    ]
  )).rows[0];
}

async function linkAttemptTargetFirst(client, fixture, turnId) {
  await client.query(
    "LOCK TABLE goals_coach_coaching_turns IN ROW EXCLUSIVE MODE"
  );
  const attempt = await insertPendingAttempt(client, fixture);
  const linkedTurn = (await client.query(
    `UPDATE goals_coach_coaching_turns
     SET transcription_attempt_id = $1
     WHERE id = $2
       AND member_id = $3
       AND conversation_id = $4
       AND plan_id = $5
       AND transcription_attempt_id IS NULL
     RETURNING *`,
    [
      attempt.id,
      turnId,
      fixture.member.memberId,
      fixture.conversation.id,
      fixture.plan.id,
    ]
  )).rows[0];
  assert.ok(linkedTurn);
  return { attempt, linkedTurn };
}

function service(pool, deterministic) {
  return createTranscriptionService({
    db: pool,
    adapter: deterministic.adapter,
    bindingKey: "synthetic-real-postgres-binding-key",
    providerTimeoutMs: 500,
    operationTimeoutMs: 1000,
  });
}

test("Migration 005 applies on real PostgreSQL 16 with native constraints", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  const version = (await disposable.pool.query("SHOW server_version")).rows[0].server_version;
  assert.match(version, /^16\./);
  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  assert.equal((await runMigration({ pool: disposable.pool })).status, "already_applied");
  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.goals_coach_transcription_attempts') AS name"
  )).rows[0].name, "goals_coach_transcription_attempts");
});

test("Rollback 005 waits for a writer-first attempt and preserves its committed provenance", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  const clients = [];
  t.after(async () => {
    await releaseClients(clients);
    await disposable.close();
  });
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "postgres-rollback-writer-first");
  const writer = await disposable.pool.connect();
  clients.push(writer);
  await writer.query("BEGIN");
  const writerPid = (await writer.query("SELECT pg_backend_pid()::int AS pid")).rows[0].pid;
  const attempt = await insertPendingAttempt(writer, fixture);
  const grantedWriterLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_transcription_attempts",
    pid: writerPid,
    mode: "RowExclusiveLock",
    granted: true,
  });
  assert.equal(grantedWriterLock.granted, true);

  const rollbackBackend = deferred();
  const rollback = trackSettlement(runRollback({
    pool: disposable.pool,
    skipConfirmation: true,
    beforeTableLocks({ backendPid }) {
      rollbackBackend.resolve(backendPid);
    },
  }));
  const rollbackPid = await rollbackBackend.promise;
  const grantedRollbackLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_coaching_turns",
    pid: rollbackPid,
    mode: "AccessExclusiveLock",
    granted: true,
  });
  assert.equal(grantedRollbackLock.granted, true);
  const waitingLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_transcription_attempts",
    pid: rollbackPid,
    mode: "AccessExclusiveLock",
    granted: false,
  });
  assert.equal(waitingLock.granted, false);
  assert.equal(rollback.isSettled(), false);

  await writer.query("COMMIT");
  const rollbackError = await captureRejection(rollback.promise);
  assert.notEqual(rollbackError.code, "40P01");
  assert.equal(rollbackError.code, "23514");
  assert.equal(
    rollbackError.constraint,
    "goals_coach_transcription_rollback_preservation_required"
  );
  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.goals_coach_transcription_attempts') AS name"
  )).rows[0].name, "goals_coach_transcription_attempts");
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'goals_coach_coaching_turns'
       AND column_name = 'transcription_attempt_id'`
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_transcription_attempts WHERE id = $1",
    [attempt.id]
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM app_schema_migrations
     WHERE version = '005_goals_coach_voice_transcription_provenance'`
  )).rows[0].count, 1);
});

test("Rollback 005 excludes a rollback-second attempt writer until the empty schema is removed", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  const clients = [];
  const releaseRollback = deferred();
  t.after(async () => {
    releaseRollback.resolve();
    await releaseClients(clients);
    await disposable.close();
  });
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "postgres-rollback-locks-first");

  const locksAcquired = deferred();
  const rollback = trackSettlement(runRollback({
    pool: disposable.pool,
    skipConfirmation: true,
    async afterTableLocks({ backendPid }) {
      locksAcquired.resolve(backendPid);
      await releaseRollback.promise;
    },
  }));
  const rollbackPid = await locksAcquired.promise;
  for (const relation of [
    "goals_coach_transcription_attempts",
    "goals_coach_coaching_turns",
  ]) {
    const grantedLock = await waitForRelationLock(disposable.pool, {
      relation,
      pid: rollbackPid,
      mode: "AccessExclusiveLock",
      granted: true,
    });
    assert.equal(grantedLock.granted, true);
  }

  const writer = await disposable.pool.connect();
  clients.push(writer);
  await writer.query("BEGIN");
  const writerPid = (await writer.query("SELECT pg_backend_pid()::int AS pid")).rows[0].pid;
  const writerInsert = trackSettlement(insertPendingAttempt(writer, fixture));
  const waitingWriterLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_transcription_attempts",
    pid: writerPid,
    mode: "RowExclusiveLock",
    granted: false,
  });
  assert.equal(waitingWriterLock.granted, false);
  assert.equal(writerInsert.isSettled(), false);
  assert.equal(rollback.isSettled(), false);

  releaseRollback.resolve();
  assert.deepEqual(await rollback.promise, {
    status: "rolled_back",
    version: "005_goals_coach_voice_transcription_provenance",
  });
  const writerError = await captureRejection(writerInsert.promise);
  assert.notEqual(writerError.code, "40P01");
  assert.equal(writerError.code, "42P01");
  await writer.query("ROLLBACK");

  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.goals_coach_transcription_attempts') AS name"
  )).rows[0].name, null);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'goals_coach_coaching_turns'
       AND column_name = 'transcription_attempt_id'`
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM app_schema_migrations
     WHERE version = '005_goals_coach_voice_transcription_provenance'`
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM app_schema_migrations
     WHERE version IN (
       '003_goals_coach_alpha_foundation',
       '004_goals_coach_workout_state_and_turn_provenance'
     )`
  )).rows[0].count, 2);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_conversations WHERE id = $1",
    [fixture.conversation.id]
  )).rows[0].count, 1);

  const reapplied = await runMigration({ pool: disposable.pool });
  assert.equal(reapplied.status, "applied");
  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.goals_coach_transcription_attempts') AS name"
  )).rows[0].name, "goals_coach_transcription_attempts");
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'goals_coach_coaching_turns'
       AND column_name = 'transcription_attempt_id'`
  )).rows[0].count, 1);
  assert.deepEqual(
    await runRollback({ pool: disposable.pool, skipConfirmation: true }),
    {
      status: "rolled_back",
      version: "005_goals_coach_voice_transcription_provenance",
    }
  );
  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.goals_coach_transcription_attempts') AS name"
  )).rows[0].name, null);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM app_schema_migrations
     WHERE version = '005_goals_coach_voice_transcription_provenance'`
  )).rows[0].count, 0);
});

test("Rollback 005 waits for a writer-first coaching-turn link and preserves both rows", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  const clients = [];
  t.after(async () => {
    await releaseClients(clients);
    await disposable.close();
  });
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "postgres-rollback-link-first");
  const attempt = await insertPendingAttempt(disposable.pool, fixture);
  const message = await insertMemberMessage(
    disposable.pool,
    fixture,
    "Concurrent rollback-link PostgreSQL voice message"
  );
  const writer = await disposable.pool.connect();
  clients.push(writer);
  await writer.query("BEGIN");
  const writerPid = (await writer.query("SELECT pg_backend_pid()::int AS pid")).rows[0].pid;
  const turn = await insertLinkedTurn(writer, fixture, message.id, attempt.id);
  const grantedWriterTargetLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_coaching_turns",
    pid: writerPid,
    mode: "RowExclusiveLock",
    granted: true,
  });
  assert.equal(grantedWriterTargetLock.granted, true);
  const grantedWriterReferenceLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_transcription_attempts",
    pid: writerPid,
    mode: "RowShareLock",
    granted: true,
  });
  assert.equal(grantedWriterReferenceLock.granted, true);

  const rollbackBackend = deferred();
  const rollback = trackSettlement(runRollback({
    pool: disposable.pool,
    skipConfirmation: true,
    beforeTableLocks({ backendPid }) {
      rollbackBackend.resolve(backendPid);
    },
  }));
  const rollbackPid = await rollbackBackend.promise;
  const waitingLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_coaching_turns",
    pid: rollbackPid,
    mode: "AccessExclusiveLock",
    granted: false,
  });
  assert.equal(waitingLock.granted, false);
  assert.equal(await countRelationLocks(disposable.pool, {
    relation: "goals_coach_transcription_attempts",
    pid: rollbackPid,
    mode: "AccessExclusiveLock",
    granted: true,
  }), 0);
  assert.equal(rollback.isSettled(), false);

  await writer.query("COMMIT");
  const rollbackError = await captureRejection(rollback.promise);
  assert.notEqual(rollbackError.code, "40P01");
  assert.equal(rollbackError.code, "23514");
  assert.equal(
    rollbackError.constraint,
    "goals_coach_transcription_rollback_preservation_required"
  );
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_transcription_attempts WHERE id = $1",
    [attempt.id]
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns
     WHERE id = $1 AND transcription_attempt_id = $2`,
    [turn.id, attempt.id]
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM app_schema_migrations
     WHERE version = '005_goals_coach_voice_transcription_provenance'`
  )).rows[0].count, 1);
});

test("Rollback 005 takes the coaching-turn lock before a rollback-second link writer", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  const clients = [];
  const allowSecondLock = deferred();
  const allowProtectedSection = deferred();
  t.after(async () => {
    allowSecondLock.resolve();
    allowProtectedSection.resolve();
    await releaseClients(clients);
    await disposable.close();
  });
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "postgres-rollback-link-second");
  const message = await insertMemberMessage(
    disposable.pool,
    fixture,
    "Rollback-first target-lock PostgreSQL voice message"
  );
  const unlinkedTurn = await insertUnlinkedTurn(
    disposable.pool,
    fixture,
    message.id
  );

  const writer = await disposable.pool.connect();
  clients.push(writer);
  await writer.query("BEGIN");
  const validControl = await linkAttemptTargetFirst(writer, fixture, unlinkedTurn.id);
  assert.equal(
    String(validControl.linkedTurn.transcription_attempt_id),
    String(validControl.attempt.id)
  );
  await writer.query("ROLLBACK");
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_transcription_attempts"
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM goals_coach_coaching_turns
     WHERE id = $1 AND transcription_attempt_id IS NULL`,
    [unlinkedTurn.id]
  )).rows[0].count, 1);

  const firstLockAcquired = deferred();
  const allLocksAcquired = deferred();
  const rollback = trackSettlement(runRollback({
    pool: disposable.pool,
    skipConfirmation: true,
    async afterFirstTableLock({ backendPid }) {
      firstLockAcquired.resolve(backendPid);
      await allowSecondLock.promise;
    },
    async afterTableLocks({ backendPid }) {
      allLocksAcquired.resolve(backendPid);
      await allowProtectedSection.promise;
    },
  }));
  const rollbackPid = await firstLockAcquired.promise;
  const grantedFirstLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_coaching_turns",
    pid: rollbackPid,
    mode: "AccessExclusiveLock",
    granted: true,
  });
  assert.equal(grantedFirstLock.granted, true);
  assert.equal(await countRelationLocks(disposable.pool, {
    relation: "goals_coach_transcription_attempts",
    pid: rollbackPid,
    mode: "AccessExclusiveLock",
    granted: true,
  }), 0);

  await writer.query("BEGIN");
  const writerPid = (await writer.query(
    "SELECT pg_backend_pid()::int AS pid"
  )).rows[0].pid;
  const writerLink = trackSettlement(
    linkAttemptTargetFirst(writer, fixture, unlinkedTurn.id)
  );
  const waitingWriterTargetLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_coaching_turns",
    pid: writerPid,
    mode: "RowExclusiveLock",
    granted: false,
  });
  assert.equal(waitingWriterTargetLock.granted, false);
  assert.equal(await countRelationLocks(disposable.pool, {
    relation: "goals_coach_coaching_turns",
    pid: writerPid,
    mode: "RowExclusiveLock",
    granted: true,
  }), 0);
  assert.equal(await countRelationLocks(disposable.pool, {
    relation: "goals_coach_transcription_attempts",
    pid: writerPid,
    mode: "RowExclusiveLock",
    granted: true,
  }), 0);
  assert.equal(writerLink.isSettled(), false);

  allowSecondLock.resolve();
  assert.equal(await allLocksAcquired.promise, rollbackPid);
  for (const relation of [
    "goals_coach_coaching_turns",
    "goals_coach_transcription_attempts",
  ]) {
    const grantedLock = await waitForRelationLock(disposable.pool, {
      relation,
      pid: rollbackPid,
      mode: "AccessExclusiveLock",
      granted: true,
    });
    assert.equal(grantedLock.granted, true);
  }
  const stillWaitingWriterTargetLock = await waitForRelationLock(disposable.pool, {
    relation: "goals_coach_coaching_turns",
    pid: writerPid,
    mode: "RowExclusiveLock",
    granted: false,
  });
  assert.equal(stillWaitingWriterTargetLock.granted, false);

  allowProtectedSection.resolve();
  assert.deepEqual(await rollback.promise, {
    status: "rolled_back",
    version: "005_goals_coach_voice_transcription_provenance",
  });
  const writerError = await captureRejection(writerLink.promise);
  assert.notEqual(writerError.code, "40P01");
  assert.equal(writerError.code, "42P01");
  await writer.query("ROLLBACK");

  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.goals_coach_transcription_attempts') AS name"
  )).rows[0].name, null);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'goals_coach_coaching_turns'
       AND column_name = 'transcription_attempt_id'`
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_constraint
     WHERE conname = 'fk_goals_coach_turn_transcription_attempt'`
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.uq_goals_coach_turn_transcription_attempt') AS name"
  )).rows[0].name, null);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns WHERE id = $1",
    [unlinkedTurn.id]
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM app_schema_migrations
     WHERE version = '005_goals_coach_voice_transcription_provenance'`
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM app_schema_migrations
     WHERE version IN (
       '003_goals_coach_alpha_foundation',
       '004_goals_coach_workout_state_and_turn_provenance'
     )`
  )).rows[0].count, 2);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_conversations WHERE id = $1",
    [fixture.conversation.id]
  )).rows[0].count, 1);
});

test("Rollback 005 still removes only empty Migration 005 objects without contention", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "postgres-rollback-empty");
  const rolledBack = await runRollback({ pool: disposable.pool, skipConfirmation: true });
  assert.deepEqual(rolledBack, {
    status: "rolled_back",
    version: "005_goals_coach_voice_transcription_provenance",
  });
  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.goals_coach_transcription_attempts') AS name"
  )).rows[0].name, null);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'goals_coach_coaching_turns'
       AND column_name = 'transcription_attempt_id'`
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM app_schema_migrations
     WHERE version IN (
       '003_goals_coach_alpha_foundation',
       '004_goals_coach_workout_state_and_turn_provenance'
     )`
  )).rows[0].count, 2);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings WHERE id = $1",
    [fixture.mapping.id]
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_conversations WHERE id = $1",
    [fixture.conversation.id]
  )).rows[0].count, 1);
});

test("PostgreSQL composite turn linkage rejects cross-scope attempts and accepts same scope", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const first = await seedFixture(disposable.pool, "postgres-turn-scope-a");
  const second = await seedFixture(disposable.pool, "postgres-turn-scope-b");
  const attempt = await insertPendingAttempt(disposable.pool, first);

  const definition = (await disposable.pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conname = 'fk_goals_coach_turn_transcription_attempt'`
  )).rows[0].definition.replace(/\s+/g, " ");
  assert.equal(
    definition,
    "FOREIGN KEY (transcription_attempt_id, member_id, conversation_id, plan_id) "
      + "REFERENCES goals_coach_transcription_attempts(id, member_id, conversation_id, plan_id) "
      + "ON DELETE RESTRICT"
  );

  const crossMemberMessage = await insertMemberMessage(
    disposable.pool,
    second,
    "Cross-member PostgreSQL voice message"
  );
  await assert.rejects(
    insertLinkedTurn(disposable.pool, second, crossMemberMessage.id, attempt.id),
    (error) => error.code === "23503"
      && error.constraint === "fk_goals_coach_turn_transcription_attempt"
  );

  const otherConversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id, status, archived_at)
     VALUES ($1, $2, 'archived', NOW()) RETURNING *`,
    [first.member.memberId, first.plan.id]
  )).rows[0];
  const crossConversation = { ...first, conversation: otherConversation };
  const crossConversationMessage = await insertMemberMessage(
    disposable.pool,
    crossConversation,
    "Cross-conversation PostgreSQL voice message"
  );
  await assert.rejects(
    insertLinkedTurn(
      disposable.pool,
      crossConversation,
      crossConversationMessage.id,
      attempt.id
    ),
    (error) => error.code === "23503"
      && error.constraint === "fk_goals_coach_turn_transcription_attempt"
  );

  const otherPlan = (await disposable.pool.query(
    `INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown)
     VALUES ($1, '{}'::jsonb, '[]'::jsonb, 'Cross-plan PostgreSQL plan') RETURNING *`,
    [first.member.memberId]
  )).rows[0];
  const otherPlanConversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [first.member.memberId, otherPlan.id]
  )).rows[0];
  const crossPlan = {
    ...first,
    plan: otherPlan,
    conversation: otherPlanConversation,
  };
  const crossPlanMessage = await insertMemberMessage(
    disposable.pool,
    crossPlan,
    "Cross-plan PostgreSQL voice message"
  );
  await assert.rejects(
    insertLinkedTurn(disposable.pool, crossPlan, crossPlanMessage.id, attempt.id),
    (error) => error.code === "23503"
      && error.constraint === "fk_goals_coach_turn_transcription_attempt"
  );

  const sameScopeMessage = await insertMemberMessage(
    disposable.pool,
    first,
    "Same-scope PostgreSQL voice message"
  );
  const sameScopeTurn = await insertLinkedTurn(
    disposable.pool,
    first,
    sameScopeMessage.id,
    attempt.id
  );
  assert.equal(String(sameScopeTurn.transcription_attempt_id), String(attempt.id));
});

test("PostgreSQL partial uniqueness permits only one raced pending attempt per member", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "postgres-pending-race");
  const parameters = (requestId) => [
    crypto.randomUUID(), requestId, fixture.member.memberId, fixture.mapping.id,
    "a".repeat(64), fixture.conversation.id, fixture.plan.id, "b".repeat(64),
  ];
  const statement = `INSERT INTO goals_coach_transcription_attempts
    (id, request_id, attempt_number, member_id, auth_mapping_id,
     auth_session_digest, conversation_id, plan_id, mime_type,
     audio_byte_count, audio_digest, provider_identifier, model_identifier,
     provider_started_at)
   VALUES ($1, $2, 1, $3, $4, $5, $6, $7,
     'audio/webm;codecs=opus', 64, $8,
     'synthetic-provider', 'synthetic-model', NOW())`;
  const results = await Promise.allSettled([
    disposable.pool.query(statement, parameters(crypto.randomUUID())),
    disposable.pool.query(statement, parameters(crypto.randomUUID())),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
    JSON.stringify(results.map((result) => result.status === "rejected" ? {
      code: result.reason.code,
      constraint: result.reason.constraint,
      message: result.reason.message,
    } : { status: result.status }))
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "23505");
  assert.equal(rejected.reason.constraint, "uq_goals_coach_pending_transcription_per_member");
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_transcription_attempts WHERE status = 'pending'"
  )).rows[0].count, 1);
});

test("simultaneous duplicate invokes the adapter once and leaves one atomic completion", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "postgres-duplicate");
  let release;
  let entered;
  const released = new Promise((resolve) => { release = resolve; });
  const providerEntered = new Promise((resolve) => { entered = resolve; });
  const deterministic = createDeterministicTranscriptionAdapter({
    text: "Atomic PostgreSQL transcript",
    durationMs: 1300,
    onCall: async () => {
      entered();
      await released;
    },
  });
  const transcriptionService = service(disposable.pool, deterministic);
  const shared = input(fixture);
  const first = transcriptionService.transcribe(shared);
  await providerEntered;
  await assert.rejects(
    transcriptionService.transcribe(shared),
    (error) => error.code === "TRANSCRIPTION_IN_PROGRESS"
  );
  release();
  const completed = await first;
  assert.equal(completed.transcript, "Atomic PostgreSQL transcript");
  assert.equal(deterministic.getCallCount(), 1);
  assert.deepEqual((await disposable.pool.query(
    `SELECT status, COUNT(*)::int AS count
     FROM goals_coach_transcription_attempts GROUP BY status`
  )).rows, [{ status: "completed", count: 1 }]);
});

test("two concurrent request IDs for one member allow only one provider-owned attempt", { skip: skipForRoot }, async (t) => {
  const disposable = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "postgres-member-concurrency");
  let release;
  let entered;
  const released = new Promise((resolve) => { release = resolve; });
  const providerEntered = new Promise((resolve) => { entered = resolve; });
  const deterministic = createDeterministicTranscriptionAdapter({
    onCall: async () => {
      entered();
      await released;
    },
  });
  const transcriptionService = service(disposable.pool, deterministic);
  const first = transcriptionService.transcribe(input(fixture));
  await providerEntered;
  await assert.rejects(
    transcriptionService.transcribe(input(fixture)),
    (error) => error.code === "TRANSCRIPTION_IN_PROGRESS"
  );
  release();
  await first;
  assert.equal(deterministic.getCallCount(), 1);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_transcription_attempts"
  )).rows[0].count, 1);
});
