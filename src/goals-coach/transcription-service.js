const crypto = require("crypto");
const {
  MAXIMUM_TRANSCRIPTION_AUDIO_BYTES,
  MAXIMUM_TRANSCRIPTION_DURATION_MS,
  SUPPORTED_TRANSCRIPTION_MIME_TYPES,
  TranscriptionAdapterError,
  canonicalUuid,
  transcribeWithAdapter,
  validateTranscriptionAdapter,
} = require("./transcription-adapter");

const MAXIMUM_AUDIO_BYTES = MAXIMUM_TRANSCRIPTION_AUDIO_BYTES;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;
const DEFAULT_OPERATION_TIMEOUT_MS = 20000;
const DEFAULT_EXPIRY_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 2000;
const DEFAULT_MAXIMUM_PER_MINUTE = 3;
const DEFAULT_MAXIMUM_PER_DAY = 30;

function serviceError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.exposeMessage = true;
  return error;
}

function concealedNotFound() {
  return serviceError(404, "TRANSCRIPTION_NOT_FOUND", "Transcription not found");
}

function conflict(code, message) {
  return serviceError(409, code, message);
}

function positiveInteger(value, fallback, name) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return selected;
}

function normalizedIdentifier(value, maximumLength) {
  return typeof value === "string"
    && value === value.trim()
    && value.length >= 1
    && value.length <= maximumLength;
}

function positiveDatabaseId(value) {
  return /^(?:[1-9]\d*)$/.test(String(value || ""));
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sessionDigest(bindingKey, authenticatedSessionId) {
  return crypto.createHmac("sha256", bindingKey).update(authenticatedSessionId).digest("hex");
}

function sameIdentifier(left, right) {
  return String(left) === String(right);
}

function validateInput(input) {
  if (!input || typeof input !== "object") {
    throw serviceError(400, "TRANSCRIPTION_REQUEST_INVALID", "Invalid transcription request");
  }
  const member = input.member;
  if (
    !member
    || !positiveDatabaseId(member.mappingId)
    || !positiveDatabaseId(member.memberId)
    || !normalizedIdentifier(member.authProvider, 40)
    || !normalizedIdentifier(member.authSubject, 200)
  ) {
    throw concealedNotFound();
  }
  if (
    !positiveDatabaseId(input.conversationId)
    || !positiveDatabaseId(input.planId)
  ) {
    throw concealedNotFound();
  }
  if (
    typeof input.authenticatedSessionId !== "string"
    || input.authenticatedSessionId.length < 1
    || input.authenticatedSessionId.length > 4096
  ) {
    throw concealedNotFound();
  }
  if (!canonicalUuid(input.requestId)) {
    throw serviceError(
      400,
      "TRANSCRIPTION_REQUEST_ID_INVALID",
      "requestId must be a canonical UUID"
    );
  }
  if (!Buffer.isBuffer(input.audio) || input.audio.length < 1) {
    throw serviceError(422, "TRANSCRIPTION_INVALID_AUDIO", "Audio is required");
  }
  if (input.audio.length > MAXIMUM_AUDIO_BYTES) {
    throw serviceError(413, "TRANSCRIPTION_AUDIO_TOO_LARGE", "Audio exceeds the size limit");
  }
  if (!SUPPORTED_TRANSCRIPTION_MIME_TYPES.includes(input.mimeType)) {
    throw serviceError(415, "TRANSCRIPTION_MIME_UNSUPPORTED", "Audio type is unsupported");
  }
  if (input.retry !== undefined && typeof input.retry !== "boolean") {
    throw serviceError(400, "TRANSCRIPTION_RETRY_INVALID", "retry must be a boolean");
  }
  return input;
}

async function withTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Preserve the original transaction error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function ensureDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Transcription clock returned an invalid date");
  return date;
}

function ownsAttempt(row, context) {
  return sameIdentifier(row.member_id, context.memberId)
    && sameIdentifier(row.auth_mapping_id, context.mappingId)
    && row.auth_session_digest === context.authSessionDigest
    && sameIdentifier(row.conversation_id, context.conversationId)
    && sameIdentifier(row.plan_id, context.planId);
}

function adapterFailureResponse(failureCategory) {
  if (failureCategory === "invalid_audio") {
    return serviceError(422, "TRANSCRIPTION_INVALID_AUDIO", "Audio could not be processed");
  }
  if (failureCategory === "unintelligible_audio") {
    return serviceError(
      422,
      "TRANSCRIPTION_AUDIO_UNINTELLIGIBLE",
      "Audio could not be understood"
    );
  }
  if (failureCategory === "provider_timeout") {
    return serviceError(
      503,
      "TRANSCRIPTION_PROVIDER_TIMEOUT",
      "Transcription is temporarily unavailable"
    );
  }
  return serviceError(
    503,
    "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
    "Transcription is temporarily unavailable"
  );
}

function createTranscriptionService(options = {}) {
  const db = options.db;
  const adapter = validateTranscriptionAdapter(options.adapter);
  if (!db || typeof db.connect !== "function" || typeof db.query !== "function") {
    throw new Error("Transcription service requires a database pool");
  }
  const bindingKey = options.bindingKey;
  if (
    !(typeof bindingKey === "string" || Buffer.isBuffer(bindingKey))
    || bindingKey.length < 1
  ) {
    throw new Error("Transcription service requires a Phase 1C binding key");
  }

  const configuration = options.configuration || {};
  const providerTimeoutMs = positiveInteger(
    options.providerTimeoutMs === undefined
      ? configuration.transcriptionTimeoutMs
      : options.providerTimeoutMs,
    DEFAULT_PROVIDER_TIMEOUT_MS,
    "providerTimeoutMs"
  );
  const operationTimeoutMs = positiveInteger(
    options.operationTimeoutMs === undefined
      ? configuration.transcriptionRequestTimeoutMs
      : options.operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    "operationTimeoutMs"
  );
  if (operationTimeoutMs <= providerTimeoutMs) {
    throw new Error("operationTimeoutMs must exceed providerTimeoutMs");
  }
  const expiryMs = positiveInteger(options.expiryMs, DEFAULT_EXPIRY_MS, "expiryMs");
  const retryDelayMs = positiveInteger(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs"
  );
  if (retryDelayMs < DEFAULT_RETRY_DELAY_MS) {
    throw new Error(`retryDelayMs must be at least ${DEFAULT_RETRY_DELAY_MS}`);
  }
  const maximumPerMinute = positiveInteger(
    options.maximumPerMinute === undefined
      ? configuration.transcriptionMaxPerMinute
      : options.maximumPerMinute,
    DEFAULT_MAXIMUM_PER_MINUTE,
    "maximumPerMinute"
  );
  const maximumPerDay = positiveInteger(
    options.maximumPerDay === undefined
      ? configuration.transcriptionMaxPerDay
      : options.maximumPerDay,
    DEFAULT_MAXIMUM_PER_DAY,
    "maximumPerDay"
  );
  if (maximumPerDay < maximumPerMinute) {
    throw new Error("maximumPerDay must be at least maximumPerMinute");
  }
  const clock = typeof options.now === "function" ? options.now : () => new Date();

  async function requireOwnership(client, context) {
    const mapping = await client.query(
      `SELECT id
       FROM goals_coach_member_auth_mappings
       WHERE id = $1
         AND member_id = $2
         AND auth_provider = $3
         AND auth_subject = $4
         AND active = TRUE
       FOR UPDATE`,
      [
        context.mappingId,
        context.memberId,
        context.authProvider,
        context.authSubject,
      ]
    );
    if (!mapping.rows.length) return false;
    const conversation = await client.query(
      `SELECT id
       FROM coaching_conversations
       WHERE id = $1
         AND member_id = $2
         AND plan_id = $3
         AND status = 'active'
       FOR UPDATE`,
      [context.conversationId, context.memberId, context.planId]
    );
    return conversation.rows.length === 1;
  }

  async function establishAttempt(input, context, audioDigest, stagedAt) {
    return withTransaction(db, async (client) => {
      if (!(await requireOwnership(client, context))) return { type: "concealed" };

      const requestAttempts = await client.query(
        `SELECT *
         FROM goals_coach_transcription_attempts
         WHERE request_id = $1
         ORDER BY attempt_number`,
        [input.requestId]
      );
      if (requestAttempts.rows.some((row) => !ownsAttempt(row, context))) {
        return { type: "concealed" };
      }

      const attempts = requestAttempts.rows;
      const latest = attempts.length ? attempts[attempts.length - 1] : null;
      if (latest) {
        if (latest.audio_digest !== audioDigest || latest.mime_type !== input.mimeType) {
          throw conflict(
            "TRANSCRIPTION_REQUEST_CONFLICT",
            "requestId was already used for different audio"
          );
        }
        if (latest.status === "pending") {
          throw conflict(
            "TRANSCRIPTION_IN_PROGRESS",
            "Transcription is already in progress"
          );
        }
        if (latest.status === "completed") {
          if (new Date(latest.expires_at).getTime() <= stagedAt.getTime()) {
            const expired = await client.query(
              `UPDATE goals_coach_transcription_attempts
               SET status = 'expired'
               WHERE id = $1
                 AND status = 'completed'
                 AND expires_at <= $2
               RETURNING id`,
              [latest.id, stagedAt]
            );
            if (expired.rows.length) return { type: "expired" };
          }
          throw conflict(
            "TRANSCRIPTION_ALREADY_COMPLETED",
            "Transcription was already completed"
          );
        }
        if (latest.status === "consumed" || latest.status === "expired") {
          return { type: "concealed" };
        }
        if (!input.retry) {
          throw conflict(
            "TRANSCRIPTION_RETRY_REQUIRED",
            "An explicit retry is required after a failed attempt"
          );
        }
        if (latest.attempt_number !== 1 || attempts.length >= 2) {
          throw conflict(
            "TRANSCRIPTION_ATTEMPT_LIMIT_REACHED",
            "No additional transcription attempts are allowed"
          );
        }
        const retryReadyAt = new Date(latest.provider_completed_at).getTime() + retryDelayMs;
        if (stagedAt.getTime() < retryReadyAt) {
          throw conflict(
            "TRANSCRIPTION_RETRY_DELAY",
            "Retry is not available yet"
          );
        }
      } else if (input.retry) {
        throw conflict(
          "TRANSCRIPTION_RETRY_NOT_AVAILABLE",
          "No failed transcription is available to retry"
        );
      }

      const pending = await client.query(
        `SELECT id
         FROM goals_coach_transcription_attempts
         WHERE member_id = $1 AND status = 'pending'
         LIMIT 1`,
        [context.memberId]
      );
      if (pending.rows.length) {
        throw conflict(
          "TRANSCRIPTION_IN_PROGRESS",
          "Another transcription is already in progress"
        );
      }

      const rate = (await client.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE created_at >= $2::timestamptz - INTERVAL '1 minute'
           )::int AS minute_count,
           COUNT(*) FILTER (
             WHERE created_at >= $2::timestamptz - INTERVAL '1 day'
           )::int AS day_count
         FROM goals_coach_transcription_attempts
         WHERE member_id = $1`,
        [context.memberId, stagedAt]
      )).rows[0];
      if (Number(rate.minute_count) >= maximumPerMinute) {
        throw serviceError(
          429,
          "TRANSCRIPTION_MINUTE_LIMIT",
          "Transcription rate limit reached"
        );
      }
      if (Number(rate.day_count) >= maximumPerDay) {
        throw serviceError(
          429,
          "TRANSCRIPTION_DAILY_LIMIT",
          "Transcription daily limit reached"
        );
      }

      const attemptNumber = latest ? 2 : 1;
      const attemptId = crypto.randomUUID();
      const inserted = await client.query(
        `INSERT INTO goals_coach_transcription_attempts
          (id, request_id, attempt_number, member_id, auth_mapping_id,
           auth_session_digest, conversation_id, plan_id, status, mime_type,
           audio_byte_count, audio_digest, provider_identifier, model_identifier,
           provider_started_at, created_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9,
           $10, $11, $12, $13, $14, $14)
         RETURNING *`,
        [
          attemptId,
          input.requestId,
          attemptNumber,
          context.memberId,
          context.mappingId,
          context.authSessionDigest,
          context.conversationId,
          context.planId,
          input.mimeType,
          input.audio.length,
          audioDigest,
          adapter.providerIdentifier,
          adapter.modelIdentifier,
          stagedAt,
        ]
      );
      return { type: "created", attempt: inserted.rows[0] };
    });
  }

  async function recordFailure(attempt, failureCategory, completedAt) {
    return withTransaction(db, async (client) => {
      const failed = await client.query(
        `UPDATE goals_coach_transcription_attempts
         SET status = 'failed',
             failure_category = $1,
             provider_completed_at = $2
         WHERE id = $3
           AND member_id = $4
           AND auth_mapping_id = $5
           AND auth_session_digest = $6
           AND conversation_id = $7
           AND plan_id = $8
           AND request_id = $9
           AND attempt_number = $10
           AND status = 'pending'
         RETURNING id`,
        [
          failureCategory,
          completedAt,
          attempt.id,
          attempt.member_id,
          attempt.auth_mapping_id,
          attempt.auth_session_digest,
          attempt.conversation_id,
          attempt.plan_id,
          attempt.request_id,
          attempt.attempt_number,
        ]
      );
      return failed.rows.length === 1;
    });
  }

  async function finalizeAttempt(attempt, context, result, completedAt, operationDeadline) {
    return withTransaction(db, async (client) => {
      const selected = await client.query(
        `SELECT *
         FROM goals_coach_transcription_attempts
         WHERE id = $1
         FOR UPDATE`,
        [attempt.id]
      );
      if (
        !selected.rows.length
        || selected.rows[0].status !== "pending"
        || !ownsAttempt(selected.rows[0], context)
        || !sameIdentifier(selected.rows[0].request_id, attempt.request_id)
        || Number(selected.rows[0].attempt_number) !== Number(attempt.attempt_number)
      ) {
        return { type: "lost" };
      }
      if (!(await requireOwnership(client, context))) {
        const failed = await client.query(
          `UPDATE goals_coach_transcription_attempts
           SET status = 'failed',
               failure_category = 'provider_error',
               provider_completed_at = $1
           WHERE id = $2 AND status = 'pending'
           RETURNING id`,
          [completedAt, attempt.id]
        );
        return failed.rows.length ? { type: "ownership_changed" } : { type: "lost" };
      }

      if (Date.now() >= operationDeadline) {
        const failed = await client.query(
          `UPDATE goals_coach_transcription_attempts
           SET status = 'failed',
               failure_category = 'provider_timeout',
               provider_completed_at = $1
           WHERE id = $2 AND status = 'pending'
           RETURNING id`,
          [completedAt, attempt.id]
        );
        return failed.rows.length ? { type: "deadline" } : { type: "lost" };
      }

      const expiresAt = new Date(completedAt.getTime() + expiryMs);
      const transcriptDigest = digest(result.text);
      const completed = await client.query(
        `UPDATE goals_coach_transcription_attempts
         SET status = 'completed',
             audio_duration_ms = $1,
             transcript_digest = $2,
             provider_completed_at = $3,
             expires_at = $4
         WHERE id = $5 AND status = 'pending'
         RETURNING id, request_id, attempt_number, audio_duration_ms, expires_at`,
        [result.durationMs, transcriptDigest, completedAt, expiresAt, attempt.id]
      );
      if (!completed.rows.length) return { type: "lost" };
      return { type: "completed", row: completed.rows[0], expiresAt };
    });
  }

  async function invokeAdapter(input, attempt) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TranscriptionAdapterError("provider_timeout"));
      }, providerTimeoutMs);
    });
    try {
      return await Promise.race([
        transcribeWithAdapter(adapter, {
          requestId: String(attempt.id),
          audio: input.audio,
          mimeType: input.mimeType,
          maximumDurationMs: MAXIMUM_TRANSCRIPTION_DURATION_MS,
          signal: controller.signal,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function transcribe(rawInput) {
    const operationStartedAt = Date.now();
    const operationDeadline = operationStartedAt + operationTimeoutMs;
    const input = validateInput(rawInput);
    const stagedAt = ensureDate(clock());
    const context = Object.freeze({
      mappingId: String(input.member.mappingId),
      memberId: String(input.member.memberId),
      authProvider: input.member.authProvider,
      authSubject: input.member.authSubject,
      authSessionDigest: sessionDigest(bindingKey, input.authenticatedSessionId),
      conversationId: String(input.conversationId),
      planId: String(input.planId),
    });
    const audioDigest = digest(input.audio);
    const established = await establishAttempt(input, context, audioDigest, stagedAt);
    if (established.type === "concealed" || established.type === "expired") {
      // The expiry transition has committed before this concealed response is raised.
      throw concealedNotFound();
    }

    const attempt = established.attempt;
    if (Date.now() >= operationDeadline) {
      const failed = await recordFailure(attempt, "provider_timeout", ensureDate(clock()));
      if (!failed) throw concealedNotFound();
      throw adapterFailureResponse("provider_timeout");
    }
    let result;
    try {
      result = await invokeAdapter(input, attempt);
      if (Date.now() >= operationDeadline) {
        throw new TranscriptionAdapterError("provider_timeout");
      }
    } catch (error) {
      const failureCategory = error instanceof TranscriptionAdapterError
        ? error.failureCategory
        : "provider_error";
      const failed = await recordFailure(attempt, failureCategory, ensureDate(clock()));
      if (!failed) throw concealedNotFound();
      throw adapterFailureResponse(failureCategory);
    }

    const completedAt = ensureDate(clock());
    if (Date.now() >= operationDeadline) {
      const failed = await recordFailure(attempt, "provider_timeout", completedAt);
      if (!failed) throw concealedNotFound();
      throw adapterFailureResponse("provider_timeout");
    }
    const finalized = await finalizeAttempt(
      attempt,
      context,
      result,
      completedAt,
      operationDeadline
    );
    if (finalized.type === "deadline") {
      throw adapterFailureResponse("provider_timeout");
    }
    if (finalized.type !== "completed") throw concealedNotFound();

    return Object.freeze({
      transcriptionId: String(finalized.row.id),
      requestId: String(finalized.row.request_id),
      attemptNumber: Number(finalized.row.attempt_number),
      transcript: result.text,
      durationMs: Number(finalized.row.audio_duration_ms),
      expiresAt: finalized.expiresAt.toISOString(),
    });
  }

  return Object.freeze({ transcribe });
}

module.exports = {
  DEFAULT_EXPIRY_MS,
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  MAXIMUM_AUDIO_BYTES,
  createTranscriptionService,
  sessionDigest,
};
