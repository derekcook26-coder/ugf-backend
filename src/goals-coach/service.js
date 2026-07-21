const { conflict, forbidden, notFound, withTransaction } = require("./repository");
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

function serializeMessage(row) {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    senderType: row.sender_type,
    content: row.content,
    structuredResponse: row.structured_response_json,
    createdAt: row.created_at,
  };
}

function serializeReview(row) {
  return {
    id: String(row.id),
    concernId: String(row.concern_id),
    memberId: String(row.member_id),
    conversationId: String(row.conversation_id),
    planId: String(row.plan_id),
    priority: row.priority,
    category: row.review_category,
    status: row.status,
    routingStatus: row.routing_status || null,
    routingAttemptCount: row.routing_attempt_count === undefined
      ? null
      : Number(row.routing_attempt_count),
    routeDestinationType: row.route_destination_type || null,
    lastRouteAttemptAt: row.last_route_attempt_at || null,
    lastRouteSucceededAt: row.last_route_succeeded_at || null,
    routingErrorCode: row.routing_error_code || null,
    targetResponseAt: row.target_response_at || null,
    assignedStaffUserId: row.assigned_staff_user_id ? String(row.assigned_staff_user_id) : null,
    memberFollowUpRequired: row.member_follow_up_required,
    memberFollowUpStatus: row.member_follow_up_status,
    memberFollowUpCompletedAt: row.member_follow_up_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function serializeReviewEvent(row) {
  return {
    id: String(row.id),
    reviewId: String(row.review_id),
    actorStaffUserId: row.actor_staff_user_id ? String(row.actor_staff_user_id) : null,
    eventType: row.event_type,
    details: row.event_details_json,
    createdAt: row.created_at,
  };
}

function serializeAssignment(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    staffUserId: String(row.staff_user_id),
    assignmentType: row.assignment_type,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeCoachingRecord(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function createGoalsCoachService(options) {
  const db = options.db;
  const phase1dEnabled = options.phase1dEnabled === true;

  async function resolveMember(client, claims) {
    const result = await client.query(
      `SELECT id, first_name, last_name
       FROM coach_members
       WHERE gymmaster_member_id = $1
       LIMIT 1`,
      [String(claims.sub)]
    );
    if (!result.rows.length) {
      throw notFound("COACHING_PROFILE_NOT_FOUND", "No saved coaching profile was found for this member");
    }
    return result.rows[0];
  }

  async function loadPrimaryCoach(client, memberId, lockAssignment = false) {
    const result = await client.query(
      `SELECT staff.id, staff.display_name
       FROM member_coach_assignments assignment
       JOIN staff_users staff ON staff.id = assignment.staff_user_id AND staff.active = TRUE
       WHERE assignment.member_id = $1
         AND assignment.status = 'active'
         AND assignment.assignment_type = 'primary'
       LIMIT 1
       ${lockAssignment ? "FOR UPDATE OF assignment" : ""}`,
      [memberId]
    );
    return result.rows[0] || null;
  }

  async function startSession(claims) {
    return withTransaction(db, async (client) => {
      const member = await resolveMember(client, claims);
      const planResult = await client.query(
        `SELECT id, created_at
         FROM coach_plans
         WHERE member_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [member.id]
      );
      if (!planResult.rows.length) {
        throw notFound("SAVED_PLAN_NOT_FOUND", "No saved workout plan is available yet");
      }
      const plan = planResult.rows[0];
      const primaryCoach = await loadPrimaryCoach(client, member.id);
      let conversationResult = await client.query(
        `INSERT INTO coaching_conversations
          (member_id, plan_id, assigned_staff_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (member_id, plan_id) WHERE status = 'active'
         DO NOTHING
         RETURNING *`,
        [member.id, plan.id, primaryCoach ? primaryCoach.id : null]
      );
      if (!conversationResult.rows.length) {
        conversationResult = await client.query(
          `SELECT * FROM coaching_conversations
           WHERE member_id = $1 AND plan_id = $2 AND status = 'active'
           LIMIT 1`,
          [member.id, plan.id]
        );
      }
      return {
        conversation: serializeConversation(conversationResult.rows[0]),
        plan: { id: String(plan.id), savedAt: plan.created_at },
        coach: primaryCoach
          ? { displayName: primaryCoach.display_name, reference: `Coach ${primaryCoach.display_name}` }
          : { displayName: null, reference: "one of our coaches" },
      };
    });
  }

  async function listConversations(claims, page) {
    return withTransaction(db, async (client) => {
      const member = await resolveMember(client, claims);
      const values = [member.id];
      let cursorSql = "";
      if (page.cursor) {
        values.push(page.cursor.t, page.cursor.id);
        cursorSql = `AND (updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`;
      }
      values.push(page.limit + 1);
      const result = await client.query(
        `SELECT * FROM coaching_conversations
         WHERE member_id = $1
         ${cursorSql}
         ORDER BY updated_at DESC, id DESC
         LIMIT $${values.length}`,
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
    });
  }

  async function listMessages(claims, conversationId, page) {
    return withTransaction(db, async (client) => {
      const member = await resolveMember(client, claims);
      const conversation = await client.query(
        "SELECT id FROM coaching_conversations WHERE id = $1 AND member_id = $2",
        [conversationId, member.id]
      );
      if (!conversation.rows.length) throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      const values = [conversationId, member.id];
      let cursorSql = "";
      if (page.cursor) {
        values.push(page.cursor.t, page.cursor.id);
        cursorSql = `AND (created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`;
      }
      values.push(page.limit + 1);
      const result = await client.query(
        `SELECT * FROM coaching_messages
         WHERE conversation_id = $1 AND member_id = $2
         ${cursorSql}
         ORDER BY created_at DESC, id DESC
         LIMIT $${values.length}`,
        values
      );
      const hasMore = result.rows.length > page.limit;
      const rows = result.rows.slice(0, page.limit);
      const last = rows[rows.length - 1];
      return {
        messages: rows.map(serializeMessage),
        nextCursor: hasMore && last
          ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: String(last.id) })
          : null,
      };
    });
  }

  async function closeConversation(claims, conversationId) {
    return withTransaction(db, async (client) => {
      const member = await resolveMember(client, claims);
      const existing = await client.query(
        "SELECT * FROM coaching_conversations WHERE id = $1 AND member_id = $2 FOR UPDATE",
        [conversationId, member.id]
      );
      if (!existing.rows.length) throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      if (existing.rows[0].status === "active") {
        const updated = await client.query(
          `UPDATE coaching_conversations
           SET status = 'archived', archived_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND member_id = $2
           RETURNING *`,
          [conversationId, member.id]
        );
        return serializeConversation(updated.rows[0]);
      }
      return serializeConversation(existing.rows[0]);
    });
  }

  async function sendTestMessage(claims, conversationId, input, responder) {
    return withTransaction(db, async (client) => {
      const member = await resolveMember(client, claims);
      const conversationResult = await client.query(
        `SELECT * FROM coaching_conversations
         WHERE id = $1 AND member_id = $2
         FOR UPDATE`,
        [conversationId, member.id]
      );
      if (!conversationResult.rows.length) throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      const conversation = conversationResult.rows[0];
      if (conversation.status !== "active") {
        throw conflict("CONVERSATION_CLOSED", "This coaching conversation is complete");
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
            SELECT MIN(candidate.id)
            FROM coaching_messages candidate
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
            content: duplicate.rows[0].content,
            structuredResponse: duplicate.rows[0].structured_response_json,
            createdAt: duplicate.rows[0].created_at,
          },
          idempotentReplay: true,
        };
      }

      const memberMessage = await client.query(
        `INSERT INTO coaching_messages
          (conversation_id, member_id, sender_type, content, client_message_id)
         VALUES ($1, $2, 'member', $3, $4)
         RETURNING *`,
        [conversation.id, member.id, input.content, input.clientMessageId]
      );
      const response = await responder({
        content: input.content,
        memberId: String(member.id),
        conversationId: String(conversation.id),
        planId: String(conversation.plan_id),
      });
      const coachMessage = await client.query(
        `INSERT INTO coaching_messages
          (conversation_id, member_id, sender_type, content, structured_response_json)
         VALUES ($1, $2, 'goals_coach', $3, $4)
         RETURNING *`,
        [conversation.id, member.id, response.content, response.structuredResponse]
      );

      let review = null;
      if (response.concern) {
        const concern = await client.query(
          `INSERT INTO coaching_concerns
            (member_id, conversation_id, source_message_id, plan_id,
             concern_category, safety_level, concerning_signals_json,
             stop_exercise, member_follow_up_required, member_follow_up_status,
             member_description, recommendation_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            member.id,
            conversation.id,
            memberMessage.rows[0].id,
            conversation.plan_id,
            response.concern.category,
            response.concern.safetyLevel,
            response.concern.concerningSignals || [],
            Boolean(response.concern.stopExercise),
            Boolean(response.concern.memberFollowUpRequired),
            response.concern.memberFollowUpRequired ? "pending" : "not_required",
            input.content,
            response.concern.recommendation || null,
          ]
        );
        const primaryCoach = await loadPrimaryCoach(client, member.id, true);
        const reviewResult = await client.query(
          `INSERT INTO coaching_reviews
            (concern_id, member_id, conversation_id, plan_id, priority,
             review_category, status, assigned_staff_user_id,
             member_follow_up_required, member_follow_up_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            concern.rows[0].id,
            member.id,
            conversation.id,
            conversation.plan_id,
            response.concern.safetyLevel,
            response.concern.category,
            primaryCoach ? "assigned" : "awaiting_review",
            primaryCoach ? primaryCoach.id : null,
            Boolean(response.concern.memberFollowUpRequired),
            response.concern.memberFollowUpRequired ? "pending" : "not_required",
          ]
        );
        await client.query(
          `INSERT INTO coaching_review_events
            (review_id, member_id, event_type, event_details_json)
           VALUES ($1, $2, 'created', $3)`,
          [reviewResult.rows[0].id, member.id, { automaticallyAssigned: Boolean(primaryCoach) }]
        );
        review = serializeReview(reviewResult.rows[0]);
      }

      await client.query(
        "UPDATE coaching_conversations SET updated_at = NOW() WHERE id = $1",
        [conversation.id]
      );
      return {
        memberMessageId: String(memberMessage.rows[0].id),
        response: serializeMessage(coachMessage.rows[0]),
        review,
        idempotentReplay: false,
      };
    });
  }

  async function listReviews(staffUser, filters) {
    const values = [];
    let accessSql;
    if (staffUser.role === "admin") {
      accessSql = "TRUE";
    } else {
      values.push(staffUser.id);
      accessSql = `review.assigned_staff_user_id = $${values.length}
        AND EXISTS (
          SELECT 1 FROM member_coach_assignments assignment
          WHERE assignment.member_id = review.member_id
            AND assignment.staff_user_id = $${values.length}
            AND assignment.status = 'active'
        )`;
    }
    if (filters.queue === "unassigned") {
      if (staffUser.role !== "admin") throw forbidden("ADMIN_ACCESS_REQUIRED", "Only admins can access the unassigned queue");
      accessSql += " AND review.assigned_staff_user_id IS NULL";
    } else if (filters.queue === "mine") {
      values.push(staffUser.id);
      accessSql += ` AND review.assigned_staff_user_id = $${values.length}`;
    }
    const priorityRank = "CASE review.priority WHEN 'urgent' THEN 1 WHEN 'priority' THEN 2 WHEN 'caution' THEN 3 ELSE 4 END";
    if (filters.cursor) {
      values.push(filters.cursor.r, filters.cursor.t, filters.cursor.id);
      accessSql += ` AND (
        ${priorityRank} > $${values.length - 2}::integer
        OR (${priorityRank} = $${values.length - 2}::integer
          AND (review.created_at, review.id) > ($${values.length - 1}::timestamptz, $${values.length}::bigint))
      )`;
    }
    values.push(filters.limit + 1);
    const result = await db.query(
      `SELECT review.*, ${priorityRank} AS priority_rank FROM coaching_reviews review
       WHERE ${accessSql}
       ORDER BY
         priority_rank ASC,
         review.created_at ASC,
         review.id ASC
       LIMIT $${values.length}`,
      values
    );
    const hasMore = result.rows.length > filters.limit;
    const rows = result.rows.slice(0, filters.limit);
    const last = rows[rows.length - 1];
    return {
      reviews: rows.map(serializeReview),
      nextCursor: hasMore && last
        ? encodeCursor({
            r: Number(last.priority_rank),
            t: new Date(last.created_at).toISOString(),
            id: String(last.id),
          })
        : null,
    };
  }

  async function requireStaffMemberAccess(client, staffUser, memberId, conceal = false) {
    if (staffUser.role === "admin") return;
    const result = await client.query(
      `SELECT 1 FROM member_coach_assignments
       WHERE member_id = $1 AND staff_user_id = $2 AND status = 'active'`,
      [memberId, staffUser.id]
    );
    if (!result.rows.length) {
      if (conceal) throw notFound("RECORD_NOT_FOUND", "Coaching record not found");
      throw forbidden("MEMBER_ACCESS_DENIED", "This member is not in your active coaching assignment");
    }
  }

  async function getReview(staffUser, reviewId) {
    return withTransaction(db, async (client) => {
      const result = await client.query("SELECT * FROM coaching_reviews WHERE id = $1", [reviewId]);
      if (!result.rows.length) throw notFound("REVIEW_NOT_FOUND", "Coaching review not found");
      const review = result.rows[0];
      await requireStaffMemberAccess(client, staffUser, review.member_id, true);
      if (staffUser.role !== "admin" && String(review.assigned_staff_user_id || "") !== staffUser.id) {
        throw notFound("REVIEW_NOT_FOUND", "Coaching review not found");
      }
      const events = await client.query(
        "SELECT * FROM coaching_review_events WHERE review_id = $1 ORDER BY created_at, id",
        [reviewId]
      );
      const concern = phase1dEnabled
        ? await client.query(
          `SELECT concern_category, safety_level, concerning_signals_json,
                  stop_exercise, member_response, safety_rule_version,
                  safety_classifier_version, classification_result_json
           FROM coaching_concerns WHERE id = $1`,
          [review.concern_id]
        )
        : { rows: [] };
      return {
        review: serializeReview(review),
        concern: concern.rows.length ? {
          category: concern.rows[0].concern_category,
          safetyLevel: concern.rows[0].safety_level,
          signals: concern.rows[0].concerning_signals_json || [],
          stopExercise: concern.rows[0].stop_exercise,
          memberResponse: concern.rows[0].member_response || null,
          safetyRuleVersion: concern.rows[0].safety_rule_version || null,
          safetyClassifierVersion: concern.rows[0].safety_classifier_version || null,
          classificationResult: concern.rows[0].classification_result_json || null,
        } : null,
        events: events.rows.map(serializeReviewEvent),
      };
    });
  }

  async function updateReview(staffUser, reviewId, input) {
    return withTransaction(db, async (client) => {
      const result = await client.query("SELECT * FROM coaching_reviews WHERE id = $1 FOR UPDATE", [reviewId]);
      if (!result.rows.length) throw notFound("REVIEW_NOT_FOUND", "Coaching review not found");
      const review = result.rows[0];
      if (input.action === "assign" || input.action === "reassign") {
        if (staffUser.role !== "admin") throw forbidden("ADMIN_ACCESS_REQUIRED", "Only an admin can assign reviews");
        if (["resolved", "no_action_needed"].includes(review.status)) {
          throw conflict("REVIEW_ALREADY_COMPLETE", "A completed coaching review cannot be reassigned");
        }
        const target = await client.query(
          "SELECT id, role FROM staff_users WHERE id = $1 AND active = TRUE FOR UPDATE",
          [input.staffUserId]
        );
        if (!target.rows.length) {
          throw conflict("ASSIGNEE_NOT_ACTIVE_FOR_MEMBER", "The selected coach does not have an active assignment for this member");
        }
        if (target.rows[0].role !== "admin") {
          const assignment = await client.query(
            `SELECT id FROM member_coach_assignments
             WHERE member_id = $1
               AND staff_user_id = $2
               AND status = 'active'
             FOR UPDATE`,
            [review.member_id, input.staffUserId]
          );
          if (!assignment.rows.length) {
            throw conflict("ASSIGNEE_NOT_ACTIVE_FOR_MEMBER", "The selected coach does not have an active assignment for this member");
          }
        }
        const eventType = review.assigned_staff_user_id ? "reassigned" : "assigned";
        const updated = await client.query(
          `UPDATE coaching_reviews
           SET assigned_staff_user_id = $1,
               assigned_by_staff_user_id = $2,
               status = 'assigned',
               updated_at = NOW()
           WHERE id = $3
           RETURNING *`,
          [input.staffUserId, staffUser.id, reviewId]
        );
        await client.query(
          `INSERT INTO coaching_review_events
            (review_id, member_id, actor_staff_user_id, event_type, event_details_json)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            reviewId,
            review.member_id,
            staffUser.id,
            eventType,
            {
              fromStaffUserId: review.assigned_staff_user_id
                ? String(review.assigned_staff_user_id)
                : null,
              toStaffUserId: String(input.staffUserId),
            },
          ]
        );
        return serializeReview(updated.rows[0]);
      }

      await requireStaffMemberAccess(client, staffUser, review.member_id, true);
      if (staffUser.role !== "admin" && String(review.assigned_staff_user_id || "") !== staffUser.id) {
        throw notFound("REVIEW_NOT_FOUND", "Coaching review not found");
      }
      if (input.action === "start") {
        if (["resolved", "no_action_needed"].includes(review.status)) {
          throw conflict("REVIEW_ALREADY_COMPLETE", "A completed coaching review cannot be reopened in Phase 2");
        }
        if (!review.assigned_staff_user_id) throw conflict("REVIEW_UNASSIGNED", "Assign this review before starting it");
        const updated = await client.query(
          `UPDATE coaching_reviews SET status = 'in_review', updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [reviewId]
        );
        await client.query(
          `UPDATE coaching_concerns
           SET status = 'reviewing', updated_at = NOW()
           WHERE id = $1 AND status = 'open'`,
          [review.concern_id]
        );
        await client.query(
          `INSERT INTO coaching_review_events
            (review_id, member_id, actor_staff_user_id, event_type)
           VALUES ($1, $2, $3, 'review_started')`,
          [reviewId, review.member_id, staffUser.id]
        );
        return serializeReview(updated.rows[0]);
      }
      if (input.action === "complete_follow_up") {
        if (!review.member_follow_up_required || review.member_follow_up_status !== "pending") {
          throw conflict("FOLLOW_UP_NOT_PENDING", "This review does not have pending member follow-up");
        }
        const updated = await client.query(
          `UPDATE coaching_reviews
           SET member_follow_up_status = 'completed',
               member_follow_up_completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [reviewId]
        );
        await client.query(
          `UPDATE coaching_concerns
           SET member_follow_up_status = 'completed',
               member_follow_up_completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [review.concern_id]
        );
        await client.query(
          `INSERT INTO coaching_review_events
            (review_id, member_id, actor_staff_user_id, event_type)
           VALUES ($1, $2, $3, 'member_follow_up_completed')`,
          [reviewId, review.member_id, staffUser.id]
        );
        return serializeReview(updated.rows[0]);
      }
      if (["resolved", "no_action_needed"].includes(review.status)) {
        throw conflict("REVIEW_ALREADY_COMPLETE", "This coaching review is already complete");
      }
      if (review.member_follow_up_required && review.member_follow_up_status !== "completed") {
        throw conflict("MEMBER_FOLLOW_UP_REQUIRED", "Complete the required member follow-up before closing this review");
      }
      const finalStatus = input.action === "resolve" ? "resolved" : "no_action_needed";
      const updated = await client.query(
        `UPDATE coaching_reviews
         SET status = $1, resolution_note = $2, resolved_at = NOW(), updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [finalStatus, input.resolutionNote, reviewId]
      );
      await client.query(
        `UPDATE coaching_concerns
         SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [review.concern_id]
      );
      await client.query(
        `INSERT INTO coaching_review_events
          (review_id, member_id, actor_staff_user_id, event_type)
         VALUES ($1, $2, $3, $4)`,
        [reviewId, review.member_id, staffUser.id, finalStatus]
      );
      return serializeReview(updated.rows[0]);
    });
  }

  async function addStaffMessage(staffUser, conversationId, input) {
    return withTransaction(db, async (client) => {
      const conversation = await client.query(
        "SELECT * FROM coaching_conversations WHERE id = $1 FOR UPDATE",
        [conversationId]
      );
      if (!conversation.rows.length) throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      await requireStaffMemberAccess(client, staffUser, conversation.rows[0].member_id, true);
      const existing = await client.query(
        `SELECT * FROM coaching_messages
         WHERE conversation_id = $1 AND client_message_id = $2`,
        [conversationId, input.clientMessageId]
      );
      if (existing.rows.length) {
        const row = existing.rows[0];
        if (
          row.sender_type !== "staff"
          || String(row.sender_staff_user_id) !== staffUser.id
          || row.content !== input.content
        ) {
          throw conflict("CLIENT_MESSAGE_ID_CONFLICT", "That clientMessageId was already used for a different message");
        }
        return { message: serializeMessage(row), idempotentReplay: true };
      }
      const message = await client.query(
        `INSERT INTO coaching_messages
          (conversation_id, member_id, sender_type, sender_staff_user_id, content, client_message_id)
         VALUES ($1, $2, 'staff', $3, $4, $5)
         RETURNING *`,
        [conversationId, conversation.rows[0].member_id, staffUser.id, input.content, input.clientMessageId]
      );
      await client.query(
        `INSERT INTO coaching_review_events
          (review_id, member_id, actor_staff_user_id, event_type, event_details_json)
         SELECT review.id,
                review.member_id,
                $1,
                'staff_message_added',
                jsonb_build_object('messageId', $2::text)
         FROM coaching_reviews review
         WHERE review.conversation_id = $3
           AND review.status IN ('assigned', 'in_review')`,
        [staffUser.id, message.rows[0].id, conversationId]
      );
      await client.query("UPDATE coaching_conversations SET updated_at = NOW() WHERE id = $1", [conversationId]);
      return { message: serializeMessage(message.rows[0]), idempotentReplay: false };
    });
  }

  async function addHumanRestriction(staffUser, reviewId, input) {
    if (!phase1dEnabled) {
      throw notFound("REVIEW_NOT_FOUND", "Coaching review not found");
    }
    if (staffUser.role !== "admin") {
      throw forbidden("ADMIN_ACCESS_REQUIRED", "Only an owner administrator can add a human restriction");
    }
    return withTransaction(db, async (client) => {
      const reviewResult = await client.query(
        "SELECT * FROM coaching_reviews WHERE id = $1 FOR UPDATE",
        [reviewId]
      );
      if (!reviewResult.rows.length) throw notFound("REVIEW_NOT_FOUND", "Coaching review not found");
      const review = reviewResult.rows[0];
      const restriction = await client.query(
        `INSERT INTO goals_coach_human_restrictions
          (member_id, conversation_id, review_id, author_staff_user_id,
           restriction_type, instruction_text, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          review.member_id,
          review.conversation_id,
          review.id,
          staffUser.id,
          input.restrictionType,
          input.instructionText,
          input.expiresAt || null,
        ]
      );
      await client.query(
        `INSERT INTO coaching_review_events
          (review_id, member_id, actor_staff_user_id, event_type, event_details_json)
         VALUES ($1, $2, $3, 'restriction_added', $4)`,
        [
          review.id,
          review.member_id,
          staffUser.id,
          { restrictionId: String(restriction.rows[0].id), restrictionType: input.restrictionType },
        ]
      );
      return {
        id: String(restriction.rows[0].id),
        reviewId: String(review.id),
        restrictionType: restriction.rows[0].restriction_type,
        status: restriction.rows[0].status,
        effectiveAt: restriction.rows[0].effective_at,
        expiresAt: restriction.rows[0].expires_at,
      };
    });
  }

  async function createAssignment(admin, input) {
    return withTransaction(db, async (client) => {
      const target = await client.query("SELECT id FROM staff_users WHERE id = $1 AND active = TRUE", [input.staffUserId]);
      if (!target.rows.length) throw conflict("STAFF_USER_INACTIVE", "The selected staff user is not active");
      const result = await client.query(
        `INSERT INTO member_coach_assignments
          (member_id, staff_user_id, assignment_type, created_by_staff_user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [input.memberId, input.staffUserId, input.assignmentType, admin.id]
      );
      return serializeAssignment(result.rows[0]);
    });
  }

  async function endAssignment(admin, assignmentId) {
    return withTransaction(db, async (client) => {
      const locked = await client.query(
        `SELECT * FROM member_coach_assignments
         WHERE id = $1 AND status = 'active'
         FOR UPDATE`,
        [assignmentId]
      );
      if (!locked.rows.length) throw notFound("ASSIGNMENT_NOT_FOUND", "Active assignment not found");
      const result = await client.query(
        `UPDATE member_coach_assignments
         SET status = 'ended', ends_at = NOW(), ended_by_staff_user_id = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'active'
         RETURNING *`,
        [admin.id, assignmentId]
      );
      return serializeAssignment(result.rows[0]);
    });
  }

  async function updateMemoryRecord(staffUser, tableName, recordId, input) {
    const specifications = {
      coaching_observations: {
        actions: ["activate", "confirm", "correct", "supersede", "retire"],
        supersedesColumn: "supersedes_observation_id",
      },
      coaching_milestones: {
        actions: ["confirm", "correct", "supersede", "withdraw"],
        supersedesColumn: "supersedes_milestone_id",
      },
      coaching_plan_change_proposals: {
        actions: ["approve", "reject", "withdraw"],
      },
    };
    const specification = specifications[tableName];
    if (!specification || !specification.actions.includes(input.action)) {
      const error = new Error("Unsupported coaching-record action");
      error.statusCode = 400;
      error.code = "INVALID_REQUEST";
      throw error;
    }
    return withTransaction(db, async (client) => {
      const record = await client.query(`SELECT * FROM ${tableName} WHERE id = $1 FOR UPDATE`, [recordId]);
      if (!record.rows.length) throw notFound("RECORD_NOT_FOUND", "Coaching record not found");
      const current = record.rows[0];
      await requireStaffMemberAccess(client, staffUser, current.member_id, true);

      if (tableName === "coaching_plan_change_proposals") {
        if (current.status !== "proposed") {
          throw conflict("INVALID_LIFECYCLE_TRANSITION", "Only a proposed plan change can be decided or withdrawn");
        }
        const statusByAction = { approve: "approved", reject: "rejected", withdraw: "withdrawn" };
        const targetStatus = statusByAction[input.action];
        const result = await client.query(
          `UPDATE coaching_plan_change_proposals
           SET status = $1,
               reviewed_by_staff_user_id = CASE WHEN $1 IN ('approved', 'rejected') THEN $2::bigint ELSE NULL END,
               reviewed_at = CASE WHEN $1 IN ('approved', 'rejected') THEN NOW() ELSE NULL END,
               review_note = $3,
               updated_at = NOW()
           WHERE id = $4 RETURNING *`,
          [targetStatus, staffUser.id, input.note, recordId]
        );
        return serializeCoachingRecord(result.rows[0]);
      }

      if (input.action === "correct") {
        if (!["candidate", "active", "confirmed", "recorded"].includes(current.status)) {
          throw conflict("INVALID_LIFECYCLE_TRANSITION", "A final coaching record cannot be corrected");
        }
        const sourceConversation = await client.query(
          `SELECT id FROM coaching_conversations
           WHERE id = $1 AND member_id = $2`,
          [input.sourceConversationId, current.member_id]
        );
        if (!sourceConversation.rows.length) throw notFound("RECORD_NOT_FOUND", "Coaching record not found");

        if (tableName === "coaching_observations") {
          const replacement = await client.query(
            `INSERT INTO coaching_observations
              (member_id, category, observation_text, status, confidence,
               source_type, source_conversation_id, source_staff_user_id,
               supersedes_observation_id)
             VALUES ($1, $2, $3, 'active', 'staff_confirmed', 'staff', $4, $5, $6)
             RETURNING *`,
            [
              current.member_id,
              input.category || current.category,
              input.correctedText,
              input.sourceConversationId,
              staffUser.id,
              current.id,
            ]
          );
          await client.query(
            "UPDATE coaching_observations SET status = 'superseded', updated_at = NOW() WHERE id = $1",
            [current.id]
          );
          return serializeCoachingRecord(replacement.rows[0]);
        }

        const replacement = await client.query(
          `INSERT INTO coaching_milestones
            (member_id, milestone_type, milestone_text, achieved_on, status,
             source_type, source_conversation_id, source_staff_user_id,
             supersedes_milestone_id)
           VALUES ($1, $2, $3, $4, 'recorded', 'staff', $5, $6, $7)
           RETURNING *`,
          [
            current.member_id,
            input.milestoneType || current.milestone_type,
            input.correctedText,
            input.achievedOn === undefined ? current.achieved_on : input.achievedOn,
            input.sourceConversationId,
            staffUser.id,
            current.id,
          ]
        );
        await client.query(
          `UPDATE coaching_milestones
           SET status = 'superseded', updated_at = NOW()
           WHERE id = $1`,
          [current.id]
        );
        return serializeCoachingRecord(replacement.rows[0]);
      }

      if (input.action === "supersede") {
        const validCurrentStatuses = tableName === "coaching_observations"
          ? ["candidate", "active", "confirmed"]
          : ["recorded", "confirmed"];
        if (!validCurrentStatuses.includes(current.status)) {
          throw conflict("INVALID_LIFECYCLE_TRANSITION", "A final coaching record cannot be superseded again");
        }
        const replacement = await client.query(
          `SELECT * FROM ${tableName}
           WHERE id = $1 AND member_id = $2
           FOR UPDATE`,
          [input.replacementRecordId, current.member_id]
        );
        if (!replacement.rows.length || String(replacement.rows[0].id) === String(current.id)) {
          throw notFound("RECORD_NOT_FOUND", "Coaching record not found");
        }
        const validReplacementStatuses = tableName === "coaching_observations"
          ? ["active", "confirmed"]
          : ["recorded", "confirmed"];
        if (!validReplacementStatuses.includes(replacement.rows[0].status)) {
          throw conflict("INVALID_LIFECYCLE_TRANSITION", "The replacement record is not active");
        }
        const existingSupersedes = replacement.rows[0][specification.supersedesColumn];
        if (existingSupersedes && String(existingSupersedes) !== String(current.id)) {
          throw conflict("INVALID_LIFECYCLE_TRANSITION", "The replacement already supersedes another record");
        }
        await client.query(
          `UPDATE ${tableName}
           SET ${specification.supersedesColumn} = $1, updated_at = NOW()
           WHERE id = $2`,
          [current.id, replacement.rows[0].id]
        );
        await client.query(
          `UPDATE ${tableName} SET status = 'superseded', updated_at = NOW() WHERE id = $1`,
          [current.id]
        );
        return serializeCoachingRecord({ ...replacement.rows[0], [specification.supersedesColumn]: current.id });
      }

      if (tableName === "coaching_observations") {
        const transitions = {
          activate: { from: ["candidate"], to: "active" },
          confirm: { from: ["candidate", "active"], to: "confirmed" },
          retire: { from: ["candidate", "active", "confirmed"], to: "retired" },
        };
        const transition = transitions[input.action];
        if (!transition || !transition.from.includes(current.status)) {
          throw conflict("INVALID_LIFECYCLE_TRANSITION", "That observation transition is not allowed");
        }
        const result = await client.query(
          `UPDATE coaching_observations
           SET status = $1,
               confidence = CASE WHEN $1 = 'confirmed' THEN 'staff_confirmed' ELSE confidence END,
               updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [transition.to, recordId]
        );
        return serializeCoachingRecord(result.rows[0]);
      }

      const transitions = {
        confirm: { from: ["recorded"], to: "confirmed" },
        withdraw: { from: ["recorded", "confirmed"], to: "withdrawn" },
      };
      const transition = transitions[input.action];
      if (!transition || !transition.from.includes(current.status)) {
        throw conflict("INVALID_LIFECYCLE_TRANSITION", "That milestone transition is not allowed");
      }
      const result = await client.query(
        `UPDATE coaching_milestones
         SET status = $1,
             confirmed_by_staff_user_id = CASE WHEN $1 = 'confirmed' THEN $2 ELSE confirmed_by_staff_user_id END,
             confirmed_at = CASE WHEN $1 = 'confirmed' THEN NOW() ELSE confirmed_at END,
             updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [transition.to, staffUser.id, recordId]
      );
      return serializeCoachingRecord(result.rows[0]);
    });
  }

  return {
    addHumanRestriction,
    addStaffMessage,
    closeConversation,
    createAssignment,
    endAssignment,
    getReview,
    listConversations,
    listMessages,
    listReviews,
    sendTestMessage,
    startSession,
    updateMemoryRecord,
    updateReview,
  };
}

module.exports = { createGoalsCoachService };
