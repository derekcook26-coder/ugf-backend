const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const express = require("express");
const { createAlphaMemberAuthorization } = require("../src/auth/alpha-member-authorization");
const { createAlphaOriginGuard } = require("../src/auth/clerk-alpha-member-auth");
const {
  APPROVED_ALPHA_CONSENT_VERSION,
  createAlphaFeatureGate,
} = require("../src/goals-coach/alpha-config");
const { createAlphaGoalsCoachRouter } = require("../src/goals-coach/alpha-routes");
const { createCoachingEngine } = require("../src/goals-coach/coaching-engine");
const { goalsCoachErrorHandler } = require("../src/goals-coach/http-error-handler");
const { createPhase1bCoachingService } = require("../src/goals-coach/phase1b-service");
const { sessionDigest } = require("../src/goals-coach/transcription-service");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const { jsonRequest, startApp } = require("./helpers/http-app");

const TEST_ORIGIN = "https://phase1c-voice-message.example.test";
const BINDING_KEY = "synthetic-phase1c-voice-message-binding-key";
const AUTHENTICATED_SESSION_ID = "synthetic-phase1c-voice-message-session";
const READY_PHASE1C_STARTUP = Object.freeze({ status: "ready", reason: null });
const APPLICATION_CONFIGURATION = Object.freeze({
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

function coachingConfiguration() {
  return Object.freeze({
    aiEnabled: true,
    generationReady: true,
    providerIdentifier: "synthetic-phase1b-provider",
    modelIdentifier: "synthetic-phase1b-model",
    promptVersion: "GC-PROMPT-1B-1.0",
    structuredOutputVersion: "GC-OUTPUT-1B-1.0",
    safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B",
    providerTimeoutMs: 1000,
  });
}

function coachingOutput(configuration, reply = "Use the reviewed message as written.") {
  return {
    reply,
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

function request(running, path, options = {}) {
  return jsonRequest(running.url, path, {
    ...options,
    headers: { Origin: TEST_ORIGIN, ...(options.headers || {}) },
  });
}

function messagePath(fixture, conversationId = fixture.conversation.id) {
  return `/alpha/goals-coach/conversations/${conversationId}/messages`;
}

async function createFixture(t, options = {}) {
  const disposable = await createDisposableDatabase({
    phase1b: !options.migration005,
    phase1cTranscription: Boolean(options.migration005),
  });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, options.suffix || crypto.randomUUID());
  const mapping = await seedAlphaMapping(
    disposable.pool,
    seeded.member,
    options.suffix || crypto.randomUUID(),
    true
  );
  const configuration = coachingConfiguration();
  const provider = options.provider || {
    async generate() {
      return { output: coachingOutput(configuration) };
    },
  };
  const engine = createCoachingEngine({ configuration, provider });
  const authorization = createAlphaMemberAuthorization({
    db: disposable.pool,
    applicationConfiguration: APPLICATION_CONFIGURATION,
  });
  const app = express();
  app.use(express.json());
  app.use("/alpha/goals-coach", createAlphaOriginGuard({ authorizedParties: [TEST_ORIGIN] }));
  app.use(
    "/alpha/goals-coach",
    createAlphaFeatureGate({ enabled: true }),
    (req, res, next) => {
      req.alphaMemberIdentity = {
        authProvider: "clerk",
        authSubject: mapping.auth_subject,
        sessionId: options.authenticatedSessionId || AUTHENTICATED_SESSION_ID,
      };
      next();
    },
    authorization.loadActiveAlphaMember,
    createAlphaGoalsCoachRouter({
      db: disposable.pool,
      applicationConfiguration: APPLICATION_CONFIGURATION,
      requireCurrentConsent: authorization.requireCurrentAlphaConsent,
      coachingEngine: options.testOnlyResponder ? undefined : engine,
      testOnlyResponder: options.testOnlyResponder,
      phase1cStartup: options.phase1cStartup,
      transcriptionBindingKey: options.transcriptionBindingKey,
      phase1bServiceOptions: {
        now: options.now,
        pendingPollIntervalMs: 2,
        pendingWaitTimeoutMs: 500,
        transactionHooks: options.transactionHooks,
      },
    })
  );
  app.use(goalsCoachErrorHandler);
  const running = await startApp(app);
  t.after(() => running.close());
  const consent = await request(running, "/alpha/goals-coach/consent", {
    method: "POST",
    body: { action: "accept" },
  });
  assert.equal(consent.response.status, 200);
  const session = await request(running, "/alpha/goals-coach/session", { method: "POST" });
  assert.equal(session.response.status, 200);
  return {
    disposable,
    seeded,
    mapping,
    provider,
    running,
    conversation: session.body.conversation,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedAttempt(fixture, options = {}) {
  const id = options.id || crypto.randomUUID();
  const requestId = options.requestId || crypto.randomUUID();
  const memberId = options.memberId || fixture.seeded.member.id;
  const mappingId = options.mappingId || fixture.mapping.id;
  const conversationId = options.conversationId || fixture.conversation.id;
  const planId = options.planId || fixture.seeded.plan.id;
  const status = options.status || "completed";
  const transcript = options.transcript || "Reviewed transcript";
  const authSessionDigest = options.authSessionDigest || sessionDigest(
    BINDING_KEY,
    AUTHENTICATED_SESSION_ID
  );
  const common = [
    id,
    requestId,
    memberId,
    mappingId,
    authSessionDigest,
    conversationId,
    planId,
    sha256("synthetic raw audio"),
  ];

  if (status === "pending") {
    await fixture.disposable.pool.query(
      `INSERT INTO goals_coach_transcription_attempts
        (id, request_id, attempt_number, member_id, auth_mapping_id,
         auth_session_digest, conversation_id, plan_id, status, mime_type,
         audio_byte_count, audio_digest)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'pending',
         'audio/webm;codecs=opus', 19, $8)`,
      common
    );
  } else if (status === "failed") {
    await fixture.disposable.pool.query(
      `INSERT INTO goals_coach_transcription_attempts
        (id, request_id, attempt_number, member_id, auth_mapping_id,
         auth_session_digest, conversation_id, plan_id, status, mime_type,
         audio_byte_count, audio_digest, provider_identifier, model_identifier,
         failure_category, provider_started_at, provider_completed_at, created_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'failed',
         'audio/webm;codecs=opus', 19, $8, 'synthetic-provider', 'synthetic-model',
         'provider_unavailable', NOW() - INTERVAL '90 seconds',
         NOW() - INTERVAL '60 seconds', NOW() - INTERVAL '2 minutes')`,
      common
    );
  } else {
    const expired = status === "expired" || options.expired === true;
    await fixture.disposable.pool.query(
      `INSERT INTO goals_coach_transcription_attempts
        (id, request_id, attempt_number, member_id, auth_mapping_id,
         auth_session_digest, conversation_id, plan_id, status, mime_type,
         audio_byte_count, audio_duration_ms, audio_digest, transcript_digest,
         provider_identifier, model_identifier, provider_started_at,
         provider_completed_at, expires_at, created_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $9,
         'audio/webm;codecs=opus', 19, 1234, $8, $10,
         'synthetic-provider', 'synthetic-model', NOW() - INTERVAL '90 seconds',
         NOW() - INTERVAL '60 seconds',
         ${expired ? "NOW() - INTERVAL '1 second'" : "NOW() + INTERVAL '10 minutes'"},
         NOW() - INTERVAL '2 minutes')`,
      [...common, status, sha256(transcript)]
    );
  }
  return { id, requestId, transcript };
}

async function consumeAttemptForSyntheticMessage(fixture, attempt, content) {
  const message = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_messages
      (conversation_id, member_id, sender_type, content, client_message_id)
     VALUES ($1, $2, 'member', $3, $4)
     RETURNING *`,
    [
      fixture.conversation.id,
      fixture.seeded.member.id,
      content,
      crypto.randomUUID(),
    ]
  )).rows[0];
  await fixture.disposable.pool.query(
    `UPDATE goals_coach_transcription_attempts
     SET status = 'consumed',
         consumed_at = NOW(),
         consumed_member_message_id = $1,
         transcript_edited = FALSE
     WHERE id = $2`,
    [message.id, attempt.id]
  );
  return message;
}

async function mutationCounts(fixture) {
  return (await fixture.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages) AS messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS workouts,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS workout_events`
  )).rows[0];
}

async function rejectionSideEffectCounts(fixture) {
  return (await fixture.disposable.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'member')
         AS member_messages,
       (SELECT COUNT(*)::int FROM coaching_messages WHERE sender_type = 'goals_coach')
         AS coach_messages,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns
          WHERE transcription_attempt_id IS NOT NULL) AS provenance_links,
       (SELECT COUNT(*)::int FROM goals_coach_transcription_attempts
          WHERE status = 'consumed') AS consumed_attempts,
       (SELECT COUNT(*)::int FROM goals_coach_workout_sessions) AS workouts,
       (SELECT COUNT(*)::int FROM goals_coach_workout_state_events) AS workout_events,
       (SELECT COUNT(*)::int FROM coaching_concerns) AS concerns,
       (SELECT COUNT(*)::int FROM coaching_reviews) AS reviews,
       (SELECT COUNT(*)::int FROM coaching_review_events) AS review_events`
  )).rows[0];
}

test("typed messages remain compatible without Migration 005 and unavailable voice fails before its storage", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-unavailable-no-005",
    migration005: false,
    phase1cStartup: READY_PHASE1C_STARTUP,
    provider: {
      async generate() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  assert.equal((await fixture.disposable.pool.query(
    "SELECT to_regclass('goals_coach_transcription_attempts') AS relation"
  )).rows[0].relation, null);

  const typed = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Typed message", clientMessageId: crypto.randomUUID() },
  });
  assert.equal(typed.response.status, 201);
  assert.equal(providerCalls, 1);

  const explicitClientMessageId = crypto.randomUUID();
  const explicitTextBody = {
    content: "Explicit text message",
    clientMessageId: explicitClientMessageId,
    inputMethod: "text",
  };
  const explicitText = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: explicitTextBody,
  });
  const explicitReplay = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: explicitTextBody,
  });
  assert.equal(explicitText.response.status, 201);
  assert.equal(explicitReplay.response.status, 201);
  assert.equal(explicitReplay.body.idempotentReplay, true);
  assert.equal(explicitReplay.body.memberMessageId, explicitText.body.memberMessageId);
  assert.equal(providerCalls, 2);

  const voice = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: "Reviewed transcript",
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: crypto.randomUUID(),
    },
  });
  assert.equal(voice.response.status, 503);
  assert.deepEqual(voice.body, {
    error: "TRANSCRIPTION_NOT_AVAILABLE",
    message: "Transcription is not available.",
  });
  assert.equal(providerCalls, 2);
  assert.deepEqual(await mutationCounts(fixture), {
    messages: 4,
    turns: 2,
    workouts: 0,
    workout_events: 0,
  });
});

test("the service requires ready startup and a binding key before opening storage", async () => {
  for (const readiness of [
    { phase1cStartup: READY_PHASE1C_STARTUP, transcriptionBindingKey: undefined },
    {
      phase1cStartup: { status: "unavailable", reason: "consent_update_required" },
      transcriptionBindingKey: BINDING_KEY,
    },
  ]) {
    let storageConnections = 0;
    const service = createPhase1bCoachingService({
      db: {
        async connect() {
          storageConnections += 1;
          throw new Error("storage must remain untouched");
        },
      },
      engine: {
        configuration: coachingConfiguration(),
        async generateTurn() {
          throw new Error("provider must remain untouched");
        },
      },
      applicationConfiguration: APPLICATION_CONFIGURATION,
      ...readiness,
    });
    await assert.rejects(
      service.sendMessage(
        { mappingId: "1", memberId: "1", authProvider: "clerk", authSubject: "subject" },
        "1",
        {
          content: "Reviewed transcript",
          clientMessageId: crypto.randomUUID(),
          inputMethod: "voice",
          transcriptionId: crypto.randomUUID(),
        },
        { authenticatedSessionId: AUTHENTICATED_SESSION_ID }
      ),
      (error) => error.statusCode === 503 && error.code === "TRANSCRIPTION_NOT_AVAILABLE"
    );
    assert.equal(storageConnections, 0);
  }
});

test("message validation is strict and rejected bodies cannot mutate coaching state", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-message-validation",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  const canonicalClientId = crypto.randomUUID();
  const canonicalTranscriptionId = crypto.randomUUID();
  const invalidBodies = [
    null,
    [],
    "message",
    { content: "Text", clientMessageId: canonicalClientId, memberId: "1" },
    { content: "Text", clientMessageId: canonicalClientId, sessionId: "browser-session" },
    { content: "Text", clientMessageId: canonicalClientId, provider: "browser-provider" },
    { content: "Text", clientMessageId: canonicalClientId, inputMethod: "voice" },
    {
      content: "Text",
      clientMessageId: canonicalClientId,
      inputMethod: "text",
      transcriptionId: canonicalTranscriptionId,
    },
    {
      content: "Text",
      clientMessageId: canonicalClientId,
      inputMethod: "VOICE",
      transcriptionId: canonicalTranscriptionId,
    },
    {
      content: "Text",
      clientMessageId: canonicalClientId,
      inputMethod: "voice",
      transcriptionId: canonicalTranscriptionId.toUpperCase(),
    },
    {
      content: "Text",
      clientMessageId: canonicalClientId,
      inputMethod: "voice",
      transcriptionId: `{${canonicalTranscriptionId}}`,
    },
  ];
  for (const body of invalidBodies) {
    const rejected = await request(fixture.running, messagePath(fixture), {
      method: "POST",
      body,
    });
    assert.equal(rejected.response.status, 400, JSON.stringify(body));
    assert.ok(
      ["INVALID_REQUEST", "GOALS_COACH_ERROR"].includes(rejected.body.error),
      JSON.stringify(rejected.body)
    );
  }
  assert.equal(providerCalls, 0);
  assert.deepEqual(await mutationCounts(fixture), {
    messages: 0,
    turns: 0,
    workouts: 0,
    workout_events: 0,
  });
});

test("implicit text, explicit text, and voice reject every non-string content category", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-message-content-type",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  const attempt = await seedAttempt(fixture, { transcript: "Usable reviewed transcript" });
  const nonStrings = [0, 7, true, false, [], {}, null];
  const expectedError = {
    error: "INVALID_REQUEST",
    message: "content must be a string",
  };
  const initialCounts = await rejectionSideEffectCounts(fixture);

  for (const inputMethod of [undefined, "text", "voice"]) {
    for (const content of nonStrings) {
      const body = {
        content,
        clientMessageId: crypto.randomUUID(),
        ...(inputMethod === undefined ? {} : { inputMethod }),
        ...(inputMethod === "voice" ? { transcriptionId: attempt.id } : {}),
      };
      const rejected = await request(fixture.running, messagePath(fixture), {
        method: "POST",
        body,
      });
      assert.equal(rejected.response.status, 400, JSON.stringify(body));
      assert.deepEqual(rejected.body, expectedError, JSON.stringify(body));
      assert.equal(providerCalls, 0);
      assert.deepEqual(await rejectionSideEffectCounts(fixture), initialCounts);
      const storedAttempt = (await fixture.disposable.pool.query(
        `SELECT status, consumed_at, consumed_member_message_id
         FROM goals_coach_transcription_attempts WHERE id = $1`,
        [attempt.id]
      )).rows[0];
      assert.deepEqual(storedAttempt, {
        status: "completed",
        consumed_at: null,
        consumed_member_message_id: null,
      });
    }
  }

  const valid = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: "Usable reviewed transcript",
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: attempt.id,
    },
  });
  assert.equal(valid.response.status, 201);
  assert.equal(providerCalls, 1);
  assert.equal((await fixture.disposable.pool.query(
    "SELECT status FROM goals_coach_transcription_attempts WHERE id = $1",
    [attempt.id]
  )).rows[0].status, "consumed");
});

test("voice submissions atomically consume unedited, edited, and trim-equivalent transcripts", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-message-consume",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  const cases = [
    { transcript: "Reviewed transcript", submitted: "Reviewed transcript", edited: false },
    { transcript: "Original transcript", submitted: "Edited interior transcript", edited: true },
    { transcript: "Trimmed transcript", submitted: "  Trimmed transcript  ", edited: false },
  ];
  for (const entry of cases) {
    const attempt = await seedAttempt(fixture, { transcript: entry.transcript });
    const clientMessageId = crypto.randomUUID();
    const response = await request(fixture.running, messagePath(fixture), {
      method: "POST",
      body: {
        content: entry.submitted,
        clientMessageId,
        inputMethod: "voice",
        transcriptionId: attempt.id,
      },
    });
    assert.equal(response.response.status, 201);
    const stored = (await fixture.disposable.pool.query(
      `SELECT status, transcript_edited, consumed_at, consumed_member_message_id,
              transcript_digest
       FROM goals_coach_transcription_attempts WHERE id = $1`,
      [attempt.id]
    )).rows[0];
    assert.equal(stored.status, "consumed");
    assert.equal(stored.transcript_edited, entry.edited);
    assert.ok(stored.consumed_at);
    assert.equal(String(stored.consumed_member_message_id), response.body.memberMessageId);
    assert.equal(stored.transcript_digest, sha256(entry.transcript));
    const turn = (await fixture.disposable.pool.query(
      `SELECT input_method, transcription_attempt_id
       FROM goals_coach_coaching_turns WHERE member_message_id = $1`,
      [response.body.memberMessageId]
    )).rows[0];
    assert.equal(turn.input_method, "voice");
    assert.equal(turn.transcription_attempt_id, attempt.id);
    const message = (await fixture.disposable.pool.query(
      "SELECT content FROM coaching_messages WHERE id = $1",
      [response.body.memberMessageId]
    )).rows[0];
    assert.equal(message.content, entry.submitted.trim());
  }
  assert.equal(providerCalls, cases.length);
  assert.equal((await fixture.disposable.pool.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_name = 'goals_coach_transcription_attempts'
       AND column_name IN ('transcript', 'transcript_text', 'raw_audio')`
  )).rows[0].count, 0);
});

test("non-consumable attempts are concealed and a completed expiry transition commits", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const now = new Date("2026-07-20T20:00:00.000Z");
  const fixture = await createFixture(t, {
    suffix: "voice-message-lifecycle",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    now: () => new Date(now),
    provider: {
      async generate() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });

  const pending = await seedAttempt(fixture, { status: "pending" });
  const pendingResponse = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: pending.transcript,
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: pending.id,
    },
  });
  assert.equal(pendingResponse.response.status, 404);
  assert.equal(pendingResponse.body.error, "TRANSCRIPTION_NOT_FOUND");
  await fixture.disposable.pool.query(
    `UPDATE goals_coach_transcription_attempts
     SET status = 'failed',
         provider_identifier = 'synthetic-provider',
         model_identifier = 'synthetic-model',
         failure_category = 'provider_unavailable',
         provider_started_at = NOW(),
         provider_completed_at = NOW()
     WHERE id = $1`,
    [pending.id]
  );
  const failedResponse = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: pending.transcript,
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: pending.id,
    },
  });
  assert.equal(failedResponse.response.status, 404);

  const expired = await seedAttempt(fixture, { status: "expired" });
  const expiredResponse = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: expired.transcript,
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: expired.id,
    },
  });
  assert.equal(expiredResponse.response.status, 404);

  const completedPastExpiry = await seedAttempt(fixture, {
    status: "completed",
    expired: true,
  });
  const transition = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: completedPastExpiry.transcript,
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: completedPastExpiry.id,
    },
  });
  assert.equal(transition.response.status, 404);
  const transitioned = (await fixture.disposable.pool.query(
    `SELECT status, consumed_at, consumed_member_message_id
     FROM goals_coach_transcription_attempts WHERE id = $1`,
    [completedPastExpiry.id]
  )).rows[0];
  assert.deepEqual(transitioned, {
    status: "expired",
    consumed_at: null,
    consumed_member_message_id: null,
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual(await mutationCounts(fixture), {
    messages: 0,
    turns: 0,
    workouts: 0,
    workout_events: 0,
  });
});

test("authoritative member, mapping, session, conversation, and plan mismatches are concealed", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-message-scope",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  const alternateMapping = (await fixture.disposable.pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot,
       active, provisioning_method, provisioning_reference)
     VALUES ($1, 'synthetic-alternate', 'alternate-subject',
       'alternate@example.test', TRUE, 'owner_approved_script', 'synthetic-test')
     RETURNING *`,
    [fixture.seeded.member.id]
  )).rows[0];
  const alternateConversation = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id, status, archived_at)
     VALUES ($1, $2, 'archived', NOW()) RETURNING *`,
    [fixture.seeded.member.id, fixture.seeded.plan.id]
  )).rows[0];
  const other = await seedMemberAndPlan(fixture.disposable.pool, "voice-scope-other-member");
  const otherMapping = await seedAlphaMapping(
    fixture.disposable.pool,
    other.member,
    "voice-scope-other-member",
    true
  );
  const otherConversation = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [other.member.id, other.plan.id]
  )).rows[0];
  const alternatePlan = (await fixture.disposable.pool.query(
    `INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown)
     VALUES ($1, '{}'::jsonb, '[]'::jsonb, 'Alternate plan') RETURNING *`,
    [fixture.seeded.member.id]
  )).rows[0];
  const alternatePlanConversation = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [fixture.seeded.member.id, alternatePlan.id]
  )).rows[0];

  const attempts = [
    await seedAttempt(fixture, {
      memberId: other.member.id,
      mappingId: otherMapping.id,
      conversationId: otherConversation.id,
      planId: other.plan.id,
    }),
    await seedAttempt(fixture, { mappingId: alternateMapping.id }),
    await seedAttempt(fixture, {
      authSessionDigest: sessionDigest(BINDING_KEY, "different-authenticated-session"),
    }),
    await seedAttempt(fixture, { conversationId: alternateConversation.id }),
    await seedAttempt(fixture, {
      conversationId: alternatePlanConversation.id,
      planId: alternatePlan.id,
    }),
  ];
  for (const attempt of attempts) {
    const response = await request(fixture.running, messagePath(fixture), {
      method: "POST",
      body: {
        content: attempt.transcript,
        clientMessageId: crypto.randomUUID(),
        inputMethod: "voice",
        transcriptionId: attempt.id,
      },
    });
    assert.equal(response.response.status, 404);
    assert.equal(response.body.error, "TRANSCRIPTION_NOT_FOUND");
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes(BINDING_KEY));
    assert.ok(!serialized.includes(AUTHENTICATED_SESSION_ID));
    assert.ok(!serialized.includes(attempt.transcript));
  }
  assert.equal(providerCalls, 0);
  assert.deepEqual(await mutationCounts(fixture), {
    messages: 0,
    turns: 0,
    workouts: 0,
    workout_events: 0,
  });
});

test("transcription concealment takes precedence over an unrelated pending coaching turn", async (t) => {
  const providerEntered = deferred();
  const releaseProvider = deferred();
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-concealment-precedence",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        providerEntered.resolve();
        await releaseProvider.promise;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  t.after(() => releaseProvider.resolve());

  const pendingTurnRequest = request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Hold an unrelated turn", clientMessageId: crypto.randomUUID() },
  });
  await providerEntered.promise;
  assert.equal(providerCalls, 1);

  const alternateMapping = (await fixture.disposable.pool.query(
    `INSERT INTO goals_coach_member_auth_mappings
      (member_id, auth_provider, auth_subject, verified_email_snapshot,
       active, provisioning_method, provisioning_reference)
     VALUES ($1, 'synthetic-alternate', 'precedence-alternate-subject',
       'precedence-alternate@example.test', TRUE,
       'owner_approved_script', 'synthetic-test')
     RETURNING *`,
    [fixture.seeded.member.id]
  )).rows[0];
  const alternateConversation = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id, status, archived_at)
     VALUES ($1, $2, 'archived', NOW()) RETURNING *`,
    [fixture.seeded.member.id, fixture.seeded.plan.id]
  )).rows[0];
  const other = await seedMemberAndPlan(
    fixture.disposable.pool,
    "voice-concealment-precedence-other"
  );
  const otherMapping = await seedAlphaMapping(
    fixture.disposable.pool,
    other.member,
    "voice-concealment-precedence-other",
    true
  );
  const otherConversation = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [other.member.id, other.plan.id]
  )).rows[0];
  const alternatePlan = (await fixture.disposable.pool.query(
    `INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown)
     VALUES ($1, '{}'::jsonb, '[]'::jsonb, 'Precedence alternate plan')
     RETURNING *`,
    [fixture.seeded.member.id]
  )).rows[0];
  const alternatePlanConversation = (await fixture.disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [fixture.seeded.member.id, alternatePlan.id]
  )).rows[0];

  const pendingAttempt = await seedAttempt(fixture, { status: "pending" });
  const failedAttempt = await seedAttempt(fixture, { status: "failed" });
  const expiredAttempt = await seedAttempt(fixture, { status: "expired" });
  const completedPastExpiry = await seedAttempt(fixture, {
    status: "completed",
    expired: true,
  });
  const consumedAttempt = await seedAttempt(fixture, {
    transcript: "Already consumed transcript",
  });
  await consumeAttemptForSyntheticMessage(
    fixture,
    consumedAttempt,
    consumedAttempt.transcript
  );
  const concealedCases = [
    { name: "unknown", id: crypto.randomUUID(), content: "Unknown transcript" },
    {
      name: "cross-member",
      ...(await seedAttempt(fixture, {
        memberId: other.member.id,
        mappingId: otherMapping.id,
        conversationId: otherConversation.id,
        planId: other.plan.id,
      })),
    },
    { name: "cross-mapping", ...(await seedAttempt(fixture, { mappingId: alternateMapping.id })) },
    {
      name: "cross-session",
      ...(await seedAttempt(fixture, {
        authSessionDigest: sessionDigest(BINDING_KEY, "precedence-other-session"),
      })),
    },
    {
      name: "cross-conversation",
      ...(await seedAttempt(fixture, { conversationId: alternateConversation.id })),
    },
    {
      name: "cross-conversation-and-plan",
      ...(await seedAttempt(fixture, {
        conversationId: alternatePlanConversation.id,
        planId: alternatePlan.id,
      })),
    },
    { name: "pending", ...pendingAttempt },
    { name: "failed", ...failedAttempt },
    { name: "already-expired", ...expiredAttempt },
    { name: "expires-during-request", ...completedPastExpiry },
    { name: "consumed-by-another-message", ...consumedAttempt },
  ];
  const baseline = await rejectionSideEffectCounts(fixture);
  const concealedBody = {
    error: "TRANSCRIPTION_NOT_FOUND",
    message: "Transcription not found",
  };

  for (const entry of concealedCases) {
    const response = await request(fixture.running, messagePath(fixture), {
      method: "POST",
      body: {
        content: entry.transcript || entry.content,
        clientMessageId: crypto.randomUUID(),
        inputMethod: "voice",
        transcriptionId: entry.id,
      },
    });
    assert.equal(response.response.status, 404, entry.name);
    assert.deepEqual(response.body, concealedBody, entry.name);
    assert.equal(providerCalls, 1, entry.name);
    assert.deepEqual(await rejectionSideEffectCounts(fixture), baseline, entry.name);
  }
  assert.equal((await fixture.disposable.pool.query(
    "SELECT status FROM goals_coach_transcription_attempts WHERE id = $1",
    [completedPastExpiry.id]
  )).rows[0].status, "expired");

  const eligible = await seedAttempt(fixture, { transcript: "Eligible but blocked transcript" });
  const blocked = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: eligible.transcript,
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: eligible.id,
    },
  });
  assert.equal(blocked.response.status, 409);
  assert.deepEqual(blocked.body, {
    error: "COACHING_TURN_IN_PROGRESS",
    message: "Another coaching turn is still being processed",
  });
  assert.equal((await fixture.disposable.pool.query(
    `SELECT status, consumed_at, consumed_member_message_id
     FROM goals_coach_transcription_attempts WHERE id = $1`,
    [eligible.id]
  )).rows[0].status, "completed");
  assert.equal(providerCalls, 1);

  releaseProvider.resolve();
  const completedPendingTurn = await pendingTurnRequest;
  assert.equal(completedPendingTurn.response.status, 409);
});

test("different-client reuse stays concealed while the original voice provider call is pending", async (t) => {
  const providerEntered = deferred();
  const releaseFirstProvider = deferred();
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-consumed-pending-precedence",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        if (providerCalls === 1) {
          providerEntered.resolve();
          await releaseFirstProvider.promise;
          const error = new Error("private synthetic provider failure");
          error.failureCategory = "provider_error";
          throw error;
        }
        return { output: coachingOutput(configuration) };
      },
    },
  });
  t.after(() => releaseFirstProvider.resolve());
  const attempt = await seedAttempt(fixture, { transcript: "Barrier-reviewed transcript" });
  const originalBody = {
    content: attempt.transcript,
    clientMessageId: crypto.randomUUID(),
    inputMethod: "voice",
    transcriptionId: attempt.id,
  };
  const firstRequest = request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: originalBody,
  });
  await providerEntered.promise;
  assert.equal(providerCalls, 1);

  const afterFirstStage = await rejectionSideEffectCounts(fixture);
  const differentClient = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { ...originalBody, clientMessageId: crypto.randomUUID() },
  });
  assert.equal(differentClient.response.status, 404);
  assert.deepEqual(differentClient.body, {
    error: "TRANSCRIPTION_NOT_FOUND",
    message: "Transcription not found",
  });
  assert.deepEqual(await rejectionSideEffectCounts(fixture), afterFirstStage);
  assert.equal(providerCalls, 1);

  const eligible = await seedAttempt(fixture, { transcript: "Other eligible transcript" });
  const eligibleBlocked = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: eligible.transcript,
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: eligible.id,
    },
  });
  assert.equal(eligibleBlocked.response.status, 409);
  assert.equal(eligibleBlocked.body.error, "COACHING_TURN_IN_PROGRESS");
  assert.deepEqual((await fixture.disposable.pool.query(
    `SELECT status, consumed_at, consumed_member_message_id
     FROM goals_coach_transcription_attempts WHERE id = $1`,
    [eligible.id]
  )).rows[0], {
    status: "completed",
    consumed_at: null,
    consumed_member_message_id: null,
  });
  assert.equal(providerCalls, 1);

  releaseFirstProvider.resolve();
  const failedFirst = await firstRequest;
  assert.equal(failedFirst.response.status, 503);
  assert.equal(failedFirst.body.error, "COACHING_TEMPORARILY_UNAVAILABLE");
  const retry = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: originalBody,
  });
  const replay = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: originalBody,
  });
  assert.equal(retry.response.status, 201);
  assert.equal(retry.body.idempotentReplay, false);
  assert.equal(replay.response.status, 201);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(providerCalls, 2);
  const turns = await fixture.disposable.pool.query(
    `SELECT attempt_number, provider_status, transcription_attempt_id
     FROM goals_coach_coaching_turns
     WHERE member_message_id = $1 ORDER BY attempt_number`,
    [retry.body.memberMessageId]
  );
  assert.deepEqual(turns.rows, [
    { attempt_number: 1, provider_status: "failed", transcription_attempt_id: attempt.id },
    { attempt_number: 2, provider_status: "completed", transcription_attempt_id: null },
  ]);
});

test("voice replay and client-message conflicts preserve exact provenance identity", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-message-replay",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  const attempt = await seedAttempt(fixture, { transcript: "Replay transcript" });
  const clientMessageId = crypto.randomUUID();
  const body = {
    content: attempt.transcript,
    clientMessageId,
    inputMethod: "voice",
    transcriptionId: attempt.id,
  };
  const first = await request(fixture.running, messagePath(fixture), { method: "POST", body });
  const replay = await request(fixture.running, messagePath(fixture), { method: "POST", body });
  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 201);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.memberMessageId, first.body.memberMessageId);
  assert.equal(providerCalls, 1);

  const changedContent = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { ...body, content: "Different reviewed content" },
  });
  assert.equal(changedContent.response.status, 409);
  assert.equal(changedContent.body.error, "CLIENT_MESSAGE_ID_CONFLICT");

  const secondAttempt = await seedAttempt(fixture, { transcript: attempt.transcript });
  const changedTranscription = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { ...body, transcriptionId: secondAttempt.id },
  });
  assert.equal(changedTranscription.response.status, 409);
  assert.equal(changedTranscription.body.error, "CLIENT_MESSAGE_ID_CONFLICT");

  const voiceToText = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: body.content, clientMessageId },
  });
  assert.equal(voiceToText.response.status, 409);
  assert.equal(voiceToText.body.error, "CLIENT_MESSAGE_ID_CONFLICT");

  const anotherClientMessage = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { ...body, clientMessageId: crypto.randomUUID() },
  });
  assert.equal(anotherClientMessage.response.status, 404);
  assert.equal(anotherClientMessage.body.error, "TRANSCRIPTION_NOT_FOUND");

  const textClientMessageId = crypto.randomUUID();
  const text = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: { content: "Typed first", clientMessageId: textClientMessageId },
  });
  assert.equal(text.response.status, 201);
  const textAttempt = await seedAttempt(fixture, { transcript: "Typed first" });
  const textToVoice = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: "Typed first",
      clientMessageId: textClientMessageId,
      inputMethod: "voice",
      transcriptionId: textAttempt.id,
    },
  });
  assert.equal(textToVoice.response.status, 409);
  assert.equal(textToVoice.body.error, "CLIENT_MESSAGE_ID_CONFLICT");
  assert.equal(providerCalls, 2);
  assert.equal((await fixture.disposable.pool.query(
    `SELECT COUNT(*)::int AS count FROM goals_coach_coaching_turns
     WHERE transcription_attempt_id = $1`,
    [attempt.id]
  )).rows[0].count, 1);
});

test("a provider retry keeps one provenance link and never rewrites the consumed attempt", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-message-provider-retry",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        if (providerCalls === 1) {
          const error = new Error("synthetic provider payload must stay private");
          error.failureCategory = "provider_error";
          throw error;
        }
        return { output: coachingOutput(configuration) };
      },
    },
  });
  const attempt = await seedAttempt(fixture, { transcript: "Retry reviewed transcript" });
  const body = {
    content: attempt.transcript,
    clientMessageId: crypto.randomUUID(),
    inputMethod: "voice",
    transcriptionId: attempt.id,
  };
  const first = await request(fixture.running, messagePath(fixture), { method: "POST", body });
  assert.equal(first.response.status, 503);
  assert.equal(first.body.error, "COACHING_TEMPORARILY_UNAVAILABLE");
  const consumedBeforeRetry = (await fixture.disposable.pool.query(
    `SELECT status, consumed_at, consumed_member_message_id, transcript_edited
     FROM goals_coach_transcription_attempts WHERE id = $1`,
    [attempt.id]
  )).rows[0];
  assert.equal(consumedBeforeRetry.status, "consumed");
  assert.equal(consumedBeforeRetry.transcript_edited, false);

  const second = await request(fixture.running, messagePath(fixture), { method: "POST", body });
  assert.equal(second.response.status, 201);
  assert.equal(second.body.idempotentReplay, false);
  const replay = await request(fixture.running, messagePath(fixture), { method: "POST", body });
  assert.equal(replay.response.status, 201);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(providerCalls, 2);

  const consumedAfterRetry = (await fixture.disposable.pool.query(
    `SELECT status, consumed_at, consumed_member_message_id, transcript_edited
     FROM goals_coach_transcription_attempts WHERE id = $1`,
    [attempt.id]
  )).rows[0];
  assert.deepEqual(consumedAfterRetry, consumedBeforeRetry);
  const turns = await fixture.disposable.pool.query(
    `SELECT attempt_number, input_method, transcription_attempt_id, provider_status
     FROM goals_coach_coaching_turns
     WHERE member_message_id = $1 ORDER BY attempt_number`,
    [second.body.memberMessageId]
  );
  assert.deepEqual(turns.rows, [
    {
      attempt_number: 1,
      input_method: "voice",
      transcription_attempt_id: attempt.id,
      provider_status: "failed",
    },
    {
      attempt_number: 2,
      input_method: "voice",
      transcription_attempt_id: null,
      provider_status: "completed",
    },
  ]);
  const serializedFailure = JSON.stringify(first.body);
  assert.ok(!serializedFailure.includes("synthetic provider payload"));
  assert.ok(!serializedFailure.includes(attempt.transcript));
  assert.ok(!serializedFailure.includes(BINDING_KEY));
  assert.ok(!serializedFailure.includes(AUTHENTICATED_SESSION_ID));
});

test("a voice staging failure rolls back message, turn, and attempt consumption", async (t) => {
  let providerCalls = 0;
  const configuration = coachingConfiguration();
  const fixture = await createFixture(t, {
    suffix: "voice-message-stage-rollback",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    provider: {
      async generate() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  const attempt = await seedAttempt(fixture, { transcript: "Rollback reviewed transcript" });
  await fixture.disposable.pool.query(`
    CREATE OR REPLACE FUNCTION reject_synthetic_voice_consumption()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.status = 'consumed' THEN
        RAISE EXCEPTION 'synthetic voice staging failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_reject_synthetic_voice_consumption
    BEFORE UPDATE ON goals_coach_transcription_attempts
    FOR EACH ROW EXECUTE FUNCTION reject_synthetic_voice_consumption();
  `);

  const capturedLogs = [];
  const originalConsoleError = console.error;
  console.error = (...values) => capturedLogs.push(values.join(" "));
  let response;
  try {
    response = await request(fixture.running, messagePath(fixture), {
      method: "POST",
      body: {
        content: attempt.transcript,
        clientMessageId: crypto.randomUUID(),
        inputMethod: "voice",
        transcriptionId: attempt.id,
      },
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(response.response.status, 500);
  assert.deepEqual(response.body, { error: "GOALS_COACH_ERROR" });
  assert.equal(providerCalls, 0);
  assert.deepEqual(await mutationCounts(fixture), {
    messages: 0,
    turns: 0,
    workouts: 0,
    workout_events: 0,
  });
  const stored = (await fixture.disposable.pool.query(
    `SELECT status, consumed_at, consumed_member_message_id, transcript_edited
     FROM goals_coach_transcription_attempts WHERE id = $1`,
    [attempt.id]
  )).rows[0];
  assert.deepEqual(stored, {
    status: "completed",
    consumed_at: null,
    consumed_member_message_id: null,
    transcript_edited: false,
  });
  const logs = capturedLogs.join("\n");
  assert.ok(logs.includes("Goals Coach route error"));
  for (const secret of [
    attempt.transcript,
    attempt.id,
    BINDING_KEY,
    AUTHENTICATED_SESSION_ID,
    "synthetic voice staging failure",
  ]) {
    assert.ok(!logs.includes(secret));
    assert.ok(!JSON.stringify(response.body).includes(secret));
  }
});

test("the deterministic test-only responder remains text-only", async (t) => {
  let responderCalls = 0;
  const fixture = await createFixture(t, {
    suffix: "voice-message-test-responder",
    migration005: true,
    phase1cStartup: READY_PHASE1C_STARTUP,
    transcriptionBindingKey: BINDING_KEY,
    testOnlyResponder: async () => {
      responderCalls += 1;
      return {
        content: "Synthetic text-only response",
        structuredResponse: { mode: "synthetic" },
      };
    },
  });
  const attempt = await seedAttempt(fixture, { transcript: "Voice must not reach responder" });
  const voice = await request(fixture.running, messagePath(fixture), {
    method: "POST",
    body: {
      content: attempt.transcript,
      clientMessageId: crypto.randomUUID(),
      inputMethod: "voice",
      transcriptionId: attempt.id,
    },
  });
  assert.equal(voice.response.status, 503);
  assert.equal(voice.body.error, "TRANSCRIPTION_NOT_AVAILABLE");
  assert.equal(responderCalls, 0);
  assert.deepEqual(await mutationCounts(fixture), {
    messages: 0,
    turns: 0,
    workouts: 0,
    workout_events: 0,
  });
  assert.equal((await fixture.disposable.pool.query(
    "SELECT status FROM goals_coach_transcription_attempts WHERE id = $1",
    [attempt.id]
  )).rows[0].status, "completed");
});
