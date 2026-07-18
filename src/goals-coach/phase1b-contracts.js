const { serializeWorkoutSession } = require("./coaching-context");

const RETRYABLE_FAILURE_CATEGORIES = new Set([
  "provider_error",
  "provider_timeout",
  "malformed_provider_response",
  "invalid_structured_output",
]);

function createCoachingCapability(startup) {
  const configuration = startup && startup.configuration;
  const engine = startup && startup.engine;
  const ready = Boolean(
    startup
      && startup.status === "ready"
      && configuration
      && configuration.aiEnabled === true
      && configuration.generationReady === true
      && engine
      && typeof engine.generateTurn === "function"
      && engine.configuration === configuration
  );
  const disabled = !configuration || configuration.aiEnabled !== true;

  return Object.freeze({
    phase: "phase_1b",
    status: ready ? "ready" : disabled ? "disabled" : "unavailable",
    reason: ready ? null : disabled ? "ai_disabled" : "provider_unavailable",
    structuredResponses: true,
    workoutStateRead: true,
    turnStatusRead: true,
  });
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

function publicTurnStatus(turn) {
  if (turn.provider_status === "pending") return "processing";
  if (turn.provider_status === "completed") return "completed";
  if (RETRYABLE_FAILURE_CATEGORIES.has(turn.failure_category)) {
    return "retryable_failure";
  }
  return "failed";
}

function serializeTurnSummary(turn) {
  if (!turn) return null;
  const status = publicTurnStatus(turn);
  return {
    status,
    retrySafe: status === "retryable_failure",
    attemptNumber: Number(turn.attempt_number),
    updatedAt: turn.provider_completed_at || turn.provider_started_at || turn.created_at,
  };
}

async function loadCompletedTurnResult(client, turn, idempotentReplay = true) {
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

module.exports = {
  RETRYABLE_FAILURE_CATEGORIES,
  createCoachingCapability,
  loadCompletedTurnResult,
  publicTurnStatus,
  serializeCoachMessage,
  serializeTurnSummary,
};
