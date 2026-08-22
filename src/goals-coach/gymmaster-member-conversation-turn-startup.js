"use strict";

const { exactHttpsOrigin } = require("./gymmaster-member-login-route");
const { createGymMasterMemberAuthorization } = require("./gymmaster-member-authorization");
const { runBoundedPostgresTransaction } = require("./bounded-postgres-transaction");
const {
  createGymMasterMemberSessionAuthenticator,
  createGymMasterMemberSessionService,
  TWO_HOUR_SESSION_FLAG,
  twoHourSessionEnabled,
} = require("./gymmaster-member-session");
const {
  MEMBER_CONVERSATION_TURN_FLAG,
  MEMBER_CONVERSATION_TURN_TIMEOUT_MILLISECONDS,
  createGymMasterMemberConversationTurnRouter,
  memberConversationTurnEnabled,
  validProvider,
} = require("./gymmaster-member-conversation-turn");
const { validMemberConversationTurnIdempotency } = require("./member-conversation-turn-idempotency");
const { validMemberConversationTurnOwnership } = require("./member-conversation-turn-ownership");
const { validMemberConversationTurnSafetyClassifier } = require("./member-conversation-turn-safety");
const {
  validCurrentConsent,
  validCurrentMembership,
  validCurrentSafetyEligibility,
} = require("./member-conversation-turn-prerequisites");

function createBoundedTurnAuthorization(options = {}) {
  if (!options.pool || typeof options.pool.connect !== "function") {
    throw new Error("Member conversation turn authorization requires a PostgreSQL pool");
  }
  return Object.freeze({
    async authorizeIdentity(identity, context = {}) {
      if (!context.terminalState || typeof context.outerDeadlineNs !== "bigint") {
        throw new Error("Member conversation turn authorization requires a bounded request context");
      }
      const result = await runBoundedPostgresTransaction({
        pool: options.pool, terminalState: context.terminalState,
        outerDeadlineNs: context.outerDeadlineNs, phaseMilliseconds: options.timeoutMilliseconds,
        readOnly: true,
        work: (client) => createGymMasterMemberAuthorization({ db: client }).authorizeIdentity(identity),
      });
      return result.value;
    },
  });
}

function createGymMasterMemberConversationTurnStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = memberConversationTurnEnabled(environment[MEMBER_CONVERSATION_TURN_FLAG]);
  const common = Object.freeze({
    status: enabled ? "not_ready" : "disabled", router: null, origin: null,
    activationPermitted: false, readOnly: true, externalCallsPermitted: false,
  });
  const origin = exactHttpsOrigin(environment.GOALS_COACH_MEMBER_LOGIN_ORIGIN);
  const secret = environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET;
  if (!enabled || !origin || twoHourSessionEnabled(environment[TWO_HOUR_SESSION_FLAG])
    || typeof secret !== "string" || secret.length < 32
    || !options.db || typeof options.db.connect !== "function" || !validProvider(options.provider)
    || !validMemberConversationTurnOwnership(options.conversationOwnership)
    || !validCurrentMembership(options.currentMembership)
    || !validCurrentConsent(options.currentConsent)
    || !validCurrentSafetyEligibility(options.currentSafetyEligibility)
    || !validMemberConversationTurnIdempotency(options.idempotency)
    || !validMemberConversationTurnSafetyClassifier(options.safetyClassifier)) return common;
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds)
    && options.timeoutMilliseconds > 0 && options.timeoutMilliseconds <= MEMBER_CONVERSATION_TURN_TIMEOUT_MILLISECONDS
    ? options.timeoutMilliseconds : MEMBER_CONVERSATION_TURN_TIMEOUT_MILLISECONDS;
  const sessionService = createGymMasterMemberSessionService({ secret, ...(options.now ? { now: options.now } : {}) });
  const authorization = createBoundedTurnAuthorization({ pool: options.db, timeoutMilliseconds });
  const router = createGymMasterMemberConversationTurnRouter({
    authenticateSession: createGymMasterMemberSessionAuthenticator({ sessionService }),
    authorizeIdentity: authorization.authorizeIdentity, conversationOwnership: options.conversationOwnership,
    currentMembership: options.currentMembership, currentConsent: options.currentConsent,
    currentSafetyEligibility: options.currentSafetyEligibility,
    idempotency: options.idempotency,
    origin, provider: options.provider, safetyClassifier: options.safetyClassifier,
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}), timeoutMilliseconds,
  });
  return Object.freeze({ ...common, status: "ready_for_separate_route_composition", router, origin });
}

module.exports = { createBoundedTurnAuthorization, createGymMasterMemberConversationTurnStartup };
