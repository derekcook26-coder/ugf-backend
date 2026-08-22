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
  MemberConversationAuthorizationError,
  createMemberConversationAuthorizationAdapters,
} = require("../src/goals-coach/member-conversation-authorization-adapters");
const {
  validCurrentConsent,
  validCurrentMembership,
  validCurrentSafetyEligibility,
} = require("../src/goals-coach/member-conversation-turn-prerequisites");
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
     VALUES ($1, 'gymmaster', $2, $3, TRUE, 'administrative', $4)
     RETURNING *`,
    [seeded.member.id, `gymmaster:${seeded.member.id}`, `${suffix}@example.test`, `test:${suffix}`]
  )).rows[0];
  const session = (await pool.query(
    `INSERT INTO goals_coach_member_sessions
       (token_hash, auth_mapping_id, member_id, issued_at, expires_at)
     VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '7200 seconds')
     RETURNING *`,
    [crypto.createHash("sha256").update(`authorization-${suffix}`).digest("hex"), mapping.id, seeded.member.id]
  )).rows[0];
  const conversation = (await pool.query(
    `INSERT INTO coaching_conversations(member_id, plan_id, status, archived_at)
     VALUES ($1, $2, 'active', NULL) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  const safetySubmittedOffset = options.expiredSafety === true ? "-2 hours" : "0 seconds";
  const safetyValidOffset = options.expiredSafety === true ? "-1 hour" : "1 hour";
  await pool.query(
    `INSERT INTO goals_coach_member_coaching_consents
       (member_id, auth_mapping_id, notice_version, status, accepted_at, updated_at)
     VALUES ($1, $2, 'GC-MEMBER-COACHING-CONSENT-1', 'accepted', NOW(), NOW())`,
    [seeded.member.id, mapping.id]
  );
  await pool.query(
    `INSERT INTO goals_coach_member_safety_intake_v2_assessments
       (auth_mapping_id, member_id, client_request_id, client_request_hash,
        client_request_hash_key_version, notice_version, outcome, rule_version,
        submitted_at, valid_until)
     VALUES ($1, $2, $3, $4, 'test-key', 'GC-MEMBER-SAFETY-NOTICE-3',
             'SCREEN_COMPLETE', 'GC-MEMBER-SAFETY-INTAKE-3',
             NOW() + $5::interval, NOW() + $6::interval)`,
    [mapping.id, seeded.member.id, crypto.randomUUID(), "a".repeat(64),
      safetySubmittedOffset, safetyValidOffset]
  );
  return { ...seeded, mapping, session, conversation };
}

function identity(value) {
  return Object.freeze({
    authProvider: "gymmaster",
    authSubject: `gymmaster:${value.member.id}`,
    mappingId: String(value.mapping.id),
    memberId: String(value.member.id),
    memberSessionId: String(value.session.id),
  });
}

function membershipInput(value, overrides = {}) {
  return {
    memberId: String(value.member.id), identity: identity(value),
    signal: new AbortController().signal, terminalState: createTerminalState(),
    outerDeadlineNs: deadlineAfter(monotonicNow(), 1000), ...overrides,
  };
}

function databaseInput(value, overrides = {}) {
  return {
    mappingId: String(value.mapping.id), memberId: String(value.member.id),
    signal: new AbortController().signal, terminalState: createTerminalState(),
    outerDeadlineNs: deadlineAfter(monotonicNow(), 1000), ...overrides,
  };
}

function ownershipInput(value, conversation, overrides = {}) {
  return {
    authMappingId: String(value.mapping.id), conversation,
    memberId: String(value.member.id), memberSessionId: String(value.session.id),
    ...overrides,
  };
}

test("authorization bundle composes exact current prerequisites and binding ownership", { skip }, async (t) => {
  const database = await databaseAt017(t);
  const first = await owner(database.pool, "bundle");
  const calls = [];
  const adapters = createMemberConversationAuthorizationAdapters({
    pool: database.pool,
    membershipVerifier: {
      async verifyActiveMember(memberId) { calls.push(memberId); return { active: true }; },
    },
  });
  assert.equal(validCurrentMembership(adapters.currentMembership), true);
  assert.equal(validCurrentConsent(adapters.currentConsent), true);
  assert.equal(validCurrentSafetyEligibility(adapters.currentSafetyEligibility), true);
  assert.equal(validMemberConversationTurnOwnership(adapters.conversationOwnership), true);

  const bindingService = require("../src/goals-coach/member-conversation-binding-service")
    .createMemberConversationBindingService({ pool: database.pool });
  const binding = await bindingService.createBinding({
    authMappingId: String(first.mapping.id),
    coachingConversationId: String(first.conversation.id),
    memberId: String(first.member.id),
    memberSessionId: String(first.session.id),
  });
  assert.deepEqual(await adapters.currentMembership.verify(membershipInput(first)), { active: true });
  assert.deepEqual(await adapters.currentConsent.verify(databaseInput(first)), { accepted: true });
  assert.deepEqual(await adapters.currentSafetyEligibility.verify(databaseInput(first)), { eligible: true });
  assert.deepEqual(await adapters.conversationOwnership.authorize(
    ownershipInput(first, binding.conversation), databaseInput(first)
  ), { owned: true });
  assert.deepEqual(calls, [String(first.member.id)]);
});

test("authorization is concealed for cross-owner and stale consent, safety, mapping, or session state", { skip }, async (t) => {
  const database = await databaseAt017(t);
  const first = await owner(database.pool, "states");
  const other = await owner(database.pool, "states-other");
  const adapters = createMemberConversationAuthorizationAdapters({
    pool: database.pool,
    membershipVerifier: { async verifyActiveMember(memberId) { return { active: memberId === String(first.member.id) }; } },
  });
  const bindingService = require("../src/goals-coach/member-conversation-binding-service")
    .createMemberConversationBindingService({ pool: database.pool });
  const binding = await bindingService.createBinding({
    authMappingId: String(first.mapping.id), coachingConversationId: String(first.conversation.id),
    memberId: String(first.member.id), memberSessionId: String(first.session.id),
  });
  assert.equal(await adapters.currentMembership.verify(membershipInput(other)), null);
  assert.equal(await adapters.currentConsent.verify(databaseInput(first, { mappingId: String(other.mapping.id) })), null);
  assert.equal(await adapters.currentSafetyEligibility.verify(databaseInput(first, { mappingId: String(other.mapping.id) })), null);
  assert.equal(await adapters.conversationOwnership.authorize(
    ownershipInput(first, binding.conversation, { memberSessionId: String(other.session.id) }), databaseInput(first)
  ), null);

  await database.pool.query(
    `UPDATE goals_coach_member_coaching_consents
        SET status='withdrawn', withdrawn_at=NOW(), updated_at=NOW()
      WHERE member_id=$1`, [first.member.id]
  );
  assert.equal(await adapters.currentConsent.verify(databaseInput(first)), null);
  await database.pool.query(
    `INSERT INTO goals_coach_member_safety_intake_v2_assessments
       (auth_mapping_id, member_id, client_request_id, client_request_hash,
        client_request_hash_key_version, notice_version, outcome, rule_version, valid_until)
     VALUES ($1, $2, $3, $4, 'test-key', 'GC-MEMBER-SAFETY-NOTICE-3',
             'MODIFICATION_REQUIRED', 'GC-MEMBER-SAFETY-INTAKE-3', NOW() + INTERVAL '1 hour')`,
    [first.mapping.id, first.member.id, crypto.randomUUID(), "b".repeat(64)]
  );
  assert.equal(await adapters.currentSafetyEligibility.verify(databaseInput(first)), null);
  await database.pool.query("UPDATE goals_coach_member_sessions SET revoked_at=NOW() WHERE id=$1", [first.session.id]);
  assert.equal(await adapters.conversationOwnership.authorize(
    ownershipInput(first, binding.conversation), databaseInput(first)
  ), null);

  const expiredSafety = await owner(database.pool, "states-expired-safety", { expiredSafety: true });
  assert.equal(await adapters.currentSafetyEligibility.verify(databaseInput(expiredSafety)), null);
  await database.pool.query(
    "UPDATE goals_coach_member_auth_mappings SET active=FALSE WHERE id=$1",
    [expiredSafety.mapping.id]
  );
  assert.equal(await adapters.currentConsent.verify(databaseInput(expiredSafety)), null);
});

test("operational failures propagate while abort and deadlines suppress late membership authority", async () => {
  const failed = createMemberConversationAuthorizationAdapters({
    pool: { async connect() { throw new Error("synthetic database detail"); } },
    membershipVerifier: { async verifyActiveMember() { return { active: true }; } },
  });
  await assert.rejects(
    failed.currentConsent.verify({ mappingId: "1", memberId: "1" }),
    (error) => error instanceof MemberConversationAuthorizationError
      && error.code === "database_unavailable"
  );

  const expanded = [];
  expanded.active = true;
  const malformed = createMemberConversationAuthorizationAdapters({
    pool: { async connect() { throw new Error("unused"); } },
    membershipVerifier: { async verifyActiveMember() { return expanded; } },
  });
  assert.equal(await malformed.currentMembership.verify({
    memberId: "1",
    identity: { authProvider: "gymmaster", authSubject: "gymmaster:1", mappingId: "1", memberId: "1", memberSessionId: "1" },
  }), null);

  let settle;
  const waiting = createMemberConversationAuthorizationAdapters({
    pool: { async connect() { throw new Error("unused"); } },
    membershipVerifier: { verifyActiveMember() { return new Promise((resolve) => { settle = resolve; }); } },
    timeoutMilliseconds: 20,
  });
  const controller = new AbortController();
  const terminalState = createTerminalState();
  const input = {
    memberId: "1",
    identity: { authProvider: "gymmaster", authSubject: "gymmaster:1", mappingId: "1", memberId: "1", memberSessionId: "1" },
    signal: controller.signal,
    terminalState,
    outerDeadlineNs: deadlineAfter(monotonicNow(), 100),
  };
  const pending = waiting.currentMembership.verify(input);
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof MemberConversationAuthorizationError);
  settle({ active: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminalState.isTerminal(), true);

  const deadline = waiting.currentMembership.verify({
    ...input,
    signal: new AbortController().signal,
    terminalState: createTerminalState(),
    outerDeadlineNs: deadlineAfter(monotonicNow(), 5),
  });
  const keepAlive = setTimeout(() => {}, 30);
  await assert.rejects(deadline, (error) => error instanceof MemberConversationAuthorizationError);
  clearTimeout(keepAlive);
});

test("the adapter bundle is absent from production composition", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.doesNotMatch(server, /member-conversation-authorization-adapters|createMemberConversationAuthorizationAdapters/);
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?conversationOwnership:\s*null[\s\S]*?\}\)/);
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?currentMembership:\s*null[\s\S]*?\}\)/);
});
