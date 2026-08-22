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
  MemberConversationBindingError,
  createMemberConversationBindingService,
} = require("../src/goals-coach/member-conversation-binding-service");
const { validMemberConversationTurnOwnership } = require("../src/goals-coach/member-conversation-turn-ownership");
const { createRealDisposablePostgres } = require("./helpers/real-postgres");
const { seedMemberAndPlan } = require("./helpers/disposable-db");

const migrations = ["005", "006", "007", "008", "009", "010", "011", "012", "013", "014", "015", "016"]
  .map((number) => require(`../migrate_${number}`).runMigration);
const { runMigration: runMigration017 } = require("../migrate_017");
const skip = typeof process.getuid === "function" && process.getuid() === 0
  ? "requires unprivileged PostgreSQL 16" : false;

async function withTrackedMigrationBytes(work) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readExactTrackedMigration(file, options) {
    const name = path.basename(String(file));
    if (/^migration_0(?:0[5-9]|1[0-6])_[a-z0-9_]+\.sql$/.test(name)) {
      const bytes = execFileSync("git", ["show", `HEAD:${name}`], {
        cwd: path.resolve(__dirname, ".."), encoding: null,
      });
      return options === "utf8" || options?.encoding === "utf8" ? bytes.toString("utf8") : bytes;
    }
    return originalReadFileSync.apply(fs, arguments);
  };
  try { return await work(); } finally { fs.readFileSync = originalReadFileSync; }
}

async function databaseAt017(t) {
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
  await runMigration017({ pool: database.pool });
  assert.match((await database.pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
  return database;
}

async function owner(pool, suffix, options = {}) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const mapping = (await pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
       (member_id, auth_provider, auth_subject, verified_email_snapshot,
        active, provisioning_method, provisioning_reference)
     VALUES ($1, 'gymmaster', $2, $3, $4, 'administrative', $5)
     RETURNING *`,
    [seeded.member.id, `gymmaster:${suffix}`, `${suffix}@example.test`, options.mappingActive !== false, `test:${suffix}`]
  )).rows[0];
  const issuedOffset = options.expired === true ? "-3 hours" : "0 seconds";
  const session = (await pool.query(
    `INSERT INTO goals_coach_member_sessions
       (token_hash, auth_mapping_id, member_id, issued_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, NOW() + $4::interval,
             NOW() + $4::interval + INTERVAL '7200 seconds',
             CASE WHEN $5::boolean THEN NOW() ELSE NULL END)
     RETURNING *`,
    [crypto.createHash("sha256").update(`binding-session-${suffix}`).digest("hex"),
      mapping.id, seeded.member.id, issuedOffset, options.revoked === true]
  )).rows[0];
  const conversation = (await pool.query(
    `INSERT INTO coaching_conversations(member_id, plan_id, status, archived_at)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'active' THEN NULL ELSE NOW() END)
     RETURNING *`,
    [seeded.member.id, seeded.plan.id, options.conversationStatus || "active"]
  )).rows[0];
  return { ...seeded, mapping, session, conversation };
}

function createInput(value) {
  return {
    authMappingId: String(value.mapping.id),
    coachingConversationId: String(value.conversation.id),
    memberId: String(value.member.id),
    memberSessionId: String(value.session.id),
  };
}

function ownershipInput(value, conversation) {
  return {
    authMappingId: String(value.mapping.id),
    conversation,
    memberId: String(value.member.id),
    memberSessionId: String(value.session.id),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("binding creation generates a server UUID and never accepts a client reference", { skip }, async (t) => {
  const database = await databaseAt017(t);
  const first = await owner(database.pool, "create");
  let generated = 0;
  const service = createMemberConversationBindingService({
    pool: database.pool,
    randomUUID() { generated += 1; return "00000000-0000-4000-8000-000000000201"; },
  });
  const result = await service.createBinding(createInput(first));
  assert.deepEqual(result, { conversation: {
    provenance: "member_session", reference: "00000000-0000-4000-8000-000000000201", version: 1,
  } });
  assert.equal(generated, 1);
  await assert.rejects(
    service.createBinding({ ...createInput(first), conversationReference: "00000000-0000-4000-8000-000000000299" }),
    (error) => error instanceof MemberConversationBindingError && error.code === "invalid_create_input"
  );
  const row = (await database.pool.query("SELECT * FROM goals_coach_member_conversation_bindings")).rows[0];
  assert.equal(row.conversation_reference, result.conversation.reference);
  assert.equal(String(row.member_id), String(first.member.id));
  assert.equal(String(row.auth_mapping_id), String(first.mapping.id));
  assert.equal(String(row.member_session_id), String(first.session.id));
});

test("concurrent exact creates return one stable binding and conflicting sessions fail closed", { skip }, async (t) => {
  const database = await databaseAt017(t);
  const first = await owner(database.pool, "concurrent");
  let next = 210;
  const service = createMemberConversationBindingService({
    pool: database.pool,
    randomUUID() { return `00000000-0000-4000-8000-000000000${next++}`; },
  });
  const [left, right] = await Promise.all([
    service.createBinding(createInput(first)),
    service.createBinding(createInput(first)),
  ]);
  assert.deepEqual(left, right);
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_bindings WHERE coaching_conversation_id=$1",
    [first.conversation.id]
  )).rows[0].count, 1);
  const replacementSession = (await database.pool.query(
    `INSERT INTO goals_coach_member_sessions(token_hash, auth_mapping_id, member_id, issued_at, expires_at)
     VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '7200 seconds') RETURNING *`,
    [crypto.createHash("sha256").update("replacement-session").digest("hex"), first.mapping.id, first.member.id]
  )).rows[0];
  await assert.rejects(service.createBinding({
    ...createInput(first), memberSessionId: String(replacementSession.id),
  }), (error) => error instanceof MemberConversationBindingError && error.code === "binding_conflict");
});

test("creation rejects cross-member and inactive conversation, mapping, or durable session state", { skip }, async (t) => {
  const database = await databaseAt017(t);
  const active = await owner(database.pool, "active");
  const other = await owner(database.pool, "other");
  const archived = await owner(database.pool, "archived", { conversationStatus: "archived" });
  const inactive = await owner(database.pool, "inactive", { mappingActive: false });
  const revoked = await owner(database.pool, "revoked", { revoked: true });
  const expired = await owner(database.pool, "expired", { expired: true });
  const service = createMemberConversationBindingService({ pool: database.pool });
  const inputs = [
    { ...createInput(active), memberId: String(other.member.id) },
    createInput(archived), createInput(inactive), createInput(revoked), createInput(expired),
  ];
  for (const input of inputs) {
    await assert.rejects(service.createBinding(input),
      (error) => error instanceof MemberConversationBindingError
        && error.code === "binding_prerequisite_unavailable");
  }
  assert.equal((await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_bindings"
  )).rows[0].count, 0);
});

test("ownership is exact, read-only, concealed, and revoked synchronously with current state", { skip }, async (t) => {
  const database = await databaseAt017(t);
  const first = await owner(database.pool, "lookup");
  const other = await owner(database.pool, "lookup-other");
  const service = createMemberConversationBindingService({ pool: database.pool });
  assert.equal(validMemberConversationTurnOwnership(service.ownership), true);
  const binding = await service.createBinding(createInput(first));
  assert.deepEqual(await service.ownership.authorize(ownershipInput(first, binding.conversation)), { owned: true });
  assert.equal(await service.ownership.authorize(ownershipInput(other, binding.conversation)), null);
  assert.equal(await service.ownership.authorize({
    ...ownershipInput(first, binding.conversation),
    conversation: { ...binding.conversation, reference: "00000000-0000-4000-8000-000000000299" },
  }), null);
  assert.equal(await service.ownership.authorize({
    ...ownershipInput(first, binding.conversation),
    conversation: { ...binding.conversation, version: 2 },
  }), null);
  await database.pool.query("UPDATE goals_coach_member_sessions SET revoked_at=NOW() WHERE id=$1", [first.session.id]);
  assert.equal(await service.ownership.authorize(ownershipInput(first, binding.conversation)), null);
  const count = (await database.pool.query(
    "SELECT COUNT(*)::int count FROM goals_coach_member_conversation_bindings"
  )).rows[0].count;
  assert.equal(count, 1);
});

test("abort and deadline during checkout revoke authority and drain late clients", async () => {
  for (const mode of ["abort", "deadline"]) {
    const checkout = deferred();
    let releases = 0;
    let queries = 0;
    const client = { query() { queries += 1; }, release() { releases += 1; } };
    const pool = { connect() { return checkout.promise; } };
    const service = createMemberConversationBindingService({ pool, timeoutMilliseconds: 100 });
    const controller = new AbortController();
    const terminalState = createTerminalState();
    const operation = mode === "abort"
      ? { signal: controller.signal, terminalState, outerDeadlineNs: deadlineAfter(monotonicNow(), 100) }
      : { terminalState, outerDeadlineNs: deadlineAfter(monotonicNow(), 5) };
    const pending = service.createBinding({
      authMappingId: "1", coachingConversationId: "1", memberId: "1", memberSessionId: "1",
    }, operation);
    const deadlineGuard = mode === "deadline" ? setTimeout(() => {}, 50) : null;
    if (mode === "abort") controller.abort();
    await assert.rejects(pending, (error) => error instanceof MemberConversationBindingError);
    if (deadlineGuard) clearTimeout(deadlineGuard);
    checkout.resolve(client);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queries, 0);
    assert.equal(releases, 1);
  }
});

test("abort and deadline during the prerequisite read prevent every late insert", async () => {
  for (const mode of ["abort", "deadline"]) {
    const queryStarted = deferred();
    const lateQuery = deferred();
    const statements = [];
    let releases = 0;
    const client = {
      query(sql) {
        statements.push(sql);
        if (sql.includes("SELECT conversation.id")) {
          queryStarted.resolve();
          return lateQuery.promise;
        }
        return Promise.resolve({ rows: [] });
      },
      release() { releases += 1; },
    };
    const service = createMemberConversationBindingService({
      pool: { async connect() { return client; } }, timeoutMilliseconds: 100,
    });
    const controller = new AbortController();
    const terminalState = createTerminalState();
    const pending = service.createBinding({
      authMappingId: "1", coachingConversationId: "1", memberId: "1", memberSessionId: "1",
    }, mode === "abort"
      ? { signal: controller.signal, terminalState, outerDeadlineNs: deadlineAfter(monotonicNow(), 100) }
      : { terminalState, outerDeadlineNs: deadlineAfter(monotonicNow(), 5) });
    await queryStarted.promise;
    if (mode === "abort") controller.abort();
    else await new Promise((resolve) => setTimeout(resolve, 10));
    lateQuery.resolve({ rows: [{ id: 1 }] });
    await assert.rejects(pending, (error) => error instanceof MemberConversationBindingError);
    assert.equal(statements.some((sql) => sql.includes("INSERT INTO goals_coach_member_conversation_bindings")), false);
    assert.equal(terminalState.isTerminal(), true);
    assert.equal(releases, 1);
  }
});

test("the service remains absent from production startup and Migration 017 is test-only here", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.doesNotMatch(server, /member-conversation-binding-service|createMemberConversationBindingService/);
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?conversationOwnership:\s*null[\s\S]*?\}\)/);
});
