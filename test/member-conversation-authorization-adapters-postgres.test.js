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
  createProductionMemberConversationAuthorizationAdapters,
} = require("../src/goals-coach/member-conversation-authorization-adapters");
const {
  createGymMasterMemberConversationTurnStartup,
} = require("../src/goals-coach/gymmaster-member-conversation-turn-startup");
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

function trackedAbortController() {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  return Object.freeze({
    abort() { controller.abort(); },
    counts() { return Object.freeze({ added, removed }); },
    signal: Object.freeze({
      get aborted() { return controller.signal.aborted; },
      addEventListener(type, listener, options) {
        added += 1;
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener) {
        removed += 1;
        controller.signal.removeEventListener(type, listener);
      },
    }),
  });
}

async function withCapturedDeadlineTimer(work) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduled = [];
  const cleared = [];
  global.setTimeout = (callback, milliseconds) => {
    const handle = Object.freeze({ unref() {} });
    scheduled.push(Object.freeze({ handle, milliseconds }));
    queueMicrotask(callback);
    return handle;
  };
  global.clearTimeout = (handle) => { cleared.push(handle); };
  try {
    await work(Object.freeze({ scheduled, cleared }));
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
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
  const controller = trackedAbortController();
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
  assert.deepEqual(controller.counts(), { added: 1, removed: 1 });

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

test("authorization deadlines clamp to the earlier local or outer bound and suppress late results", async () => {
  async function verifyDeadline(localMilliseconds, outerMilliseconds) {
    await withCapturedDeadlineTimer(async ({ scheduled, cleared }) => {
      let settle;
      let outcome = "pending";
      const controller = trackedAbortController();
      const terminalState = createTerminalState();
      const adapters = createMemberConversationAuthorizationAdapters({
        pool: { async connect() { throw new Error("unused"); } },
        membershipVerifier: {
          verifyActiveMember() {
            return new Promise((resolve) => { settle = resolve; });
          },
        },
        monotonicNow: () => 0n,
        timeoutMilliseconds: localMilliseconds,
      });
      const pending = adapters.currentMembership.verify({
        memberId: "1",
        identity: {
          authProvider: "gymmaster",
          authSubject: "gymmaster:1",
          mappingId: "1",
          memberId: "1",
          memberSessionId: "1",
        },
        signal: controller.signal,
        terminalState,
        outerDeadlineNs: deadlineAfter(0n, outerMilliseconds),
      });
      pending.then(() => { outcome = "fulfilled"; }, () => { outcome = "rejected"; });

      await assert.rejects(
        pending,
        (error) => error instanceof MemberConversationAuthorizationError
          && error.code === "operation_terminal"
      );
      assert.deepEqual(scheduled.map(({ milliseconds }) => milliseconds), [
        Math.min(localMilliseconds, outerMilliseconds),
      ]);
      assert.equal(cleared.length, 1);
      assert.equal(cleared[0], scheduled[0].handle);
      assert.equal(terminalState.reason(), "member_conversation_authorization_deadline");
      assert.deepEqual(controller.counts(), { added: 1, removed: 1 });
      assert.equal(outcome, "rejected");

      settle({ active: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(outcome, "rejected");
      assert.equal(terminalState.isTerminal(), true);
    });
  }

  await verifyDeadline(20, 200);
  await verifyDeadline(200, 5);
});

test("production composition creates no startup work and remains unavailable without downstream authority", () => {
  let connectionCalls = 0;
  let gatekeeperCalls = 0;
  const pool = {
    async connect() {
      connectionCalls += 1;
      throw new Error("must not connect during composition");
    },
  };
  const adapters = createProductionMemberConversationAuthorizationAdapters({
    pool,
    fetchImpl: async () => {
      gatekeeperCalls += 1;
      throw new Error("must not call Gatekeeper during composition");
    },
    environment: {
      GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL:
        "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
      GYMMASTER_API_KEY: "synthetic-server-side-key",
      GYMMASTER_SITE: "synthetic-site",
    },
  });
  assert.equal(validCurrentMembership(adapters.currentMembership), true);
  assert.equal(validCurrentConsent(adapters.currentConsent), true);
  assert.equal(validCurrentSafetyEligibility(adapters.currentSafetyEligibility), true);
  assert.equal(validMemberConversationTurnOwnership(adapters.conversationOwnership), true);
  assert.equal(connectionCalls, 0);
  assert.equal(gatekeeperCalls, 0);

  const startup = createGymMasterMemberConversationTurnStartup({
    db: pool,
    environment: {
      GOALS_COACH_MEMBER_CONVERSATION_TURN_ENABLED: "true",
      GOALS_COACH_MEMBER_LOGIN_ORIGIN: "https://coach.example",
      GOALS_COACH_MEMBER_TWO_HOUR_SESSION_ENABLED: "true",
    },
    ...adapters,
    idempotency: null,
    provider: null,
    safetyClassifier: null,
  });
  assert.equal(startup.status, "not_ready");
  assert.equal(startup.router, null);
  assert.equal(startup.activationPermitted, false);
  assert.equal(startup.externalCallsPermitted, false);
  assert.equal(connectionCalls, 0);
  assert.equal(gatekeeperCalls, 0);
});

test("production authorization composition fails closed for incomplete existing boundaries", () => {
  const valid = {
    pool: { async connect() { throw new Error("must not connect"); } },
    fetchImpl: async () => { throw new Error("must not fetch"); },
    environment: {
      GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL:
        "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members",
      GYMMASTER_API_KEY: "synthetic-server-side-key",
      GYMMASTER_SITE: "synthetic-site",
    },
  };
  for (const options of [
    {},
    { ...valid, pool: null },
    { ...valid, fetchImpl: null },
    { ...valid, environment: { ...valid.environment, GYMMASTER_API_KEY: "" } },
    { ...valid, environment: { ...valid.environment, GYMMASTER_SITE: "" } },
    { ...valid, environment: {
      ...valid.environment,
      GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL: "http://example.test/members",
    } },
  ]) {
    assert.deepEqual(createProductionMemberConversationAuthorizationAdapters(options), {
      conversationOwnership: null,
      currentConsent: null,
      currentMembership: null,
      currentSafetyEligibility: null,
    });
  }
});

test("server passes the fail-closed production authorization bundle into dormant turn startup", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(server, /createProductionMemberConversationAuthorizationAdapters\(\{[\s\S]*?pool:\s*db[\s\S]*?fetchImpl:\s*fetch[\s\S]*?\}\)/);
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?conversationOwnership:\s*memberConversationAuthorization\.conversationOwnership[\s\S]*?\}\)/);
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?currentMembership:\s*memberConversationAuthorization\.currentMembership[\s\S]*?\}\)/);
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?currentConsent:\s*memberConversationAuthorization\.currentConsent[\s\S]*?\}\)/);
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?currentSafetyEligibility:\s*memberConversationAuthorization\.currentSafetyEligibility[\s\S]*?\}\)/);
  assert.match(server, /createGymMasterMemberConversationTurnStartup\(\{[\s\S]*?idempotency:\s*null[\s\S]*?provider:\s*null[\s\S]*?safetyClassifier:\s*null[\s\S]*?\}\)/);
});
