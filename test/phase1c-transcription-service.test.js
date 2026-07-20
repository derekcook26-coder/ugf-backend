const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { runMigration } = require("../migrate_005");
const {
  MAXIMUM_TRANSCRIPT_CHARACTERS,
  MAXIMUM_TRANSCRIPTION_AUDIO_BYTES,
  TranscriptionAdapterError,
  transcribeWithAdapter,
  validateTranscriptionAdapter,
} = require("../src/goals-coach/transcription-adapter");
const {
  createTranscriptionService,
  sessionDigest,
} = require("../src/goals-coach/transcription-service");
const {
  createDisposableDatabase,
  seedAlphaMapping,
  seedMemberAndPlan,
} = require("./helpers/disposable-db");
const {
  createDeterministicTranscriptionAdapter,
} = require("./helpers/deterministic-transcription-adapter");

const BINDING_KEY = "synthetic-phase1c-binding-key";
const MIME = "audio/webm;codecs=opus";

async function seedFixture(pool, suffix) {
  const seeded = await seedMemberAndPlan(pool, suffix);
  const mapping = await seedAlphaMapping(pool, seeded.member, suffix, true);
  const conversation = (await pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [seeded.member.id, seeded.plan.id]
  )).rows[0];
  return {
    ...seeded,
    mapping,
    conversation,
    member: {
      mappingId: String(mapping.id),
      memberId: String(seeded.member.id),
      authProvider: mapping.auth_provider,
      authSubject: mapping.auth_subject,
    },
  };
}

function request(fixture, overrides = {}) {
  return {
    member: fixture.member,
    authenticatedSessionId: "synthetic-authenticated-session",
    conversationId: String(fixture.conversation.id),
    planId: String(fixture.plan.id),
    requestId: crypto.randomUUID(),
    retry: false,
    audio: Buffer.from("synthetic-voice-audio"),
    mimeType: MIME,
    ...overrides,
  };
}

function service(pool, deterministic, options = {}) {
  return createTranscriptionService({
    db: pool,
    adapter: deterministic.adapter,
    bindingKey: BINDING_KEY,
    providerTimeoutMs: 30,
    operationTimeoutMs: 80,
    retryDelayMs: 2000,
    expiryMs: 50,
    maximumPerMinute: 3,
    maximumPerDay: 30,
    ...options,
  });
}

async function disposableFixture(t, suffix) {
  const disposable = await createDisposableDatabase({ phase1b: true });
  t.after(() => disposable.close());
  await runMigration({ pool: disposable.pool });
  const fixture = await seedFixture(disposable.pool, suffix);
  return { disposable, fixture };
}

test("transcription adapter contract validates shape, signal, text bounds, and authoritative duration", async () => {
  assert.throws(
    () => validateTranscriptionAdapter({ transcribe() {} }),
    /providerIdentifier/
  );
  const deterministic = createDeterministicTranscriptionAdapter({
    text: `  ${"x".repeat(9000)}  `,
    durationMs: 29999,
  });
  const controller = new AbortController();
  const result = await transcribeWithAdapter(deterministic.adapter, {
    requestId: crypto.randomUUID(),
    audio: Buffer.from("audio"),
    mimeType: MIME,
    maximumDurationMs: 30000,
    signal: controller.signal,
  });
  assert.equal(result.text.length, MAXIMUM_TRANSCRIPT_CHARACTERS);
  assert.equal(result.durationMs, 29999);
  assert.deepEqual(deterministic.getCalls(), [{
    requestId: deterministic.getCalls()[0].requestId,
    mimeType: MIME,
    audioByteCount: 5,
    maximumDurationMs: 30000,
    signalProvided: true,
  }]);

  await assert.rejects(
    transcribeWithAdapter(deterministic.adapter, {
      requestId: crypto.randomUUID(),
      audio: Buffer.from("audio"),
      mimeType: MIME,
      maximumDurationMs: 30000,
    }),
    (error) => error instanceof TranscriptionAdapterError
      && error.failureCategory === "provider_error"
  );
  const empty = createDeterministicTranscriptionAdapter({ text: "  ", durationMs: 1 });
  await assert.rejects(
    transcribeWithAdapter(empty.adapter, {
      requestId: crypto.randomUUID(), audio: Buffer.from("audio"), mimeType: MIME,
      maximumDurationMs: 30000, signal: new AbortController().signal,
    }),
    (error) => error.failureCategory === "unintelligible_audio"
  );
  const invalidDuration = createDeterministicTranscriptionAdapter({ durationMs: 30001 });
  await assert.rejects(
    transcribeWithAdapter(invalidDuration.adapter, {
      requestId: crypto.randomUUID(), audio: Buffer.from("audio"), mimeType: MIME,
      maximumDurationMs: 30000, signal: new AbortController().signal,
    }),
    (error) => error.failureCategory === "provider_error"
  );
});

test("adapter boundary accepts exactly one MiB and rejects one byte more before invocation", async () => {
  const exactLimit = createDeterministicTranscriptionAdapter();
  const exactResult = await transcribeWithAdapter(exactLimit.adapter, {
    requestId: crypto.randomUUID(),
    audio: Buffer.alloc(MAXIMUM_TRANSCRIPTION_AUDIO_BYTES),
    mimeType: MIME,
    maximumDurationMs: 30000,
    signal: new AbortController().signal,
  });
  assert.equal(exactResult.durationMs, 1200);
  assert.equal(exactLimit.getCallCount(), 1);

  const oversized = createDeterministicTranscriptionAdapter();
  await assert.rejects(
    transcribeWithAdapter(oversized.adapter, {
      requestId: crypto.randomUUID(),
      audio: Buffer.alloc(MAXIMUM_TRANSCRIPTION_AUDIO_BYTES + 1),
      mimeType: MIME,
      maximumDurationMs: 30000,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof TranscriptionAdapterError
      && error.failureCategory === "invalid_audio"
      && error.message === "Transcription provider could not complete the request"
      && !Object.hasOwn(error, "cause")
  );
  assert.equal(oversized.getCallCount(), 0);
});

test("deterministic adapter exposes only approved minimized failure categories", async () => {
  for (const failureCategory of [
    "invalid_audio",
    "unintelligible_audio",
    "provider_timeout",
    "provider_unavailable",
    "provider_error",
  ]) {
    const deterministic = createDeterministicTranscriptionAdapter({
      type: "failure",
      failureCategory,
    });
    await assert.rejects(
      transcribeWithAdapter(deterministic.adapter, {
        requestId: crypto.randomUUID(), audio: Buffer.from("audio"), mimeType: MIME,
        maximumDurationMs: 30000, signal: new AbortController().signal,
      }),
      (error) => error instanceof TranscriptionAdapterError
        && error.failureCategory === failureCategory
        && !Object.hasOwn(error, "cause")
    );
  }
});

test("production composition cannot import or select the deterministic transcription adapter", () => {
  const root = path.resolve(__dirname, "..");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const productionSources = [
    "src/goals-coach/transcription-adapter.js",
    "src/goals-coach/transcription-service.js",
    "src/goals-coach/phase1c-startup.js",
  ].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(serverSource, /deterministic-transcription-adapter/);
  assert.doesNotMatch(productionSources, /test\/helpers|deterministic-transcription-adapter/);
  assert.doesNotMatch(serverSource, /createTranscriptionService/);
});

test("transcription service rejects retry delays below 2000 milliseconds", () => {
  const deterministic = createDeterministicTranscriptionAdapter();
  const db = Object.freeze({ connect() {}, query() {} });
  for (const retryDelayMs of [1, 1999]) {
    assert.throws(
      () => createTranscriptionService({
        db,
        adapter: deterministic.adapter,
        bindingKey: BINDING_KEY,
        providerTimeoutMs: 30,
        operationTimeoutMs: 80,
        retryDelayMs,
      }),
      /retryDelayMs must be at least 2000/
    );
  }
  const accepted = createTranscriptionService({
    db,
    adapter: deterministic.adapter,
    bindingKey: BINDING_KEY,
    providerTimeoutMs: 30,
    operationTimeoutMs: 80,
    retryDelayMs: 2000,
  });
  assert.equal(typeof accepted.transcribe, "function");
});

test("successful transcription persists only bounded provenance and returns authoritative duration", async (t) => {
  const { disposable, fixture } = await disposableFixture(t, "service-success");
  const deterministic = createDeterministicTranscriptionAdapter({
    text: "  A bounded synthetic transcript.  ",
    durationMs: 2345,
  });
  const transcriptionService = service(disposable.pool, deterministic);
  const input = request(fixture);
  const result = await transcriptionService.transcribe(input);
  assert.deepEqual(result, {
    transcriptionId: result.transcriptionId,
    requestId: input.requestId,
    attemptNumber: 1,
    transcript: "A bounded synthetic transcript.",
    durationMs: 2345,
    expiresAt: result.expiresAt,
  });
  assert.match(result.transcriptionId, /^[0-9a-f-]{36}$/);
  assert.equal(deterministic.getCallCount(), 1);

  const row = (await disposable.pool.query(
    "SELECT * FROM goals_coach_transcription_attempts WHERE id = $1",
    [result.transcriptionId]
  )).rows[0];
  assert.equal(row.status, "completed");
  assert.equal(row.audio_byte_count, input.audio.length);
  assert.equal(row.audio_duration_ms, 2345);
  assert.equal(row.audio_digest, crypto.createHash("sha256").update(input.audio).digest("hex"));
  assert.equal(row.transcript_digest, crypto.createHash("sha256").update(result.transcript).digest("hex"));
  assert.equal(
    row.auth_session_digest,
    sessionDigest(BINDING_KEY, input.authenticatedSessionId)
  );
  assert.doesNotMatch(JSON.stringify(row), /bounded synthetic transcript/i);
  assert.doesNotMatch(JSON.stringify(row), /synthetic-voice-audio/i);
});

test("finalization revalidates locked ownership and fails closed after an in-flight mapping change", async (t) => {
  const { disposable, fixture } = await disposableFixture(t, "service-finalize-ownership-change");
  let providerEntered;
  let releaseProvider;
  const entered = new Promise((resolve) => { providerEntered = resolve; });
  const released = new Promise((resolve) => { releaseProvider = resolve; });
  t.after(() => releaseProvider());
  const deterministic = createDeterministicTranscriptionAdapter({
    text: "Ownership must be revalidated after the provider returns",
    durationMs: 1234,
    async onCall() {
      providerEntered();
      await released;
    },
  });
  const transcriptionService = service(disposable.pool, deterministic, {
    providerTimeoutMs: 1000,
    operationTimeoutMs: 2000,
  });
  const pending = transcriptionService.transcribe(request(fixture));
  await entered;
  await disposable.pool.query(
    `UPDATE goals_coach_member_auth_mappings
     SET active = FALSE
     WHERE id = $1 AND member_id = $2`,
    [fixture.mapping.id, fixture.member.memberId]
  );
  releaseProvider();
  await assert.rejects(
    pending,
    (error) => error.statusCode === 404 && error.code === "TRANSCRIPTION_NOT_FOUND"
  );
  assert.equal(deterministic.getCallCount(), 1);
  const stored = (await disposable.pool.query(
    `SELECT status, failure_category, provider_completed_at,
            transcript_digest, expires_at
     FROM goals_coach_transcription_attempts`
  )).rows[0];
  assert.equal(stored.status, "failed");
  assert.equal(stored.failure_category, "provider_error");
  assert.ok(stored.provider_completed_at);
  assert.equal(stored.transcript_digest, null);
  assert.equal(stored.expires_at, null);
});

test("completed duplicate is rejected without reconstructing a lost transcript response", async (t) => {
  const { disposable, fixture } = await disposableFixture(t, "service-completed-duplicate");
  const deterministic = createDeterministicTranscriptionAdapter();
  const transcriptionService = service(disposable.pool, deterministic);
  const input = request(fixture);
  await transcriptionService.transcribe(input);
  await assert.rejects(
    transcriptionService.transcribe(input),
    (error) => error.statusCode === 409
      && error.code === "TRANSCRIPTION_ALREADY_COMPLETED"
  );
  assert.equal(deterministic.getCallCount(), 1);
});

test("failed first attempt remains blocked at 1999 ms and retries at exactly 2000 ms", async (t) => {
  const { disposable, fixture } = await disposableFixture(t, "service-retry");
  let now = new Date();
  const deterministic = createDeterministicTranscriptionAdapter({ outcomes: [
    { type: "failure", failureCategory: "provider_unavailable" },
    { type: "success", text: "Retry transcript", durationMs: 1400 },
  ] });
  const transcriptionService = service(disposable.pool, deterministic, { now: () => now });
  const input = request(fixture);
  await assert.rejects(
    transcriptionService.transcribe(input),
    (error) => error.code === "TRANSCRIPTION_PROVIDER_UNAVAILABLE"
  );
  await assert.rejects(
    transcriptionService.transcribe({ ...input, retry: true }),
    (error) => error.code === "TRANSCRIPTION_RETRY_DELAY"
  );
  now = new Date(now.getTime() + 1999);
  await assert.rejects(
    transcriptionService.transcribe({ ...input, retry: true }),
    (error) => error.code === "TRANSCRIPTION_RETRY_DELAY"
  );
  assert.equal(deterministic.getCallCount(), 1);
  now = new Date(now.getTime() + 1);
  const result = await transcriptionService.transcribe({ ...input, retry: true });
  assert.equal(result.attemptNumber, 2);
  assert.equal(result.transcript, "Retry transcript");
  assert.equal(deterministic.getCallCount(), 2);
  assert.deepEqual((await disposable.pool.query(
    `SELECT attempt_number, status
     FROM goals_coach_transcription_attempts
     WHERE request_id = $1 ORDER BY attempt_number`,
    [input.requestId]
  )).rows, [
    { attempt_number: 1, status: "failed" },
    { attempt_number: 2, status: "completed" },
  ]);
});

test("retry rejects changed bytes, changed MIME, and any third provider attempt", async (t) => {
  const firstDatabase = await disposableFixture(t, "service-conflicts");
  let now = new Date();
  const failed = createDeterministicTranscriptionAdapter({
    type: "failure",
    failureCategory: "provider_error",
  });
  const failedService = service(firstDatabase.disposable.pool, failed, { now: () => now });
  const input = request(firstDatabase.fixture);
  await assert.rejects(failedService.transcribe(input));
  now = new Date(now.getTime() + 2000);
  await assert.rejects(
    failedService.transcribe({ ...input, retry: true, audio: Buffer.from("changed-audio") }),
    (error) => error.code === "TRANSCRIPTION_REQUEST_CONFLICT"
  );
  await assert.rejects(
    failedService.transcribe({ ...input, retry: true, mimeType: "audio/mp4" }),
    (error) => error.code === "TRANSCRIPTION_REQUEST_CONFLICT"
  );

  const secondDatabase = await disposableFixture(t, "service-third-attempt");
  let secondNow = new Date();
  const twiceFailed = createDeterministicTranscriptionAdapter({ outcomes: [
    { type: "failure", failureCategory: "provider_error" },
    { type: "failure", failureCategory: "provider_timeout" },
  ] });
  const twiceFailedService = service(secondDatabase.disposable.pool, twiceFailed, {
    now: () => secondNow,
  });
  const secondInput = request(secondDatabase.fixture);
  await assert.rejects(twiceFailedService.transcribe(secondInput));
  secondNow = new Date(secondNow.getTime() + 2000);
  await assert.rejects(twiceFailedService.transcribe({ ...secondInput, retry: true }));
  secondNow = new Date(secondNow.getTime() + 2000);
  await assert.rejects(
    twiceFailedService.transcribe({ ...secondInput, retry: true }),
    (error) => error.code === "TRANSCRIPTION_ATTEMPT_LIMIT_REACHED"
  );
  assert.equal(twiceFailed.getCallCount(), 2);
});

test("expired completed attempt commits expired state before concealed not-found", async (t) => {
  const { disposable, fixture } = await disposableFixture(t, "service-expiry");
  let now = new Date();
  const deterministic = createDeterministicTranscriptionAdapter();
  const transcriptionService = service(disposable.pool, deterministic, {
    now: () => now,
    expiryMs: 5,
  });
  const input = request(fixture);
  const completed = await transcriptionService.transcribe(input);
  now = new Date(now.getTime() + 6);
  await assert.rejects(
    transcriptionService.transcribe(input),
    (error) => error.statusCode === 404 && error.code === "TRANSCRIPTION_NOT_FOUND"
  );
  const persisted = (await disposable.pool.query(
    "SELECT status FROM goals_coach_transcription_attempts WHERE id = $1",
    [completed.transcriptionId]
  )).rows[0];
  assert.equal(persisted.status, "expired");
  assert.equal(deterministic.getCallCount(), 1);
});

test("cross-member, cross-session, cross-conversation, and cross-plan replay is concealed", async (t) => {
  const { disposable, fixture } = await disposableFixture(t, "service-owner-a");
  const other = await seedFixture(disposable.pool, "service-owner-b");
  const deterministic = createDeterministicTranscriptionAdapter();
  const transcriptionService = service(disposable.pool, deterministic);
  const input = request(fixture);
  await transcriptionService.transcribe(input);

  const secondPlan = (await disposable.pool.query(
    `INSERT INTO coach_plans (member_id, profile_json, assessment_messages, plan_markdown)
     VALUES ($1, '{}'::jsonb, '[]'::jsonb, 'Second synthetic plan') RETURNING *`,
    [fixture.member.memberId]
  )).rows[0];
  const secondConversation = (await disposable.pool.query(
    `INSERT INTO coaching_conversations (member_id, plan_id)
     VALUES ($1, $2) RETURNING *`,
    [fixture.member.memberId, secondPlan.id]
  )).rows[0];

  for (const changed of [
    { authenticatedSessionId: "other-authenticated-session" },
    { conversationId: String(secondConversation.id), planId: String(secondPlan.id) },
    { planId: String(secondPlan.id) },
    {
      member: other.member,
      authenticatedSessionId: "other-member-session",
      conversationId: String(other.conversation.id),
      planId: String(other.plan.id),
    },
  ]) {
    await assert.rejects(
      transcriptionService.transcribe({ ...input, ...changed }),
      (error) => error.statusCode === 404 && error.code === "TRANSCRIPTION_NOT_FOUND"
    );
  }
  assert.equal(deterministic.getCallCount(), 1);
});

test("provider timeout persists minimized failure and late completion cannot rewrite it", async (t) => {
  const { disposable, fixture } = await disposableFixture(t, "service-late");
  const deterministic = createDeterministicTranscriptionAdapter({
    type: "late_completion",
    delayMs: 30,
    text: "This late result must be discarded",
    durationMs: 900,
  });
  const transcriptionService = service(disposable.pool, deterministic, {
    providerTimeoutMs: 5,
    operationTimeoutMs: 50,
  });
  const input = request(fixture);
  await assert.rejects(
    transcriptionService.transcribe(input),
    (error) => error.code === "TRANSCRIPTION_PROVIDER_TIMEOUT"
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const row = (await disposable.pool.query(
    `SELECT status, failure_category, transcript_digest, audio_duration_ms
     FROM goals_coach_transcription_attempts
     WHERE request_id = $1`,
    [input.requestId]
  )).rows[0];
  assert.deepEqual(row, {
    status: "failed",
    failure_category: "provider_timeout",
    transcript_digest: null,
    audio_duration_ms: null,
  });
  assert.equal(deterministic.getCallCount(), 1);
});

test("minute and daily attempt limits are enforced from persisted provider attempts", async (t) => {
  const minuteDatabase = await disposableFixture(t, "service-minute-limit");
  let minuteNow = new Date();
  const minuteAdapter = createDeterministicTranscriptionAdapter();
  const minuteService = service(minuteDatabase.disposable.pool, minuteAdapter, {
    now: () => minuteNow,
    maximumPerMinute: 1,
    maximumPerDay: 2,
  });
  await minuteService.transcribe(request(minuteDatabase.fixture));
  await assert.rejects(
    minuteService.transcribe(request(minuteDatabase.fixture)),
    (error) => error.statusCode === 429 && error.code === "TRANSCRIPTION_MINUTE_LIMIT"
  );

  const dailyDatabase = await disposableFixture(t, "service-day-limit");
  let dailyNow = new Date();
  const dailyAdapter = createDeterministicTranscriptionAdapter();
  const dailyService = service(dailyDatabase.disposable.pool, dailyAdapter, {
    now: () => dailyNow,
    maximumPerMinute: 1,
    maximumPerDay: 1,
  });
  await dailyService.transcribe(request(dailyDatabase.fixture));
  dailyNow = new Date(dailyNow.getTime() + 61 * 1000);
  await assert.rejects(
    dailyService.transcribe(request(dailyDatabase.fixture)),
    (error) => error.statusCode === 429 && error.code === "TRANSCRIPTION_DAILY_LIMIT"
  );
});

test("failed authorization transaction leaves no attempt and protected errors are never logged", async (t) => {
  const { disposable, fixture } = await disposableFixture(t, "service-privacy");
  const rawProviderError = "RAW_PROVIDER_SECRET_PAYLOAD";
  const adapter = Object.freeze({
    providerIdentifier: "synthetic-private-provider",
    modelIdentifier: "synthetic-private-model",
    async transcribe() {
      throw new Error(rawProviderError);
    },
  });
  const transcriptionService = createTranscriptionService({
    db: disposable.pool,
    adapter,
    bindingKey: BINDING_KEY,
    providerTimeoutMs: 30,
    operationTimeoutMs: 80,
  });
  const captured = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...values) => captured.push(values.join(" "));
  console.error = (...values) => captured.push(values.join(" "));
  console.warn = (...values) => captured.push(values.join(" "));
  try {
    await assert.rejects(
      transcriptionService.transcribe(request(fixture, { planId: "999999999" })),
      (error) => error.code === "TRANSCRIPTION_NOT_FOUND"
    );
    assert.equal((await disposable.pool.query(
      "SELECT COUNT(*)::int AS count FROM goals_coach_transcription_attempts"
    )).rows[0].count, 0);
    await assert.rejects(
      transcriptionService.transcribe(request(fixture)),
      (error) => error.code === "TRANSCRIPTION_PROVIDER_UNAVAILABLE"
    );
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }
  assert.deepEqual(captured, []);
  const row = (await disposable.pool.query(
    "SELECT status, failure_category FROM goals_coach_transcription_attempts"
  )).rows[0];
  assert.deepEqual(row, { status: "failed", failure_category: "provider_error" });
  assert.doesNotMatch(JSON.stringify(row), new RegExp(rawProviderError));
});
