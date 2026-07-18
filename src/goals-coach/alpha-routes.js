const express = require("express");
const { createAlphaGoalsCoachService } = require("./alpha-service");
const { createCoachingCapability } = require("./phase1b-contracts");
const { createPhase1bCoachingService } = require("./phase1b-service");
const { createAlphaRateLimits } = require("./alpha-rate-limits");
const {
  alphaMessageInput,
  consentInput,
  feedbackInput,
  preferenceInput,
} = require("./alpha-validation");
const {
  decodeCursor,
  pageLimit,
  positiveId,
  requiredClientMessageId,
} = require("./validation");

function createAlphaGoalsCoachRouter(options) {
  const router = express.Router();
  const capabilityStartup = options.phase1bStartup || (options.coachingEngine
    ? {
      status: "ready",
      configuration: options.coachingEngine.configuration,
      engine: options.coachingEngine,
    }
    : {
      status: "disabled",
      configuration: Object.freeze({ aiEnabled: false, generationReady: false }),
      engine: null,
    });
  const service = options.service || createAlphaGoalsCoachService({
    db: options.db,
    applicationConfiguration: options.applicationConfiguration,
    coachingCapability: createCoachingCapability(capabilityStartup),
  });
  const requireCurrentConsent = options.requireCurrentConsent;
  const testOnlyResponder = options.testOnlyResponder || null;
  const phase1bService = options.phase1bService || (options.coachingEngine
    ? createPhase1bCoachingService({
      db: options.db,
      engine: options.coachingEngine,
      applicationConfiguration: options.applicationConfiguration,
      ...(options.phase1bServiceOptions || {}),
    })
    : null);
  const rateLimits = options.rateLimits || createAlphaRateLimits();

  if (typeof requireCurrentConsent !== "function") {
    throw new Error("Alpha Goals Coach routes require current-consent authorization");
  }

  router.get("/consent", rateLimits.read, async (req, res, next) => {
    try {
      return res.status(200).json(await service.getConsent(req.alphaMember));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/consent", rateLimits.consent, async (req, res, next) => {
    try {
      const input = consentInput(req.body);
      return res.status(200).json(await service.recordConsent(req.alphaMember, input.action));
    } catch (error) {
      return next(error);
    }
  });

  router.use(requireCurrentConsent);

  router.get("/profile", rateLimits.read, async (req, res, next) => {
    try {
      return res.status(200).json(await service.getProfile(req.alphaMember));
    } catch (error) {
      return next(error);
    }
  });

  router.get("/plan", rateLimits.read, async (req, res, next) => {
    try {
      return res.status(200).json(await service.getCurrentPlan(req.alphaMember));
    } catch (error) {
      return next(error);
    }
  });

  router.get("/preferences", rateLimits.read, async (req, res, next) => {
    try {
      return res.status(200).json(await service.getPreferences(req.alphaMember));
    } catch (error) {
      return next(error);
    }
  });

  router.patch("/preferences", rateLimits.mutation, async (req, res, next) => {
    try {
      return res.status(200).json(
        await service.updatePreferences(req.alphaMember, preferenceInput(req.body))
      );
    } catch (error) {
      return next(error);
    }
  });

  router.post("/session", rateLimits.session, async (req, res, next) => {
    try {
      return res.status(200).json(await service.startSession(req.alphaMember));
    } catch (error) {
      return next(error);
    }
  });

  router.get("/conversations", rateLimits.read, async (req, res, next) => {
    try {
      return res.status(200).json(await service.listConversations(req.alphaMember, {
        limit: pageLimit(req.query.limit),
        cursor: decodeCursor(req.query.cursor, ["t", "id"]),
      }));
    } catch (error) {
      return next(error);
    }
  });

  router.get("/conversations/:conversationId/messages", rateLimits.read, async (req, res, next) => {
    try {
      const conversationId = positiveId(req.params.conversationId, "conversationId");
      const result = await service.listMessages(req.alphaMember, conversationId, {
        limit: pageLimit(req.query.limit),
        cursor: decodeCursor(req.query.cursor, ["t", "id"]),
      });
      return res.status(200).json({ conversationId, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.get(
    "/conversations/:conversationId/turns/:clientMessageId",
    rateLimits.read,
    async (req, res, next) => {
      try {
        const conversationId = positiveId(req.params.conversationId, "conversationId");
        const clientMessageId = requiredClientMessageId(req.params.clientMessageId);
        return res.status(200).json(
          await service.getTurn(req.alphaMember, conversationId, clientMessageId)
        );
      } catch (error) {
        return next(error);
      }
    }
  );

  router.post("/conversations/:conversationId/messages", rateLimits.message, async (req, res, next) => {
    if (!phase1bService && !testOnlyResponder) {
      return res.status(503).json({
        error: "ALPHA_TEST_RESPONDER_NOT_AVAILABLE",
        message: "Private-alpha test messaging is not available in this startup mode.",
      });
    }
    try {
      const conversationId = positiveId(req.params.conversationId, "conversationId");
      const input = alphaMessageInput(req.body);
      const result = phase1bService
        ? await phase1bService.sendMessage(req.alphaMember, conversationId, input)
        : await service.sendTestMessage(
          req.alphaMember,
          conversationId,
          input,
          testOnlyResponder
        );
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/conversations/:conversationId/close", rateLimits.mutation, async (req, res, next) => {
    try {
      const conversationId = positiveId(req.params.conversationId, "conversationId");
      const conversation = await service.closeConversation(req.alphaMember, conversationId);
      return res.status(200).json({
        conversationId: conversation.id,
        status: conversation.status,
        archivedAt: conversation.archivedAt,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/feedback", rateLimits.mutation, async (req, res, next) => {
    try {
      return res.status(201).json(
        await service.createFeedback(req.alphaMember, feedbackInput(req.body))
      );
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createAlphaGoalsCoachRouter };
