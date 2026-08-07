"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const {
  createStaffAuthenticator,
  createStaffOriginGuard,
} = require("../src/auth/clerk-staff-auth");
const { createStaffAuthorization } = require("../src/auth/staff-authorization");
const {
  createGymMasterMemberAccessAuthorizer,
} = require("../src/goals-coach/gymmaster-gatekeeper-membership");
const {
  createGymMasterMemberAuthorization,
} = require("../src/goals-coach/gymmaster-member-authorization");
const {
  createGymMasterMemberLoginService,
} = require("../src/goals-coach/gymmaster-member-login");
const {
  createGymMasterMemberLoginHandler,
} = require("../src/goals-coach/gymmaster-member-login-route");
const {
  MEMBER_PENDING_ENROLLMENT_FLAG,
  PENDING_ENROLLMENT_TTL_MILLISECONDS,
  createGymMasterMemberPendingEnrollmentService,
  memberPendingEnrollmentEnabled,
  parsePendingEnrollmentRequest,
} = require("../src/goals-coach/gymmaster-member-pending-enrollment");
const {
  createGymMasterMemberPendingEnrollmentStartup,
} = require("../src/goals-coach/gymmaster-member-pending-enrollment-startup");
const {
  createGymMasterMemberSessionService,
} = require("../src/goals-coach/gymmaster-member-session");
const { createGoalsCoachStaffRouter } = require("../src/goals-coach/staff-routes");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const {
  createDisposableDatabase,
  seedStaff,
} = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");
const { runMigration: runSafetyIntakeMigration } = require("../migrate_009");
const { runMigration: runPendingEnrollmentMigration } = require("../migrate_010");

const STAFF_ORIGIN = "https://staff.example.test";
const MEMBER_ORIGIN = "https://ultimategoalsfitness.com";
const SESSION_SECRET = "p".repeat(32);
const noRateLimits = {
  staffRead: (_req, _res, next) => next(),
  staffMutation: (_req, _res, next) => next(),
};

function requestId(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function staffAuthConfiguration() {
  return {
    environment: "production",
    authorizedParties: [STAFF_ORIGIN],
    secretKey: "test-secret-not-a-real-key",
    publishableKey: "pk_test_not_real",
    issuer: "https://clerk.example.test",
  };
}

function signedInState(subject) {
  if (!subject) return { isAuthenticated: false, tokenType: null };
  return {
    isAuthenticated: true,
    tokenType: "session_token",
    toAuth() {
      return {
        userId: subject,
        sessionId: `session_${subject}`,
        sessionClaims: {
          azp: STAFF_ORIGIN,
          iss: "https://clerk.example.test",
          exp: Math.floor(Date.now() / 1000) + 300,
        },
      };
    },
  };
}

function response() {
  return {
    headers: {},
    statusCode: null,
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

function loginRequest(email = " member@example.test ", password = "member-password") {
  return {
    body: { email, password },
    ip: "203.0.113.20",
    get(name) { return name === "Origin" ? MEMBER_ORIGIN : undefined; },
  };
}

async function fixture(t) {
  const disposable = await createDisposableDatabase({
    ownerEditableWorkoutSessions: true,
  });
  t.after(() => disposable.close());
  await runSafetyIntakeMigration({ pool: disposable.pool });
  await runPendingEnrollmentMigration({ pool: disposable.pool });
  const admin = await seedStaff(disposable.pool, "pending-admin", "admin", true);
  const coach = await seedStaff(disposable.pool, "pending-coach", "coach", true);
  const inactive = await seedStaff(disposable.pool, "pending-inactive", "admin", false);
  return { disposable, admin, coach, inactive };
}

async function seedGymMasterMember(pool, gymmasterMemberId) {
  return (await pool.query(
    `INSERT INTO coach_members (gymmaster_member_id, first_name, last_name)
     VALUES ($1, 'Pending', 'Member')
     RETURNING *`,
    [gymmasterMemberId]
  )).rows[0];
}

function verifier(activeMemberIds, calls) {
  return {
    async verifyActiveMember(memberId) {
      calls.push(memberId);
      return Object.freeze({ active: activeMemberIds.has(memberId) });
    },
  };
}

async function createProtectedStaffApp(pool, service) {
  const configuration = staffAuthConfiguration();
  const staffAuthorization = createStaffAuthorization({ db: pool });
  const app = express();
  app.use(express.json({ limit: "4kb" }));
  app.use("/staff", createStaffOriginGuard(configuration));
  app.use("/staff", createStaffAuthenticator({
    configuration,
    clerkClient: {},
    authenticateRequest: async ({ request }) => signedInState(
      request.get("X-Test-Staff-Subject")
    ),
  }));
  app.use(
    "/staff",
    staffAuthorization.loadActiveStaff,
    createGoalsCoachStaffRouter({
      db: pool,
      requireAdmin: staffAuthorization.requireAdmin,
      pendingEnrollmentEnabled: true,
      pendingEnrollmentService: service,
      rateLimits: noRateLimits,
    })
  );
  app.use(goalsCoachErrorHandler);
  return startApp(app);
}

function asStaff(subject, body, extra = {}) {
  return {
    method: "POST",
    headers: {
      Origin: STAFF_ORIGIN,
      "X-Test-Staff-Subject": subject,
      ...(extra.headers || {}),
    },
    body,
    ...extra,
  };
}

test("pending enrollment is exact-disabled and absent with zero startup work", async (t) => {
  assert.equal(memberPendingEnrollmentEnabled("true"), true);
  for (const value of [undefined, true, "True", "TRUE", " true", "true ", "1"]) {
    assert.equal(memberPendingEnrollmentEnabled(value), false);
  }

  let databaseCalls = 0;
  let providerCalls = 0;
  const db = {
    async query() { databaseCalls += 1; throw new Error("disabled database call"); },
    async connect() { databaseCalls += 1; throw new Error("disabled database call"); },
  };
  for (const value of [undefined, "false", "True", " true", "true "]) {
    const startup = createGymMasterMemberPendingEnrollmentStartup({
      environment: { [MEMBER_PENDING_ENROLLMENT_FLAG]: value },
      db,
      membershipVerifier: {
        async verifyActiveMember() { providerCalls += 1; return { active: true }; },
      },
    });
    assert.equal(startup.status, "disabled");
    assert.equal(startup.service, null);
  }
  assert.equal(databaseCalls, 0);
  assert.equal(providerCalls, 0);

  const ready = createGymMasterMemberPendingEnrollmentStartup({
    environment: { [MEMBER_PENDING_ENROLLMENT_FLAG]: "true" },
    db,
    membershipVerifier: {
      async verifyActiveMember() { providerCalls += 1; return { active: true }; },
    },
  });
  assert.equal(ready.status, "ready_for_existing_boundaries");
  assert.equal(typeof ready.service.createPendingEnrollment, "function");
  assert.equal(ready.activationPermitted, false);
  assert.equal(ready.startupExternalCallsPermitted, false);
  assert.equal(databaseCalls, 0);
  assert.equal(providerCalls, 0);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.staffUser = { id: "1", role: "admin", displayName: "Admin" };
    next();
  });
  app.use("/staff", createGoalsCoachStaffRouter({
    db,
    requireAdmin: (_req, _res, next) => next(),
    pendingEnrollmentEnabled: false,
    pendingEnrollmentService: {
      async createPendingEnrollment() { databaseCalls += 1; },
    },
    rateLimits: noRateLimits,
  }));
  const running = await startApp(app);
  t.after(() => running.close());
  const absent = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    { method: "POST", body: { gymmasterMemberId: "1", clientRequestId: requestId(1) } }
  );
  assert.equal(absent.response.status, 404);
  assert.equal(databaseCalls, 0);
});

test("staff enrollment reuses exact origin, Clerk session, active staff, and admin role", async (t) => {
  const { disposable, admin, coach, inactive } = await fixture(t);
  await seedGymMasterMember(disposable.pool, "42001");
  const calls = [];
  const service = createGymMasterMemberPendingEnrollmentService({
    db: disposable.pool,
    membershipVerifier: verifier(new Set(["42001"]), calls),
    now: () => new Date("2026-08-07T12:00:00.000Z"),
  });
  const running = await createProtectedStaffApp(disposable.pool, service);
  t.after(() => running.close());
  const body = { gymmasterMemberId: "42001", clientRequestId: requestId(101) };

  const wrongOrigin = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(admin.auth_subject, body, {
      headers: { Origin: "https://wrong.example.test" },
    })
  );
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.error, "STAFF_ORIGIN_NOT_ALLOWED");

  const unauthenticated = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff("", body)
  );
  assert.equal(unauthenticated.response.status, 401);

  const inactiveStaff = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(inactive.auth_subject, body)
  );
  assert.equal(inactiveStaff.response.status, 403);
  assert.equal(inactiveStaff.body.error, "STAFF_ACCESS_DISABLED");

  const nonAdmin = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(coach.auth_subject, body)
  );
  assert.equal(nonAdmin.response.status, 403);
  assert.equal(nonAdmin.body.error, "ADMIN_ACCESS_REQUIRED");

  const created = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(admin.auth_subject, body)
  );
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body, {
    pendingEnrollment: {
      status: "pending",
      expiresAt: "2026-08-08T12:00:00.000Z",
    },
    idempotentReplay: false,
  });
  assert.equal(JSON.stringify(created.body).includes("email"), false);
  assert.equal(JSON.stringify(created.body).includes("mapping"), false);
  assert.equal(Object.hasOwn(created.body, "staffUserId"), false);
  assert.equal(Object.hasOwn(created.body.pendingEnrollment, "staffUserId"), false);
  assert.deepEqual(calls, ["42001"]);
});

test("strict validation, active verification, coach-member matching, replay, conflict, and expiry are enforced", async (t) => {
  const { disposable, admin } = await fixture(t);
  await seedGymMasterMember(disposable.pool, "42101");
  await seedGymMasterMember(disposable.pool, "42102");
  const active = new Set(["42101", "49999"]);
  const calls = [];
  let clock = new Date("2026-08-07T13:00:00.000Z");
  const service = createGymMasterMemberPendingEnrollmentService({
    db: disposable.pool,
    membershipVerifier: verifier(active, calls),
    now: () => clock,
  });
  const running = await createProtectedStaffApp(disposable.pool, service);
  t.after(() => running.close());

  for (const body of [
    { gymmasterMemberId: 42101, clientRequestId: requestId(201) },
    { gymmasterMemberId: "0", clientRequestId: requestId(202) },
    { gymmasterMemberId: "042101", clientRequestId: requestId(203) },
    { gymmasterMemberId: "42101", clientRequestId: "not-a-uuid" },
    { gymmasterMemberId: "42101", clientRequestId: requestId(204), email: "staff@example.test" },
  ]) {
    const invalid = await jsonRequest(
      running.url,
      "/staff/member-pending-enrollments",
      asStaff(admin.auth_subject, body)
    );
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error, "MEMBER_PENDING_ENROLLMENT_INVALID");
  }
  assert.equal(calls.length, 0);
  assert.throws(
    () => parsePendingEnrollmentRequest({
      gymmasterMemberId: "42101",
      clientRequestId: requestId(205),
      ownerId: "1",
    }),
    (error) => error.code === "MEMBER_PENDING_ENROLLMENT_INVALID"
  );

  const inactiveMember = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(admin.auth_subject, {
      gymmasterMemberId: "42102",
      clientRequestId: requestId(206),
    })
  );
  assert.equal(inactiveMember.response.status, 409);
  assert.equal(inactiveMember.body.error, "MEMBER_PENDING_ENROLLMENT_NOT_AVAILABLE");

  const missingCoachMember = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(admin.auth_subject, {
      gymmasterMemberId: "49999",
      clientRequestId: requestId(207),
    })
  );
  assert.equal(missingCoachMember.response.status, 409);
  assert.equal(missingCoachMember.body.error, "MEMBER_PENDING_ENROLLMENT_NOT_AVAILABLE");

  const firstBody = {
    gymmasterMemberId: "42101",
    clientRequestId: requestId(208),
  };
  const created = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(admin.auth_subject, firstBody)
  );
  assert.equal(created.response.status, 201);
  assert.equal(created.body.idempotentReplay, false);
  assert.equal(
    Date.parse(created.body.pendingEnrollment.expiresAt) - clock.getTime(),
    PENDING_ENROLLMENT_TTL_MILLISECONDS
  );
  const callCountBeforeReplay = calls.length;
  const replay = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(admin.auth_subject, firstBody)
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(calls.length, callCountBeforeReplay);
  assert.equal(
    (await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_provisioning_events"
    )).rows[0].count,
    1
  );

  const conflict = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(admin.auth_subject, {
      gymmasterMemberId: "42101",
      clientRequestId: requestId(209),
    })
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error, "MEMBER_PENDING_ENROLLMENT_CONFLICT");

  clock = new Date("2026-08-08T13:00:00.001Z");
  const afterExpiry = await jsonRequest(
    running.url,
    "/staff/member-pending-enrollments",
    asStaff(admin.auth_subject, {
      gymmasterMemberId: "42101",
      clientRequestId: requestId(210),
    })
  );
  assert.equal(afterExpiry.response.status, 201);
  const lifecycle = await disposable.pool.query(
    `SELECT status
     FROM goals_coach_member_pending_enrollments
     WHERE gymmaster_member_id = '42101'
     ORDER BY id`
  );
  assert.deepEqual(lifecycle.rows.map((row) => row.status), ["expired", "pending"]);
});

test("successful login alone supplies the email snapshot, consumes enrollment, and changes no consent or safety data", async (t) => {
  const { disposable, admin } = await fixture(t);
  const member = await seedGymMasterMember(disposable.pool, "42201");
  const calls = [];
  const membershipVerifier = verifier(new Set(["42201"]), calls);
  const enrollmentService = createGymMasterMemberPendingEnrollmentService({
    db: disposable.pool,
    membershipVerifier,
    now: () => new Date("2026-08-07T14:00:00.000Z"),
  });
  await enrollmentService.createPendingEnrollment(
    { id: String(admin.id), role: "admin" },
    { gymmasterMemberId: "42201", clientRequestId: requestId(301) }
  );

  const forged = await enrollmentService.completeAuthenticatedEnrollment({
    authProvider: "gymmaster",
    authSubject: "gymmaster:42201",
    memberId: "42201",
    expiresInSeconds: 3600,
  });
  assert.deepEqual(forged, { active: false });
  assert.equal(
    (await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings"
    )).rows[0].count,
    0
  );

  const before = (await disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM goals_coach_alpha_consents) AS consents,
       (SELECT COUNT(*)::int FROM goals_coach_member_safety_intake_submissions) AS safety`
  )).rows[0];
  const loginService = createGymMasterMemberLoginService({
    enabled: true,
    memberApiKey: "member-api-key",
    loginClient: async ({ email, password }) => {
      assert.equal(email, "Member.Email@Example.Test");
      assert.equal(password, "member-password-secret");
      return {
        result: {
          token: "provider-token-secret",
          expires: 3600,
          memberid: 42201,
        },
      };
    },
  });
  const mappingAuthorization = createGymMasterMemberAuthorization({
    db: disposable.pool,
  });
  const accessAuthorization = createGymMasterMemberAccessAuthorizer({
    mappingAuthorizer: mappingAuthorization,
    membershipVerifier,
  });
  const diagnostics = [];
  const handler = createGymMasterMemberLoginHandler({
    enabled: true,
    origin: MEMBER_ORIGIN,
    loginService,
    authorizeIdentity: accessAuthorization.authorizeIdentity,
    completePendingEnrollment:
      enrollmentService.completeAuthenticatedEnrollment,
    sessionService: createGymMasterMemberSessionService({
      secret: SESSION_SECRET,
      now: () => new Date("2026-08-07T14:00:00.000Z"),
      randomBytes: () => Buffer.alloc(32, 8),
    }),
    attemptLimiter: { allow: () => true },
    ownerLoginStageDiagnostic: "true",
    diagnosticSink: (value) => diagnostics.push(value),
  });
  const res = response();
  await handler(
    loginRequest(" Member.Email@Example.Test ", "member-password-secret"),
    res
  );
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, undefined);
  assert.match(res.headers["Set-Cookie"], /^gc_member_session=/);

  const mapping = (await disposable.pool.query(
    `SELECT *
     FROM goals_coach_member_auth_mappings
     WHERE member_id = $1`,
    [member.id]
  )).rows[0];
  assert.equal(mapping.auth_provider, "gymmaster");
  assert.equal(mapping.auth_subject, "gymmaster:42201");
  assert.equal(mapping.verified_email_snapshot, "Member.Email@Example.Test");
  assert.equal(mapping.active, true);
  assert.equal(mapping.provisioning_method, "administrative");
  assert.equal(mapping.provisioned_by_staff_user_id, admin.id);
  assert.match(mapping.provisioning_reference, /^pending_enrollment:[1-9]\d*$/);

  const pending = (await disposable.pool.query(
    "SELECT * FROM goals_coach_member_pending_enrollments"
  )).rows[0];
  assert.equal(pending.status, "consumed");
  assert.equal(String(pending.auth_mapping_id), String(mapping.id));
  const events = (await disposable.pool.query(
    `SELECT pending_enrollment_id, auth_mapping_id, member_id, staff_user_id,
            client_request_id, action, result, reason_code, created_at
     FROM goals_coach_member_provisioning_events
     ORDER BY id`
  )).rows;
  assert.deepEqual(events.map((event) => event.action), [
    "pending_enrollment_created",
    "mapping_completed",
  ]);
  assert.equal(events.every((event) => event.reason_code === null), true);

  const after = (await disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM goals_coach_alpha_consents) AS consents,
       (SELECT COUNT(*)::int FROM goals_coach_member_safety_intake_submissions) AS safety`
  )).rows[0];
  assert.deepEqual(after, before);
  const nonMappingOutput = JSON.stringify({
    responseBody: res.body,
    responseHeaders: res.headers,
    pending,
    events,
    diagnostics,
  });
  for (const secret of [
    "Member.Email@Example.Test",
    "member-password-secret",
    "provider-token-secret",
    "member-api-key",
  ]) {
    assert.equal(nonMappingOutput.includes(secret), false, secret);
  }
  assert.deepEqual(diagnostics, []);
});

test("existing mapped-member login remains response-compatible and never invokes completion", async () => {
  let completionCalls = 0;
  function loginService() {
    return createGymMasterMemberLoginService({
      enabled: true,
      memberApiKey: "member-api-key",
      loginClient: async () => ({
        result: { token: "provider-token", expires: 3600, memberid: 42301 },
      }),
    });
  }
  function handler(completePendingEnrollment) {
    return createGymMasterMemberLoginHandler({
      enabled: true,
      origin: MEMBER_ORIGIN,
      loginService: loginService(),
      authorizeIdentity: async () => ({
        active: true,
        mappingId: "7",
        memberId: "77",
      }),
      ...(completePendingEnrollment ? { completePendingEnrollment } : {}),
      sessionService: { issue: () => "fixed-session" },
      attemptLimiter: { allow: () => true },
    });
  }
  const original = response();
  const extended = response();
  await handler()(loginRequest(), original);
  await handler(async () => {
    completionCalls += 1;
    return { active: false };
  })(loginRequest(), extended);
  assert.equal(extended.statusCode, original.statusCode);
  assert.deepEqual(extended.body, original.body);
  assert.deepEqual(extended.headers, original.headers);
  assert.equal(completionCalls, 0);
});

test("missing, mismatched, expired, and inactive completion states share one generic login failure", async (t) => {
  const { disposable, admin } = await fixture(t);
  await seedGymMasterMember(disposable.pool, "42401");
  const activeIds = new Set(["42401"]);
  const calls = [];
  let clock = new Date("2026-08-07T15:00:00.000Z");
  const membershipVerifier = verifier(activeIds, calls);
  const enrollmentService = createGymMasterMemberPendingEnrollmentService({
    db: disposable.pool,
    membershipVerifier,
    now: () => clock,
  });
  const mappingAuthorization = createGymMasterMemberAuthorization({
    db: disposable.pool,
  });
  const accessAuthorization = createGymMasterMemberAccessAuthorizer({
    mappingAuthorizer: mappingAuthorization,
    membershipVerifier,
  });

  async function attempt(memberId, email) {
    const diagnostics = [];
    const loginService = createGymMasterMemberLoginService({
      enabled: true,
      memberApiKey: "member-api-key",
      loginClient: async () => ({
        result: { token: "provider-token", expires: 3600, memberid: memberId },
      }),
    });
    const handler = createGymMasterMemberLoginHandler({
      enabled: true,
      origin: MEMBER_ORIGIN,
      loginService,
      authorizeIdentity: accessAuthorization.authorizeIdentity,
      completePendingEnrollment:
        enrollmentService.completeAuthenticatedEnrollment,
      sessionService: { issue: () => "must-not-be-issued" },
      attemptLimiter: { allow: () => true },
      ownerLoginStageDiagnostic: "true",
      diagnosticSink: (value) => diagnostics.push(value),
    });
    const res = response();
    await handler(loginRequest(email, "hidden-password"), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "MEMBER_LOGIN_FAILED" });
    assert.equal(res.headers["Set-Cookie"], undefined);
    assert.deepEqual(diagnostics, ["[UGF] goals_coach_owner_login_stage=local_mapping"]);
    assert.equal(JSON.stringify({ res, diagnostics }).includes(email.trim()), false);
  }

  await attempt(42401, "missing@example.test");
  await enrollmentService.createPendingEnrollment(
    { id: String(admin.id), role: "admin" },
    { gymmasterMemberId: "42401", clientRequestId: requestId(401) }
  );
  await attempt(42402, "mismatch@example.test");
  activeIds.delete("42401");
  await attempt(42401, "inactive@example.test");
  activeIds.add("42401");
  clock = new Date("2026-08-08T15:00:00.001Z");
  await attempt(42401, "expired@example.test");
  assert.equal(
    (await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_member_auth_mappings"
    )).rows[0].count,
    0
  );
});
