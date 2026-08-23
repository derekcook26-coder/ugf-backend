"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  createTerminalState,
  deadlineAfter,
  monotonicNow,
} = require("../src/goals-coach/bounded-postgres-transaction");
const {
  createMemberConversationProviderDispatchAuthorization,
  MemberConversationProviderDispatchError,
  createMemberConversationProviderDispatchService,
} = require("../src/goals-coach/member-conversation-provider-dispatch-service");
const {
  createMemberConversationAuthorizationAdapters,
} = require("../src/goals-coach/member-conversation-authorization-adapters");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const { seedMemberAndPlan } = require("./helpers/disposable-db");

const migrations = Array.from({ length: 14 }, (_, index) => String(index + 5).padStart(3, "0"))
  .map((number) => require(`../migrate_${number}`).runMigration);
const { runMigration: runMigration019 } = require("../migrate_019");
const skip = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires unprivileged PostgreSQL 16" : false;

async function withTrackedMigrationBytes(work) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readExactTrackedMigration(file, options) {
    const name = path.basename(String(file));
    if (/^migration_0(?:0[5-9]|1[0-8])_[a-z0-9_]+\.sql$/.test(name)) {
      const bytes = execFileSync("git", ["show", `HEAD:${name}`], {
        cwd: path.resolve(__dirname, ".."), encoding: null,
      });
      return options === "utf8" || options?.encoding === "utf8"
        ? bytes.toString("utf8") : bytes;
    }
    return originalReadFileSync.apply(fs, arguments);
  };
  try { return await work(); } finally { fs.readFileSync = originalReadFileSync; }
}

async function databaseAt019(t) {
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
  await runMigration019({ pool: database.pool });
  assert.match((await database.pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
  return database;
}

async function owner(pool, suffix, reference, options = {}) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const mapping = (await pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
       (member_id,auth_provider,auth_subject,verified_email_snapshot,active,
        provisioning_method,provisioning_reference)
     VALUES($1,'gymmaster',$2,$3,TRUE,'administrative',$4) RETURNING *`,
    [seeded.member.id, `gymmaster:${suffix}`, `${suffix}@example.test`, `test:${suffix}`]
  )).rows[0];
  const session = (await pool.query(
    `INSERT INTO goals_coach_member_sessions
       (token_hash,auth_mapping_id,member_id,issued_at,expires_at)
     VALUES($1,$2,$3,NOW(),NOW()+INTERVAL '7200 seconds') RETURNING *`,
    [crypto.createHash("sha256").update(`dispatch-session-${suffix}`).digest("hex"),
      mapping.id, seeded.member.id]
  )).rows[0];
  const conversation = (await pool.query(
    `INSERT INTO coaching_conversations(member_id,plan_id,status)
     VALUES($1,$2,'active') RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  const binding = (await pool.query(
    `INSERT INTO goals_coach_member_conversation_bindings
       (conversation_reference,conversation_version,provenance,
        coaching_conversation_id,member_id,auth_mapping_id,member_session_id)
     VALUES($1,1,'member_session',$2,$3,$4,$5) RETURNING *`,
    [reference, conversation.id, seeded.member.id, mapping.id, session.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO goals_coach_member_coaching_consents
       (member_id,auth_mapping_id,notice_version,status,accepted_at,updated_at)
     VALUES($1,$2,'GC-MEMBER-COACHING-CONSENT-1','accepted',NOW(),NOW())`,
    [seeded.member.id, mapping.id]
  );
  await pool.query(
    `INSERT INTO goals_coach_member_safety_intake_v2_assessments
       (auth_mapping_id,member_id,client_request_id,client_request_hash,
        client_request_hash_key_version,notice_version,outcome,rule_version,
        submitted_at,valid_until)
     VALUES($1,$2,$3,$4,'test-key','GC-MEMBER-SAFETY-NOTICE-3',
            'SCREEN_COMPLETE','GC-MEMBER-SAFETY-INTAKE-3',NOW(),NOW()+$5::interval)`,
    [mapping.id, seeded.member.id, crypto.randomUUID(), "f".repeat(64),
      options.safetyValidOffset || "1 hour"]
  );
  return { ...seeded, binding, conversation, mapping, session };
}

function dispatchAuthorization(pool, membershipVerifier = {
  async verifyActiveMember() { return { active: true }; },
}) {
  const adapters = createMemberConversationAuthorizationAdapters({ pool, membershipVerifier });
  return createMemberConversationProviderDispatchAuthorization(adapters);
}

function dispatchService(pool, options = {}) {
  return createMemberConversationProviderDispatchService({
    ...options,
    pool,
    preDispatchAuthorization: options.preDispatchAuthorization
      || dispatchAuthorization(pool, options.membershipVerifier),
  });
}

function reservationInput(value, key, signature = "a".repeat(64)) {
  return {
    contractVersion: "GC-MEMBER-CONVERSATION-TURN-1",
    conversation: {
      provenance: "member_session",
      reference: value.binding.conversation_reference,
      version: 1,
    },
    conversationBindingId: String(value.binding.id),
    idempotencyKey: key,
    requestSignatureSha256: signature,
    safetyRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-1",
    safetySourceRuleVersion: "GC-MEMBER-CONVERSATION-SAFETY-RULES-1",
  };
}

function attemptInput(reservation, attemptId) {
  return { ...reservation, attemptId };
}

test("reservation binds exact key, signature, and conversation and replays one state", { skip }, async (t) => {
  const database = await databaseAt019(t);
  const first = await owner(database.pool, "dispatch-reserve", "10000000-0000-4000-8000-000000000301");
  const second = await owner(database.pool, "dispatch-other", "10000000-0000-4000-8000-000000000302");
  const input = reservationInput(first, "20000000-0000-4000-8000-000000000301");
  const service = dispatchService(database.pool);

  assert.equal(service.providerFree, true);
  assert.equal(service.externalEffectsPermitted, false);
  assert.deepEqual(await service.reserve(input), { eventSequence: 1, state: "reserved" });
  assert.deepEqual(await service.reserve(input), { eventSequence: 1, state: "reserved" });
  assert.deepEqual(await service.read(input), { eventSequence: 1, state: "reserved" });
  assert.equal(await service.read({ ...input, idempotencyKey: "20000000-0000-4000-8000-000000000399" }), null);
  await assert.rejects(
    service.reserve({ ...input, requestSignatureSha256: "b".repeat(64) }),
    (error) => error instanceof MemberConversationProviderDispatchError
      && error.code === "reservation_conflict"
  );
  await assert.rejects(
    service.reserve({
      ...input,
      conversation: { ...input.conversation, reference: second.binding.conversation_reference },
      conversationBindingId: String(second.binding.id),
    }),
    (error) => error instanceof MemberConversationProviderDispatchError
      && error.code === "reservation_conflict"
  );
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_reservations"
  )).rows[0].count, 1);
});

test("concurrent lease acquisition grants one bounded attempt and dispatch starts once", { skip }, async (t) => {
  const database = await databaseAt019(t);
  const owned = await owner(database.pool, "dispatch-concurrent", "10000000-0000-4000-8000-000000000303");
  const input = reservationInput(owned, "20000000-0000-4000-8000-000000000303");
  let next = 303;
  const service = dispatchService(database.pool, {
    randomUUID() { return `30000000-0000-4000-8000-000000000${next++}`; },
  });
  await service.reserve(input);
  const leases = await Promise.allSettled([service.acquireLease(input), service.acquireLease(input)]);
  const winner = leases.find(({ status }) => status === "fulfilled").value;
  assert.equal(leases.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(leases.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(winner.state, "lease_acquired");
  assert.equal(Object.isFrozen(winner), true);

  assert.deepEqual(await service.startDispatch(attemptInput(input, winner.attemptId)), {
    attemptId: winner.attemptId,
    eventSequence: 3,
    state: "dispatch_started",
  });
  await assert.rejects(
    service.acquireLease(input),
    (error) => error instanceof MemberConversationProviderDispatchError
      && error.code === "transition_unavailable"
  );
  assert.equal((await database.pool.query(
    `SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events
     WHERE event_type='dispatch_started'`
  )).rows[0].count, 1);
});

test("post-lease authorization drift cannot commit dispatch authority", { skip }, async (t) => {
  const database = await databaseAt019(t);
  const membership = new Map();
  const membershipVerifier = {
    async verifyActiveMember(memberId) {
      const result = membership.get(String(memberId));
      if (result instanceof Error) throw result;
      return result || { active: true };
    },
  };
  const preDispatchAuthorization = dispatchAuthorization(database.pool, membershipVerifier);
  const scenarios = [
    ["revoked-session", async (value) => database.pool.query(
      "UPDATE goals_coach_member_sessions SET revoked_at=NOW() WHERE id=$1", [value.session.id]
    )],
    ["expired-session", async (value) => database.pool.query(
      `UPDATE goals_coach_member_sessions
          SET issued_at=NOW()-INTERVAL '7201 seconds',expires_at=NOW()-INTERVAL '1 second'
        WHERE id=$1`,
      [value.session.id]
    )],
    ["inactive-mapping", async (value) => database.pool.query(
      "UPDATE goals_coach_member_auth_mappings SET active=FALSE WHERE id=$1", [value.mapping.id]
    )],
    ["withdrawn-consent", async (value) => database.pool.query(
      `UPDATE goals_coach_member_coaching_consents
          SET status='withdrawn',withdrawn_at=NOW(),updated_at=NOW()
        WHERE auth_mapping_id=$1`,
      [value.mapping.id]
    )],
    ["inactive-conversation", async (value) => database.pool.query(
      "UPDATE coaching_conversations SET status='archived',archived_at=NOW() WHERE id=$1",
      [value.conversation.id]
    )],
    ["inactive-membership", async (value) => {
      membership.set(String(value.member.id), { active: false });
    }],
    ["unavailable-membership", async (value) => {
      membership.set(String(value.member.id), new Error("synthetic Gatekeeper unavailable"));
    }],
    ["expired-safety", async () => new Promise((resolve) => setTimeout(resolve, 80))],
  ];
  let sequence = 401;
  for (const [name, invalidate] of scenarios) {
    const suffix = `dispatch-${name}`;
    const digits = String(sequence++).padStart(3, "0");
    const owned = await owner(
      database.pool, suffix, `10000000-0000-4000-8000-000000000${digits}`,
      name === "expired-safety" ? { safetyValidOffset: "50 milliseconds" } : {}
    );
    const input = reservationInput(owned, `20000000-0000-4000-8000-000000000${digits}`);
    const attemptId = `30000000-0000-4000-8000-000000000${digits}`;
    const service = dispatchService(database.pool, {
      preDispatchAuthorization,
      randomUUID() { return attemptId; },
    });
    await service.reserve(input);
    assert.equal((await service.acquireLease(input)).state, "lease_acquired");
    await invalidate(owned);
    await assert.rejects(
      service.startDispatch(attemptInput(input, attemptId)),
      (error) => name === "unavailable-membership"
        ? error instanceof Error
        : error instanceof MemberConversationProviderDispatchError
          && error.code === "authorization_unavailable",
      name
    );
    assert.equal((await database.pool.query(
      `SELECT COUNT(*)::int count
         FROM goals_coach_member_conversation_turn_dispatch_events event
         JOIN goals_coach_member_conversation_turn_reservations reservation
           ON reservation.id=event.reservation_id
        WHERE reservation.idempotency_key=$1::uuid AND event.event_type='dispatch_started'`,
      [input.idempotencyKey]
    )).rows[0].count, 0, name);
    assert.equal((await service.read(input)).state, "lease_acquired", name);
  }
});

test("definite rejection is terminal and no standalone success or final replay authority exists", { skip }, async (t) => {
  const database = await databaseAt019(t);
  const rejectedOwner = await owner(database.pool, "dispatch-rejected", "10000000-0000-4000-8000-000000000304");
  const rejectedInput = reservationInput(rejectedOwner, "20000000-0000-4000-8000-000000000304");
  const attempts = [
    "30000000-0000-4000-8000-000000000304",
    "30000000-0000-4000-8000-000000000305",
    "30000000-0000-4000-8000-000000000306",
  ];
  const service = dispatchService(database.pool, {
    randomUUID() { return attempts.shift(); },
  });
  await service.reserve(rejectedInput);
  const rejectedLease = await service.acquireLease(rejectedInput);
  await service.startDispatch(attemptInput(rejectedInput, rejectedLease.attemptId));
  assert.deepEqual(await service.recordRejection({
    ...attemptInput(rejectedInput, rejectedLease.attemptId),
    providerRequestId: "request-rejected-304",
    terminalCategory: "request_rejected",
  }), {
    attemptId: rejectedLease.attemptId,
    eventSequence: 4,
    state: "provider_rejected",
  });
  await assert.rejects(service.acquireLease(rejectedInput),
    (error) => error.code === "transition_unavailable");

  assert.equal("execute" in service, false);
  assert.equal("operation" in service, false);
  assert.equal("recordSuccess" in service, false);
  assert.equal((await database.pool.query(
    `SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events
     WHERE event_type IN ('provider_succeeded', 'finalized')`
  )).rows[0].count, 0);
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_idempotency"
  )).rows[0].count, 0);
});

test("expired pre-dispatch lease can be reclaimed but committed dispatch cannot", { skip }, async (t) => {
  const database = await databaseAt019(t);
  const owned = await owner(database.pool, "dispatch-expiry", "10000000-0000-4000-8000-000000000306");
  const input = reservationInput(owned, "20000000-0000-4000-8000-000000000306");
  const attempts = [
    "30000000-0000-4000-8000-000000000306",
    "30000000-0000-4000-8000-000000000307",
    "30000000-0000-4000-8000-000000000308",
  ];
  const service = dispatchService(database.pool, {
    leaseMilliseconds: 20,
    randomUUID() { return attempts.shift(); },
  });
  await service.reserve(input);
  await service.acquireLease(input);
  await new Promise((resolve) => setTimeout(resolve, 35));
  const reclaimed = await service.acquireLease(input);
  await service.startDispatch(attemptInput(input, reclaimed.attemptId));
  await new Promise((resolve) => setTimeout(resolve, 35));
  await assert.rejects(service.acquireLease(input),
    (error) => error.code === "transition_unavailable");
  assert.equal((await database.pool.query(
    `SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events
     WHERE event_type='dispatch_started'`
  )).rows[0].count, 1);
});

test("indeterminate transition is bounded and suppresses every late receipt", { skip }, async (t) => {
  const database = await databaseAt019(t);
  const owned = await owner(database.pool, "dispatch-indeterminate", "10000000-0000-4000-8000-000000000309");
  const input = reservationInput(owned, "20000000-0000-4000-8000-000000000309");
  const attemptId = "30000000-0000-4000-8000-000000000309";
  const service = dispatchService(database.pool, {
    randomUUID() { return attemptId; },
    reconciliationMilliseconds: 20,
  });
  await service.reserve(input);
  await service.acquireLease(input);
  await service.startDispatch(attemptInput(input, attemptId));
  await assert.rejects(service.markIndeterminate(attemptInput(input, attemptId)),
    (error) => error.code === "transition_unavailable");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal((await service.markIndeterminate(attemptInput(input, attemptId))).state, "indeterminate");
  assert.equal("recordSuccess" in service, false);
  assert.equal((await database.pool.query(
    `SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_dispatch_events
     WHERE event_type IN ('provider_succeeded', 'finalized')`
  )).rows[0].count, 0);
  assert.equal((await service.read(input)).state, "indeterminate");
});

test("abort and deadline revoke transaction authority, drain late checkout, and clean listeners", { skip }, async (t) => {
  const database = await databaseAt019(t);
  const owned = await owner(database.pool, "dispatch-terminal", "10000000-0000-4000-8000-000000000310");
  const input = reservationInput(owned, "20000000-0000-4000-8000-000000000310");
  let releaseCount = 0;
  let resolveCheckout;
  const delayedPool = {
    connect() {
      return new Promise((resolve) => { resolveCheckout = resolve; });
    },
  };
  const service = dispatchService(delayedPool);
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = {
    addEventListener(...args) {
      added += 1;
      return controller.signal.addEventListener(...args);
    },
    get aborted() { return controller.signal.aborted; },
    removeEventListener(...args) {
      removed += 1;
      return controller.signal.removeEventListener(...args);
    },
  };
  const pending = service.reserve(input, { signal });
  controller.abort();
  const client = await database.pool.connect();
  resolveCheckout({
    query: (...args) => client.query(...args),
    release(error) { releaseCount += 1; client.release(error); },
  });
  await assert.rejects(pending,
    (error) => error instanceof MemberConversationProviderDispatchError
      && ["database_unavailable", "operation_terminal"].includes(error.code));
  assert.equal(releaseCount, 1);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_turn_reservations"
  )).rows[0].count, 0);

  const terminalState = createTerminalState();
  const deadlineService = dispatchService(database.pool);
  await assert.rejects(deadlineService.reserve(input, {
    monotonicNow,
    outerDeadlineNs: deadlineAfter(monotonicNow(), 1) - 2_000_000n,
    terminalState,
  }), (error) => error.code === "operation_terminal" || error.code === "database_unavailable");
});

test("production remains unwired and migrations remain unchanged", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const startup = fs.readFileSync(
    path.resolve(__dirname, "../src/goals-coach/gymmaster-member-conversation-turn-startup.js"),
    "utf8"
  );
  assert.doesNotMatch(server, /member-conversation-provider-dispatch-service/);
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
  assert.doesNotMatch(startup, /member-conversation-provider-dispatch-service/);
  assert.equal(fs.readFileSync(path.resolve(__dirname, "../migration_018_goals_coach_member_conversation_turn_idempotency.sql"), "utf8").length > 0, true);
  assert.equal(fs.readFileSync(path.resolve(__dirname, "../migration_019_goals_coach_member_conversation_provider_dispatch.sql"), "utf8").length > 0, true);
});
