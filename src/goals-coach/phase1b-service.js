const crypto = require("crypto");
const { buildCoachingContext, serializeWorkoutSession } = require("./coaching-context");
const {
  RETRYABLE_FAILURE_CATEGORIES,
  loadCompletedTurnResult,
  serializeCoachMessage,
} = require("./phase1b-contracts");
const { conflict, notFound, withTransaction } = require("./repository");
const { canonicalUuid } = require("./transcription-adapter");
const { sessionDigest } = require("./transcription-service");
const { applyWorkoutTransition } = require("./workout-state");

const COACHING_UNAVAILABLE_MESSAGE =
  "Goals Coach is temporarily unavailable. Your conversation is saved, but I can’t safely generate the next coaching step right now.";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function terminalFailureCategory(error) {
  const value = error && (error.failureCategory || error.code);
  const normalized = String(value || "coaching_transaction_failed").trim();
  return normalized.slice(0, 100) || "coaching_transaction_failed";
}

function unavailableError(failureCategory) {
  const error = new Error(COACHING_UNAVAILABLE_MESSAGE);
  error.statusCode = 503;
  error.code = "COACHING_TEMPORARILY_UNAVAILABLE";
  error.failureCategory = failureCategory;
  error.exposeMessage = true;
  error.publicDetails = Object.freeze({ messageSaved: true, retrySafe: true });
  return error;
}

function storedFailureError(failureCategory) {
  if (RETRYABLE_FAILURE_CATEGORIES.has(failureCategory)) {
    return unavailableError(failureCategory);
  }
  const error = new Error("The coaching turn could not be completed safely");
  error.statusCode = 409;
  error.code = /^[A-Z][A-Z0-9_]{1,99}$/.test(failureCategory || "")
    ? failureCategory
    : "COACHING_TURN_FAILED";
  return error;
}

function voiceUnavailableError() {
  const error = new Error("Transcription is not available.");
  error.statusCode = 503;
  error.code = "TRANSCRIPTION_NOT_AVAILABLE";
  error.exposeMessage = true;
  return error;
}

function concealedTranscriptionNotFound() {
  return notFound("TRANSCRIPTION_NOT_FOUND", "Transcription not found");
}

function sameIdentifier(left, right) {
  return String(left) === String(right);
}

function transcriptDigest(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function validBindingKey(value) {
  return (typeof value === "string" || Buffer.isBuffer(value)) && value.length > 0;
}

async function requireActiveMappingAndConsent(client, member, configuration) {
  if (!configuration || !configuration.valid) {
    const error = new Error("Private-alpha application configuration is incomplete");
    error.statusCode = 503;
    error.code = "ALPHA_APPLICATION_NOT_CONFIGURED";
    throw error;
  }

  const mapping = await client.query(
    `SELECT id
     FROM goals_coach_member_auth_mappings
     WHERE id = $1
       AND member_id = $2
       AND auth_provider = $3
       AND auth_subject = $4
       AND active = TRUE
     FOR UPDATE`,
    [member.mappingId, member.memberId, member.authProvider, member.authSubject]
  );
  if (!mapping.rows.length) {
    const error = new Error("Private-alpha access is unavailable");
    error.statusCode = 403;
    error.code = "ALPHA_ACCESS_FORBIDDEN";
    throw error;
  }

  const consent = await client.query(
    `SELECT id
     FROM goals_coach_alpha_consents
     WHERE member_id = $1
       AND auth_mapping_id = $2
       AND consent_version = $3
       AND environment = $4
       AND status = 'accepted'
     FOR UPDATE`,
    [
      member.memberId,
      member.mappingId,
      configuration.consentVersion,
      configuration.alphaEnvironment,
    ]
  );
  if (!consent.rows.length) {
    const error = new Error("Current private-alpha consent is required");
    error.statusCode = 403;
    error.code = "ALPHA_CONSENT_REQUIRED";
    throw error;
  }
}

function createPhase1bCoachingService(options) {
  const db = options.db;
  const engine = options.engine;
  const applicationConfiguration = options.applicationConfiguration;
  const phase1cStartup = options.phase1cStartup || null;
  // Phase 1D is opt-in while the private alpha remains disabled by default.
  // A supplied safety service runs before the coaching provider and may only
  // replace ordinary coaching with a safer, locally persisted response.
  const safetyService = options.safetyService || null;
  const reviewRouting = options.reviewRouting || null;
  const safetyEnvironment = typeof options.safetyEnvironment === "string"
    ? options.safetyEnvironment.slice(0, 100)
    : "test";
  const transcriptionBindingKey = options.transcriptionBindingKey;
  const voiceSubmissionReady = Boolean(
    phase1cStartup
    && phase1cStartup.status === "ready"
    && validBindingKey(transcriptionBindingKey)
  );
  const clock = typeof options.now === "function" ? options.now : () => new Date();
  const pollIntervalMs = Number.isInteger(options.pendingPollIntervalMs)
    ? options.pendingPollIntervalMs
    : 15;
  const waitTimeoutMs = Number.isInteger(options.pendingWaitTimeoutMs)
    ? options.pendingWaitTimeoutMs
    : engine.configuration.providerTimeoutMs + 2000;
  const transactionHooks = options.transactionHooks || null;

  if (!db || typeof db.connect !== "function") {
    throw new Error("Phase 1B coaching service requires a database pool");
  }
  if (!engine || typeof engine.generateTurn !== "function" || !engine.configuration) {
    throw new Error("Phase 1B coaching service requires a configured coaching engine");
  }

  async function runTransactionHook(name, client) {
    const hook = transactionHooks && transactionHooks[name];
    if (typeof hook !== "function") return;
    const backend = await client.query("SELECT pg_backend_pid()::int AS pid");
    await hook({ backendPid: Number(backend.rows[0].pid) });
  }

  async function stageTextTurn(member, conversationId, input) {
    return withTransaction(db, async (client) => {
      await requireActiveMappingAndConsent(client, member, applicationConfiguration);
      const conversation = await client.query(
        `SELECT *
         FROM coaching_conversations
         WHERE id = $1 AND member_id = $2
         FOR UPDATE`,
        [conversationId, member.memberId]
      );
      if (!conversation.rows.length) {
        throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      if (conversation.rows[0].status !== "active") {
        throw conflict("CONVERSATION_CLOSED", "This private-alpha conversation is complete");
      }

      const existingMessage = await client.query(
        `SELECT *
         FROM coaching_messages
         WHERE conversation_id = $1
           AND member_id = $2
           AND sender_type = 'member'
           AND client_message_id = $3
         LIMIT 1`,
        [conversationId, member.memberId, input.clientMessageId]
      );
      let memberMessage = existingMessage.rows[0] || null;
      if (memberMessage && memberMessage.content !== input.content) {
        throw conflict(
          "CLIENT_MESSAGE_ID_CONFLICT",
          "That clientMessageId was already used for different content"
        );
      }

      if (memberMessage) {
        const previousTurn = await client.query(
          `SELECT *
           FROM goals_coach_coaching_turns
           WHERE member_message_id = $1
             AND conversation_id = $2
             AND member_id = $3
           ORDER BY attempt_number DESC
           LIMIT 1`,
          [memberMessage.id, conversationId, member.memberId]
        );
        if (previousTurn.rows.length) {
          const turn = previousTurn.rows[0];
          if (turn.input_method !== "text") {
            throw conflict(
              "CLIENT_MESSAGE_ID_CONFLICT",
              "That clientMessageId was already used for a different input method"
            );
          }
          if (turn.provider_status === "completed") {
            return {
              type: "completed",
              result: await loadCompletedTurnResult(client, turn, true),
            };
          }
          if (turn.provider_status === "pending") {
            return { type: "pending", turnId: String(turn.id) };
          }
        }
      }

      const otherPending = await client.query(
        `SELECT id
         FROM goals_coach_coaching_turns
         WHERE conversation_id = $1
           AND member_id = $2
           AND provider_status = 'pending'
         LIMIT 1`,
        [conversationId, member.memberId]
      );
      if (otherPending.rows.length) {
        throw conflict(
          "COACHING_TURN_IN_PROGRESS",
          "Another coaching turn is still being processed"
        );
      }

      if (!memberMessage) {
        const inserted = await client.query(
          `INSERT INTO coaching_messages
            (conversation_id, member_id, sender_type, content, client_message_id)
           VALUES ($1, $2, 'member', $3, $4)
           RETURNING *`,
          [conversationId, member.memberId, input.content, input.clientMessageId]
        );
        memberMessage = inserted.rows[0];
      }

      const stagedAt = clock();
      const built = await buildCoachingContext({
        client,
        member,
        conversationId,
        memberMessage: input.content,
        now: stagedAt,
      });
      const attempt = await client.query(
        `SELECT COALESCE(MAX(attempt_number), 0)::int + 1 AS next_attempt
         FROM goals_coach_coaching_turns
         WHERE member_message_id = $1`,
        [memberMessage.id]
      );
      const requestId = crypto.randomUUID();
      const turn = await client.query(
        `INSERT INTO goals_coach_coaching_turns
          (member_id, conversation_id, plan_id, member_message_id,
           provider_identifier, model_identifier, prompt_version,
           structured_output_version, safety_rule_version, request_id,
           attempt_number, input_method, context_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'text', $12)
         RETURNING *`,
        [
          member.memberId,
          conversationId,
          built.conversation.plan_id,
          memberMessage.id,
          engine.configuration.providerIdentifier,
          engine.configuration.modelIdentifier,
          engine.configuration.promptVersion,
          engine.configuration.structuredOutputVersion,
          engine.configuration.safetyRuleVersion,
          requestId,
          attempt.rows[0].next_attempt,
          built.digest,
        ]
      );

      return {
        type: "generate",
        turn: turn.rows[0],
        memberMessage,
        context: built.context,
        contextDigest: built.digest,
        stagedAt,
      };
    });
  }

  async function authorizeSafetyAssessment(member, conversationId) {
    return withTransaction(db, async (client) => {
      await requireActiveMappingAndConsent(client, member, applicationConfiguration);
      const conversation = await client.query(
        `SELECT id, status
         FROM coaching_conversations
         WHERE id = $1 AND member_id = $2
         FOR UPDATE`,
        [conversationId, member.memberId]
      );
      if (!conversation.rows.length) {
        throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      if (conversation.rows[0].status !== "active") {
        throw conflict("CONVERSATION_CLOSED", "This private-alpha conversation is complete");
      }
    });
  }

  async function stageVoiceTurn(member, conversationId, input, requestContext) {
    if (!voiceSubmissionReady) throw voiceUnavailableError();
    if (
      !canonicalUuid(input.transcriptionId)
      || !requestContext
      || typeof requestContext.authenticatedSessionId !== "string"
      || requestContext.authenticatedSessionId.length < 1
      || requestContext.authenticatedSessionId.length > 4096
    ) {
      throw concealedTranscriptionNotFound();
    }

    const authenticatedSessionDigest = sessionDigest(
      transcriptionBindingKey,
      requestContext.authenticatedSessionId
    );
    const result = await withTransaction(db, async (client) => {
      await requireActiveMappingAndConsent(client, member, applicationConfiguration);
      const conversation = await client.query(
        `SELECT *
         FROM coaching_conversations
         WHERE id = $1 AND member_id = $2
         FOR UPDATE`,
        [conversationId, member.memberId]
      );
      if (!conversation.rows.length) {
        throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      if (conversation.rows[0].status !== "active") {
        throw conflict("CONVERSATION_CLOSED", "This private-alpha conversation is complete");
      }

      // Match the certified rollback/write order: coaching turns before attempts.
      await runTransactionHook("beforeVoiceTurnLock", client);
      await client.query(
        "LOCK TABLE goals_coach_coaching_turns IN ROW EXCLUSIVE MODE"
      );
      await runTransactionHook("afterVoiceTurnLock", client);

      const existingMessage = await client.query(
        `SELECT *
         FROM coaching_messages
         WHERE conversation_id = $1
           AND member_id = $2
           AND sender_type = 'member'
           AND client_message_id = $3
         LIMIT 1`,
        [conversationId, member.memberId, input.clientMessageId]
      );
      let memberMessage = existingMessage.rows[0] || null;
      if (memberMessage && memberMessage.content !== input.content) {
        throw conflict(
          "CLIENT_MESSAGE_ID_CONFLICT",
          "That clientMessageId was already used for different content"
        );
      }

      let previousTurns = [];
      if (memberMessage) {
        const turnResult = await client.query(
          `SELECT *
           FROM goals_coach_coaching_turns
           WHERE member_message_id = $1
             AND conversation_id = $2
             AND member_id = $3
           ORDER BY attempt_number ASC`,
          [memberMessage.id, conversationId, member.memberId]
        );
        previousTurns = turnResult.rows;
        const firstTurn = previousTurns[0];
        if (
          !firstTurn
          || previousTurns.some((turn) => turn.input_method !== "voice")
          || !sameIdentifier(firstTurn.transcription_attempt_id, input.transcriptionId)
        ) {
          throw conflict(
            "CLIENT_MESSAGE_ID_CONFLICT",
            "That clientMessageId was already used for different voice provenance"
          );
        }
      }

      const attemptResult = await client.query(
        `SELECT *
         FROM goals_coach_transcription_attempts
         WHERE id = $1
         FOR UPDATE`,
        [input.transcriptionId]
      );
      if (!attemptResult.rows.length) throw concealedTranscriptionNotFound();
      const transcriptionAttempt = attemptResult.rows[0];
      const authoritativeScopeMatches =
        sameIdentifier(transcriptionAttempt.member_id, member.memberId)
        && sameIdentifier(transcriptionAttempt.auth_mapping_id, member.mappingId)
        && transcriptionAttempt.auth_session_digest === authenticatedSessionDigest
        && sameIdentifier(transcriptionAttempt.conversation_id, conversationId)
        && sameIdentifier(transcriptionAttempt.plan_id, conversation.rows[0].plan_id);
      if (!authoritativeScopeMatches) throw concealedTranscriptionNotFound();

      const stagedAt = clock();
      const expiresAt = new Date(transcriptionAttempt.expires_at);
      if (
        transcriptionAttempt.status === "completed"
        && !Number.isNaN(expiresAt.getTime())
        && expiresAt.getTime() <= stagedAt.getTime()
      ) {
        await client.query(
          `UPDATE goals_coach_transcription_attempts
           SET status = 'expired'
           WHERE id = $1 AND status = 'completed'`,
          [transcriptionAttempt.id]
        );
        return { type: "expired" };
      }

      if (memberMessage) {
        if (
          transcriptionAttempt.status !== "consumed"
          || !sameIdentifier(
            transcriptionAttempt.consumed_member_message_id,
            memberMessage.id
          )
        ) {
          throw concealedTranscriptionNotFound();
        }
        const latestTurn = previousTurns[previousTurns.length - 1];
        if (latestTurn.provider_status === "completed") {
          return {
            type: "completed",
            result: await loadCompletedTurnResult(client, latestTurn, true),
          };
        }
        if (latestTurn.provider_status === "pending") {
          return { type: "pending", turnId: String(latestTurn.id) };
        }
      } else {
        if (
          transcriptionAttempt.status !== "completed"
          || transcriptionAttempt.consumed_at !== null
          || transcriptionAttempt.consumed_member_message_id !== null
        ) {
          throw concealedTranscriptionNotFound();
        }
      }

      const otherPending = await client.query(
        `SELECT id
         FROM goals_coach_coaching_turns
         WHERE conversation_id = $1
           AND member_id = $2
           AND provider_status = 'pending'
           AND ($3::bigint IS NULL OR member_message_id <> $3)
         LIMIT 1`,
        [conversationId, member.memberId, memberMessage ? memberMessage.id : null]
      );
      if (otherPending.rows.length) {
        throw conflict(
          "COACHING_TURN_IN_PROGRESS",
          "Another coaching turn is still being processed"
        );
      }

      if (!memberMessage) {
        const inserted = await client.query(
          `INSERT INTO coaching_messages
            (conversation_id, member_id, sender_type, content, client_message_id)
           VALUES ($1, $2, 'member', $3, $4)
           RETURNING *`,
          [conversationId, member.memberId, input.content, input.clientMessageId]
        );
        memberMessage = inserted.rows[0];
      }

      const built = await buildCoachingContext({
        client,
        member,
        conversationId,
        memberMessage: input.content,
        now: stagedAt,
      });
      const attemptNumber = await client.query(
        `SELECT COALESCE(MAX(attempt_number), 0)::int + 1 AS next_attempt
         FROM goals_coach_coaching_turns
         WHERE member_message_id = $1`,
        [memberMessage.id]
      );
      const firstVoiceTurn = previousTurns.length === 0;
      const requestId = crypto.randomUUID();
      const turn = await client.query(
        `INSERT INTO goals_coach_coaching_turns
          (member_id, conversation_id, plan_id, member_message_id,
           provider_identifier, model_identifier, prompt_version,
           structured_output_version, safety_rule_version, request_id,
           attempt_number, input_method, transcription_attempt_id, context_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'voice', $12, $13)
         RETURNING *`,
        [
          member.memberId,
          conversationId,
          built.conversation.plan_id,
          memberMessage.id,
          engine.configuration.providerIdentifier,
          engine.configuration.modelIdentifier,
          engine.configuration.promptVersion,
          engine.configuration.structuredOutputVersion,
          engine.configuration.safetyRuleVersion,
          requestId,
          attemptNumber.rows[0].next_attempt,
          firstVoiceTurn ? transcriptionAttempt.id : null,
          built.digest,
        ]
      );

      if (firstVoiceTurn) {
        const consumed = await client.query(
          `UPDATE goals_coach_transcription_attempts
           SET status = 'consumed',
               consumed_at = $1,
               consumed_member_message_id = $2,
               transcript_edited = $3
           WHERE id = $4
             AND status = 'completed'
             AND consumed_at IS NULL
             AND consumed_member_message_id IS NULL
           RETURNING id`,
          [
            stagedAt,
            memberMessage.id,
            transcriptDigest(input.content) !== transcriptionAttempt.transcript_digest,
            transcriptionAttempt.id,
          ]
        );
        if (!consumed.rows.length) throw concealedTranscriptionNotFound();
      }

      return {
        type: "generate",
        turn: turn.rows[0],
        memberMessage,
        context: built.context,
        contextDigest: built.digest,
        stagedAt,
      };
    });

    // The expiry transition must commit before the concealed response is raised.
    if (result.type === "expired") throw concealedTranscriptionNotFound();
    return result;
  }

  async function stageSafetyResponse(member, conversationId, input, assessment, options = {}) {
    return withTransaction(db, async (client) => {
      await requireActiveMappingAndConsent(client, member, applicationConfiguration);
      const conversationResult = await client.query(
        `SELECT *
         FROM coaching_conversations
         WHERE id = $1 AND member_id = $2
         FOR UPDATE`,
        [conversationId, member.memberId]
      );
      if (!conversationResult.rows.length) {
        throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      const conversation = conversationResult.rows[0];
      if (conversation.status !== "active") {
        throw conflict("CONVERSATION_CLOSED", "This private-alpha conversation is complete");
      }

      const existingMessage = await client.query(
        `SELECT *
         FROM coaching_messages
         WHERE conversation_id = $1
           AND member_id = $2
           AND sender_type = 'member'
           AND client_message_id = $3
         LIMIT 1`,
        [conversationId, member.memberId, input.clientMessageId]
      );
      let memberMessage = existingMessage.rows[0] || null;
      if (memberMessage && memberMessage.content !== input.content) {
        throw conflict(
          "CLIENT_MESSAGE_ID_CONFLICT",
          "That clientMessageId was already used for different content"
        );
      }

      // A safety escalation always outranks an in-flight ordinary response,
      // including a retry staged immediately before an idempotent safety replay.
      await client.query(
        `UPDATE goals_coach_coaching_turns
         SET provider_status = 'failed',
             failure_category = 'safety_review_required',
             provider_completed_at = NOW()
         WHERE conversation_id = $1
           AND member_id = $2
           AND provider_status = 'pending'`,
        [conversationId, member.memberId]
      );

      if (memberMessage) {
        const existingReview = await client.query(
          `SELECT review.id AS review_id, review.status, review.routing_status,
                  coach_message.id AS coach_message_id,
                  coach_message.conversation_id AS coach_conversation_id,
                  coach_message.member_id AS coach_member_id,
                  coach_message.sender_type AS coach_sender_type,
                  coach_message.content AS coach_content,
                  coach_message.structured_response_json AS coach_structured_response_json,
                  coach_message.created_at AS coach_created_at
           FROM coaching_concerns concern
           JOIN coaching_reviews review ON review.concern_id = concern.id
           LEFT JOIN coaching_messages coach_message
             ON coach_message.conversation_id = concern.conversation_id
            AND coach_message.member_id = concern.member_id
            AND coach_message.sender_type = 'goals_coach'
            AND coach_message.structured_response_json->>'safetyReviewId' = review.id::text
           WHERE concern.source_message_id = $1
             AND concern.conversation_id = $2
             AND concern.member_id = $3
           LIMIT 1`,
          [memberMessage.id, conversationId, member.memberId]
        );
        if (existingReview.rows.length) {
          const row = existingReview.rows[0];
          if (!row.review_id || !row.coach_message_id || !row.coach_content) {
            throw new Error("Safety review replay is missing its protected response");
          }
          return {
            type: "replay",
            result: {
              memberMessageId: String(memberMessage.id),
              response: serializeCoachMessage({
                id: row.coach_message_id,
                conversation_id: row.coach_conversation_id,
                member_id: row.coach_member_id,
                sender_type: row.coach_sender_type,
                content: row.coach_content,
                structured_response_json: row.coach_structured_response_json,
                created_at: row.coach_created_at,
              }),
              workoutState: null,
              turn: null,
              review: {
                id: String(row.review_id),
                status: row.status,
                routingStatus: row.routing_status,
              },
              idempotentReplay: true,
            },
          };
        }
        if (!options.allowExistingPendingMessage) {
          throw conflict(
            "CLIENT_MESSAGE_ID_CONFLICT",
            "That clientMessageId was already used for a different coaching result"
          );
        }
      }

      if (!memberMessage) {
        const insertedMessage = await client.query(
          `INSERT INTO coaching_messages
            (conversation_id, member_id, sender_type, content, client_message_id)
           VALUES ($1, $2, 'member', $3, $4)
           RETURNING *`,
          [conversationId, member.memberId, input.content, input.clientMessageId]
        );
        memberMessage = insertedMessage.rows[0];
      }
      const concern = await client.query(
        `INSERT INTO coaching_concerns
          (member_id, conversation_id, source_message_id, plan_id,
           concern_category, safety_level, concerning_signals_json,
           stop_exercise, member_follow_up_required, member_follow_up_status,
           safety_rule_version, safety_classifier_version,
           classification_result_json, member_response, environment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, 'not_required',
                 $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          member.memberId,
          conversationId,
          memberMessage.id,
          conversation.plan_id,
          assessment.category,
          assessment.priority,
          [assessment.reasonCode],
          Boolean(assessment.stopNormalCoaching),
          assessment.ruleVersion,
          assessment.classifierVersion,
          {
            decision: assessment.decision,
            priority: assessment.priority,
            category: assessment.category,
            reasonCode: assessment.reasonCode,
            classifierStatus: assessment.classifierStatus,
          },
          assessment.memberResponse,
          safetyEnvironment,
        ]
      );
      const review = await client.query(
        `INSERT INTO coaching_reviews
          (concern_id, member_id, conversation_id, plan_id, priority,
           review_category, status, routing_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'new', 'pending')
         RETURNING *`,
        [
          concern.rows[0].id,
          member.memberId,
          conversationId,
          conversation.plan_id,
          assessment.priority,
          assessment.category,
        ]
      );
      await client.query(
        `INSERT INTO coaching_review_events (review_id, member_id, event_type, event_details_json)
         VALUES ($1, $2, 'created', $3)`,
        [
          review.rows[0].id,
          member.memberId,
          {
            decision: assessment.decision,
            priority: assessment.priority,
            ruleVersion: assessment.ruleVersion,
            classifierStatus: assessment.classifierStatus,
          },
        ]
      );
      const coachMessage = await client.query(
        `INSERT INTO coaching_messages
          (conversation_id, member_id, sender_type, content, structured_response_json)
         VALUES ($1, $2, 'goals_coach', $3, $4)
         RETURNING *`,
        [
          conversationId,
          member.memberId,
          assessment.memberResponse,
          {
            mode: assessment.stopNormalCoaching ? "safety_stop" : "human_review",
            phase: "phase_1d",
            safetyReviewId: String(review.rows[0].id),
            decision: assessment.decision,
            priority: assessment.priority,
            reviewRequired: true,
            routingConfirmed: false,
          },
        ]
      );
      return {
        type: "created",
        review: review.rows[0],
        result: {
          memberMessageId: String(memberMessage.id),
          response: serializeCoachMessage(coachMessage.rows[0]),
          workoutState: null,
          turn: null,
          review: {
            id: String(review.rows[0].id),
            status: review.rows[0].status,
            routingStatus: review.rows[0].routing_status,
          },
          idempotentReplay: false,
        },
      };
    });
  }

  async function activeHumanRestrictions(member, conversationId) {
    if (!safetyService) return [];
    return withTransaction(db, async (client) => {
      await requireActiveMappingAndConsent(client, member, applicationConfiguration);
      const conversation = await client.query(
        `SELECT id
         FROM coaching_conversations
         WHERE id = $1 AND member_id = $2 AND status = 'active'
         FOR UPDATE`,
        [conversationId, member.memberId]
      );
      if (!conversation.rows.length) return [];
      const restrictions = await client.query(
        `SELECT id, restriction_type
         FROM goals_coach_human_restrictions
         WHERE member_id = $1
           AND conversation_id = $2
           AND status = 'active'
           AND effective_at <= NOW()
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY effective_at DESC, id DESC`,
        [member.memberId, conversationId]
      );
      return restrictions.rows;
    });
  }

  function restrictionAssessment(restrictions) {
    if (!restrictions.length) return null;
    return Object.freeze({
      decision: "review",
      priority: "priority",
      category: "technique_uncertainty",
      stopNormalCoaching: true,
      reviewRequired: true,
      ruleVersion: "GC-SAFETY-1D-1",
      classifierVersion: null,
      classifierStatus: "not_configured",
      reasonCode: "active_human_restriction",
      memberResponse:
        "A human-approved safety restriction applies to this activity. Stop the current movement and wait for review before continuing.",
    });
  }

  async function waitForExistingTurn(member, turnId) {
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() <= deadline) {
      const result = await db.query(
        `SELECT *
         FROM goals_coach_coaching_turns
         WHERE id = $1 AND member_id = $2`,
        [turnId, member.memberId]
      );
      if (!result.rows.length) {
        throw notFound("COACHING_TURN_NOT_FOUND", "Coaching turn not found");
      }
      const turn = result.rows[0];
      if (turn.provider_status === "completed") {
        return loadCompletedTurnResult(db, turn, true);
      }
      if (turn.provider_status === "failed") {
        throw storedFailureError(turn.failure_category);
      }
      await sleep(pollIntervalMs);
    }
    throw conflict(
      "COACHING_TURN_IN_PROGRESS",
      "This coaching turn is still being processed"
    );
  }

  async function markFailed(turnId, failureCategory) {
    await withTransaction(db, async (client) => {
      await client.query(
        `UPDATE goals_coach_coaching_turns
         SET provider_status = 'failed',
             failure_category = $1,
             provider_completed_at = NOW()
         WHERE id = $2 AND provider_status = 'pending'`,
        [failureCategory, turnId]
      );
    });
  }

  async function finalizeTurn(member, input, staged, generated) {
    return withTransaction(db, async (client) => {
      await requireActiveMappingAndConsent(client, member, applicationConfiguration);
      const conversationResult = await client.query(
        `SELECT id, plan_id, status
         FROM coaching_conversations
         WHERE id = $1 AND member_id = $2
         FOR UPDATE`,
        [staged.turn.conversation_id, member.memberId]
      );
      if (
        !conversationResult.rows.length
        || conversationResult.rows[0].status !== "active"
        || !sameIdentifier(conversationResult.rows[0].plan_id, staged.turn.plan_id)
      ) {
        throw conflict(
          "COACHING_CONTEXT_CHANGED",
          "Your coaching context changed while this response was being prepared"
        );
      }
      const turnResult = await client.query(
        `SELECT *
         FROM goals_coach_coaching_turns
         WHERE id = $1
           AND member_id = $2
           AND conversation_id = $3
           AND member_message_id = $4
           AND provider_status = 'pending'
         FOR UPDATE`,
        [staged.turn.id, member.memberId, staged.turn.conversation_id, staged.memberMessage.id]
      );
      if (!turnResult.rows.length) {
        throw conflict("COACHING_TURN_CHANGED", "The coaching turn is no longer pending");
      }
      const turn = turnResult.rows[0];
      const rebuilt = await buildCoachingContext({
        client,
        member,
        conversationId: turn.conversation_id,
        memberMessage: input.content,
        now: staged.stagedAt,
      });
      if (rebuilt.digest !== staged.contextDigest || rebuilt.digest !== turn.context_digest) {
        throw conflict(
          "COACHING_CONTEXT_CHANGED",
          "Your coaching context changed while this response was being prepared"
        );
      }

      const workout = await applyWorkoutTransition(client, {
        memberId: String(turn.member_id),
        conversationId: String(turn.conversation_id),
        planId: String(turn.plan_id),
        coachingContext: rebuilt.context,
        memberMessageId: String(turn.member_message_id),
        idempotencyKey: input.clientMessageId,
        output: generated.output,
      });
      const coachMessage = await client.query(
        `INSERT INTO coaching_messages
          (conversation_id, member_id, sender_type, content, structured_response_json)
         VALUES ($1, $2, 'goals_coach', $3, $4)
         RETURNING *`,
        [turn.conversation_id, turn.member_id, generated.output.reply, generated.output]
      );
      const completed = await client.query(
        `UPDATE goals_coach_coaching_turns
         SET workout_session_id = $1,
             coach_message_id = $2,
             coach_message_sender_type = 'goals_coach',
             provider_status = 'completed',
             structured_output_json = $3,
             proposed_state_transition_json = $4,
             provider_completed_at = NOW()
         WHERE id = $5 AND provider_status = 'pending'
         RETURNING *`,
        [
          workout ? workout.id : null,
          coachMessage.rows[0].id,
          generated.output,
          generated.output.stateTransition,
          turn.id,
        ]
      );
      if (!completed.rows.length) {
        throw conflict("COACHING_TURN_CHANGED", "The coaching turn changed during finalization");
      }
      await client.query(
        `UPDATE coaching_conversations
         SET updated_at = NOW()
         WHERE id = $1 AND member_id = $2`,
        [turn.conversation_id, turn.member_id]
      );
      return {
        memberMessageId: String(turn.member_message_id),
        response: serializeCoachMessage(coachMessage.rows[0]),
        workoutState: serializeWorkoutSession(workout),
        turn: {
          requestId: String(completed.rows[0].request_id),
          attemptNumber: Number(completed.rows[0].attempt_number),
          providerStatus: completed.rows[0].provider_status,
        },
        idempotentReplay: false,
      };
    });
  }

  async function sendMessage(member, conversationId, input, requestContext) {
    const inputMethod = input.inputMethod === undefined ? "text" : input.inputMethod;
    const safetyAssessmentAvailable = Boolean(
      safetyService && typeof safetyService.assess === "function"
    );
    const assessSafety = async () => {
      if (!safetyAssessmentAvailable) return null;
      return safetyService.assess(input.content, {
        memberId: String(member.memberId),
        conversationId: String(conversationId),
        inputMethod,
      });
    };
    const routeSafety = async (assessment, options) => {
      const protectedResult = await stageSafetyResponse(member, conversationId, input, assessment, options);
      if (protectedResult.type === "created" && reviewRouting && typeof reviewRouting.route === "function") {
        // Delivery is intentionally best-effort after durable local recording.
        // The member response never claims routing succeeded.
        try {
          await reviewRouting.route(protectedResult.review);
        } catch (_) {
          // A missing receipt remains a protected local review; never resume coaching.
        }
      }
      return protectedResult.result;
    };

    // Voice staging remains the certified Phase 1C provenance boundary.  It
    // validates and consumes the exact completed attempt before safety can
    // suppress ordinary generation.
    if (inputMethod === "voice") {
      const stagedVoice = await stageVoiceTurn(member, conversationId, input, requestContext);
      if (stagedVoice.type === "completed") return stagedVoice.result;
      if (stagedVoice.type === "pending") return waitForExistingTurn(member, stagedVoice.turnId);
      const assessment = await assessSafety();
      if (assessment && assessment.reviewRequired) {
        return routeSafety(assessment, { allowExistingPendingMessage: true });
      }
      const restriction = restrictionAssessment(await activeHumanRestrictions(member, conversationId));
      if (restriction) return routeSafety(restriction, { allowExistingPendingMessage: true });
      let generated;
      try {
        generated = await engine.generateTurn({
          context: stagedVoice.context,
          memberMessage: input.content,
          requestId: String(stagedVoice.turn.request_id),
        });
      } catch (error) {
        const failureCategory = terminalFailureCategory(error);
        await markFailed(stagedVoice.turn.id, failureCategory);
        if (RETRYABLE_FAILURE_CATEGORIES.has(failureCategory)) {
          throw unavailableError(failureCategory);
        }
        throw error;
      }
      try {
        return await finalizeTurn(member, input, stagedVoice, generated);
      } catch (error) {
        await markFailed(stagedVoice.turn.id, terminalFailureCategory(error));
        throw error;
      }
    }

    // Classifier adapters are optional external boundaries. Revalidate the
    // mapped member, current consent, and active conversation before content
    // is supplied to one; stageSafetyResponse revalidates again before write.
    if (safetyAssessmentAvailable) {
      await authorizeSafetyAssessment(member, conversationId);
    }
    const assessment = await assessSafety();
    if (assessment && assessment.reviewRequired) {
      return routeSafety(assessment);
    }
    const restriction = restrictionAssessment(await activeHumanRestrictions(member, conversationId));
    if (restriction) return routeSafety(restriction);
    const staged = await stageTextTurn(member, conversationId, input);
    if (staged.type === "completed") return staged.result;
    if (staged.type === "pending") return waitForExistingTurn(member, staged.turnId);

    let generated;
    try {
      generated = await engine.generateTurn({
        context: staged.context,
        memberMessage: input.content,
        requestId: String(staged.turn.request_id),
      });
    } catch (error) {
      const failureCategory = terminalFailureCategory(error);
      await markFailed(staged.turn.id, failureCategory);
      if (RETRYABLE_FAILURE_CATEGORIES.has(failureCategory)) {
        throw unavailableError(failureCategory);
      }
      throw error;
    }

    try {
      return await finalizeTurn(member, input, staged, generated);
    } catch (error) {
      await markFailed(staged.turn.id, terminalFailureCategory(error));
      throw error;
    }
  }

  return Object.freeze({ sendMessage });
}

module.exports = {
  COACHING_UNAVAILABLE_MESSAGE,
  createPhase1bCoachingService,
};
