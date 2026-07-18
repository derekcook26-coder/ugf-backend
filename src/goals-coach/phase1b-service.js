const crypto = require("crypto");
const { buildCoachingContext, serializeWorkoutSession } = require("./coaching-context");
const { conflict, notFound, withTransaction } = require("./repository");
const { applyWorkoutTransition } = require("./workout-state");

const COACHING_UNAVAILABLE_MESSAGE =
  "Goals Coach is temporarily unavailable. Your conversation is saved, but I can’t safely generate the next coaching step right now.";

const PROVIDER_FAILURE_CATEGORIES = new Set([
  "provider_error",
  "provider_timeout",
  "malformed_provider_response",
  "invalid_structured_output",
]);

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
  if (PROVIDER_FAILURE_CATEGORIES.has(failureCategory)) {
    return unavailableError(failureCategory);
  }
  const error = new Error("The coaching turn could not be completed safely");
  error.statusCode = 409;
  error.code = /^[A-Z][A-Z0-9_]{1,99}$/.test(failureCategory || "")
    ? failureCategory
    : "COACHING_TURN_FAILED";
  return error;
}

function serializeCoachMessage(row) {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    senderType: row.sender_type,
    content: row.content,
    structuredResponse: row.structured_response_json,
    createdAt: row.created_at,
  };
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

async function loadCompletedResult(client, turn, idempotentReplay) {
  const coachMessage = await client.query(
    `SELECT *
     FROM coaching_messages
     WHERE id = $1
       AND conversation_id = $2
       AND member_id = $3
       AND sender_type = 'goals_coach'`,
    [turn.coach_message_id, turn.conversation_id, turn.member_id]
  );
  if (!coachMessage.rows.length) {
    throw new Error("Completed coaching turn is missing its response");
  }

  let workoutState = null;
  if (turn.workout_session_id) {
    const workout = await client.query(
      `SELECT *
       FROM goals_coach_workout_sessions
       WHERE id = $1
         AND member_id = $2
         AND conversation_id = $3
         AND plan_id = $4`,
      [turn.workout_session_id, turn.member_id, turn.conversation_id, turn.plan_id]
    );
    workoutState = serializeWorkoutSession(workout.rows[0] || null);
  }

  return {
    memberMessageId: String(turn.member_message_id),
    response: serializeCoachMessage(coachMessage.rows[0]),
    workoutState,
    turn: {
      requestId: String(turn.request_id),
      attemptNumber: Number(turn.attempt_number),
      providerStatus: turn.provider_status,
    },
    idempotentReplay,
  };
}

function createPhase1bCoachingService(options) {
  const db = options.db;
  const engine = options.engine;
  const applicationConfiguration = options.applicationConfiguration;
  const clock = typeof options.now === "function" ? options.now : () => new Date();
  const pollIntervalMs = Number.isInteger(options.pendingPollIntervalMs)
    ? options.pendingPollIntervalMs
    : 15;
  const waitTimeoutMs = Number.isInteger(options.pendingWaitTimeoutMs)
    ? options.pendingWaitTimeoutMs
    : engine.configuration.providerTimeoutMs + 2000;

  if (!db || typeof db.connect !== "function") {
    throw new Error("Phase 1B coaching service requires a database pool");
  }
  if (!engine || typeof engine.generateTurn !== "function" || !engine.configuration) {
    throw new Error("Phase 1B coaching service requires a configured coaching engine");
  }

  async function stageTurn(member, conversationId, input) {
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
          if (turn.provider_status === "completed") {
            return { type: "completed", result: await loadCompletedResult(client, turn, true) };
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
        return loadCompletedResult(db, turn, true);
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

  async function sendMessage(member, conversationId, input) {
    const staged = await stageTurn(member, conversationId, input);
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
      if (PROVIDER_FAILURE_CATEGORIES.has(failureCategory)) {
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
