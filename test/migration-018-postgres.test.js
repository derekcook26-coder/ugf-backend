"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MEMBER_CONVERSATION_TURN_MAXIMUM_BYTES,
  parseMemberConversationTurnResponse,
} = require("../src/goals-coach/member-conversation-turn-contract");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const { seedMemberAndPlan } = require("./helpers/disposable-db");

const migrations = [
  "005", "006", "007", "008", "009", "010", "011",
  "012", "013", "014", "015", "016", "017",
].map((number) => require(`../migrate_${number}`).runMigration);
const {
  checksum,
  MIGRATION_FILE,
  MIGRATION_VERSION,
  Migration018Error,
  REQUIRED_MIGRATION_CHECKSUM,
  REQUIRED_MIGRATION_CHECKSUM_CRLF,
  runMigration,
} = require("../migrate_018");
const { runRollback } = require("../rollback_018");

const skip = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires unprivileged PostgreSQL 16"
  : false;

async function withTrackedMigrationBytes(work) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readExactTrackedMigration(file, options) {
    const name = path.basename(String(file));
    if (/^migration_0(?:0[5-9]|1[0-7])_[a-z0-9_]+\.sql$/.test(name)) {
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

async function withMigration018Sql(sql, work) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readMigration018WithSelectedLineEndings(file, options) {
    if (path.resolve(String(file)) === path.resolve(MIGRATION_FILE)) {
      return options === "utf8" || options?.encoding === "utf8" ? sql : Buffer.from(sql, "utf8");
    }
    return originalReadFileSync.apply(fs, arguments);
  };
  try {
    return await work();
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

async function at017(t) {
  const database = await createRealDisposablePostgres({ phase1b: true });
  t.after(() => database.close());
  await withTrackedMigrationBytes(async () => {
    for (const migration of migrations) {
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
  return { ...seeded, binding, conversation, mapping, session };
}

function validRecord(owned, key, overrides = {}) {
  return {
    idempotencyKey: key,
    conversationBindingId: owned.binding.id,
    conversationReference: owned.binding.conversation_reference,
    conversationVersion: 1,
    conversationProvenance: "member_session",
    requestSignature: "a".repeat(64),
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-1",
    safetyRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-1",
    safetySourceRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-RULES-1",
    responseState: "blocked",
    responseReason: "safety_stop",
    safetyClassification: "pain_or_instability",
    safetyAction: "stop",
    ...overrides,
  };
}

async function insertRecord(pool, record) {
  return pool.query(
    `INSERT INTO goals_coach_member_conversation_turn_idempotency
       (idempotency_key,conversation_binding_id,conversation_reference,conversation_version,
        conversation_provenance,request_signature_sha256,contract_version,safety_rule_version,
        safety_source_rule_version,response_state,response_reason,safety_classification,safety_action)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      record.idempotencyKey,
      record.conversationBindingId,
      record.conversationReference,
      record.conversationVersion,
      record.conversationProvenance,
      record.requestSignature,
      record.contractVersion,
      record.safetyRuleVersion,
      record.safetySourceRuleVersion,
      record.responseState,
      record.responseReason,
      record.safetyClassification,
      record.safetyAction,
    ]
  );
}

function reconstructResponse(row) {
  return {
    contractVersion: row.contract_version,
    requestId: row.idempotency_key,
    idempotencyKey: row.idempotency_key,
    conversation: {
      reference: row.conversation_reference,
      version: row.conversation_version,
      provenance: row.conversation_provenance,
    },
    result: {
      state: row.response_state,
      reason: row.response_reason,
      safety: {
        ruleVersion: row.safety_rule_version,
        sourceRuleVersion: row.safety_source_rule_version,
        requestHash: row.request_signature_sha256,
        classification: row.safety_classification,
        action: row.safety_action,
      },
    },
  };
}

test("Migration 018 is ordered, checksummed, replayable, and non-backfilled", { skip }, async (t) => {
  const predecessor = execFileSync(
    "git",
    ["show", "HEAD:migration_017_goals_coach_member_conversation_bindings.sql"],
    { encoding: null }
  );
  assert.equal(
    crypto.createHash("sha256").update(predecessor).digest("hex"),
    REQUIRED_MIGRATION_CHECKSUM
  );
  assert.equal(
    crypto.createHash("sha256").update(predecessor.toString("utf8").replace(/\n/g, "\r\n")).digest("hex"),
    REQUIRED_MIGRATION_CHECKSUM_CRLF
  );
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts["migrate:member-conversation-turn-idempotency"], "node migrate_018.js");
  assert.equal(packageJson.scripts["rollback:member-conversation-turn-idempotency"], "node rollback_018.js");
  assert.doesNotMatch(fs.readFileSync("server.js", "utf8"), /migrate_018|member_conversation_turn_idempotency/);

  const database = await at017(t);
  await owner(database.pool, "legacy", "10000000-0000-4000-8000-000000000180");
  assert.equal((await runMigration({ pool: database.pool })).status, "applied");
  assert.equal((await runMigration({ pool: database.pool })).status, "already_applied");
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_idempotency"
  )).rows[0].count, 0);
});

test("Migration 018 accepts the exact CRLF predecessor and keeps replay and rollback checkout-independent", { skip }, async (t) => {
  const database = await at017(t);
  await database.pool.query(
    "UPDATE app_schema_migrations SET checksum=$1 WHERE version='017_goals_coach_member_conversation_bindings'",
    [REQUIRED_MIGRATION_CHECKSUM_CRLF]
  );
  const workingSql = fs.readFileSync(MIGRATION_FILE, "utf8");
  const lfSql = workingSql.replace(/\r\n/g, "\n");
  const crlfSql = lfSql.replace(/\n/g, "\r\n");

  const applied = await withMigration018Sql(crlfSql, () => runMigration({ pool: database.pool }));
  assert.equal(applied.status, "applied");
  assert.equal(applied.checksum, checksum(lfSql));
  assert.equal((await database.pool.query(
    "SELECT checksum FROM app_schema_migrations WHERE version=$1",
    [MIGRATION_VERSION]
  )).rows[0].checksum, checksum(lfSql));

  const replay = await withMigration018Sql(lfSql, () => runMigration({ pool: database.pool }));
  assert.equal(replay.status, "already_applied");
  assert.equal(replay.checksum, checksum(lfSql));
  assert.equal((await withMigration018Sql(crlfSql, () => runRollback({
    pool: database.pool,
    skipConfirmation: true,
  }))).status, "rolled_back");
});

test("Migration 018 stores only a strict bounded replay response and immutable provenance", { skip }, async (t) => {
  const database = await at017(t);
  await runMigration({ pool: database.pool });
  const owned = await owner(database.pool, "strict", "10000000-0000-4000-8000-000000000181");
  const record = validRecord(owned, "20000000-0000-4000-8000-000000000181");
  const row = (await insertRecord(database.pool, record)).rows[0];
  const response = parseMemberConversationTurnResponse(reconstructResponse(row));
  assert.equal(response.result.safety.requestHash, record.requestSignature);
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= MEMBER_CONVERSATION_TURN_MAXIMUM_BYTES);

  const columns = (await database.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='goals_coach_member_conversation_turn_idempotency'
     ORDER BY ordinal_position`
  )).rows.map((item) => item.column_name);
  assert.deepEqual(columns, [
    "id", "idempotency_key", "conversation_binding_id", "conversation_reference",
    "conversation_version", "conversation_provenance", "request_signature_sha256",
    "contract_version", "safety_rule_version", "safety_source_rule_version",
    "response_state", "response_reason", "safety_classification", "safety_action", "created_at",
  ]);
  assert.equal(columns.some((name) => /text|transcript|payload|token|secret|name|email/i.test(name)), false);
  await assert.rejects(
    database.pool.query(
      "UPDATE goals_coach_member_conversation_turn_idempotency SET response_state=response_state WHERE id=$1",
      [row.id]
    ),
    (error) => error.code === "55000"
  );
  await assert.rejects(
    database.pool.query("DELETE FROM goals_coach_member_conversation_turn_idempotency WHERE id=$1", [row.id]),
    (error) => error.code === "55000"
  );
});

test("Migration 018 rejects key conflicts, cross-binding identity, and expanded response states", { skip }, async (t) => {
  const database = await at017(t);
  await runMigration({ pool: database.pool });
  const first = await owner(database.pool, "first", "10000000-0000-4000-8000-000000000182");
  const second = await owner(database.pool, "second", "10000000-0000-4000-8000-000000000183");
  const key = "20000000-0000-4000-8000-000000000182";
  await insertRecord(database.pool, validRecord(first, key));

  await assert.rejects(
    insertRecord(database.pool, validRecord(second, key, { requestSignature: "b".repeat(64) })),
    (error) => error.code === "23505"
  );
  await assert.rejects(
    insertRecord(database.pool, validRecord(first, "20000000-0000-4000-8000-000000000183", {
      conversationReference: second.binding.conversation_reference,
    })),
    (error) => error.code === "23503"
  );
  await assert.rejects(
    insertRecord(database.pool, validRecord(first, "20000000-0000-0000-0000-000000000183")),
    (error) => error.code === "23514"
  );

  const invalid = [
    { requestSignature: "A".repeat(64) },
    { contractVersion: "future" },
    { safetyRuleVersion: "future" },
    { safetySourceRuleVersion: "future" },
    { conversationVersion: 2 },
    { conversationProvenance: "provider" },
    { responseState: "safe_to_process", responseReason: null },
    { safetyAction: "allow_provider_processing" },
  ];
  let sequence = 190;
  for (const overrides of invalid) {
    const suffix = String(sequence++).padStart(3, "0");
    await assert.rejects(insertRecord(database.pool, validRecord(
      first,
      `20000000-0000-4000-8000-000000000${suffix}`,
      overrides
    )), (error) => error.code === "23514" || error.code === "23503");
  }
});

test("Migration 018 refuses predecessor and ledger checksum mismatches", { skip }, async (t) => {
  const database = await at017(t);
  await database.pool.query(
    "DELETE FROM app_schema_migrations WHERE version='017_goals_coach_member_conversation_bindings'"
  );
  await assert.rejects(
    runMigration({ pool: database.pool }),
    (error) => error instanceof Migration018Error && error.code === "required_migration_mismatch"
  );
  await database.pool.query(
    "INSERT INTO app_schema_migrations(version,checksum) VALUES('017_goals_coach_member_conversation_bindings','tampered')"
  );
  await assert.rejects(
    runMigration({ pool: database.pool }),
    (error) => error instanceof Migration018Error && error.code === "required_migration_mismatch"
  );
  await database.pool.query(
    "UPDATE app_schema_migrations SET checksum=$1 WHERE version='017_goals_coach_member_conversation_bindings'",
    [REQUIRED_MIGRATION_CHECKSUM]
  );
  await database.pool.query(
    "INSERT INTO app_schema_migrations(version,checksum) VALUES($1,'bad')",
    [MIGRATION_VERSION]
  );
  await assert.rejects(runMigration({ pool: database.pool }), (error) => error.code === "checksum_mismatch");
});

test("Migration 018 rollback refuses rows and later migrations", { skip }, async (t) => {
  const database = await at017(t);
  await runMigration({ pool: database.pool });
  await database.pool.query("INSERT INTO app_schema_migrations(version,checksum) VALUES('019_future','test')");
  await assert.rejects(
    runRollback({ pool: database.pool, skipConfirmation: true }),
    (error) => error.code === "later_migration_applied"
  );
  await database.pool.query("DELETE FROM app_schema_migrations WHERE version='019_future'");
  const owned = await owner(database.pool, "rollback-row", "10000000-0000-4000-8000-000000000184");
  await insertRecord(
    database.pool,
    validRecord(owned, "20000000-0000-4000-8000-000000000184")
  );
  await assert.rejects(
    runRollback({ pool: database.pool, skipConfirmation: true }),
    (error) => error.code === "idempotency_rows_exist"
  );
});

test("Migration 018 rollback removes only an unused idempotency foundation", { skip }, async (t) => {
  const database = await at017(t);
  await runMigration({ pool: database.pool });
  assert.equal((await runRollback({ pool: database.pool, skipConfirmation: true })).status, "rolled_back");
  assert.equal((await runRollback({ pool: database.pool, skipConfirmation: true })).status, "not_applied");
  assert.equal((await database.pool.query(
    "SELECT to_regclass('public.goals_coach_member_conversation_turn_idempotency') name"
  )).rows[0].name, null);
  const key = await database.pool.query(
    "SELECT 1 FROM pg_constraint WHERE conname='uq_goals_coach_member_conversation_bindings_exact_identity'"
  );
  assert.equal(key.rowCount, 0);
  assert.notEqual((await database.pool.query(
    "SELECT to_regclass('public.goals_coach_member_conversation_bindings') name"
  )).rows[0].name, null);
});
