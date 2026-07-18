const { conflict } = require("./repository");
const { serializeWorkoutSession } = require("./coaching-context");

function integer(value, fallback = null) {
  const parsed = Number.parseInt(String(value === undefined ? "" : value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function exerciseTargets(exercise) {
  const prescription = exercise && exercise.prescription
    && typeof exercise.prescription === "object"
    ? exercise.prescription
    : {};
  const repetitions = prescription.repetitions === undefined
    ? prescription.reps
    : prescription.repetitions;
  return {
    targetSets: integer(prescription.sets, 1),
    targetRepetitions: repetitions === undefined || repetitions === null
      ? null
      : String(repetitions).slice(0, 80),
    targetDurationSeconds: integer(
      prescription.durationSeconds === undefined
        ? prescription.duration_seconds
        : prescription.durationSeconds,
      null
    ),
  };
}

function stateSnapshot(row) {
  return row ? serializeWorkoutSession(row) : {};
}

async function loadCurrentSession(client, context, forUpdate = true) {
  const result = await client.query(
    `SELECT *
     FROM goals_coach_workout_sessions
     WHERE member_id = $1
       AND conversation_id = $2
       AND plan_id = $3
       AND workout_day_key = $4
     ORDER BY created_at DESC, id DESC
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [context.memberId, context.conversationId, context.planId, context.date]
  );
  return result.rows[0] || null;
}

async function recordEvent(client, options) {
  await client.query(
    `INSERT INTO goals_coach_workout_state_events
      (workout_session_id, member_id, conversation_id, plan_id, event_type,
       previous_state_version, resulting_state_version, triggering_message_id,
       triggering_message_sender_type, actor_type, idempotency_key,
       previous_state_json, resulting_state_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'member', 'goals_coach', $9, $10, $11)`,
    [
      options.resulting.id,
      options.resulting.member_id,
      options.resulting.conversation_id,
      options.resulting.plan_id,
      options.eventType,
      options.previous ? options.previous.state_version : null,
      options.resulting.state_version,
      options.memberMessageId,
      options.idempotencyKey,
      stateSnapshot(options.previous),
      stateSnapshot(options.resulting),
    ]
  );
}

function transitionContext(input) {
  return {
    memberId: input.memberId,
    conversationId: input.conversationId,
    planId: input.planId,
    date: input.coachingContext.date,
  };
}

async function startSession(client, input) {
  const context = transitionContext(input);
  const existing = await loadCurrentSession(client, context);
  if (existing) return existing;
  const exercise = input.coachingContext.plan.exercises[0];
  if (!exercise) return null;
  const targets = exerciseTargets(exercise);
  const key = `${context.date}:${context.planId}:default`;
  const result = await client.query(
    `INSERT INTO goals_coach_workout_sessions
      (member_id, conversation_id, plan_id, workout_session_key, workout_day_key,
       current_plan_exercise_id, current_exercise_index, current_exercise_key,
       current_exercise_name, current_set, target_sets, target_repetitions,
       target_duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 1, $9, $10, $11)
     RETURNING *`,
    [
      context.memberId,
      context.conversationId,
      context.planId,
      key,
      context.date,
      exercise.id,
      exercise.key,
      exercise.name,
      targets.targetSets,
      targets.targetRepetitions,
      targets.targetDurationSeconds,
    ]
  );
  await recordEvent(client, {
    eventType: "session_started",
    previous: null,
    resulting: result.rows[0],
    memberMessageId: input.memberMessageId,
    idempotencyKey: input.idempotencyKey,
  });
  return result.rows[0];
}

function requireVersion(session, expectedVersion) {
  if (!session || session.status !== "active") {
    throw conflict(
      "WORKOUT_SESSION_NOT_ACTIVE",
      "No active workout session can accept that update"
    );
  }
  if (Number(session.state_version) !== Number(expectedVersion)) {
    throw conflict(
      "WORKOUT_STATE_CHANGED",
      "Your workout changed. Refresh before retrying this step."
    );
  }
}

async function advanceSession(client, input, session) {
  requireVersion(session, input.transition.expectedVersion);
  const previous = { ...session };
  const exercises = input.coachingContext.plan.exercises;
  let eventType = "step_advanced";
  let result;

  if (session.current_set < session.target_sets) {
    result = await client.query(
      `UPDATE goals_coach_workout_sessions
       SET current_set = current_set + 1,
           state_version = state_version + 1,
           last_activity_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND state_version = $2
       RETURNING *`,
      [session.id, session.state_version]
    );
  } else {
    const nextIndex = session.current_exercise_index + 1;
    const nextExercise = exercises[nextIndex] || null;
    const completed = [...(session.completed_exercises_json || [])];
    if (!completed.includes(session.current_exercise_key)) {
      completed.push(session.current_exercise_key);
    }
    if (!nextExercise) {
      eventType = "session_completed";
      result = await client.query(
        `UPDATE goals_coach_workout_sessions
         SET status = 'completed',
             completed_exercises_json = $1,
             completed_at = NOW(),
             state_version = state_version + 1,
             last_activity_at = NOW(),
             updated_at = NOW()
         WHERE id = $2 AND state_version = $3
         RETURNING *`,
        [completed, session.id, session.state_version]
      );
    } else {
      const targets = exerciseTargets(nextExercise);
      result = await client.query(
        `UPDATE goals_coach_workout_sessions
         SET current_plan_exercise_id = $1,
             current_exercise_index = $2,
             current_exercise_key = $3,
             current_exercise_name = $4,
             current_set = 1,
             target_sets = $5,
             target_repetitions = $6,
             target_duration_seconds = $7,
             completed_exercises_json = $8,
             selected_modification_json = '{}'::jsonb,
             state_version = state_version + 1,
             last_activity_at = NOW(),
             updated_at = NOW()
         WHERE id = $9 AND state_version = $10
         RETURNING *`,
        [
          nextExercise.id,
          nextIndex,
          nextExercise.key,
          nextExercise.name,
          targets.targetSets,
          targets.targetRepetitions,
          targets.targetDurationSeconds,
          completed,
          session.id,
          session.state_version,
        ]
      );
    }
  }
  if (!result.rows.length) {
    throw conflict("WORKOUT_STATE_CHANGED", "Your workout changed during this request");
  }
  await recordEvent(client, {
    eventType,
    previous,
    resulting: result.rows[0],
    memberMessageId: input.memberMessageId,
    idempotencyKey: input.idempotencyKey,
  });
  return result.rows[0];
}

async function modifySession(client, input, session) {
  requireVersion(session, input.transition.expectedVersion);
  const changes = input.transition.changes;
  if (changes.targetSets !== undefined) {
    if (session.target_sets !== null && changes.targetSets > session.target_sets) {
      throw conflict(
        "WORKOUT_MODIFICATION_EXPANDS_SESSION",
        "A session-level modification cannot add sets"
      );
    }
    if (changes.targetSets < session.current_set) {
      throw conflict(
        "WORKOUT_MODIFICATION_BEHIND_PROGRESS",
        "A session-level modification cannot remove completed progress"
      );
    }
  }
  if (changes.targetDurationSeconds !== undefined
    && session.target_duration_seconds !== null
    && changes.targetDurationSeconds > session.target_duration_seconds) {
    throw conflict(
      "WORKOUT_MODIFICATION_EXPANDS_SESSION",
      "A session-level modification cannot increase duration"
    );
  }

  const values = [];
  const assignments = [];
  const columns = {
    targetSets: "target_sets",
    targetRepetitions: "target_repetitions",
    targetDurationSeconds: "target_duration_seconds",
    selectedModification: "selected_modification_json",
    reportedEffort: "reported_effort",
    reportedDiscomfort: "reported_discomfort_json",
  };
  for (const [name, column] of Object.entries(columns)) {
    if (changes[name] !== undefined) {
      values.push(changes[name]);
      assignments.push(`${column} = $${values.length}`);
    }
  }
  if (!assignments.length) {
    throw conflict(
      "WORKOUT_MODIFICATION_EMPTY",
      "The proposed workout modification made no approved change"
    );
  }
  values.push(session.id, session.state_version);
  const previous = { ...session };
  const result = await client.query(
    `UPDATE goals_coach_workout_sessions
     SET ${assignments.join(", ")},
         state_version = state_version + 1,
         last_activity_at = NOW(),
         updated_at = NOW()
     WHERE id = $${values.length - 1} AND state_version = $${values.length}
     RETURNING *`,
    values
  );
  if (!result.rows.length) {
    throw conflict("WORKOUT_STATE_CHANGED", "Your workout changed during this request");
  }
  await recordEvent(client, {
    eventType: "session_modified",
    previous,
    resulting: result.rows[0],
    memberMessageId: input.memberMessageId,
    idempotencyKey: input.idempotencyKey,
  });
  return result.rows[0];
}

async function completeSession(client, input, session) {
  requireVersion(session, input.transition.expectedVersion);
  const previous = { ...session };
  const completed = [...(session.completed_exercises_json || [])];
  if (session.current_exercise_key && !completed.includes(session.current_exercise_key)) {
    completed.push(session.current_exercise_key);
  }
  const result = await client.query(
    `UPDATE goals_coach_workout_sessions
     SET status = 'completed',
         completed_exercises_json = $1,
         completed_at = NOW(),
         state_version = state_version + 1,
         last_activity_at = NOW(),
         updated_at = NOW()
     WHERE id = $2 AND state_version = $3
     RETURNING *`,
    [completed, session.id, session.state_version]
  );
  if (!result.rows.length) {
    throw conflict("WORKOUT_STATE_CHANGED", "Your workout changed during this request");
  }
  await recordEvent(client, {
    eventType: "session_completed",
    previous,
    resulting: result.rows[0],
    memberMessageId: input.memberMessageId,
    idempotencyKey: input.idempotencyKey,
  });
  return result.rows[0];
}

async function applyWorkoutTransition(client, input) {
  const transition = input.output.stateTransition;
  const transitionInput = { ...input, transition };
  const context = transitionContext(input);
  if (["no_change", "request_information"].includes(transition.type)) {
    return loadCurrentSession(client, context);
  }
  if (transition.type === "start_session") {
    return startSession(client, transitionInput);
  }
  const session = await loadCurrentSession(client, context);
  if (transition.type === "advance") {
    return advanceSession(client, transitionInput, session);
  }
  if (transition.type === "modify") {
    return modifySession(client, transitionInput, session);
  }
  if (transition.type === "complete") {
    return completeSession(client, transitionInput, session);
  }
  throw conflict(
    "WORKOUT_TRANSITION_INVALID",
    "The proposed workout transition is not supported"
  );
}

module.exports = {
  applyWorkoutTransition,
  exerciseTargets,
  stateSnapshot,
};
