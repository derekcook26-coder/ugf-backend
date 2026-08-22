"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { createTerminalState, deadlineAfter, monotonicNow } = require("./bounded-postgres-transaction");
const { validGymMasterIdentity } = require("./gymmaster-member-authorization");
const {
  MEMBER_CONVERSATION_TURN_CONTRACT_VERSION,
  MEMBER_CONVERSATION_TURN_MAXIMUM_BYTES,
  createMemberConversationTurnResponse,
  memberConversationTurnRequestHash,
  parseMemberConversationTurnRequest,
  parseMemberConversationTurnResponse,
  responseMatchesRequest,
} = require("./member-conversation-turn-contract");
const { validMemberConversationTurnIdempotency } = require("./member-conversation-turn-idempotency");
const {
  validConversationOwnershipResult,
  validMemberConversationTurnOwnership,
} = require("./member-conversation-turn-ownership");
const { validMemberConversationTurnSafetyClassifier } = require("./member-conversation-turn-safety");
const {
  validCurrentConsent,
  validCurrentConsentResult,
  validCurrentMembership,
  validCurrentMembershipResult,
  validCurrentSafetyEligibility,
  validCurrentSafetyEligibilityResult,
} = require("./member-conversation-turn-prerequisites");

const MEMBER_CONVERSATION_TURN_FLAG = "GOALS_COACH_MEMBER_CONVERSATION_TURN_ENABLED";
const MEMBER_CONVERSATION_TURN_TIMEOUT_MILLISECONDS = 5000;
const DATABASE_ID = /^[1-9]\d{0,18}$/;

function memberConversationTurnEnabled(value) { return value === "true"; }
function send(res, status, error) {
  if (res.headersSent || res.writableEnded || res.destroyed || res.closed) return undefined;
  return res.status(status).json({ error });
}
function responseAuthorityRevoked(req, res, error) {
  return Boolean(error && error.responseAllowed === false)
    || Boolean(req && (req.aborted || (req.destroyed && !req.complete)))
    || Boolean(res && (res.writableEnded || res.destroyed || res.closed));
}

function runBoundedTurn(operation, req, res, milliseconds) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const terminalState = createTerminalState();
    const controller = new AbortController();
    const outerDeadlineNs = deadlineAfter(monotonicNow(), milliseconds);
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener?.("aborted", onAborted);
      req.removeListener?.("close", onRequestClose);
      res.removeListener?.("close", onResponseClose);
      action(value);
    };
    const terminate = (reason, responseAllowed) => {
      terminalState.terminate(reason, { responseAllowed });
      controller.abort(reason);
      finish(reject, Object.assign(new Error(reason), { code: reason, responseAllowed }));
    };
    const onAborted = () => terminate("request_aborted", false);
    const onRequestClose = () => { if (!req.complete) onAborted(); };
    const onResponseClose = () => terminate("response_closed", false);
    const timer = setTimeout(() => terminate("member_conversation_turn_deadline", true), milliseconds);
    timer.unref?.();
    req.once?.("aborted", onAborted);
    req.once?.("close", onRequestClose);
    res.once?.("close", onResponseClose);
    if (req.aborted || (req.destroyed && !req.complete)) return onAborted();
    Promise.resolve().then(() => operation(Object.freeze({
      terminalState, outerDeadlineNs, signal: controller.signal,
    }))).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function validAuthorization(value) {
  return Boolean(value && value.active === true
    && DATABASE_ID.test(String(value.mappingId)) && DATABASE_ID.test(String(value.memberId)));
}

function validProvider(provider) {
  return Boolean(provider
    && provider.contractVersion === MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    && provider.cancellationMode === "abort_signal_required"
    && provider.persistencePermitted === false
    && provider.externalCallsPermitted === false
    && typeof provider.processTurn === "function");
}

function requireActive(context) {
  if (!context.signal.aborted && !context.terminalState.isTerminal()) return;
  const error = new Error("Member conversation turn authority ended");
  error.code = context.terminalState.reason() || "member_conversation_turn_terminal";
  error.responseAllowed = context.terminalState.responseAllowed();
  throw error;
}

function validProviderAcceptance(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.accepted === true);
}

function createTurnRateLimit() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `member:${String(req.alphaMemberIdentity.authSubject)}`,
    handler: (_req, res) => send(res, 429, "RATE_LIMITED"),
  });
}

function createConversationTurnRequestHandler(options = {}) {
  const {
    authorizeIdentity, conversationOwnership, currentConsent, currentMembership,
    currentSafetyEligibility, idempotency, provider, safetyClassifier, timeoutMilliseconds,
  } = options;
  return async (req, res) => {
    if (Object.keys(req.query).length || !validGymMasterIdentity(req.alphaMemberIdentity)) {
      return send(res, 401, "MEMBER_AUTHENTICATION_REQUIRED");
    }
    let request;
    try { request = parseMemberConversationTurnRequest(req.body); }
    catch { return send(res, 400, "MEMBER_CONVERSATION_TURN_INVALID"); }
    try {
      const response = await runBoundedTurn(async (context) => {
        const authorization = await authorizeIdentity(req.alphaMemberIdentity, context);
        requireActive(context);
        if (!validAuthorization(authorization)) return { concealed: true };
        const membership = await currentMembership.verify(Object.freeze({
          memberId: String(authorization.memberId),
          identity: req.alphaMemberIdentity,
          signal: context.signal,
          terminalState: context.terminalState,
          outerDeadlineNs: context.outerDeadlineNs,
        }));
        requireActive(context);
        if (!validCurrentMembershipResult(membership)) return { concealed: true };
        const providerContext = Object.freeze({
          memberId: String(authorization.memberId), request, signal: context.signal,
          terminalState: context.terminalState, outerDeadlineNs: context.outerDeadlineNs,
        });
        const ownership = await conversationOwnership.authorize(Object.freeze({
          memberId: providerContext.memberId,
          conversation: request.conversation,
          signal: context.signal,
          terminalState: context.terminalState,
          outerDeadlineNs: context.outerDeadlineNs,
        }));
        requireActive(context);
        if (!validConversationOwnershipResult(ownership)) return { concealed: true };
        const prerequisiteContext = Object.freeze({
          memberId: providerContext.memberId,
          mappingId: String(authorization.mappingId),
          signal: context.signal,
          terminalState: context.terminalState,
          outerDeadlineNs: context.outerDeadlineNs,
        });
        const consent = await currentConsent.verify(prerequisiteContext);
        requireActive(context);
        if (!validCurrentConsentResult(consent)) return { concealed: true };
        const safetyEligibility = await currentSafetyEligibility.verify(prerequisiteContext);
        requireActive(context);
        if (!validCurrentSafetyEligibilityResult(safetyEligibility)) return { concealed: true };
        const signature = memberConversationTurnRequestHash(request);
        const execution = await idempotency.execute({
          key: request.idempotencyKey,
          signature,
          signal: context.signal,
          operation: async () => {
            requireActive(context);
            const safety = await safetyClassifier.classify({ request, signal: context.signal });
            requireActive(context);
            const classifiedResponse = createMemberConversationTurnResponse(request, safety);
            if (classifiedResponse.result.state !== "safe_to_process") return { response: classifiedResponse };
            const accepted = await provider.processTurn(providerContext);
            requireActive(context);
            if (!validProviderAcceptance(accepted)) throw new Error("Conversation turn provider result is invalid");
            const parsed = createMemberConversationTurnResponse(request, safety);
            if (!responseMatchesRequest(request, parsed)) throw new Error("Conversation turn response provenance mismatch");
            return { response: parsed };
          },
        });
        requireActive(context);
        if (!execution || typeof execution !== "object" || Array.isArray(execution)
          || Object.keys(execution).length !== 1 || !("response" in execution)) {
          throw new Error("Conversation turn idempotency result is invalid");
        }
        const parsed = parseMemberConversationTurnResponse(execution.response);
        if (!responseMatchesRequest(request, parsed)) throw new Error("Conversation turn response provenance mismatch");
        return { response: parsed };
      }, req, res, timeoutMilliseconds);
      if (response.concealed) return send(res, 404, "MEMBER_CONVERSATION_NOT_FOUND");
      if (responseAuthorityRevoked(req, res)) return undefined;
      return res.status(200).json(response.response);
    } catch (error) {
      if (responseAuthorityRevoked(req, res, error)) return undefined;
      return send(res, 503, "MEMBER_CONVERSATION_TURN_UNAVAILABLE");
    }
  };
}

function createGymMasterMemberConversationTurnRouter(options = {}) {
  const {
    authenticateSession, authorizeIdentity, conversationOwnership, currentConsent, currentMembership,
    currentSafetyEligibility, idempotency, origin, provider, safetyClassifier,
  } = options;
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds)
    && options.timeoutMilliseconds > 0 && options.timeoutMilliseconds <= MEMBER_CONVERSATION_TURN_TIMEOUT_MILLISECONDS
    ? options.timeoutMilliseconds : MEMBER_CONVERSATION_TURN_TIMEOUT_MILLISECONDS;
  if (typeof authenticateSession !== "function" || typeof authorizeIdentity !== "function"
    || !origin || !validProvider(provider) || !validMemberConversationTurnOwnership(conversationOwnership)
    || !validCurrentMembership(currentMembership) || !validCurrentConsent(currentConsent)
    || !validCurrentSafetyEligibility(currentSafetyEligibility)
    || !validMemberConversationTurnIdempotency(idempotency)
    || !validMemberConversationTurnSafetyClassifier(safetyClassifier)) {
    throw new Error("Member conversation turn dependencies are incomplete");
  }
  const router = express.Router();
  router.post("/",
    (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.headers.origin !== origin) return send(res, 403, "MEMBER_ORIGIN_NOT_ALLOWED");
      return authenticateSession(req, res, next);
    },
    options.rateLimit || createTurnRateLimit(),
    express.json({ inflate: false, limit: MEMBER_CONVERSATION_TURN_MAXIMUM_BYTES, strict: true }),
    createConversationTurnRequestHandler({
      authorizeIdentity, conversationOwnership, currentConsent, currentMembership,
      currentSafetyEligibility, idempotency, provider, safetyClassifier, timeoutMilliseconds,
    })
  );
  router.use((error, _req, res, _next) => {
    if (error && (error.type === "entity.too.large" || error instanceof SyntaxError)) {
      return send(res, 400, "MEMBER_CONVERSATION_TURN_INVALID");
    }
    return send(res, 503, "MEMBER_CONVERSATION_TURN_UNAVAILABLE");
  });
  return router;
}

module.exports = {
  MEMBER_CONVERSATION_TURN_FLAG,
  MEMBER_CONVERSATION_TURN_TIMEOUT_MILLISECONDS,
  createConversationTurnRequestHandler,
  createGymMasterMemberConversationTurnRouter,
  memberConversationTurnEnabled,
  responseAuthorityRevoked,
  runBoundedTurn,
  requireActive,
  validProvider,
  validProviderAcceptance,
};
