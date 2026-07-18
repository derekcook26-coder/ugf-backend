const crypto = require("crypto");
const { conflict, notFound } = require("./repository");

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function digestContext(context) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(context)))
    .digest("hex");
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function timeZoneDateKey(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

function extractAvailableMinutes(content) {
  const match = String(content || "").match(/\b(\d{1,3})\s*(?:minute|minutes|min)\b/i);
  if (!match) return null;
  const minutes = Number.parseInt(match[1], 10);
  return minutes >= 5 && minutes <= 240 ? minutes : null;
}

function serializeWorkoutSession(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    workoutSessionKey: row.workout_session_key,
    workoutDayKey: row.workout_day_key,
    status: row.status,
    currentExerciseIndex: row.current_exercise_index,
    currentExerciseKey: row.current_exercise_key,
    currentExerciseName: row.current_exercise_name,
    currentSet: row.current_set,
    targetSets: row.target_sets,
    targetRepetitions: row.target_repetitions,
    targetDurationSeconds: row.target_duration_seconds,
    selectedModification: row.selected_modification_json || {},
    completedExercises: row.completed_exercises_json || [],
    skippedExercises: row.skipped_exercises_json || [],
    reportedEffort: row.reported_effort,
    reportedDiscomfort: row.reported_discomfort_json || {},
    stateVersion: Number(row.state_version),
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    completedAt: row.completed_at,
  };
}

async function buildCoachingContext(options) {
  const client = options.client;
  const member = options.member;
  const conversationId = options.conversationId;
  const now = options.now || new Date();

  const conversationResult = await client.query(
    `SELECT conversation.id,
            conversation.member_id,
            conversation.plan_id,
            conversation.status,
            member.first_name,
            plan.profile_json,
            plan.plan_markdown,
            plan.created_at AS plan_created_at
     FROM coaching_conversations conversation
     JOIN coach_members member ON member.id = conversation.member_id
     JOIN coach_plans plan
       ON plan.id = conversation.plan_id
      AND plan.member_id = conversation.member_id
     WHERE conversation.id = $1 AND conversation.member_id = $2`,
    [conversationId, member.memberId]
  );
  if (!conversationResult.rows.length) {
    throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
  }
  const conversation = conversationResult.rows[0];
  if (conversation.status !== "active") {
    throw conflict("CONVERSATION_CLOSED", "This private-alpha conversation is complete");
  }

  const latestPlan = await client.query(
    `SELECT id
     FROM coach_plans
     WHERE member_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [member.memberId]
  );
  if (!latestPlan.rows.length || String(latestPlan.rows[0].id) !== String(conversation.plan_id)) {
    throw conflict(
      "WORKOUT_PLAN_SUPERSEDED",
      "Your saved workout changed. Start a new conversation before continuing."
    );
  }

  const profile = conversation.profile_json || {};
  const timeZone = typeof profile.timeZone === "string"
    ? profile.timeZone
    : typeof profile.time_zone === "string" ? profile.time_zone : "UTC";
  const dateKey = timeZoneDateKey(now, timeZone);

  const [
    exerciseResult,
    instructionResult,
    messageResult,
    checkinResult,
    limitationResult,
    sessionResult,
  ] = await Promise.all([
    client.query(
      `SELECT id, plan_item_key, workout_label, sequence_number, exercise_name,
              movement_pattern, equipment_json, limitation_considerations_json,
              prescription_json, intent_validation_status
       FROM coach_plan_exercises
       WHERE plan_id = $1 AND status = 'active'
       ORDER BY sequence_number, id`,
      [conversation.plan_id]
    ),
    client.query(
      `SELECT id, content, sender_staff_user_id, created_at
       FROM coaching_messages
       WHERE conversation_id = $1
         AND member_id = $2
         AND sender_type = 'staff'
       ORDER BY created_at DESC, id DESC
       LIMIT 5`,
      [conversationId, member.memberId]
    ),
    client.query(
      `SELECT id, sender_type, content, created_at
       FROM coaching_messages
       WHERE conversation_id = $1 AND member_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 12`,
      [conversationId, member.memberId]
    ),
    client.query(
      `SELECT week_start, status, trainer_summary
       FROM weekly_checkins
       WHERE member_id = $1
       ORDER BY week_start DESC, id DESC
       LIMIT 1`,
      [member.memberId]
    ),
    client.query(
      `SELECT id, observation_text, updated_at
       FROM coaching_observations
       WHERE member_id = $1
         AND category = 'movement_limitation'
         AND status IN ('active', 'confirmed')
         AND confidence = 'staff_confirmed'
       ORDER BY updated_at DESC, id DESC
       LIMIT 10`,
      [member.memberId]
    ),
    client.query(
      `SELECT *
       FROM goals_coach_workout_sessions
       WHERE member_id = $1
         AND conversation_id = $2
         AND plan_id = $3
         AND workout_day_key = $4
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [member.memberId, conversationId, conversation.plan_id, dateKey]
    ),
  ]);

  const approvedLimitations = [
    ...arrayValue(profile.approvedLimitations || profile.approved_limitations),
    ...limitationResult.rows.map((row) => ({
      source: "staff_confirmed_observation",
      reference: String(row.id),
      text: row.observation_text,
      updatedAt: row.updated_at,
    })),
  ];
  const primaryGoal = profile.primaryGoal || profile.primary_goal || profile.goal || null;
  const context = {
    precedence: [
      "safety_restrictions",
      "human_approved_instructions",
      "latest_approved_plan",
      "current_member_statement",
      "recent_checkin_context",
      "older_profile_context",
      "general_coaching_knowledge",
    ],
    member: {
      preferredName: conversation.first_name,
      primaryGoal,
      timeZone,
    },
    plan: {
      id: String(conversation.plan_id),
      savedAt: conversation.plan_created_at,
      summary: conversation.plan_markdown.slice(0, 12000),
      exercises: exerciseResult.rows.map((row) => ({
        id: String(row.id),
        key: row.plan_item_key,
        workoutLabel: row.workout_label,
        sequence: row.sequence_number,
        name: row.exercise_name,
        movementPattern: row.movement_pattern,
        equipment: row.equipment_json || [],
        limitationConsiderations: row.limitation_considerations_json || [],
        prescription: row.prescription_json || {},
        intentValidationStatus: row.intent_validation_status,
      })),
    },
    safetyRestrictions: approvedLimitations,
    humanApprovedInstructions: instructionResult.rows.reverse().map((row) => ({
      messageId: String(row.id),
      staffUserId: String(row.sender_staff_user_id),
      instruction: row.content,
      createdAt: row.created_at,
    })),
    currentMemberStatement: options.memberMessage,
    availableMinutes: extractAvailableMinutes(options.memberMessage),
    recentCheckin: checkinResult.rows[0] ? {
      weekStart: checkinResult.rows[0].week_start,
      status: checkinResult.rows[0].status,
      staffSummary: checkinResult.rows[0].trainer_summary,
    } : null,
    currentConversation: messageResult.rows.reverse().map((row) => ({
      messageId: String(row.id),
      senderType: row.sender_type,
      content: row.content,
      createdAt: row.created_at,
    })),
    workoutSession: serializeWorkoutSession(sessionResult.rows[0] || null),
    equipment: arrayValue(
      profile.equipment || profile.availableEquipment || profile.available_equipment
    ),
    date: dateKey,
    conflicts: [],
  };

  return { context, digest: digestContext(context), conversation };
}

module.exports = {
  buildCoachingContext,
  digestContext,
  extractAvailableMinutes,
  serializeWorkoutSession,
  timeZoneDateKey,
};
