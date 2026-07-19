const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { runMigration } = require("../migrate_005");
const { runRollback } = require("../rollback_005");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SESSION_DIGEST = "c".repeat(64);

async function seedFixture(pool, suffix) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const mapping = await seedAlphaMapping(pool, seeded.member, suffix, true);
  const conversation = (await pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  return { ...seeded, mapping, conversation };
}

async function insertPending(pool, fixture, overrides = {}) {
  const values = {
    id: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    attemptNumber: 1,
    memberId: fixture.member.id,
    mappingId: fixture.mapping.id,
    sessionDigest: SESSION_DIGEST,
    conversationId: fixture.conversation.id,
    planId: fixture.plan.id,
    mimeType: "audio/webm;codecs=opus",
    byteCount: 128,
    audioDigest: DIGEST_A,
    ...overrides,
  };
  return (await pool.query(
    `INSERT INTO goals_coach_transcription_attempts
      (id, request_id, attempt_number, member_id, auth_mapping_id,
       auth_session_digest, conversation_id, plan_id, mime_type,
       audio_byte_count, audio_digest, provider_identifier, model_identifier,
       provider_started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       'synthetic-provider', 'synthetic-model', NOW())
     RETURNING *`,
    [
      values.id,
      values.requestId,
      values.attemptNumber,
      values.memberId,
      values.mappingId,
      values.sessionDigest,
      values.conversationId,
      values.planId,
      values.mimeType,
      values.byteCount,
      values.audioDigest,
    ]
  )).rows[0];
}

async function completeAttempt(pool, id) {
  return (await pool.query(
    `UPDATE goals_coach_transcription_attempts
     SET status = 'completed',
         audio_duration_ms = 1200,
         transcript_digest = $1,
         provider_completed_at = NOW() + INTERVAL '1 millisecond',
         expires_at = NOW() + INTERVAL '10 minutes'
     WHERE id = $2
     RETURNING *`,
    [DIGEST_B, id]
  )).rows[0];
}

async function insertMemberMessage(pool, fixture, content) {
  return (await pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', $3) RETURNING *`,
    [fixture.conversation.id, fixture.member.id, content]
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
      fixture.member.id,
      fixture.conversation.id,
      fixture.plan.id,
      memberMessageId,
      crypto.randomUUID(),
      "e".repeat(64),
      transcriptionAttemptId,
    ]
  )).rows[0];
}

test("migration 005 requires migration 004", async (t) => {
  const disposable = await createDisposableDatabase({ phase1a: true });
  t.after(() => disposable.close());
  await assert.rejects(
    runMigration({ pool: disposable.pool }),
    /Migration 004 must be applied before Migration 005/
  );
});

test("migration 005 is checksummed, additive, idempotent, and narrowly reversible", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  const fixture = await seedFixture(disposable.pool, "migration-005-preserve");
  const existingMessage = (await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Existing synthetic message') RETURNING *`,
    [fixture.conversation.id, fixture.member.id]
  )).rows[0];
  const before = {
    members: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_members")).rows[0].count,
    plans: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coach_plans")).rows[0].count,
    mappings: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings")).rows[0].count,
    conversations: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_conversations")).rows[0].count,
    messages: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM coaching_messages")).rows[0].count,
    turns: (await disposable.pool.query("SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns")).rows[0].count,
  };

  const applied = await runMigration({ pool: disposable.pool });
  assert.equal(applied.status, "applied");
  assert.match(applied.checksum, /^[a-f0-9]{64}$/);
  const rerun = await runMigration({ pool: disposable.pool });
  assert.deepEqual(rerun, { ...applied, status: "already_applied" });
  assert.equal((await disposable.pool.query(
    "SELECT checksum FROM app_schema_migrations WHERE version = '005_goals_coach_voice_transcription_provenance'"
  )).rows[0].checksum, applied.checksum);

  for (const [table, expected] of Object.entries(before)) {
    const relation = {
      members: "coach_members",
      plans: "coach_plans",
      mappings: "goals_coach_member_auth_mappings",
      conversations: "coaching_conversations",
      messages: "coaching_messages",
      turns: "goals_coach_coaching_turns",
    }[table];
    assert.equal((await disposable.pool.query(
      `SELECT COUNT(*)::int AS count FROM ${relation}`
    )).rows[0].count, expected);
  }
  assert.equal(String((await disposable.pool.query(
    "SELECT id FROM coaching_messages WHERE id = $1",
    [existingMessage.id]
  )).rows[0].id), String(existingMessage.id));

  const columns = (await disposable.pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'goals_coach_transcription_attempts'
     ORDER BY ordinal_position`
  )).rows.map((row) => row.column_name);
  assert.deepEqual(columns, [
    "id", "request_id", "attempt_number", "member_id", "auth_mapping_id",
    "auth_session_digest", "conversation_id", "plan_id", "status", "mime_type",
    "audio_byte_count", "audio_duration_ms", "audio_digest", "transcript_digest",
    "provider_identifier", "model_identifier", "failure_category",
    "provider_started_at", "provider_completed_at", "expires_at", "consumed_at",
    "consumed_member_message_id", "transcript_edited", "created_at",
  ]);
  for (const prohibited of [
    "audio", "raw_audio", "transcript", "transcript_text", "device_label",
    "provider_request", "provider_response", "credential", "bearer_token",
  ]) {
    assert.equal(columns.includes(prohibited), false);
  }
  assert.equal((await disposable.pool.query(
    `SELECT data_type
     FROM information_schema.columns
     WHERE table_name = 'goals_coach_coaching_turns'
       AND column_name = 'transcription_attempt_id'`
  )).rows[0].data_type, "uuid");
  const turnTranscriptionForeignKey = (await disposable.pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conname = 'fk_goals_coach_turn_transcription_attempt'`
  )).rows[0].definition.replace(/\s+/g, " ");
  assert.equal(
    turnTranscriptionForeignKey,
    "FOREIGN KEY (transcription_attempt_id, member_id, conversation_id, plan_id) "
      + "REFERENCES goals_coach_transcription_attempts(id, member_id, conversation_id, plan_id) "
      + "ON DELETE RESTRICT"
  );

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.equal(packageJson.scripts["migrate:phase1c-transcription"], "node migrate_005.js");
  assert.equal(packageJson.scripts["rollback:phase1c-transcription"], "node rollback_005.js");

  const previousConfirmation = process.env.CONFIRM_PHASE1C_TRANSCRIPTION_ROLLBACK;
  delete process.env.CONFIRM_PHASE1C_TRANSCRIPTION_ROLLBACK;
  try {
    await assert.rejects(
      runRollback({ pool: disposable.pool }),
      /Set CONFIRM_PHASE1C_TRANSCRIPTION_ROLLBACK=YES/
    );
  } finally {
    if (previousConfirmation === undefined) {
      delete process.env.CONFIRM_PHASE1C_TRANSCRIPTION_ROLLBACK;
    } else {
      process.env.CONFIRM_PHASE1C_TRANSCRIPTION_ROLLBACK = previousConfirmation;
    }
  }

  const rolledBack = await runRollback({ pool: disposable.pool, skipConfirmation: true });
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal((await disposable.pool.query(
    "SELECT to_regclass('public.goals_coach_transcription_attempts') AS name"
  )).rows[0].name, null);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_name = 'goals_coach_coaching_turns'
       AND column_name = 'transcription_attempt_id'`
  )).rows[0].count, 0);
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM coaching_messages"
  )).rows[0].count, before.messages);
});

test("migration 005 enforces ownership, pending concurrency, lifecycle, and replay constraints", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const first = await seedFixture(disposable.pool, "migration-005-first");
  const second = await seedFixture(disposable.pool, "migration-005-second");
  const pending = await insertPending(disposable.pool, first);

  await assert.rejects(
    insertPending(disposable.pool, first),
    (error) => error.code === "23505"
      && error.constraint === "uq_goals_coach_pending_transcription_per_member"
  );
  await assert.rejects(
    insertPending(disposable.pool, first, {
      memberId: second.member.id,
      requestId: crypto.randomUUID(),
    }),
    (error) => error.code === "23503"
  );
  await assert.rejects(
    disposable.pool.query(
      `UPDATE goals_coach_transcription_attempts
       SET status = 'completed', provider_completed_at = NOW()
       WHERE id = $1`,
      [pending.id]
    ),
    (error) => error.code === "23514"
  );
  const completed = await completeAttempt(disposable.pool, pending.id);
  assert.equal(completed.status, "completed");
  await assert.rejects(
    insertPending(disposable.pool, first, {
      requestId: pending.request_id,
      attemptNumber: 2,
    }),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_transcription_attempt_two_requires_failed_first"
  );
  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_transcription_attempts SET status = 'pending' WHERE id = $1",
      [pending.id]
    ),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_transcription_attempt_lifecycle"
  );
  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_transcription_attempts SET transcript_digest = $1 WHERE id = $2",
      ["d".repeat(64), pending.id]
    ),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_transcription_attempt_terminal_immutable"
  );
  await assert.rejects(
    disposable.pool.query(
      "DELETE FROM goals_coach_transcription_attempts WHERE id = $1",
      [pending.id]
    ),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_transcription_attempt_delete_prohibited"
  );

  const firstMessage = (await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Synthetic consumed transcript') RETURNING *`,
    [first.conversation.id, first.member.id]
  )).rows[0];
  const secondMessage = (await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Wrong member synthetic transcript') RETURNING *`,
    [second.conversation.id, second.member.id]
  )).rows[0];
  await assert.rejects(
    disposable.pool.query(
      `UPDATE goals_coach_transcription_attempts
       SET status = 'consumed', consumed_at = provider_completed_at,
           consumed_member_message_id = $1
       WHERE id = $2`,
      [secondMessage.id, pending.id]
    ),
    (error) => error.code === "23503"
  );
  const consumed = (await disposable.pool.query(
    `UPDATE goals_coach_transcription_attempts
     SET status = 'consumed', consumed_at = provider_completed_at,
         consumed_member_message_id = $1, transcript_edited = TRUE
     WHERE id = $2 RETURNING *`,
    [firstMessage.id, pending.id]
  )).rows[0];
  assert.equal(consumed.status, "consumed");

  await assert.rejects(
    insertLinkedTurn(disposable.pool, second, secondMessage.id, pending.id),
    (error) => error.code === "23503"
      && error.constraint === "fk_goals_coach_turn_transcription_attempt"
  );

  const otherConversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id, status, archived_at)
     VALUES ($1, $2, 'archived', NOW()) RETURNING *`,
    [first.member.id, first.plan.id]
  )).rows[0];
  const otherConversationFixture = { ...first, conversation: otherConversation };
  const otherConversationMessage = await insertMemberMessage(
    disposable.pool,
    otherConversationFixture,
    "Cross-conversation synthetic voice message"
  );
  await assert.rejects(
    insertLinkedTurn(
      disposable.pool,
      otherConversationFixture,
      otherConversationMessage.id,
      pending.id
    ),
    (error) => error.code === "23503"
      && error.constraint === "fk_goals_coach_turn_transcription_attempt"
  );

  const otherPlan = (await disposable.pool.query(
    `INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown)
     VALUES ($1, '{}'::jsonb, '[]'::jsonb, 'Cross-plan synthetic plan') RETURNING *`,
    [first.member.id]
  )).rows[0];
  const otherPlanConversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [first.member.id, otherPlan.id]
  )).rows[0];
  const otherPlanFixture = {
    ...first,
    plan: otherPlan,
    conversation: otherPlanConversation,
  };
  const otherPlanMessage = await insertMemberMessage(
    disposable.pool,
    otherPlanFixture,
    "Cross-plan synthetic voice message"
  );
  await assert.rejects(
    insertLinkedTurn(disposable.pool, otherPlanFixture, otherPlanMessage.id, pending.id),
    (error) => error.code === "23503"
      && error.constraint === "fk_goals_coach_turn_transcription_attempt"
  );

  const firstTurn = await insertLinkedTurn(
    disposable.pool,
    first,
    firstMessage.id,
    pending.id
  );
  await disposable.pool.query(
    `UPDATE goals_coach_coaching_turns
     SET provider_status = 'failed', failure_category = 'synthetic_failure',
         provider_completed_at = NOW()
     WHERE id = $1`,
    [firstTurn.id]
  );
  const secondSameConversationMessage = (await disposable.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Second synthetic voice message') RETURNING *`,
    [first.conversation.id, first.member.id]
  )).rows[0];
  await assert.rejects(
    insertLinkedTurn(
      disposable.pool,
      first,
      secondSameConversationMessage.id,
      pending.id
    ),
    (error) => error.code === "23505"
      && error.constraint === "uq_goals_coach_turn_transcription_attempt"
  );
  await assert.rejects(
    disposable.pool.query(
      "UPDATE goals_coach_transcription_attempts SET status = 'completed' WHERE id = $1",
      [pending.id]
    ),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_transcription_attempt_lifecycle"
  );
});

test("migration 005 permits only a matching failed first attempt to create attempt two", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "migration-005-retry");
  const first = await insertPending(disposable.pool, fixture);
  await disposable.pool.query(
    `UPDATE goals_coach_transcription_attempts
     SET status = 'failed', failure_category = 'provider_timeout',
         provider_completed_at = NOW() + INTERVAL '1 millisecond'
     WHERE id = $1`,
    [first.id]
  );
  const second = await insertPending(disposable.pool, fixture, {
    requestId: first.request_id,
    attemptNumber: 2,
  });
  assert.equal(second.attempt_number, 2);
  await assert.rejects(
    disposable.pool.query(
      `INSERT INTO goals_coach_transcription_attempts
        (id, request_id, attempt_number, member_id, auth_mapping_id,
         auth_session_digest, conversation_id, plan_id, mime_type,
         audio_byte_count, audio_digest)
       VALUES ($1, $2, 3, $3, $4, $5, $6, $7,
         'audio/webm;codecs=opus', 128, $8)`,
      [
        crypto.randomUUID(), first.request_id, fixture.member.id, fixture.mapping.id,
        SESSION_DIGEST, fixture.conversation.id, fixture.plan.id, DIGEST_A,
      ]
    ),
    (error) => error.code === "23514"
  );
});

test("migration 005 checksum mismatch and later-migration rollback protection fail closed", async (t) => {
  const checksumDatabase = await createDisposableDatabase({ phase1b: true });
  t.after(() => checksumDatabase.close());
  await runMigration({ pool: checksumDatabase.pool });
  await checksumDatabase.pool.query(
    `UPDATE app_schema_migrations
     SET checksum = $1
     WHERE version = '005_goals_coach_voice_transcription_provenance'`,
    ["0".repeat(64)]
  );
  await assert.rejects(
    runMigration({ pool: checksumDatabase.pool }),
    /Migration 005 was already applied with a different checksum/
  );
  await assert.rejects(
    runRollback({ pool: checksumDatabase.pool, skipConfirmation: true }),
    /Cannot roll back migration 005 with a different checksum/
  );

  const rollbackDatabase = await createDisposableDatabase({ phase1b: true });
  t.after(() => rollbackDatabase.close());
  await runMigration({ pool: rollbackDatabase.pool });
  await rollbackDatabase.pool.query(
    `INSERT INTO app_schema_migrations (version, checksum, applied_at)
     SELECT '006_synthetic_later', 'synthetic', applied_at + INTERVAL '1 microsecond'
     FROM app_schema_migrations
     WHERE version = '005_goals_coach_voice_transcription_provenance'`
  );
  await assert.rejects(
    runRollback({ pool: rollbackDatabase.pool, skipConfirmation: true }),
    /Cannot roll back migration 005 while later migration 006_synthetic_later is applied/
  );
});

test("migration 005 rollback refuses to destroy transcription provenance", async (t) => {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, "migration-005-rollback");
  const attempt = await insertPending(disposable.pool, fixture);
  await assert.rejects(
    runRollback({ pool: disposable.pool, skipConfirmation: true }),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_transcription_rollback_preservation_required"
  );
  assert.equal((await disposable.pool.query(
    "SELECT COUNT(*)::int AS count FROM goals_coach_transcription_attempts"
  )).rows[0].count, 1);

  const message = await insertMemberMessage(
    disposable.pool,
    fixture,
    "Rollback preservation synthetic voice message"
  );
  const turn = await insertLinkedTurn(disposable.pool, fixture, message.id, attempt.id);
  await assert.rejects(
    runRollback({ pool: disposable.pool, skipConfirmation: true }),
    (error) => error.code === "23514"
      && error.constraint === "goals_coach_transcription_rollback_preservation_required"
  );
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM goals_coach_coaching_turns
     WHERE id = $1 AND transcription_attempt_id = $2`,
    [turn.id, attempt.id]
  )).rows[0].count, 1);
  assert.equal((await disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM app_schema_migrations
     WHERE version = '005_goals_coach_voice_transcription_provenance'`
  )).rows[0].count, 1);
});
