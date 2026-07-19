const crypto = require("crypto");
const { serializeWorkoutSession } = require("./coaching-context");
const {
  createCoachingCapability,
  loadCompletedTurnResult,
  publicTurnStatus,
  serializeTurnSummary,
} = require("./phase1b-contracts");
const { createVoiceCapability } = require("./phase1c-contracts");
const { conflict, notFound, withTransaction } = require("./repository");
const { encodeCursor } = require("./validation");

function serializeConversation(row) {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    status: row.status,
    openedAt: row.opened_at,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}

function serializeMessage(row, includeStructuredResponse = true) {
  const message = {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    senderType: row.sender_type,
    content: row.content,
    structuredResponse: includeStructuredResponse ? row.structured_response_json : null,
    createdAt: row.created_at,
  };
  if (row.sender_type === "member") {
    message.clientMessageId = row.client_message_id
      ? String(row.client_message_id)
      : null;
    message.turn = row.turn_id
      ? serializeTurnSummary({
        provider_status: row.turn_provider_status,
        failure_category: row.turn_failure_category,
        attempt_number: row.turn_attempt_number,
        provider_started_at: row.turn_provider_started_at,
        provider_completed_at: row.turn_provider_completed_at,
        created_at: row.turn_created_at,
      })
      : null;
  }
  return message;
}

function serializePreferences(row) {
  return {
    voiceInputEnabled: row.voice_input_enabled,
    spokenResponsesEnabled: row.spoken_responses_enabled,
    automaticPlayback: row.automatic_playback,
    transcriptReviewRequired: row.transcript_review_required,
    reducedMotion: row.reduced_motion,
    largerText: row.larger_text,
    notificationFrequency: row.notification_frequency,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    quietHoursTimezone: row.quiet_hours_timezone,
    privateNotificationPreviews: row.private_notification_previews,
    updatedAt: row.updated_at,
  };
}

function createAlphaGoalsCoachService(options) {
  const db = options.db;
  const configuration = options.applicationConfiguration;
  const coachingCapability = options.coachingCapability
    || createCoachingCapability(null);
  const voiceCapability = options.voiceCapability
    || createVoiceCapability(null);

  async function phase1bSchemaAvailability(client) {
    const result = await client.query(
      `SELECT
         to_regclass('public.goals_coach_workout_sessions')::text AS workout_sessions,
         to_regclass('public.goals_coach_coaching_turns')::text AS coaching_turns`
    );
    return {
      workoutSessions: Boolean(result.rows[0] && result.rows[0].workout_sessions),
      coachingTurns: Boolean(result.rows[0] && result.rows[0].coaching_turns),
    };
  }

  function requireConfiguration() {
    if (!configuration || !configuration.valid) {
      const error = new Error("Private-alpha application configuration is incomplete");
      error.statusCode = 503;
      error.code = "ALPHA_APPLICATION_NOT_CONFIGURED";
      throw error;
    }
  }

  async function lockActiveMapping(client, member) {
    const result = await client.query(
      `SELECT * FROM goals_coach_member_auth_mappings
       WHERE id = $1
         AND member_id = $2
         AND auth_provider = $3
         AND auth_subject = $4
         AND active = TRUE
       FOR UPDATE`,
      [member.mappingId, member.memberId, member.authProvider, member.authSubject]
    );
    if (!result.rows.length) {
      const error = new Error("Private-alpha access is unavailable");
      error.statusCode = 403;
      error.code = "ALPHA_ACCESS_FORBIDDEN";
      throw error;
    }
    return result.rows[0];
  }

  async function getConsent(member) {
    requireConfiguration();
    const current = await db.query(
      `SELECT status, consent_version, accepted_at, declined_at, withdrawn_at, updated_at
       FROM goals_coach_alpha_consents
       WHERE member_id = $1
         AND auth_mapping_id = $2
         AND consent_version = $3
         AND environment = $4
       LIMIT 1`,
      [member.memberId, member.mappingId, configuration.consentVersion, configuration.alphaEnvironment]
    );
    const outdated = await db.query(
      `SELECT consent_version
       FROM goals_coach_alpha_consents
       WHERE member_id = $1
         AND auth_mapping_id = $2
         AND environment = $3
         AND status = 'accepted'
         AND consent_version <> $4
       ORDER BY updated_at DESC
       LIMIT 1`,
      [member.memberId, member.mappingId, configuration.alphaEnvironment, configuration.consentVersion]
    );
    const row = current.rows[0] || null;
    return {
      requiredVersion: configuration.consentVersion,
      environment: configuration.alphaEnvironment,
      current: row ? {
        version: row.consent_version,
        status: row.status,
        acceptedAt: row.accepted_at,
        declinedAt: row.declined_at,
        withdrawnAt: row.withdrawn_at,
        updatedAt: row.updated_at,
      } : null,
      currentAccepted: Boolean(row && row.status === "accepted"),
      outdatedAcceptedVersion: outdated.rows[0] ? outdated.rows[0].consent_version : null,
    };
  }

  async function recordConsent(member, action) {
    requireConfiguration();
    return withTransaction(db, async (client) => {
      await lockActiveMapping(client, member);
      const existing = await client.query(
        `SELECT * FROM goals_coach_alpha_consents
         WHERE member_id = $1 AND consent_version = $2 AND environment = $3
         FOR UPDATE`,
        [member.memberId, configuration.consentVersion, configuration.alphaEnvironment]
      );
      const current = existing.rows[0] || null;
      if (action === "accept" && current && current.status === "accepted"
        && String(current.auth_mapping_id) === String(member.mappingId)) {
        return { status: "accepted", version: current.consent_version, acceptedAt: current.accepted_at, idempotent: true };
      }
      if (action === "decline" && current && current.status === "declined"
        && String(current.auth_mapping_id) === String(member.mappingId)) {
        return { status: "declined", version: current.consent_version, declinedAt: current.declined_at, idempotent: true };
      }
      if (action === "decline" && current && current.status === "accepted") {
        throw conflict("CONSENT_WITHDRAWAL_REQUIRED", "Use withdrawal to end accepted private-alpha consent");
      }
      if (action === "withdraw" && (!current || current.status !== "accepted"
        || String(current.auth_mapping_id) !== String(member.mappingId))) {
        throw conflict("CONSENT_NOT_ACTIVE", "Current private-alpha consent is not active");
      }

      let consent;
      if (!current) {
        if (action === "withdraw") throw conflict("CONSENT_NOT_ACTIVE", "Current private-alpha consent is not active");
        const inserted = await client.query(
          `INSERT INTO goals_coach_alpha_consents
            (member_id, auth_mapping_id, consent_version, environment, status,
             accepted_at, declined_at)
           VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $5 = 'accepted' THEN NOW() ELSE NULL END,
             CASE WHEN $5 = 'declined' THEN NOW() ELSE NULL END)
           RETURNING *`,
          [
            member.memberId,
            member.mappingId,
            configuration.consentVersion,
            configuration.alphaEnvironment,
            action === "accept" ? "accepted" : "declined",
          ]
        );
        consent = inserted.rows[0];
      } else {
        const status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "withdrawn";
        const updated = await client.query(
          `UPDATE goals_coach_alpha_consents
           SET auth_mapping_id = $1,
               status = $2,
               accepted_at = CASE
                 WHEN $2 = 'accepted' THEN NOW()
                 WHEN $2 = 'withdrawn' THEN accepted_at
                 ELSE NULL
               END,
               declined_at = CASE WHEN $2 = 'declined' THEN NOW() ELSE NULL END,
               withdrawn_at = CASE WHEN $2 = 'withdrawn' THEN NOW() ELSE NULL END,
               updated_at = NOW()
           WHERE id = $3
           RETURNING *`,
          [member.mappingId, status, current.id]
        );
        consent = updated.rows[0];
      }

      const eventType = action === "accept" ? "accepted" : action === "decline" ? "declined" : "withdrawn";
      await client.query(
        `INSERT INTO goals_coach_alpha_consent_events
          (consent_id, member_id, auth_mapping_id, auth_provider, auth_subject,
           consent_version, environment, event_type, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          consent.id,
          member.memberId,
          member.mappingId,
          member.authProvider,
          member.authSubject,
          configuration.consentVersion,
          configuration.alphaEnvironment,
          eventType,
          crypto.randomUUID(),
        ]
      );
      return {
        status: consent.status,
        version: consent.consent_version,
        acceptedAt: consent.accepted_at,
        declinedAt: consent.declined_at,
        withdrawnAt: consent.withdrawn_at,
        idempotent: false,
      };
    });
  }

  async function getProfile(member) {
    const result = await db.query(
      `SELECT member.first_name,
              COALESCE(
                plan.profile_json->>'primaryGoal',
                plan.profile_json->>'primary_goal',
                plan.profile_json->>'goal'
              ) AS current_goal
       FROM coach_members member
       LEFT JOIN LATERAL (
         SELECT profile_json
         FROM coach_plans
         WHERE member_id = member.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) plan ON TRUE
       WHERE member.id = $1`,
      [member.memberId]
    );
    if (!result.rows.length) throw notFound("COACHING_PROFILE_NOT_FOUND", "Coaching profile not found");
    return {
      preferredName: result.rows[0].first_name,
      currentGoal: result.rows[0].current_goal,
      access: "private_owner_alpha",
    };
  }

  async function getCurrentPlan(member) {
    const result = await db.query(
      `SELECT id, plan_markdown, created_at
       FROM coach_plans
       WHERE member_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [member.memberId]
    );
    if (!result.rows.length) throw notFound("SAVED_PLAN_NOT_FOUND", "No saved workout plan is available yet");
    return {
      id: String(result.rows[0].id),
      planMarkdown: result.rows[0].plan_markdown,
      savedAt: result.rows[0].created_at,
    };
  }

  async function loadPrimaryCoach(client, memberId) {
    const result = await client.query(
      `SELECT staff.id, staff.display_name
       FROM member_coach_assignments assignment
       JOIN staff_users staff ON staff.id = assignment.staff_user_id AND staff.active = TRUE
       WHERE assignment.member_id = $1
         AND assignment.status = 'active'
         AND assignment.assignment_type = 'primary'
       LIMIT 1`,
      [memberId]
    );
    return result.rows[0] || null;
  }

  async function startSession(member) {
    return withTransaction(db, async (client) => {
      await lockActiveMapping(client, member);
      const planResult = await client.query(
        `SELECT id, created_at FROM coach_plans
         WHERE member_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [member.memberId]
      );
      if (!planResult.rows.length) throw notFound("SAVED_PLAN_NOT_FOUND", "No saved workout plan is available yet");
      const plan = planResult.rows[0];
      const primaryCoach = await loadPrimaryCoach(client, member.memberId);
      let conversation = await client.query(
        `INSERT INTO coaching_conversations (member_id, plan_id, assigned_staff_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (member_id, plan_id) WHERE status = 'active'
         DO NOTHING
         RETURNING *`,
        [member.memberId, plan.id, primaryCoach ? primaryCoach.id : null]
      );
      if (!conversation.rows.length) {
        conversation = await client.query(
          `SELECT * FROM coaching_conversations
           WHERE member_id = $1 AND plan_id = $2 AND status = 'active' LIMIT 1`,
          [member.memberId, plan.id]
        );
      }
      const schema = await phase1bSchemaAvailability(client);
      let workoutState = null;
      if (schema.workoutSessions) {
        const workout = await client.query(
          `SELECT *
           FROM goals_coach_workout_sessions
           WHERE member_id = $1
             AND conversation_id = $2
             AND plan_id = $3
             AND status = 'active'
           ORDER BY last_activity_at DESC, id DESC
           LIMIT 1`,
          [member.memberId, conversation.rows[0].id, plan.id]
        );
        workoutState = serializeWorkoutSession(workout.rows[0] || null);
      }
      return {
        conversation: serializeConversation(conversation.rows[0]),
        plan: { id: String(plan.id), savedAt: plan.created_at },
        coach: primaryCoach
          ? { displayName: primaryCoach.display_name, reference: `Coach ${primaryCoach.display_name}` }
          : { displayName: null, reference: "one of our coaches" },
        coachingMode: "phase_1a_test_only",
        coachingCapability,
        voiceCapability,
        workoutState,
      };
    });
  }

  async function listConversations(member, page) {
    const values = [member.memberId];
    let cursorSql = "";
    if (page.cursor) {
      values.push(page.cursor.t, page.cursor.id);
      cursorSql = `AND (updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`;
    }
    values.push(page.limit + 1);
    const result = await db.query(
      `SELECT * FROM coaching_conversations
       WHERE member_id = $1 ${cursorSql}
       ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`,
      values
    );
    const hasMore = result.rows.length > page.limit;
    const rows = result.rows.slice(0, page.limit);
    const last = rows[rows.length - 1];
    return {
      conversations: rows.map(serializeConversation),
      nextCursor: hasMore && last
        ? encodeCursor({ t: new Date(last.updated_at).toISOString(), id: String(last.id) })
        : null,
    };
  }

  async function listMessages(member, conversationId, page) {
    const owner = await db.query(
      "SELECT id FROM coaching_conversations WHERE id = $1 AND member_id = $2",
      [conversationId, member.memberId]
    );
    if (!owner.rows.length) throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
    const schema = await phase1bSchemaAvailability(db);
    const values = [conversationId, member.memberId];
    let cursorSql = "";
    if (page.cursor) {
      values.push(page.cursor.t, page.cursor.id);
      cursorSql = `AND (message.created_at, message.id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`;
    }
    values.push(page.limit + 1);
    const result = schema.coachingTurns
      ? await db.query(
        `SELECT message.*,
                turn.id AS turn_id,
                turn.provider_status AS turn_provider_status,
                turn.failure_category AS turn_failure_category,
                turn.attempt_number AS turn_attempt_number,
                turn.provider_started_at AS turn_provider_started_at,
                turn.provider_completed_at AS turn_provider_completed_at,
                turn.created_at AS turn_created_at
         FROM coaching_messages message
         LEFT JOIN LATERAL (
           SELECT candidate.*
           FROM goals_coach_coaching_turns candidate
           WHERE candidate.member_message_id = message.id
             AND candidate.conversation_id = message.conversation_id
             AND candidate.member_id = message.member_id
           ORDER BY candidate.attempt_number DESC
           LIMIT 1
         ) turn ON message.sender_type = 'member'
         WHERE message.conversation_id = $1
           AND message.member_id = $2 ${cursorSql}
         ORDER BY message.created_at DESC, message.id DESC
         LIMIT $${values.length}`,
        values
      )
      : await db.query(
        `SELECT message.*
         FROM coaching_messages message
         WHERE message.conversation_id = $1
           AND message.member_id = $2 ${cursorSql}
         ORDER BY message.created_at DESC, message.id DESC
         LIMIT $${values.length}`,
        values
      );
    const hasMore = result.rows.length > page.limit;
    const rows = result.rows.slice(0, page.limit);
    const last = rows[rows.length - 1];
    return {
      messages: rows.map((row) => serializeMessage(row)),
      nextCursor: hasMore && last
        ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: String(last.id) })
        : null,
    };
  }

  async function getTurn(member, conversationId, clientMessageId) {
    const schema = await phase1bSchemaAvailability(db);
    if (!schema.coachingTurns) {
      throw notFound("COACHING_TURN_NOT_FOUND", "Coaching turn not found");
    }
    const result = await db.query(
      `SELECT turn.*, message.client_message_id
       FROM coaching_conversations conversation
       JOIN coaching_messages message
         ON message.conversation_id = conversation.id
        AND message.member_id = conversation.member_id
        AND message.sender_type = 'member'
        AND message.client_message_id = $3
       JOIN LATERAL (
         SELECT candidate.*
         FROM goals_coach_coaching_turns candidate
         WHERE candidate.member_message_id = message.id
           AND candidate.conversation_id = conversation.id
           AND candidate.member_id = conversation.member_id
         ORDER BY candidate.attempt_number DESC
         LIMIT 1
       ) turn ON TRUE
       WHERE conversation.id = $1
         AND conversation.member_id = $2
       LIMIT 1`,
      [conversationId, member.memberId, clientMessageId]
    );
    if (!result.rows.length) {
      throw notFound("COACHING_TURN_NOT_FOUND", "Coaching turn not found");
    }

    const turn = result.rows[0];
    const status = publicTurnStatus(turn);
    const summary = serializeTurnSummary(turn);
    return {
      conversationId: String(turn.conversation_id),
      clientMessageId: String(turn.client_message_id),
      memberMessageId: String(turn.member_message_id),
      status,
      messageSaved: true,
      retrySafe: summary.retrySafe,
      attemptNumber: summary.attemptNumber,
      result: status === "completed"
        ? await loadCompletedTurnResult(db, turn, true)
        : null,
      updatedAt: summary.updatedAt,
    };
  }

  async function closeConversation(member, conversationId) {
    return withTransaction(db, async (client) => {
      const existing = await client.query(
        "SELECT * FROM coaching_conversations WHERE id = $1 AND member_id = $2 FOR UPDATE",
        [conversationId, member.memberId]
      );
      if (!existing.rows.length) throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      if (existing.rows[0].status !== "active") return serializeConversation(existing.rows[0]);
      const updated = await client.query(
        `UPDATE coaching_conversations
         SET status = 'archived', archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND member_id = $2 RETURNING *`,
        [conversationId, member.memberId]
      );
      return serializeConversation(updated.rows[0]);
    });
  }

  async function sendTestMessage(member, conversationId, input, responder) {
    return withTransaction(db, async (client) => {
      await lockActiveMapping(client, member);
      const conversationResult = await client.query(
        `SELECT * FROM coaching_conversations
         WHERE id = $1 AND member_id = $2 FOR UPDATE`,
        [conversationId, member.memberId]
      );
      if (!conversationResult.rows.length) throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      if (conversationResult.rows[0].status !== "active") {
        throw conflict("CONVERSATION_CLOSED", "This private-alpha conversation is complete");
      }

      const duplicate = await client.query(
        `SELECT member_message.id AS member_message_id,
                coach_message.id AS coach_message_id,
                coach_message.content,
                coach_message.structured_response_json,
                coach_message.created_at
         FROM coaching_messages member_message
         LEFT JOIN coaching_messages coach_message
           ON coach_message.conversation_id = member_message.conversation_id
          AND coach_message.id = (
            SELECT MIN(candidate.id) FROM coaching_messages candidate
            WHERE candidate.conversation_id = member_message.conversation_id
              AND candidate.id > member_message.id
              AND candidate.sender_type = 'goals_coach'
          )
         WHERE member_message.conversation_id = $1
           AND member_message.client_message_id = $2`,
        [conversationId, input.clientMessageId]
      );
      if (duplicate.rows.length && duplicate.rows[0].coach_message_id) {
        return {
          memberMessageId: String(duplicate.rows[0].member_message_id),
          response: {
            id: String(duplicate.rows[0].coach_message_id),
            conversationId: String(conversationId),
            senderType: "goals_coach",
            content: duplicate.rows[0].content,
            structuredResponse: null,
            createdAt: duplicate.rows[0].created_at,
          },
          idempotentReplay: true,
        };
      }

      const memberMessage = await client.query(
        `INSERT INTO coaching_messages
          (conversation_id, member_id, sender_type, content, client_message_id)
         VALUES ($1, $2, 'member', $3, $4) RETURNING *`,
        [conversationId, member.memberId, input.content, input.clientMessageId]
      );
      const generated = await responder({
        content: input.content,
        conversationId: String(conversationId),
      });
      if (!generated || typeof generated.content !== "string" || !generated.content.trim()
        || generated.content.length > 8000
        || !generated.structuredResponse
        || typeof generated.structuredResponse !== "object"
        || Array.isArray(generated.structuredResponse)) {
        throw new Error("The deterministic Phase 1A responder returned an invalid test response");
      }
      const coachMessage = await client.query(
        `INSERT INTO coaching_messages
          (conversation_id, member_id, sender_type, content, structured_response_json)
         VALUES ($1, $2, 'goals_coach', $3, $4) RETURNING *`,
        [conversationId, member.memberId, generated.content.trim(), generated.structuredResponse]
      );
      await client.query(
        "UPDATE coaching_conversations SET updated_at = NOW() WHERE id = $1 AND member_id = $2",
        [conversationId, member.memberId]
      );
      return {
        memberMessageId: String(memberMessage.rows[0].id),
        response: serializeMessage(coachMessage.rows[0], false),
        idempotentReplay: false,
      };
    });
  }

  async function getPreferences(member) {
    await db.query(
      `INSERT INTO goals_coach_member_preferences (member_id, updated_by_auth_mapping_id)
       VALUES ($1, $2) ON CONFLICT (member_id) DO NOTHING`,
      [member.memberId, member.mappingId]
    );
    const result = await db.query(
      "SELECT * FROM goals_coach_member_preferences WHERE member_id = $1",
      [member.memberId]
    );
    return serializePreferences(result.rows[0]);
  }

  async function updatePreferences(member, input) {
    return withTransaction(db, async (client) => {
      await lockActiveMapping(client, member);
      await client.query(
        `INSERT INTO goals_coach_member_preferences (member_id, updated_by_auth_mapping_id)
         VALUES ($1, $2) ON CONFLICT (member_id) DO NOTHING`,
        [member.memberId, member.mappingId]
      );
      const columns = {
        voiceInputEnabled: "voice_input_enabled",
        spokenResponsesEnabled: "spoken_responses_enabled",
        automaticPlayback: "automatic_playback",
        reducedMotion: "reduced_motion",
        largerText: "larger_text",
        notificationFrequency: "notification_frequency",
        quietHoursStart: "quiet_hours_start",
        quietHoursEnd: "quiet_hours_end",
        quietHoursTimezone: "quiet_hours_timezone",
        privateNotificationPreviews: "private_notification_previews",
      };
      const values = [member.mappingId];
      const assignments = ["updated_by_auth_mapping_id = $1", "updated_at = NOW()"];
      for (const [key, column] of Object.entries(columns)) {
        if (input[key] !== undefined) {
          values.push(input[key]);
          assignments.push(`${column} = $${values.length}`);
        }
      }
      values.push(member.memberId);
      const result = await client.query(
        `UPDATE goals_coach_member_preferences
         SET ${assignments.join(", ")}
         WHERE member_id = $${values.length}
         RETURNING *`,
        values
      );
      return serializePreferences(result.rows[0]);
    });
  }

  async function createFeedback(member, input) {
    if (input.conversationId) {
      const owner = await db.query(
        "SELECT id FROM coaching_conversations WHERE id = $1 AND member_id = $2",
        [input.conversationId, member.memberId]
      );
      if (!owner.rows.length) throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
    }
    const eventId = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO goals_coach_alpha_feedback
        (member_id, auth_mapping_id, conversation_id, expectation, what_occurred,
         page_or_feature, approximate_time, severity, comments, app_version,
         browser, device_type, event_id, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, event_id, created_at`,
      [
        member.memberId,
        member.mappingId,
        input.conversationId,
        input.expectation,
        input.whatOccurred,
        input.pageOrFeature,
        input.approximateTime,
        input.severity,
        input.comments,
        input.appVersion,
        input.browser,
        input.deviceType,
        eventId,
        configuration.alphaEnvironment,
      ]
    );
    return {
      feedbackId: String(result.rows[0].id),
      eventId: String(result.rows[0].event_id),
      receivedAt: result.rows[0].created_at,
    };
  }

  return {
    closeConversation,
    createFeedback,
    getConsent,
    getCurrentPlan,
    getPreferences,
    getProfile,
    getTurn,
    listConversations,
    listMessages,
    recordConsent,
    sendTestMessage,
    startSession,
    updatePreferences,
  };
}

module.exports = { createAlphaGoalsCoachService };
