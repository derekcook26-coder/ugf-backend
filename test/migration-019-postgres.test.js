"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const { seedMemberAndPlan } = require("./helpers/disposable-db");

const migrations = [
  "005", "006", "007", "008", "009", "010", "011",
  "012", "013", "014", "015", "016", "017", "018",
].map((number) => require(`../migrate_${number}`).runMigration);
const {
  checksum,
  MIGRATION_FILE,
  MIGRATION_VERSION,
  Migration019Error,
  REQUIRED_MIGRATION_CHECKSUM,
  runMigration,
} = require("../migrate_019");
const { runRollback } = require("../rollback_019");

const skip = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires unprivileged PostgreSQL 16"
  : false;

async function withTrackedMigrationBytes(work) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readExactTrackedMigration(file, options) {
    const name = path.basename(String(file));
    if (/^migration_0(?:0[5-9]|1[0-8])_[a-z0-9_]+\.sql$/.test(name)) {
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

async function at018(t) {
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

function reservationRecord(owned, key, overrides = {}) {
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
    ...overrides,
  };
}

async function insertReservation(pool, record) {
  return (await pool.query(
    `INSERT INTO goals_coach_member_conversation_turn_reservations
       (idempotency_key,conversation_binding_id,conversation_reference,conversation_version,
        conversation_provenance,request_signature_sha256,contract_version,safety_rule_version,
        safety_source_rule_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
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
    ]
  )).rows[0];
}

async function insertEvent(pool, reservationId, eventType, values = {}) {
  return (await pool.query(
    `INSERT INTO goals_coach_member_conversation_turn_dispatch_events
       (reservation_id,event_type,attempt_id,lease_expires_at,reconciliation_not_before,
        provider_contract_version,client_request_id,provider_request_id,provider_response_id,
        response_digest_sha256,terminal_category)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      reservationId,
      eventType,
      values.attemptId || null,
      values.leaseExpiresAt || null,
      values.reconciliationNotBefore || null,
      values.providerContractVersion || null,
      values.clientRequestId || null,
      values.providerRequestId || null,
      values.providerResponseId || null,
      values.responseDigest || null,
      values.terminalCategory || null,
    ]
  )).rows[0];
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
  assert.fail("event insert did not reach the reservation advisory lock");
}

async function lockReservation(client, reservationId) {
  await client.query("BEGIN");
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('goals_coach_member_conversation_turn_dispatch:' || $1::text, 0)
     )`,
    [reservationId]
  );
}

async function insertFinal(pool, reservation, responseState = "blocked") {
  const tuples = responseState === "safe_to_process"
    ? ["safe_to_process", null, "clear", "allow_provider_processing"]
    : responseState === "unavailable"
      ? ["unavailable", "provider_unavailable", "unavailable", "unavailable"]
      : ["blocked", "safety_stop", "pain_or_instability", "stop"];
  await pool.query(
    `INSERT INTO goals_coach_member_conversation_turn_idempotency
       (idempotency_key,conversation_binding_id,conversation_reference,conversation_version,
        conversation_provenance,request_signature_sha256,contract_version,safety_rule_version,
        safety_source_rule_version,response_state,response_reason,safety_classification,safety_action)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      reservation.idempotency_key,
      reservation.conversation_binding_id,
      reservation.conversation_reference,
      reservation.conversation_version,
      reservation.conversation_provenance,
      reservation.request_signature_sha256,
      reservation.contract_version,
      reservation.safety_rule_version,
      reservation.safety_source_rule_version,
      ...tuples,
    ]
  );
}

test("Migration 019 is ordered, canonical-checksummed, replayable, and non-backfilled", { skip }, async (t) => {
  const predecessor = execFileSync(
    "git",
    ["show", "HEAD:migration_018_goals_coach_member_conversation_turn_idempotency.sql"],
    { encoding: "utf8" }
  );
  assert.equal(checksum(predecessor), REQUIRED_MIGRATION_CHECKSUM);
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts["migrate:member-conversation-provider-dispatch"], "node migrate_019.js");
  assert.equal(packageJson.scripts["rollback:member-conversation-provider-dispatch"], "node rollback_019.js");
  assert.doesNotMatch(fs.readFileSync("server.js", "utf8"), /migrate_019|turn_reservations|dispatch_events/);

  const database = await at018(t);
  await owner(database.pool, "legacy019", "10000000-0000-4000-8000-000000000190");
  assert.equal((await runMigration({ pool: database.pool })).status, "applied");
  assert.equal((await runMigration({ pool: database.pool })).status, "already_applied");
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_reservations"
  )).rows[0].count, 0);
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events"
  )).rows[0].count, 0);
});

test("Migration 019 reservations bind exact key, signature, and conversation identity immutably", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });
  const first = await owner(database.pool, "reservation-first", "10000000-0000-4000-8000-000000000191");
  const second = await owner(database.pool, "reservation-second", "10000000-0000-4000-8000-000000000192");
  const key = "20000000-0000-4000-8000-000000000191";
  const reservation = await insertReservation(database.pool, reservationRecord(first, key));

  await assert.rejects(
    insertReservation(database.pool, reservationRecord(second, key, { requestSignature: "b".repeat(64) })),
    (error) => error.code === "23505"
  );
  await assert.rejects(
    insertReservation(database.pool, reservationRecord(first, "20000000-0000-4000-8000-000000000192", {
      conversationReference: second.binding.conversation_reference,
    })),
    (error) => error.code === "23503"
  );
  await assert.rejects(
    database.pool.query("UPDATE goals_coach_member_conversation_turn_reservations SET contract_version=contract_version WHERE id=$1", [reservation.id]),
    (error) => error.code === "55000"
  );
  await assert.rejects(
    database.pool.query("DELETE FROM goals_coach_member_conversation_turn_reservations WHERE id=$1", [reservation.id]),
    (error) => error.code === "55000"
  );

  const columns = (await database.pool.query(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name IN (
       'goals_coach_member_conversation_turn_reservations',
       'goals_coach_member_conversation_turn_dispatch_events'
     ) ORDER BY table_name,ordinal_position`
  )).rows;
  assert.equal(columns.some(({ column_name: name }) => /member_text|transcript|prompt|payload|token|secret|email|name/i.test(name)), false);
});

test("Migration 019 commits a no-redispatch barrier and terminal provider rejection", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });
  const owned = await owner(database.pool, "rejection", "10000000-0000-4000-8000-000000000193");
  const reservation = await insertReservation(database.pool, reservationRecord(
    owned,
    "20000000-0000-4000-8000-000000000193"
  ));
  const attempt = "30000000-0000-4000-8000-000000000193";
  await insertEvent(database.pool, reservation.id, "reserved");
  await insertEvent(database.pool, reservation.id, "lease_acquired", {
    attemptId: attempt,
    leaseExpiresAt: new Date(Date.now() + 30_000),
  });
  await insertEvent(database.pool, reservation.id, "dispatch_started", {
    attemptId: attempt,
    reconciliationNotBefore: new Date(Date.now() + 30_000),
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
  });
  await assert.rejects(
    insertEvent(database.pool, reservation.id, "lease_acquired", {
      attemptId: "30000000-0000-4000-8000-000000000194",
      leaseExpiresAt: new Date(Date.now() + 30_000),
    }),
    (error) => error.code === "23514"
  );
  const rejected = await insertEvent(database.pool, reservation.id, "provider_rejected", {
    attemptId: attempt,
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
    providerRequestId: "request-019-rejected",
    terminalCategory: "request_rejected",
  });
  assert.equal(rejected.event_type, "provider_rejected");
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_idempotency WHERE idempotency_key=$1",
    [reservation.idempotency_key]
  )).rows[0].count, 0);
  await assert.rejects(insertFinal(database.pool, reservation, "unavailable"), (error) => error.code === "23514");
  await assert.rejects(insertEvent(database.pool, reservation.id, "finalized"), (error) => error.code === "23514");
  await assert.rejects(
    database.pool.query("UPDATE goals_coach_member_conversation_turn_dispatch_events SET event_type=event_type WHERE id=$1", [rejected.id]),
    (error) => error.code === "55000"
  );
});

test("Migration 019 finalizes only exact representable deterministic or provider-success rows", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });

  const blockedOwner = await owner(database.pool, "blocked", "10000000-0000-4000-8000-000000000194");
  const blocked = await insertReservation(database.pool, reservationRecord(
    blockedOwner,
    "20000000-0000-4000-8000-000000000194"
  ));
  await insertEvent(database.pool, blocked.id, "reserved");
  await assert.rejects(insertEvent(database.pool, blocked.id, "finalized"), (error) => error.code === "23514");
  await insertFinal(database.pool, blocked, "blocked");
  assert.equal((await insertEvent(database.pool, blocked.id, "finalized")).event_type, "finalized");

  const safeOwner = await owner(database.pool, "safe", "10000000-0000-4000-8000-000000000195");
  const safe = await insertReservation(database.pool, reservationRecord(
    safeOwner,
    "20000000-0000-4000-8000-000000000195"
  ));
  const attempt = "30000000-0000-4000-8000-000000000195";
  await insertEvent(database.pool, safe.id, "reserved");
  await insertEvent(database.pool, safe.id, "lease_acquired", {
    attemptId: attempt,
    leaseExpiresAt: new Date(Date.now() + 30_000),
  });
  await insertEvent(database.pool, safe.id, "dispatch_started", {
    attemptId: attempt,
    reconciliationNotBefore: new Date(Date.now() + 30_000),
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
  });
  await insertEvent(database.pool, safe.id, "provider_succeeded", {
    attemptId: attempt,
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
    providerRequestId: "request-019-success",
    providerResponseId: "response-019-success",
    responseDigest: "c".repeat(64),
    terminalCategory: "success",
  });
  await insertFinal(database.pool, safe, "safe_to_process");
  assert.equal((await insertEvent(database.pool, safe.id, "finalized")).event_type, "finalized");
});

test("Migration 019 serializes concurrent lease acquisition and permits only expired pre-dispatch reclaim", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });
  const owned = await owner(database.pool, "concurrent", "10000000-0000-4000-8000-000000000196");
  const reservation = await insertReservation(database.pool, reservationRecord(
    owned,
    "20000000-0000-4000-8000-000000000196"
  ));
  await insertEvent(database.pool, reservation.id, "reserved");
  const attempts = [
    "30000000-0000-4000-8000-000000000196",
    "30000000-0000-4000-8000-000000000197",
  ];
  const results = await Promise.allSettled(attempts.map((attemptId) => insertEvent(
    database.pool,
    reservation.id,
    "lease_acquired",
    { attemptId, leaseExpiresAt: new Date(Date.now() + 30_000) }
  )));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);

  const expiredOwner = await owner(database.pool, "expired", "10000000-0000-4000-8000-000000000197");
  const expired = await insertReservation(database.pool, reservationRecord(
    expiredOwner,
    "20000000-0000-4000-8000-000000000197"
  ));
  await insertEvent(database.pool, expired.id, "reserved");
  await insertEvent(database.pool, expired.id, "lease_acquired", {
    attemptId: attempts[0],
    leaseExpiresAt: new Date(Date.now() + 20),
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal((await insertEvent(database.pool, expired.id, "lease_acquired", {
    attemptId: attempts[1],
    leaseExpiresAt: new Date(Date.now() + 30_000),
  })).attempt_id, attempts[1]);
});

test("Migration 019 checks lease expiry only after a waiting dispatch obtains serialization authority", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });
  const owned = await owner(database.pool, "wait-expiry", "10000000-0000-4000-8000-000000000200");
  const reservation = await insertReservation(database.pool, reservationRecord(
    owned,
    "20000000-0000-4000-8000-000000000200"
  ));
  const attempt = "30000000-0000-4000-8000-000000000200";
  await insertEvent(database.pool, reservation.id, "reserved");
  await insertEvent(database.pool, reservation.id, "lease_acquired", {
    attemptId: attempt,
    leaseExpiresAt: new Date(Date.now() + 250),
  });

  const locker = await database.pool.connect();
  const waiter = await database.pool.connect();
  try {
    await lockReservation(locker, reservation.id);
    const waiterPid = (await waiter.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const blockedDispatch = insertEvent(waiter, reservation.id, "dispatch_started", {
      attemptId: attempt,
      reconciliationNotBefore: new Date(Date.now() + 30_000),
      providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
      clientRequestId: attempt,
    });
    await waitForAdvisoryWait(database.pool, waiterPid);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await locker.query("COMMIT");
    await assert.rejects(blockedDispatch, (error) => error.code === "23514");
  } finally {
    await locker.query("ROLLBACK").catch(() => {});
    locker.release();
    waiter.release();
  }
  assert.equal((await database.pool.query(
    `SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events
     WHERE reservation_id=$1 AND event_type='dispatch_started'`,
    [reservation.id]
  )).rows[0].count, 0);
});

test("Migration 019 current state follows post-lock sequence despite inverted global IDs", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });
  const owned = await owner(database.pool, "sequence-order", "10000000-0000-4000-8000-000000000201");
  const reservation = await insertReservation(database.pool, reservationRecord(
    owned,
    "20000000-0000-4000-8000-000000000201"
  ));
  const waitingAttempt = "30000000-0000-4000-8000-000000000201";
  const earlierAttempt = "30000000-0000-4000-8000-000000000202";
  await insertEvent(database.pool, reservation.id, "reserved");

  const locker = await database.pool.connect();
  const waiter = await database.pool.connect();
  try {
    await lockReservation(locker, reservation.id);
    const waiterPid = (await waiter.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const waitingLease = insertEvent(waiter, reservation.id, "lease_acquired", {
      attemptId: waitingAttempt,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    await waitForAdvisoryWait(database.pool, waiterPid);
    const earlierLease = await insertEvent(locker, reservation.id, "lease_acquired", {
      attemptId: earlierAttempt,
      leaseExpiresAt: new Date(Date.now() + 250),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await locker.query("COMMIT");
    const laterSerializedLease = await waitingLease;
    assert.ok(laterSerializedLease.id < earlierLease.id);
    assert.ok(laterSerializedLease.event_sequence > earlierLease.event_sequence);
  } finally {
    await locker.query("ROLLBACK").catch(() => {});
    locker.release();
    waiter.release();
  }

  const current = (await database.pool.query(
    `SELECT attempt_id,event_sequence FROM goals_coach_member_conversation_turn_dispatch_events
     WHERE reservation_id=$1 ORDER BY event_sequence DESC LIMIT 1`,
    [reservation.id]
  )).rows[0];
  assert.equal(current.attempt_id, waitingAttempt);
  await insertEvent(database.pool, reservation.id, "dispatch_started", {
    attemptId: waitingAttempt,
    reconciliationNotBefore: new Date(Date.now() + 30_000),
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: waitingAttempt,
  });
  await assert.rejects(insertEvent(database.pool, reservation.id, "dispatch_started", {
    attemptId: earlierAttempt,
    reconciliationNotBefore: new Date(Date.now() + 30_000),
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: earlierAttempt,
  }), (error) => error.code === "23514");
  assert.equal((await database.pool.query(
    `SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events
     WHERE reservation_id=$1 AND event_type='dispatch_started'`,
    [reservation.id]
  )).rows[0].count, 1);
});

test("Migration 019 terminal state cannot be hidden by a preallocated provider-result ID", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });
  const owned = await owner(database.pool, "terminal-order", "10000000-0000-4000-8000-000000000202");
  const reservation = await insertReservation(database.pool, reservationRecord(
    owned,
    "20000000-0000-4000-8000-000000000202"
  ));
  const attempt = "30000000-0000-4000-8000-000000000203";
  await insertEvent(database.pool, reservation.id, "reserved");
  await insertEvent(database.pool, reservation.id, "lease_acquired", {
    attemptId: attempt,
    leaseExpiresAt: new Date(Date.now() + 30_000),
  });
  await insertEvent(database.pool, reservation.id, "dispatch_started", {
    attemptId: attempt,
    reconciliationNotBefore: new Date(Date.now() + 30_000),
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
  });

  const locker = await database.pool.connect();
  const waiter = await database.pool.connect();
  try {
    await lockReservation(locker, reservation.id);
    const waiterPid = (await waiter.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const waitingSuccess = insertEvent(waiter, reservation.id, "provider_succeeded", {
      attemptId: attempt,
      providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
      clientRequestId: attempt,
      providerRequestId: "preallocated-request",
      providerResponseId: "preallocated-response",
      responseDigest: "e".repeat(64),
      terminalCategory: "success",
    });
    await waitForAdvisoryWait(database.pool, waiterPid);
    const rejected = await insertEvent(locker, reservation.id, "provider_rejected", {
      attemptId: attempt,
      providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
      clientRequestId: attempt,
      providerRequestId: "terminal-request",
      terminalCategory: "request_rejected",
    });
    await locker.query("COMMIT");
    await assert.rejects(waitingSuccess, (error) => error.code === "23514");
    const current = (await database.pool.query(
      `SELECT id,event_sequence,event_type FROM goals_coach_member_conversation_turn_dispatch_events
       WHERE reservation_id=$1 ORDER BY event_sequence DESC LIMIT 1`,
      [reservation.id]
    )).rows[0];
    assert.equal(current.id, rejected.id);
    assert.equal(current.event_type, "provider_rejected");
  } finally {
    await locker.query("ROLLBACK").catch(() => {});
    locker.release();
    waiter.release();
  }
  await assert.rejects(insertEvent(database.pool, reservation.id, "lease_acquired", {
    attemptId: "30000000-0000-4000-8000-000000000204",
    leaseExpiresAt: new Date(Date.now() + 30_000),
  }), (error) => error.code === "23514");
});

test("Migration 019 permits bounded indeterminate transition and rejects late dispatch authority", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });
  const owned = await owner(database.pool, "indeterminate", "10000000-0000-4000-8000-000000000198");
  const reservation = await insertReservation(database.pool, reservationRecord(
    owned,
    "20000000-0000-4000-8000-000000000198"
  ));
  const attempt = "30000000-0000-4000-8000-000000000198";
  await insertEvent(database.pool, reservation.id, "reserved");
  await insertEvent(database.pool, reservation.id, "lease_acquired", {
    attemptId: attempt,
    leaseExpiresAt: new Date(Date.now() + 30_000),
  });
  await insertEvent(database.pool, reservation.id, "dispatch_started", {
    attemptId: attempt,
    reconciliationNotBefore: new Date(Date.now() + 20),
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
  });
  await assert.rejects(insertEvent(database.pool, reservation.id, "indeterminate", {
    attemptId: attempt,
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
    terminalCategory: "provider_contact_indeterminate",
  }), (error) => error.code === "23514");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal((await insertEvent(database.pool, reservation.id, "indeterminate", {
    attemptId: attempt,
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
    terminalCategory: "provider_contact_indeterminate",
  })).event_type, "indeterminate");
  await assert.rejects(insertEvent(database.pool, reservation.id, "provider_succeeded", {
    attemptId: attempt,
    providerContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-1",
    clientRequestId: attempt,
    providerRequestId: "late-request",
    providerResponseId: "late-response",
    responseDigest: "d".repeat(64),
    terminalCategory: "success",
  }), (error) => error.code === "23514");
});

test("Migration 019 fails closed on predecessor and ledger drift and guards rollback", { skip }, async (t) => {
  const database = await at018(t);
  await database.pool.query(
    "UPDATE app_schema_migrations SET checksum='tampered' WHERE version='018_goals_coach_member_conversation_turn_idempotency'"
  );
  await assert.rejects(runMigration({ pool: database.pool }), (error) => (
    error instanceof Migration019Error && error.code === "required_migration_mismatch"
  ));
  await database.pool.query(
    "UPDATE app_schema_migrations SET checksum=$1 WHERE version='018_goals_coach_member_conversation_turn_idempotency'",
    [REQUIRED_MIGRATION_CHECKSUM]
  );
  await runMigration({ pool: database.pool });
  await database.pool.query("INSERT INTO app_schema_migrations(version,checksum) VALUES('020_future','test')");
  await assert.rejects(
    runRollback({ pool: database.pool, skipConfirmation: true }),
    (error) => error.code === "later_migration_applied"
  );
  await database.pool.query("DELETE FROM app_schema_migrations WHERE version='020_future'");
  const owned = await owner(database.pool, "rollback-row", "10000000-0000-4000-8000-000000000199");
  await insertReservation(database.pool, reservationRecord(
    owned,
    "20000000-0000-4000-8000-000000000199"
  ));
  await assert.rejects(
    runRollback({ pool: database.pool, skipConfirmation: true }),
    (error) => error.code === "provider_dispatch_rows_exist"
  );
});

test("Migration 019 rollback removes only an unused foundation", { skip }, async (t) => {
  const database = await at018(t);
  await runMigration({ pool: database.pool });
  assert.equal((await runRollback({ pool: database.pool, skipConfirmation: true })).status, "rolled_back");
  assert.equal((await runRollback({ pool: database.pool, skipConfirmation: true })).status, "not_applied");
  assert.equal((await database.pool.query(
    "SELECT to_regclass('public.goals_coach_member_conversation_turn_reservations') name"
  )).rows[0].name, null);
  assert.equal((await database.pool.query(
    "SELECT to_regclass('public.goals_coach_member_conversation_turn_dispatch_events') name"
  )).rows[0].name, null);
  assert.notEqual((await database.pool.query(
    "SELECT to_regclass('public.goals_coach_member_conversation_turn_idempotency') name"
  )).rows[0].name, null);
});
