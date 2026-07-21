"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { APPROVED_ALPHA_CONSENT_VERSION } = require("../src/goals-coach/alpha-config");
const { createPhase1bCoachingService } = require("../src/goals-coach/phase1b-service");
const { createSafetyService } = require("../src/goals-coach/safety-service");
const { sessionDigest } = require("../src/goals-coach/transcription-service");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
  seedStaff,
} = require("./helpers/disposable-db");

const APPLICATION_CONFIGURATION = Object.freeze({
  valid: true,
  consentVersion: APPROVED_ALPHA_CONSENT_VERSION,
  alphaEnvironment: "test",
});

function coachingOutput(configuration) {
  return {
    reply: "A synthetic ordinary coaching response.",
    mode: "continue",
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

async function fixture(t, suffix, safetyService, reviewRouting) {
  const disposable = await createDisposableDatabase({ phase1dSafety: true });
  t.after(() => disposable.close());
  const seeded = await seedMemberAndPlan(disposable.pool, suffix);
  const mapping = await seedAlphaMapping(disposable.pool, seeded.member, suffix, true);
  const conversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  await disposable.pool.query(
    `INSERT INTO goals_coach_alpha_consents
      (member_id, auth_mapping_id, consent_version, environment, status, accepted_at)
     VALUES ($1, $2, $3, 'test', 'accepted', NOW())`,
    [seeded.member.id, mapping.id, APPROVED_ALPHA_CONSENT_VERSION]
  );
  let providerCalls = 0;
  const configuration = Object.freeze({
    providerIdentifier: "synthetic-phase1d-provider",
    modelIdentifier: "synthetic-phase1d-model",
    promptVersion: "GC-PROMPT-1B-1.0",
    structuredOutputVersion: "GC-OUTPUT-1B-1.0",
    safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B",
    providerTimeoutMs: 100,
  });
  const service = createPhase1bCoachingService({
    db: disposable.pool,
    applicationConfiguration: APPLICATION_CONFIGURATION,
    safetyService,
    reviewRouting,
    safetyEnvironment: "test",
    engine: {
      configuration,
      async generateTurn() {
        providerCalls += 1;
        return { output: coachingOutput(configuration) };
      },
    },
  });
  return {
    pool: disposable.pool,
    service,
    conversation,
    member: {
      mappingId: String(mapping.id),
      memberId: String(seeded.member.id),
      authProvider: mapping.auth_provider,
      authSubject: mapping.auth_subject,
    },
    providerCalls: () => providerCalls,
  };
}

async function insertCompletedVoiceAttempt(pool, fx, content, bindingKey, sessionId) {
  const sha256 = (value) => require("node:crypto").createHash("sha256").update(value, "utf8").digest("hex");
  return (await pool.query(
    `INSERT INTO goals_coach_transcription_attempts
      (id, request_id, attempt_number, member_id, auth_mapping_id, auth_session_digest,
       conversation_id, plan_id, status, mime_type, audio_byte_count, audio_duration_ms, audio_digest,
       transcript_digest, provider_identifier, model_identifier, provider_started_at,
       provider_completed_at, expires_at, created_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'completed',
       'audio/webm;codecs=opus', 32, 1200, $8, $9, 'synthetic-transcription',
       'synthetic-model', NOW() - INTERVAL '2 seconds', NOW() - INTERVAL '1 second',
       NOW() + INTERVAL '10 minutes', NOW() - INTERVAL '3 seconds')
     RETURNING *`,
    [
      crypto.randomUUID(), crypto.randomUUID(), fx.member.memberId, fx.member.mappingId,
      sessionDigest(bindingKey, sessionId), fx.conversation.id, fx.conversation.plan_id,
      sha256("synthetic-audio"), sha256(content),
    ]
  )).rows[0];
}

function input(content, clientMessageId = crypto.randomUUID()) {
  return { content, clientMessageId, inputMethod: "text" };
}

test("urgent Phase 1D safety stops ordinary coaching, records a review, and replays safely", async (t) => {
  const fx = await fixture(t, "phase1d-urgent", createSafetyService());
  const request = input("I have chest pain during this set");
  const first = await fx.service.sendMessage(fx.member, fx.conversation.id, request);
  const replay = await fx.service.sendMessage(fx.member, fx.conversation.id, request);

  assert.equal(fx.providerCalls(), 0);
  assert.equal(first.response.structuredResponse.mode, "safety_stop");
  assert.match(first.response.content, /Chest pain during activity/);
  assert.equal(first.review.status, "new");
  assert.equal(first.review.routingStatus, "pending");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.response.id, first.response.id);
  assert.deepEqual((await fx.pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM goals_coach_coaching_turns) AS turns,
       (SELECT COUNT(*)::int FROM coaching_concerns WHERE concern_category = 'safety') AS concerns,
       (SELECT COUNT(*)::int FROM coaching_reviews WHERE status = 'new' AND routing_status = 'pending') AS reviews,
       (SELECT COUNT(*)::int FROM coaching_review_events WHERE event_type = 'created') AS events`
  )).rows[0], { turns: 0, concerns: 1, reviews: 1, events: 1 });
});

test("review and classifier failure are both protected before the provider and do not claim delivery", async (t) => {
  const unavailableClassifier = createSafetyService({
    async classify() {
      throw new Error("synthetic classifier outage");
    },
  });
  const fx = await fixture(t, "phase1d-classifier-failure", unavailableClassifier);
  const result = await fx.service.sendMessage(
    fx.member,
    fx.conversation.id,
    input("Can you make this exercise harder?")
  );

  assert.equal(fx.providerCalls(), 0);
  assert.equal(result.response.structuredResponse.mode, "safety_stop");
  assert.equal(result.response.structuredResponse.routingConfirmed, false);
  assert.doesNotMatch(result.response.content, /sent|notified|delivered/i);
  const stored = await fx.pool.query(
    `SELECT concern_category, safety_level, member_description, routing_status
     FROM coaching_concerns concern
     JOIN coaching_reviews review ON review.concern_id = concern.id`
  );
  assert.deepEqual(stored.rows, [{
    concern_category: "technical_failure",
    safety_level: "priority",
    member_description: null,
    routing_status: "pending",
  }]);
});

test("indirect historical language stays eligible for ordinary synthetic coaching", async (t) => {
  const fx = await fixture(t, "phase1d-indirect", createSafetyService());
  const result = await fx.service.sendMessage(
    fx.member,
    fx.conversation.id,
    input("My friend quoted a movie character with chest pain last year.")
  );

  assert.equal(fx.providerCalls(), 1);
  assert.equal(result.turn.providerStatus, "completed");
  assert.equal((await fx.pool.query("SELECT COUNT(*)::int AS count FROM coaching_concerns")).rows[0].count, 0);
});

test("voice safety preserves the certified consumed-attempt boundary without calling the provider", async (t) => {
  const bindingKey = "phase1d-synthetic-binding-key";
  const sessionId = "phase1d-synthetic-session";
  const fx = await fixture(t, "phase1d-voice", createSafetyService());
  // Recreate with the certified voice boundary enabled; the ordinary service
  // remains provider-free after the safety decision.
  const original = fx.service;
  const configuration = original ? {
    providerIdentifier: "synthetic-phase1d-provider", modelIdentifier: "synthetic-phase1d-model",
    promptVersion: "GC-PROMPT-1B-1.0", structuredOutputVersion: "GC-OUTPUT-1B-1.0",
    safetyRuleVersion: "GC-SAFETY-PLACEHOLDER-1B", providerTimeoutMs: 100,
  } : null;
  let calls = 0;
  const voiceService = createPhase1bCoachingService({
    db: fx.pool,
    applicationConfiguration: APPLICATION_CONFIGURATION,
    safetyService: createSafetyService(),
    phase1cStartup: { status: "ready" },
    transcriptionBindingKey: bindingKey,
    engine: {
      configuration,
      async generateTurn() { calls += 1; return { output: coachingOutput(configuration) }; },
    },
  });
  const content = "I have chest pain while lifting";
  const attempt = await insertCompletedVoiceAttempt(fx.pool, fx, content, bindingKey, sessionId);
  const voiceInput = {
    content,
    clientMessageId: crypto.randomUUID(),
    inputMethod: "voice",
    transcriptionId: attempt.id,
  };
  const result = await voiceService.sendMessage(
    fx.member,
    fx.conversation.id,
    voiceInput,
    { authenticatedSessionId: sessionId }
  );
  const replay = await voiceService.sendMessage(
    fx.member,
    fx.conversation.id,
    voiceInput,
    { authenticatedSessionId: sessionId }
  );
  assert.equal(calls, 0);
  assert.equal(result.response.structuredResponse.mode, "safety_stop");
  assert.equal(replay.idempotentReplay, true);
  const attemptAfter = await fx.pool.query(
    "SELECT status, consumed_member_message_id FROM goals_coach_transcription_attempts WHERE id = $1",
    [attempt.id]
  );
  assert.equal(attemptAfter.rows[0].status, "consumed");
  assert.equal(String(attemptAfter.rows[0].consumed_member_message_id), result.memberMessageId);
  assert.deepEqual((await fx.pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE provider_status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE provider_status = 'failed')::int AS failed
     FROM goals_coach_coaching_turns`
  )).rows[0], { total: 2, pending: 0, failed: 2 });
});

test("text safety classification cannot call an optional classifier before current consent is revalidated", async (t) => {
  let classifierCalls = 0;
  const fx = await fixture(t, "phase1d-consent-before-classifier", createSafetyService({
    async classify() { classifierCalls += 1; return { decision: "continue", category: "other" }; },
  }));
  await fx.pool.query(
    `UPDATE goals_coach_alpha_consents
     SET status = 'withdrawn',
         withdrawn_at = NOW()
     WHERE member_id = $1 AND auth_mapping_id = $2`,
    [fx.member.memberId, fx.member.mappingId]
  );
  await assert.rejects(
    () => fx.service.sendMessage(fx.member, fx.conversation.id, input("I have chest pain now")),
    (error) => error && error.code === "ALPHA_CONSENT_REQUIRED"
  );
  assert.equal(classifierCalls, 0);
});

test("an active human restriction outranks ordinary coaching and is never delegated to the provider", async (t) => {
  const fx = await fixture(t, "phase1d-human-restriction", createSafetyService());
  const staff = await seedStaff(fx.pool, "phase1d-human-restriction", "admin");
  const source = (await fx.pool.query(
    `INSERT INTO coaching_messages (conversation_id, member_id, sender_type, content)
     VALUES ($1, $2, 'member', 'Earlier safety concern') RETURNING *`,
    [fx.conversation.id, fx.member.memberId]
  )).rows[0];
  const concern = (await fx.pool.query(
    `INSERT INTO coaching_concerns (member_id, conversation_id, source_message_id, plan_id, concern_category, safety_level)
     VALUES ($1, $2, $3, $4, 'safety', 'priority') RETURNING *`,
    [fx.member.memberId, fx.conversation.id, source.id, fx.conversation.plan_id]
  )).rows[0];
  const review = (await fx.pool.query(
    `INSERT INTO coaching_reviews (concern_id, member_id, conversation_id, plan_id, priority, review_category, status)
     VALUES ($1, $2, $3, $4, 'priority', 'safety', 'new') RETURNING *`,
    [concern.id, fx.member.memberId, fx.conversation.id, fx.conversation.plan_id]
  )).rows[0];
  await fx.pool.query(
    `INSERT INTO goals_coach_human_restrictions
      (member_id, conversation_id, review_id, author_staff_user_id, restriction_type, instruction_text)
     VALUES ($1, $2, $3, $4, 'prohibited_exercise', 'No loaded overhead pressing')`,
    [fx.member.memberId, fx.conversation.id, review.id, staff.id]
  );
  const result = await fx.service.sendMessage(
    fx.member, fx.conversation.id, input("Can I do another overhead press?")
  );
  assert.equal(fx.providerCalls(), 0);
  assert.equal(result.response.structuredResponse.mode, "safety_stop");
  assert.match(result.response.content, /human-approved safety restriction/i);
});
