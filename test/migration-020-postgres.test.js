"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const { seedMemberAndPlan } = require("./helpers/disposable-db");

const priorMigrations = [
  "002", "003", "004", "005", "006", "007", "008", "009", "010", "011", "012",
  "013", "014", "015", "016", "017", "018", "019",
].map((number) => require(`../migrate_${number}`).runMigration);
const {
  checksum,
  MIGRATION_FILE,
  MIGRATION_VERSION,
  REQUIRED_MIGRATION_CHECKSUM,
  runMigration,
} = require("../migrate_020");
const { runRollback } = require("../rollback_020");

const skip = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires unprivileged PostgreSQL 16"
  : false;

async function withTrackedMigrationBytes(work) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readExactTrackedMigration(file, options) {
    const name = path.basename(String(file));
    if (/^migration_0(?:0[5-9]|1[0-9])_[a-z0-9_]+\.sql$/.test(name)) {
      const bytes = execFileSync("git", ["show", `HEAD:${name}`], {
        cwd: path.resolve(__dirname, ".."),
        encoding: null,
      });
      return options === "utf8" || options?.encoding === "utf8"
        ? bytes.toString("utf8")
        : bytes;
    }
    return originalReadFileSync.apply(fs, arguments);
  };
  try {
    return await work();
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

async function at019(t) {
  const database = await createRealDisposablePostgres({ phase1b: true });
  const adminPool = database.pool;
  const databaseName = `migration_020_utf8_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName} ENCODING 'UTF8' TEMPLATE template0`);
  const utf8Pool = new Pool({
    host: "127.0.0.1",
    port: adminPool.options.port,
    user: "ugf_test",
    password: "local-disposable-only",
    database: databaseName,
    max: 10,
  });
  t.after(async () => {
    await utf8Pool.end();
    await database.close();
  });
  database.pool = utf8Pool;
  await utf8Pool.query(fs.readFileSync(path.resolve(__dirname, "../migration_001_checkin_tables.sql"), "utf8"));
  await withTrackedMigrationBytes(async () => {
    for (const migration of priorMigrations) {
      await migration({
        pool: database.pool,
        environment: { GOALS_COACH_MEMBER_PENDING_ENROLLMENT_ENABLED: "false" },
      });
    }
  });
  assert.match((await database.pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
  return database;
}

async function owner(pool, suffix, reference) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const mapping = (await pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
       (member_id,auth_provider,auth_subject,verified_email_snapshot,active,provisioning_method,provisioning_reference)
     VALUES($1,'gymmaster',$2,$3,TRUE,'administrative',$4) RETURNING *`,
    [seeded.member.id, `gymmaster:${suffix}`, `${suffix}@example.test`, `test:${suffix}`]
  )).rows[0];
  const session = (await pool.query(
    `INSERT INTO goals_coach_member_sessions
       (token_hash,auth_mapping_id,member_id,issued_at,expires_at)
     VALUES($1,$2,$3,NOW(),NOW()+INTERVAL '7200 seconds') RETURNING *`,
    [crypto.createHash("sha256").update(`session-${suffix}`).digest("hex"), mapping.id, seeded.member.id]
  )).rows[0];
  const conversation = (await pool.query(
    "INSERT INTO coaching_conversations(member_id,plan_id) VALUES($1,$2) RETURNING *",
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  const binding = (await pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,conversation_version,provenance,coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES($1,1,'member_session',$2,$3,$4,$5) RETURNING *`,
    [reference, conversation.id, seeded.member.id, mapping.id, session.id]
  )).rows[0];
  return { binding };
}

async function reservation(pool, owned, key, signature = "a".repeat(64)) {
  return (await pool.query(
    `INSERT INTO goals_coach_member_conversation_turn_reservations
       (idempotency_key,conversation_binding_id,conversation_reference,conversation_version,
        conversation_provenance,request_signature_sha256,contract_version,safety_rule_version,
        safety_source_rule_version)
     VALUES($1,$2,$3,1,'member_session',$4,'GC-MEMBER-CONVERSATION-TURN-1',
       'GC-MEMBER-CONVERSATION-SAFETY-1','GC-MEMBER-CONVERSATION-SAFETY-RULES-1') RETURNING *`,
    [key, owned.binding.id, owned.binding.conversation_reference, signature]
  )).rows[0];
}

async function event(pool, reservationId, eventType, values = {}) {
  return (await pool.query(
    `INSERT INTO goals_coach_member_conversation_turn_dispatch_events
       (reservation_id,event_type,attempt_id,lease_expires_at,reconciliation_not_before,
        provider_contract_version,client_request_id,provider_request_id,provider_response_id,
        response_digest_sha256,terminal_category)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      reservationId, eventType, values.attemptId || null, values.leaseExpiresAt || null,
      values.reconciliationNotBefore || null, values.providerContractVersion || null,
      values.clientRequestId || null, values.providerRequestId || null,
      values.providerResponseId || null, values.responseDigest || null,
      values.terminalCategory || null,
    ]
  )).rows[0];
}

async function safeRow(pool, exact) {
  return (await pool.query(
    `INSERT INTO goals_coach_member_conversation_turn_idempotency
       (idempotency_key,conversation_binding_id,conversation_reference,conversation_version,
        conversation_provenance,request_signature_sha256,contract_version,safety_rule_version,
        safety_source_rule_version,response_state,response_reason,safety_classification,safety_action)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'safe_to_process',NULL,'clear','allow_provider_processing')
     RETURNING *`,
    [
      exact.idempotency_key, exact.conversation_binding_id, exact.conversation_reference,
      exact.conversation_version, exact.conversation_provenance, exact.request_signature_sha256,
      exact.contract_version, exact.safety_rule_version, exact.safety_source_rule_version,
    ]
  )).rows[0];
}

function response(exact, coaching) {
  return {
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-RESPONSE-2",
    requestContractVersion: "GC-MEMBER-CONVERSATION-TURN-1",
    requestId: exact.idempotency_key,
    idempotencyKey: exact.idempotency_key,
    conversation: {
      reference: exact.conversation_reference,
      version: exact.conversation_version,
      provenance: exact.conversation_provenance,
    },
    result: {
      state: "safe_to_process",
      reason: null,
      safety: {
        ruleVersion: exact.safety_rule_version,
        sourceRuleVersion: exact.safety_source_rule_version,
        requestHash: exact.request_signature_sha256,
        classification: "clear",
        action: "allow_provider_processing",
      },
    },
    coaching,
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function applyMigration020(pool) {
  try {
    return await runMigration({ pool });
  } catch (error) {
    let cause = error;
    while (cause.cause) cause = cause.cause;
    throw cause;
  }
}

async function providerSuccess(pool, exact, coaching = "Move smoothly and stop if symptoms change.") {
  const attemptId = crypto.randomUUID();
  const responseDigest = digest(JSON.stringify(response(exact, coaching)));
  await event(pool, exact.id, "reserved");
  await event(pool, exact.id, "lease_acquired", {
    attemptId,
    leaseExpiresAt: new Date(Date.now() + 30_000),
  });
  await event(pool, exact.id, "dispatch_started", {
    attemptId,
    reconciliationNotBefore: new Date(Date.now() + 30_000),
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attemptId,
  });
  await event(pool, exact.id, "provider_succeeded", {
    attemptId,
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attemptId,
    providerRequestId: `request-${attemptId}`,
    providerResponseId: `response-${attemptId}`,
    responseDigest,
    terminalCategory: "success",
  });
  return { attemptId, coaching, responseDigest };
}

async function companion(pool, exact, finalRow, success, overrides = {}) {
  return pool.query(
    `INSERT INTO goals_coach_member_conversation_provider_coaching_replays
       (reservation_id,migration_018_row_id,idempotency_key,conversation_binding_id,
        conversation_reference,conversation_version,conversation_provenance,request_signature_sha256,
        response_contract_version,coaching_text,response_digest_sha256,coaching_digest_sha256)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'GC-MEMBER-CONVERSATION-TURN-RESPONSE-2',$9,$10,$11)
     RETURNING *`,
    [
      overrides.reservationId || exact.id,
      overrides.finalRowId || finalRow.id,
      overrides.idempotencyKey || exact.idempotency_key,
      overrides.bindingId || exact.conversation_binding_id,
      overrides.reference || exact.conversation_reference,
      exact.conversation_version,
      exact.conversation_provenance,
      overrides.signature || exact.request_signature_sha256,
      overrides.coaching || success.coaching,
      overrides.responseDigest || success.responseDigest,
      overrides.coachingDigest || digest(overrides.coaching || success.coaching),
    ]
  );
}

async function waitForAdvisoryWait(pool, backendPid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query(
      "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
      [backendPid]
    );
    if (waiting.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("coaching replay insert did not reach the reservation advisory lock");
}

test("Migration 020 is ordered, checksummed, replayable, and zero-backfill", { skip }, async (t) => {
  const predecessor = execFileSync(
    "git",
    ["show", "HEAD:migration_019_goals_coach_member_conversation_provider_dispatch.sql"],
    { encoding: "utf8" }
  );
  assert.equal(checksum(predecessor), REQUIRED_MIGRATION_CHECKSUM);
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts["migrate:member-conversation-provider-coaching-replay"], "node migrate_020.js");
  assert.equal(packageJson.scripts["rollback:member-conversation-provider-coaching-replay"], "node rollback_020.js");
  assert.doesNotMatch(fs.readFileSync("server.js", "utf8"), /migrate_020|provider_coaching_replays/);

  const database = await at019(t);
  const owned = await owner(database.pool, "legacy020", "10000000-0000-4000-8000-000000000200");
  await reservation(database.pool, owned, "20000000-0000-4000-8000-000000000200");
  assert.equal((await applyMigration020(database.pool)).status, "applied");
  assert.equal((await applyMigration020(database.pool)).status, "already_applied");
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_provider_coaching_replays"
  )).rows[0].count, 0);
});

test("Migration 020 atomically gates provider finalization on exact canonical replay", { skip }, async (t) => {
  const database = await at019(t);
  await applyMigration020(database.pool);
  const owned = await owner(database.pool, "success020", "10000000-0000-4000-8000-000000000201");
  const exact = await reservation(database.pool, owned, "20000000-0000-4000-8000-000000000201");
  const success = await providerSuccess(
    database.pool,
    exact,
    "Move smoothly.\nStop if symptoms change."
  );
  const finalRow = await safeRow(database.pool, exact);

  await assert.rejects(event(database.pool, exact.id, "finalized"), (error) => error.code === "23514");
  const inserted = (await companion(database.pool, exact, finalRow, success)).rows[0];
  assert.equal((await event(database.pool, exact.id, "finalized")).event_type, "finalized");
  await assert.rejects(
    database.pool.query(
      "UPDATE goals_coach_member_conversation_provider_coaching_replays SET coaching_text=coaching_text WHERE id=$1",
      [inserted.id]
    ),
    (error) => error.code === "55000"
  );
  await assert.rejects(
    database.pool.query("DELETE FROM goals_coach_member_conversation_provider_coaching_replays WHERE id=$1", [inserted.id]),
    (error) => error.code === "55000"
  );
});

test("Migration 020 rejects non-NFC coaching before durable replay or finalization", { skip }, async (t) => {
  const database = await at019(t);
  await applyMigration020(database.pool);
  const owned = await owner(database.pool, "nfc020", "10000000-0000-4000-8000-000000000206");
  const exact = await reservation(database.pool, owned, "20000000-0000-4000-8000-000000000206");
  const success = await providerSuccess(database.pool, exact, "Use cafe\u0301 form deliberately.");
  const finalRow = await safeRow(database.pool, exact);
  await assert.rejects(
    companion(database.pool, exact, finalRow, success),
    (error) => error.code === "23514"
  );
  await assert.rejects(event(database.pool, exact.id, "finalized"), (error) => error.code === "23514");
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_provider_coaching_replays"
  )).rows[0].count, 0);
  assert.equal((await database.pool.query(
    `SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events
     WHERE reservation_id=$1 AND event_type='finalized'`,
    [exact.id]
  )).rows[0].count, 0);
});

test("Migration 020 rejects exact ECMAScript boundary whitespace without banning interior LF", { skip }, async (t) => {
  const database = await at019(t);
  await applyMigration020(database.pool);
  const invalidCoaching = [
    "\nStart with controlled movement.",
    "Finish with controlled movement.\n",
    "\u00a0Start with controlled movement.",
    "Finish with controlled movement.\u3000",
  ];
  for (const [index, coaching] of invalidCoaching.entries()) {
    const owned = await owner(database.pool, `trim020-${index}`, crypto.randomUUID());
    const exact = await reservation(database.pool, owned, crypto.randomUUID());
    const success = await providerSuccess(database.pool, exact, coaching);
    const finalRow = await safeRow(database.pool, exact);
    await assert.rejects(
      companion(database.pool, exact, finalRow, success),
      (error) => error.code === "23514"
    );
    await assert.rejects(event(database.pool, exact.id, "finalized"), (error) => error.code === "23514");
  }
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_provider_coaching_replays"
  )).rows[0].count, 0);
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events WHERE event_type='finalized'"
  )).rows[0].count, 0);
});

test("Migration 020 rejects cross-turn identity and false response provenance", { skip }, async (t) => {
  const database = await at019(t);
  await applyMigration020(database.pool);
  const firstOwner = await owner(database.pool, "first020", "10000000-0000-4000-8000-000000000202");
  const secondOwner = await owner(database.pool, "second020", "10000000-0000-4000-8000-000000000203");
  const first = await reservation(database.pool, firstOwner, "20000000-0000-4000-8000-000000000202");
  const second = await reservation(database.pool, secondOwner, "20000000-0000-4000-8000-000000000203", "b".repeat(64));
  const success = await providerSuccess(database.pool, first);
  await providerSuccess(database.pool, second);
  const firstFinal = await safeRow(database.pool, first);
  const secondFinal = await safeRow(database.pool, second);

  await assert.rejects(
    companion(database.pool, first, secondFinal, success, { finalRowId: secondFinal.id }),
    (error) => error.code === "23514"
  );
  await assert.rejects(
    companion(database.pool, first, firstFinal, success, { responseDigest: "f".repeat(64) }),
    (error) => error.code === "23514"
  );
  await assert.rejects(
    companion(database.pool, first, firstFinal, success, { coachingDigest: "e".repeat(64) }),
    (error) => error.code === "23514"
  );
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_provider_coaching_replays"
  )).rows[0].count, 0);
});

test("Migration 020 serializes replay authority under the reservation lock", { skip }, async (t) => {
  const database = await at019(t);
  await applyMigration020(database.pool);
  const owned = await owner(database.pool, "lock020", "10000000-0000-4000-8000-000000000205");
  const exact = await reservation(database.pool, owned, "20000000-0000-4000-8000-000000000205");
  const success = await providerSuccess(database.pool, exact);
  const finalRow = await safeRow(database.pool, exact);
  const holder = await database.pool.connect();
  const waiter = await database.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('goals_coach_member_conversation_turn_dispatch:' || $1::text, 0)
       )`,
      [exact.id]
    );
    const backendPid = (await waiter.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const pending = companion(waiter, exact, finalRow, success);
    await waitForAdvisoryWait(database.pool, backendPid);
    await holder.query("COMMIT");
    assert.equal((await pending).rowCount, 1);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    waiter.release();
  }
});

test("Migration 020 rollback is guarded by checksum, later migrations, and replay rows", { skip }, async (t) => {
  const database = await at019(t);
  await applyMigration020(database.pool);
  const owned = await owner(database.pool, "rollback020", "10000000-0000-4000-8000-000000000204");
  const exact = await reservation(database.pool, owned, "20000000-0000-4000-8000-000000000204");
  const success = await providerSuccess(database.pool, exact);
  const finalRow = await safeRow(database.pool, exact);
  await companion(database.pool, exact, finalRow, success);
  await assert.rejects(
    runRollback({ pool: database.pool, skipConfirmation: true }),
    (error) => error.code === "provider_coaching_replay_rows_exist"
  );

  const empty = await at019(t);
  await applyMigration020(empty.pool);
  await empty.pool.query(
    "UPDATE app_schema_migrations SET checksum=$1 WHERE version=$2",
    ["f".repeat(64), MIGRATION_VERSION]
  );
  await assert.rejects(
    runRollback({ pool: empty.pool, skipConfirmation: true }),
    (error) => error.code === "checksum_mismatch"
  );
  await empty.pool.query(
    "UPDATE app_schema_migrations SET checksum=$1 WHERE version=$2",
    [checksum(fs.readFileSync(MIGRATION_FILE, "utf8")), MIGRATION_VERSION]
  );
  await empty.pool.query(
    "INSERT INTO app_schema_migrations(version,checksum) VALUES('021_test_later_migration',$1)",
    ["a".repeat(64)]
  );
  await assert.rejects(
    runRollback({ pool: empty.pool, skipConfirmation: true }),
    (error) => error.code === "later_migration_applied"
  );
  await empty.pool.query("DELETE FROM app_schema_migrations WHERE version='021_test_later_migration'");
  assert.equal((await runRollback({ pool: empty.pool, skipConfirmation: true })).status, "rolled_back");
  assert.equal((await runRollback({ pool: empty.pool, skipConfirmation: true })).status, "not_applied");
});
