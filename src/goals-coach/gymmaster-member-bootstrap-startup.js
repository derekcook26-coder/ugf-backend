"use strict";

const { exactHttpsOrigin } = require("./gymmaster-member-login-route");
const { createGymMasterMemberAuthorization } = require("./gymmaster-member-authorization");
const {
  runBoundedPostgresTransaction,
} = require("./bounded-postgres-transaction");
const {
  createGymMasterMemberSessionAuthenticator,
  createGymMasterMemberSessionService,
  TWO_HOUR_SESSION_FLAG,
  twoHourSessionEnabled,
} = require("./gymmaster-member-session");
const {
  MEMBER_BOOTSTRAP_AUTHORIZATION_TIMEOUT_MILLISECONDS,
  MEMBER_BOOTSTRAP_FLAG,
  createGymMasterMemberBootstrapRouter,
  memberBootstrapEnabled,
} = require("./gymmaster-member-bootstrap");
const { createMemberBootstrap } = require("./member-bootstrap-contract");

function createBoundedMemberAuthorization(options = {}) {
  const pool = options.pool;
  const timeoutMilliseconds = options.timeoutMilliseconds;
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("Member bootstrap authorization requires a PostgreSQL pool");
  }
  return Object.freeze({
    async authorizeIdentity(identity, context = {}) {
      if (!context.terminalState || typeof context.outerDeadlineNs !== "bigint") {
        throw new Error("Member bootstrap authorization requires a bounded request context");
      }
      const result = await runBoundedPostgresTransaction({
        pool,
        terminalState: context.terminalState,
        outerDeadlineNs: context.outerDeadlineNs,
        phaseMilliseconds: timeoutMilliseconds,
        readOnly: true,
        work: (client) => createGymMasterMemberAuthorization({ db: client }).authorizeIdentity(identity),
      });
      return result.value;
    },
  });
}

function createGymMasterMemberBootstrapStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = memberBootstrapEnabled(environment[MEMBER_BOOTSTRAP_FLAG]);
  const origin = exactHttpsOrigin(environment.GOALS_COACH_MEMBER_LOGIN_ORIGIN);
  const secret = environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET;
  const twoHourSession = twoHourSessionEnabled(environment[TWO_HOUR_SESSION_FLAG]);
  const common = Object.freeze({
    status: enabled ? "not_ready" : "disabled",
    router: null,
    origin: null,
    activationPermitted: false,
    readOnly: true,
    externalCallsPermitted: false,
  });
  if (!enabled || !origin || twoHourSession
    || typeof secret !== "string" || secret.length < 32
    || !options.db || typeof options.db.connect !== "function") {
    return common;
  }
  const bootstrap = createMemberBootstrap({
    origin,
    consentStartup: options.consentStartup,
    safetyStartup: options.safetyStartup,
    workoutStartup: options.workoutStartup,
    conversationStartup: options.conversationStartup,
  });
  const sessionService = createGymMasterMemberSessionService({
    secret,
    ...(options.now ? { now: options.now } : {}),
  });
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds)
    && options.timeoutMilliseconds > 0
    && options.timeoutMilliseconds <= MEMBER_BOOTSTRAP_AUTHORIZATION_TIMEOUT_MILLISECONDS
    ? options.timeoutMilliseconds : MEMBER_BOOTSTRAP_AUTHORIZATION_TIMEOUT_MILLISECONDS;
  const authorization = createBoundedMemberAuthorization({
    pool: options.db,
    timeoutMilliseconds,
  });
  const router = createGymMasterMemberBootstrapRouter({
    authenticateSession: createGymMasterMemberSessionAuthenticator({ sessionService }),
    authorizeIdentity: authorization.authorizeIdentity,
    origin,
    bootstrap,
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.timeoutMilliseconds ? { timeoutMilliseconds: options.timeoutMilliseconds } : {}),
  });
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    router,
    origin,
    bootstrap,
  });
}

module.exports = { createBoundedMemberAuthorization, createGymMasterMemberBootstrapStartup };
