const express = require("express");
const { createGoalsCoachService } = require("./service");
const { createGoalsCoachRateLimits } = require("./rate-limits");
const {
  clientMessageId,
  decodeCursor,
  messageContent,
  pageLimit,
  positiveId,
} = require("./validation");

function createGoalsCoachMemberRouter(options) {
  const router = express.Router();
  const service = options.service || createGoalsCoachService({ db: options.db });
  const requireMember = options.requireMember;
  const testOnlyResponder = options.testOnlyResponder || null;
  const rateLimits = options.rateLimits || createGoalsCoachRateLimits();

  if (typeof requireMember !== "function") {
    throw new Error("Goals Coach member routes require member authentication");
  }

  router.use(requireMember);

  router.post("/session", rateLimits.memberSession, async (req, res, next) => {
    try {
      const result = await service.startSession(req.memberClaims);
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/conversations", rateLimits.memberRead, async (req, res, next) => {
    try {
      const result = await service.listConversations(req.memberClaims, {
        limit: pageLimit(req.query.limit),
        cursor: decodeCursor(req.query.cursor, ["t", "id"]),
      });
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/conversations/:conversationId/messages", rateLimits.memberRead, async (req, res, next) => {
    try {
      const conversationId = positiveId(req.params.conversationId, "conversationId");
      const result = await service.listMessages(req.memberClaims, conversationId, {
        limit: pageLimit(req.query.limit),
        cursor: decodeCursor(req.query.cursor, ["t", "id"]),
      });
      return res.status(200).json({ conversationId, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/conversations/:conversationId/messages", rateLimits.memberMessage, async (req, res, next) => {
    if (!testOnlyResponder) {
      return res.status(503).json({
        error: "COACHING_NOT_READY",
        message: "Goals Coach ongoing conversations are not available yet.",
      });
    }

    try {
      const conversationId = positiveId(req.params.conversationId, "conversationId");
      const result = await service.sendTestMessage(
        req.memberClaims,
        conversationId,
        {
          content: messageContent(req.body && req.body.content),
          clientMessageId: clientMessageId(req.body && req.body.clientMessageId),
        },
        testOnlyResponder
      );
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/conversations/:conversationId/close", rateLimits.memberClose, async (req, res, next) => {
    try {
      const conversationId = positiveId(req.params.conversationId, "conversationId");
      const conversation = await service.closeConversation(req.memberClaims, conversationId);
      return res.status(200).json({
        conversationId: conversation.id,
        status: conversation.status,
        archivedAt: conversation.archivedAt,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createGoalsCoachMemberRouter };
