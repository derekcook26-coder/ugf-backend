const express = require("express");
const { createGoalsCoachService } = require("./service");
const { createGoalsCoachRateLimits } = require("./rate-limits");
const {
  decodeCursor,
  enumValue,
  messageContent,
  optionalDate,
  optionalText,
  pageLimit,
  positiveId,
  requiredClientMessageId,
} = require("./validation");

function createGoalsCoachStaffRouter(options) {
  const router = express.Router();
  const service = options.service || createGoalsCoachService({ db: options.db });
  const requireAdmin = options.requireAdmin;
  const rateLimits = options.rateLimits || createGoalsCoachRateLimits();

  router.get("/session", rateLimits.staffRead, (req, res) => {
    res.status(200).json({
      staffUser: {
        id: req.staffUser.id,
        displayName: req.staffUser.displayName,
        role: req.staffUser.role,
      },
    });
  });

  router.get("/coaching-reviews", rateLimits.staffRead, async (req, res, next) => {
    try {
      const queue = req.query.queue === undefined
        ? "all"
        : enumValue(req.query.queue, "queue", ["all", "mine", "unassigned"]);
      const result = await service.listReviews(req.staffUser, {
        queue,
        limit: pageLimit(req.query.limit),
        cursor: decodeCursor(req.query.cursor, ["r", "t", "id"]),
      });
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/coaching-reviews/:reviewId", rateLimits.staffRead, async (req, res, next) => {
    try {
      const result = await service.getReview(
        req.staffUser,
        positiveId(req.params.reviewId, "reviewId")
      );
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.patch("/coaching-reviews/:reviewId", rateLimits.staffMutation, async (req, res, next) => {
    try {
      const action = enumValue(
        req.body && req.body.action,
        "action",
        ["assign", "reassign", "start", "complete_follow_up", "resolve", "no_action_needed"]
      );
      const staffUserId = ["assign", "reassign"].includes(action)
        ? positiveId(req.body.staffUserId, "staffUserId")
        : null;
      const resolutionNote = ["resolve", "no_action_needed"].includes(action)
        ? optionalText(req.body.resolutionNote, "resolutionNote", 4000)
        : null;
      if (["resolve", "no_action_needed"].includes(action) && !resolutionNote) {
        const error = new Error("resolutionNote is required when completing a coaching review");
        error.statusCode = 400;
        error.code = "INVALID_REQUEST";
        throw error;
      }
      const review = await service.updateReview(
        req.staffUser,
        positiveId(req.params.reviewId, "reviewId"),
        { action, staffUserId, resolutionNote }
      );
      return res.status(200).json({ review });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/coaching-conversations/:conversationId/messages", rateLimits.staffMutation, async (req, res, next) => {
    try {
      const result = await service.addStaffMessage(
        req.staffUser,
        positiveId(req.params.conversationId, "conversationId"),
        {
          content: messageContent(req.body && req.body.content),
          clientMessageId: requiredClientMessageId(req.body && req.body.clientMessageId),
        }
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/member-coach-assignments", rateLimits.staffMutation, requireAdmin, async (req, res, next) => {
    try {
      const assignment = await service.createAssignment(req.staffUser, {
        memberId: positiveId(req.body && req.body.memberId, "memberId"),
        staffUserId: positiveId(req.body && req.body.staffUserId, "staffUserId"),
        assignmentType: enumValue(
          req.body && req.body.assignmentType,
          "assignmentType",
          ["primary", "secondary"]
        ),
      });
      return res.status(201).json({ assignment });
    } catch (error) {
      return next(error);
    }
  });

  router.patch("/member-coach-assignments/:assignmentId", rateLimits.staffMutation, requireAdmin, async (req, res, next) => {
    try {
      enumValue(req.body && req.body.action, "action", ["end"]);
      const assignment = await service.endAssignment(
        req.staffUser,
        positiveId(req.params.assignmentId, "assignmentId")
      );
      return res.status(200).json({ assignment });
    } catch (error) {
      return next(error);
    }
  });

  const updateRecord = (tableName, actions) => async (req, res, next) => {
    try {
      const body = req.body || {};
      const action = enumValue(body.action, "action", actions);
      const input = {
        action,
        note: optionalText(body.note, "note", 4000),
      };
      if (action === "correct") {
        input.correctedText = optionalText(body.correctedText, "correctedText", 2000);
        if (!input.correctedText) {
          const error = new Error("correctedText is required for a correction");
          error.statusCode = 400;
          error.code = "INVALID_REQUEST";
          throw error;
        }
        input.sourceConversationId = positiveId(body.sourceConversationId, "sourceConversationId");
        if (tableName === "coaching_observations" && body.category !== undefined) {
          input.category = enumValue(body.category, "category", [
            "exercise_preference", "exercise_dislike", "recurring_discomfort",
            "work_schedule", "equipment_access", "accountability_preference",
            "motivation_style", "lifestyle", "movement_limitation", "other",
          ]);
        }
        if (tableName === "coaching_milestones") {
          input.milestoneType = optionalText(body.milestoneType, "milestoneType", 200);
          if (body.achievedOn !== undefined) {
            input.achievedOn = optionalDate(body.achievedOn, "achievedOn");
          }
        }
      }
      if (action === "supersede") {
        input.replacementRecordId = positiveId(body.replacementRecordId, "replacementRecordId");
      }
      if (
        tableName === "coaching_plan_change_proposals"
        && ["approve", "reject"].includes(action)
        && !input.note
      ) {
        const error = new Error("note is required when approving or rejecting a plan-change proposal");
        error.statusCode = 400;
        error.code = "INVALID_REQUEST";
        throw error;
      }
      const record = await service.updateMemoryRecord(
        req.staffUser,
        tableName,
        positiveId(req.params.recordId, "recordId"),
        input
      );
      return res.status(200).json({ record });
    } catch (error) {
      return next(error);
    }
  };

  router.patch(
    "/coaching-observations/:recordId",
    rateLimits.staffMutation,
    updateRecord("coaching_observations", ["activate", "confirm", "correct", "supersede", "retire"])
  );
  router.patch(
    "/coaching-milestones/:recordId",
    rateLimits.staffMutation,
    updateRecord("coaching_milestones", ["confirm", "correct", "supersede", "withdraw"])
  );
  router.patch(
    "/plan-change-proposals/:recordId",
    rateLimits.staffMutation,
    updateRecord("coaching_plan_change_proposals", ["approve", "reject", "withdraw"])
  );

  return router;
}

module.exports = { createGoalsCoachStaffRouter };
