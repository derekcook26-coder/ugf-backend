const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { runMigration } = require("../migrate_005");
const { runRollback } = require("../rollback_005");
const {
  APPROVED_ALPHA_CONSENT_VERSION,
} = require("../src/goals-coach/alpha-config");
const {
  createPhase1bCoachingService,
} = require("../src/goals-coach/phase1b-service");
const {
  createTranscriptionService,
  sessionDigest,
} = require("../src/goals-coach/transcription-service");
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

const NATIVE_BINDING_KEY = "synthetic-native-lock-order-binding-key";
const NATIVE_SESSION_ID = "synthetic-native-lock-order-session";
const NATIVE_APPLICATION_CONFIGURATION = Object.freeze({
  valid: true,
  consentVersion: APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnvironment: "test",
});

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

async function relationLocksForBackend(pool, relationName, backendPid) {
  return (await pool.query(
    `SELECT locks.mode, locks.granted
     FROM pg_locks AS locks
     JOIN pg_class AS relation ON relation.oid = locks.relation
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = $1
       AND locks.pid = $2
     ORDER BY locks.granted DESC, locks.mode`,
    [relationName, backendPid]
  )).rows;
}

async function waitForBackendLockWait(pool, backendPid) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const activity = await pool.query(
      `SELECT pid::int AS pid, state, wait_event_type, wait_event
       FROM pg_stat_activity
       WHERE pid = $1`,
      [backendPid]
    );
    if (activity.rows[0] && activity.rows[0].wait_event_type === "Lock") {
      return activity.rows[0];
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for backend ${backendPid} to wait on a lock`);
}

async function waitForBlockingPid(pool, blockedPid, blockingPid) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const result = await pool.query(
      `SELECT pg_blocking_pids($1)::int[] AS blocking_pids`,
      [blockedPid]
    );
    const blockingPids = result.rows[0].blocking_pids.map(Number);
    if (blockingPids.includes(blockingPid)) return blockingPids;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Timed out waiting for backend ${blockedPid} to be blocked by ${blockingPid}`
  );
}

async function backendLockEvidence(pool, backendPid, relationNames) {
  return (await pool.query(
    `SELECT locks.locktype,
            relation.relname AS relation,
            locks.mode,
            locks.granted
     FROM pg_locks AS locks
     LEFT JOIN pg_class AS relation ON relation.oid = locks.relation
     LEFT JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE locks.pid = $1
       AND (
         (namespace.nspname = 'public' AND relation.relname = ANY($2::text[]))
         OR locks.granted = FALSE
       )
     ORDER BY locks.granted DESC, relation.relname NULLS LAST, locks.locktype, locks.mode`,
    [backendPid, relationNames]
  )).rows.map((row) => ({
    lockType: row.locktype,
    relation: row.relation,
    mode: row.mode,
    granted: row.granted,
  }));
}

async function assertNoLeakedTransactions(pool) {
  const result = await pool.query(
    `SELECT pid::int AS pid, state
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND usename = current_user
       AND pid <> pg_backend_pid()
       AND state IN ('idle in transaction', 'idle in transaction (aborted)')`
  );
  assert.deepEqual(result.rows, []);
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

async function acceptFixtureConsent(pool, fixture) {
  await pool.query(
    `INSERT INTO goals_coach_alpha_consents
      (member_id, auth_mapping_id, consent_version, environment, status, accepted_at)
     VALUES ($1, $2, $3, 'test', 'accepted', NOW())`,
    [fixture.member.memberId, fixture.mapping.id, APPROVED_ALPHA_CONSENT_VERSION]
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function insertCompletedVoiceAttempt(pool, fixture, content) {
  return (await pool.query(
    `INSERT INTO goals_coach_transcription_attempts
      (id, request_id, attempt_number, member_id, auth_mapping_id,
       auth_session_digest, conversation_id, plan_id, status, mime_type,
       audio_byte_count, audio_duration_ms, audio_digest, transcript_digest,
       provider_identifier, model_identifier, provider_started_at,
       provider_completed_at, expires_at, created_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'completed',
       'audio/webm;codecs=opus', 32, 1200, $8, $9,
       'synthetic-native-provider', 'synthetic-native-model',
       NOW() - INTERVAL '2 seconds', NOW() - INTERVAL '1 second',
       NOW() + INTERVAL '10 minutes', NOW() - INTERVAL '3 seconds')
     RETURNING *`,
    [
      crypto.randomUUID(),
      crypto.randomUUID(),
      fixture.member.memberId,
      fixture.mapping.id,
      sessionDigest(NATIVE_BINDING_KEY, NATIVE_SESSION_ID),
      fixture.conversation.id,
      fixture.plan.id,
      sha256("synthetic native voice audio"),
      sha256(content),
    ]
  )).rows[0];
}

function nativeCoachingOutput(configuration) {
  return {
    reply: "Synthetic native lock-order response.",
    mode: "start_today",
    nextAction: null,
    conversationState: { workoutActive: false, awaitingMemberCompletion: false },
    stateTransition: { type: "no_change", expectedVersion: null, changes: {} },
    review: { required: false, priority: null, category: null, reason: null },
    safety: { stopNormalCoaching: false, severity: "none" },
    uncertainty: { missingContext: false, reason: null },
    promptVersion: configuration.promptVersion,
    schemaVersion: configuration.structuredOutputVersion,
  };
}

function nativeVoiceService(pool, transactionHooks, onProviderCall) {
  const configuration = Object.freeze({
    providerIdentifier: "synthetic-native-coaching-provider",
    modelIdentifier: "synthetic-native-coaching-model",
    promptVersion: "GC-PROMPT-1B-1.0",
    structuredOutputVersion: "GC-OUTPUT-1B-1.0",
    safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B",
    providerTimeoutMs: 15000,
  });
  return createPhase1bCoachingService({
    db: pool,
    applicationConfiguration: NATIVE_APPLICATION_CONFIGURATION,
    phase1cStartup: { status: "ready" },
    transcriptionBindingKey: NATIVE_BINDING_KEY,
    transactionHooks,
    pendingPollIntervalMs: 2,
    pendingWaitTimeoutMs: 20000,
    engine: {
      configuration,
      async generateTurn() {
        if (onProviderCall) await onProviderCall();
        return { output: nativeCoachingOutput(configuration) };
      },
    },
  });
}

function nativeVoiceInput(attempt, clientMessageId = crypto.randomUUID()) {
  return {
    content: "Synthetic native reviewed transcript",
    clientMessageId,
    inputMethod: "voice",
    transcriptionId: attempt.id,
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

function service(pool, deterministic, options = {}) {
  return createTranscriptionService({
    db: pool,
    adapter: deterministic.adapter,
    bindingKey: "synthetic-real-postgres-binding-key",
    providerTimeoutMs: 500,
    operationTimeoutMs: 1000,
    ...options,
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

test(
  "voice staging and transcription finalization preserve mapping-conversation-attempt lock order",
  { skip: skipForRoot, timeout: 30000 },
  async (t) => {
    const disposable = await createRealDisposablePostgres({ phase1b: true });
    const providerEntered = deferred();
    const releaseTranscriptionProvider = deferred();
    const voiceOwnsEarlierLocks = deferred();
    const releaseVoiceAttemptStage = deferred();
    const finalizerStarted = deferred();
    let transcription;
    let voice;
    t.after(async () => {
      releaseTranscriptionProvider.resolve();
      releaseVoiceAttemptStage.resolve();
      await Promise.allSettled(
        [transcription, voice].filter(Boolean).map((tracked) => tracked.promise)
      );
      await disposable.close();
    });
    await runMigration({ pool: disposable.pool });
    const fixture = await seedFixture(disposable.pool, "postgres-global-lock-order-two-way");
    await acceptFixtureConsent(disposable.pool, fixture);

    const finalTranscript = "Synthetic native finalization transcript";
    const transcriptionRequestId = crypto.randomUUID();
    const deterministic = createDeterministicTranscriptionAdapter({
      text: finalTranscript,
      durationMs: 1400,
      async onCall() {
        providerEntered.resolve();
        await releaseTranscriptionProvider.promise;
      },
    });
    const transcriptionService = service(disposable.pool, deterministic, {
      bindingKey: NATIVE_BINDING_KEY,
      providerTimeoutMs: 15000,
      operationTimeoutMs: 20000,
      transactionHooks: {
        beforeFinalizeOwnershipLocks({ backendPid }) {
          finalizerStarted.resolve(backendPid);
        },
      },
    });
    transcription = trackSettlement(
      transcriptionService.transcribe({
        ...input(fixture, transcriptionRequestId),
        authenticatedSessionId: NATIVE_SESSION_ID,
      })
    );
    await providerEntered.promise;

    const pendingAttempts = await disposable.pool.query(
      `SELECT *
       FROM goals_coach_transcription_attempts
       WHERE request_id = $1
       ORDER BY attempt_number`,
      [transcriptionRequestId]
    );
    assert.equal(pendingAttempts.rows.length, 1);
    const sharedAttempt = pendingAttempts.rows[0];
    assert.equal(sharedAttempt.status, "pending");
    assert.equal(sharedAttempt.attempt_number, 1);
    let coachingProviderCalls = 0;
    const voiceService = nativeVoiceService(
      disposable.pool,
      {
        async afterVoiceTurnLock({ backendPid }) {
          voiceOwnsEarlierLocks.resolve(backendPid);
          await releaseVoiceAttemptStage.promise;
        },
      },
      async () => { coachingProviderCalls += 1; }
    );
    voice = trackSettlement(voiceService.sendMessage(
      fixture.member,
      String(fixture.conversation.id),
      nativeVoiceInput(sharedAttempt),
      { authenticatedSessionId: NATIVE_SESSION_ID }
    ));
    const voicePid = await voiceOwnsEarlierLocks.promise;
    const voiceGrantedLocks = [];
    for (const [relation, mode] of [
      ["goals_coach_member_auth_mappings", "RowShareLock"],
      ["coaching_conversations", "RowShareLock"],
      ["goals_coach_coaching_turns", "RowExclusiveLock"],
    ]) {
      const granted = await waitForRelationLock(disposable.pool, {
        relation,
        pid: voicePid,
        mode,
        granted: true,
      });
      assert.equal(granted.granted, true);
      voiceGrantedLocks.push({ relation, mode, granted: granted.granted });
    }
    assert.deepEqual(
      await relationLocksForBackend(
        disposable.pool,
        "goals_coach_transcription_attempts",
        voicePid
      ),
      []
    );

    releaseTranscriptionProvider.resolve();
    const finalizerPid = await finalizerStarted.promise;
    const finalizerWait = await waitForBackendLockWait(disposable.pool, finalizerPid);
    assert.equal(finalizerWait.wait_event_type, "Lock");
    assert.ok(finalizerWait.wait_event);
    const finalizerBlockingPids = await waitForBlockingPid(
      disposable.pool,
      finalizerPid,
      voicePid
    );
    assert.ok(finalizerBlockingPids.includes(voicePid));
    assert.deepEqual(
      await relationLocksForBackend(
        disposable.pool,
        "goals_coach_transcription_attempts",
        finalizerPid
      ),
      [],
      "finalization must not lock the attempt before its authoritative mapping/conversation"
    );
    const relevantRelations = [
      "goals_coach_member_auth_mappings",
      "coaching_conversations",
      "goals_coach_coaching_turns",
      "goals_coach_transcription_attempts",
    ];
    const voiceLockEvidence = await backendLockEvidence(
      disposable.pool,
      voicePid,
      relevantRelations
    );
    const finalizerLockEvidence = await backendLockEvidence(
      disposable.pool,
      finalizerPid,
      relevantRelations
    );
    assert.equal(transcription.isSettled(), false);

    releaseVoiceAttemptStage.resolve();
    const [voiceResult, transcriptionResult] = await Promise.allSettled([
      voice.promise,
      transcription.promise,
    ]);
    for (const result of [voiceResult, transcriptionResult]) {
      if (result.status === "rejected") {
        assert.notEqual(result.reason && result.reason.code, "40P01");
        assert.notEqual(result.reason && result.reason.code, "55P03");
      }
    }
    assert.equal(voiceResult.status, "rejected");
    assert.equal(voiceResult.reason.statusCode, 404);
    assert.equal(voiceResult.reason.code, "TRANSCRIPTION_NOT_FOUND");
    assert.equal(voiceResult.reason.message, "Transcription not found");
    assert.equal(
      transcriptionResult.status,
      "fulfilled",
      transcriptionResult.reason && transcriptionResult.reason.message
    );
    assert.equal(deterministic.getCallCount(), 1);
    assert.equal(coachingProviderCalls, 0);
    assert.equal(transcriptionResult.value.transcriptionId, sharedAttempt.id);
    assert.equal(transcriptionResult.value.transcript, finalTranscript);
    assert.equal(transcriptionResult.value.attemptNumber, 1);

    const attemptStates = await disposable.pool.query(
      `SELECT id, request_id, attempt_number, status, consumed_at,
              consumed_member_message_id
       FROM goals_coach_transcription_attempts
       ORDER BY id`
    );
    assert.deepEqual(attemptStates.rows, [{
      id: sharedAttempt.id,
      request_id: transcriptionRequestId,
      attempt_number: 1,
      status: "completed",
      consumed_at: null,
      consumed_member_message_id: null,
    }]);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM coaching_messages"
    )).rows[0].count, 0);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns"
    )).rows[0].count, 0);
    assert.equal((await disposable.pool.query(
      `SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns
       WHERE transcription_attempt_id IS NOT NULL`
    )).rows[0].count, 0);
    await assertNoLeakedTransactions(disposable.pool);
    t.diagnostic(JSON.stringify({
      evidence: "postgres-lock-order",
      race: "same-attempt voice-staging versus transcription-finalization",
      voicePid,
      finalizerPid,
      relevantRelations,
      voiceGrantedLocks,
      voiceLocks: voiceLockEvidence,
      finalizerLocks: finalizerLockEvidence,
      finalizerBlockingPids,
      finalAttemptId: sharedAttempt.id,
      finalAttemptLifecycle: "completed-unconsumed",
      deadlockObserved: false,
      lockTimeoutObserved: false,
      statementTimeoutObserved: false,
      retryObserved: false,
    }));
  }
);

test(
  "voice staging, finalization, and Rollback 005 form no three-way deadlock cycle",
  { skip: skipForRoot, timeout: 30000 },
  async (t) => {
    const disposable = await createRealDisposablePostgres({ phase1b: true });
    const providerEntered = deferred();
    const releaseTranscriptionProvider = deferred();
    const rollbackOwnsTurnTable = deferred();
    const releaseRollbackSecondLock = deferred();
    const voiceReachedTurnLock = deferred();
    const finalizerStarted = deferred();
    let transcription;
    let rollback;
    let voice;
    t.after(async () => {
      releaseTranscriptionProvider.resolve();
      releaseRollbackSecondLock.resolve();
      await Promise.allSettled(
        [transcription, rollback, voice].filter(Boolean).map((tracked) => tracked.promise)
      );
      await disposable.close();
    });
    await runMigration({ pool: disposable.pool });
    const fixture = await seedFixture(disposable.pool, "postgres-global-lock-order-three-way");
    await acceptFixtureConsent(disposable.pool, fixture);

    const finalTranscript = "Synthetic native three-way finalization transcript";
    const transcriptionRequestId = crypto.randomUUID();
    const deterministic = createDeterministicTranscriptionAdapter({
      text: finalTranscript,
      durationMs: 1500,
      async onCall() {
        providerEntered.resolve();
        await releaseTranscriptionProvider.promise;
      },
    });
    const transcriptionService = service(disposable.pool, deterministic, {
      providerTimeoutMs: 15000,
      operationTimeoutMs: 20000,
      transactionHooks: {
        beforeFinalizeOwnershipLocks({ backendPid }) {
          finalizerStarted.resolve(backendPid);
        },
      },
    });
    transcription = trackSettlement(
      transcriptionService.transcribe(input(fixture, transcriptionRequestId))
    );
    await providerEntered.promise;
    const finalizerAttempts = await disposable.pool.query(
      `SELECT *
       FROM goals_coach_transcription_attempts
       WHERE request_id = $1
       ORDER BY attempt_number`,
      [transcriptionRequestId]
    );
    assert.equal(finalizerAttempts.rows.length, 1);
    const finalizerAttempt = finalizerAttempts.rows[0];
    assert.equal(finalizerAttempt.status, "pending");
    assert.equal(finalizerAttempt.attempt_number, 1);
    const voiceAttempt = await insertCompletedVoiceAttempt(
      disposable.pool,
      fixture,
      "Synthetic native reviewed transcript"
    );

    rollback = trackSettlement(runRollback({
      pool: disposable.pool,
      skipConfirmation: true,
      async afterFirstTableLock({ backendPid }) {
        rollbackOwnsTurnTable.resolve(backendPid);
        await releaseRollbackSecondLock.promise;
      },
    }));
    const rollbackPid = await rollbackOwnsTurnTable.promise;
    const rollbackTurnLock = await waitForRelationLock(disposable.pool, {
      relation: "goals_coach_coaching_turns",
      pid: rollbackPid,
      mode: "AccessExclusiveLock",
      granted: true,
    });
    assert.equal(rollbackTurnLock.granted, true);
    assert.deepEqual(
      await relationLocksForBackend(
        disposable.pool,
        "goals_coach_transcription_attempts",
        rollbackPid
      ),
      []
    );

    let coachingProviderCalls = 0;
    const voiceService = nativeVoiceService(
      disposable.pool,
      {
        beforeVoiceTurnLock({ backendPid }) {
          voiceReachedTurnLock.resolve(backendPid);
        },
      },
      async () => { coachingProviderCalls += 1; }
    );
    voice = trackSettlement(voiceService.sendMessage(
      fixture.member,
      String(fixture.conversation.id),
      nativeVoiceInput(voiceAttempt),
      { authenticatedSessionId: NATIVE_SESSION_ID }
    ));
    const voicePid = await voiceReachedTurnLock.promise;
    const waitingVoiceTurnLock = await waitForRelationLock(disposable.pool, {
      relation: "goals_coach_coaching_turns",
      pid: voicePid,
      mode: "RowExclusiveLock",
      granted: false,
    });
    assert.equal(waitingVoiceTurnLock.granted, false);
    const voiceBlockingPids = await waitForBlockingPid(
      disposable.pool,
      voicePid,
      rollbackPid
    );
    assert.ok(voiceBlockingPids.includes(rollbackPid));
    for (const relation of [
      "goals_coach_member_auth_mappings",
      "coaching_conversations",
    ]) {
      const earlierLock = await waitForRelationLock(disposable.pool, {
        relation,
        pid: voicePid,
        mode: "RowShareLock",
        granted: true,
      });
      assert.equal(earlierLock.granted, true);
    }
    assert.deepEqual(
      await relationLocksForBackend(
        disposable.pool,
        "goals_coach_transcription_attempts",
        voicePid
      ),
      []
    );

    releaseTranscriptionProvider.resolve();
    const finalizerPid = await finalizerStarted.promise;
    const finalizerWait = await waitForBackendLockWait(disposable.pool, finalizerPid);
    assert.equal(finalizerWait.wait_event_type, "Lock");
    const finalizerBlockingPids = await waitForBlockingPid(
      disposable.pool,
      finalizerPid,
      voicePid
    );
    assert.ok(finalizerBlockingPids.includes(voicePid));
    assert.deepEqual(
      await relationLocksForBackend(
        disposable.pool,
        "goals_coach_transcription_attempts",
        finalizerPid
      ),
      [],
      "the rejected attempt-first finalizer would hold a RowShareLock here"
    );
    const relevantRelations = [
      "goals_coach_member_auth_mappings",
      "coaching_conversations",
      "goals_coach_coaching_turns",
      "goals_coach_transcription_attempts",
    ];
    const rollbackLockEvidence = await backendLockEvidence(
      disposable.pool,
      rollbackPid,
      relevantRelations
    );
    const voiceLockEvidence = await backendLockEvidence(
      disposable.pool,
      voicePid,
      relevantRelations
    );
    const finalizerLockEvidence = await backendLockEvidence(
      disposable.pool,
      finalizerPid,
      relevantRelations
    );
    assert.equal(rollback.isSettled(), false);
    assert.equal(voice.isSettled(), false);
    assert.equal(transcription.isSettled(), false);

    releaseRollbackSecondLock.resolve();
    const rollbackError = await captureRejection(rollback.promise);
    assert.notEqual(rollbackError.code, "40P01");
    assert.notEqual(rollbackError.code, "55P03");
    assert.equal(rollbackError.code, "23514");
    assert.equal(
      rollbackError.constraint,
      "goals_coach_transcription_rollback_preservation_required"
    );

    const [voiceResult, transcriptionResult] = await Promise.allSettled([
      voice.promise,
      transcription.promise,
    ]);
    for (const result of [voiceResult, transcriptionResult]) {
      if (result.status === "rejected") {
        assert.notEqual(result.reason && result.reason.code, "40P01");
        assert.notEqual(result.reason && result.reason.code, "55P03");
      }
      assert.equal(result.status, "fulfilled", result.reason && result.reason.message);
    }
    assert.equal(deterministic.getCallCount(), 1);
    assert.equal(coachingProviderCalls, 1);
    assert.equal(transcriptionResult.value.transcriptionId, finalizerAttempt.id);
    assert.equal(transcriptionResult.value.transcript, finalTranscript);
    assert.equal(transcriptionResult.value.attemptNumber, 1);

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
      `SELECT COUNT(*)::int AS count FROM app_schema_migrations
       WHERE version = '005_goals_coach_voice_transcription_provenance'`
    )).rows[0].count, 1);
    assert.equal((await disposable.pool.query(
      `SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings
       WHERE id = $1 AND active = TRUE`,
      [fixture.mapping.id]
    )).rows[0].count, 1);
    assert.equal((await disposable.pool.query(
      `SELECT COUNT(*)::int AS count FROM coaching_conversations
       WHERE id = $1 AND status = 'active'`,
      [fixture.conversation.id]
    )).rows[0].count, 1);
    const voiceState = (await disposable.pool.query(
      `SELECT status, consumed_member_message_id
       FROM goals_coach_transcription_attempts WHERE id = $1`,
      [voiceAttempt.id]
    )).rows[0];
    assert.equal(voiceState.status, "consumed");
    assert.ok(voiceState.consumed_member_message_id);
    assert.equal((await disposable.pool.query(
      `SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns
       WHERE transcription_attempt_id = $1 AND provider_status = 'completed'`,
      [voiceAttempt.id]
    )).rows[0].count, 1);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM coaching_messages"
    )).rows[0].count, 2);
    const finalizerState = (await disposable.pool.query(
      `SELECT id, request_id, attempt_number, status, transcript_digest,
              consumed_at, consumed_member_message_id, failure_category
       FROM goals_coach_transcription_attempts
       WHERE id = $1`,
      [finalizerAttempt.id]
    )).rows[0];
    assert.deepEqual(finalizerState, {
      id: finalizerAttempt.id,
      request_id: transcriptionRequestId,
      attempt_number: 1,
      status: "completed",
      transcript_digest: sha256(finalTranscript),
      consumed_at: null,
      consumed_member_message_id: null,
      failure_category: null,
    });
    assert.ok(finalizerState.transcript_digest);
    assert.equal((await disposable.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM goals_coach_transcription_attempts
       WHERE request_id = $1`,
      [transcriptionRequestId]
    )).rows[0].count, 1);
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_transcription_attempts"
    )).rows[0].count, 2);
    await assertNoLeakedTransactions(disposable.pool);
    t.diagnostic(JSON.stringify({
      evidence: "postgres-lock-order",
      race: "voice-staging versus transcription-finalization versus rollback-005",
      rollbackPid,
      voicePid,
      finalizerPid,
      relevantRelations,
      rollbackLocks: rollbackLockEvidence,
      voiceLocks: voiceLockEvidence,
      finalizerLocks: finalizerLockEvidence,
      voiceBlockingPids,
      finalizerBlockingPids,
      finalAttemptId: finalizerAttempt.id,
      finalAttemptLifecycle: "completed-unconsumed",
      rollbackResult: "preservation-refusal-23514",
      deadlockObserved: false,
      lockTimeoutObserved: false,
      statementTimeoutObserved: false,
      retryObserved: false,
    }));
  }
);
