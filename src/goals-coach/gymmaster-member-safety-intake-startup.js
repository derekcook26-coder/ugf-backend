"use strict";

const {
  createGymMasterGatekeeperMembershipVerifier,
  createGymMasterMemberAccessAuthorizer,
  exactGatekeeperMembersEndpoint,
} = require("./gymmaster-gatekeeper-membership");
const { createGymMasterMemberAuthorization } = require("./gymmaster-member-authorization");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");
const {
  createGymMasterMemberSessionAuthenticator,
  createGymMasterMemberSessionService,
  createGymMasterTwoHourSessionAuthenticator, createGymMasterTwoHourSessionService,
  TWO_HOUR_SESSION_FLAG, twoHourSessionEnabled,
} = require("./gymmaster-member-session");
const {
  MEMBER_SAFETY_INTAKE_FLAG,
  MEMBER_SAFETY_NOTICE_VERSION,
  createGymMasterMemberSafetyIntakeRouter,
  memberSafetyIntakeEnabled,
} = require("./gymmaster-member-safety-intake");

function validEndpoint(value) {
  try { exactGatekeeperMembersEndpoint(value); return true; } catch (_) { return false; }
}

function createGymMasterMemberSafetyIntakeStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = memberSafetyIntakeEnabled(environment[MEMBER_SAFETY_INTAKE_FLAG]);
  const origin = exactHttpsOrigin(environment.GOALS_COACH_MEMBER_LOGIN_ORIGIN);
  const endpoint = environment.GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL;
  const site = environment.GYMMASTER_SITE;
  const apiKey = environment.GYMMASTER_API_KEY;
  const secret = environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET;
  const twoHour = twoHourSessionEnabled(environment[TWO_HOUR_SESSION_FLAG]);
  const common = Object.freeze({
    status: enabled ? "not_ready" : "disabled",
    router: null,
    origin: null,
    activationPermitted: false,
    externalCallsPermitted: false,
  });
  if (!enabled || !origin || (!twoHour && !validEndpoint(endpoint))
    || (!twoHour && (typeof site !== "string" || !/^[a-z0-9_-]{1,40}$/i.test(site)))
    || (!twoHour && (typeof apiKey !== "string" || !apiKey))
    || (!twoHour && (typeof secret !== "string" || secret.length < 32))
    || !options.db || typeof options.db.query !== "function"
    || typeof options.db.connect !== "function"
    || (!twoHour && typeof options.fetchImpl !== "function")) return common;

  const sessionService = twoHour ? createGymMasterTwoHourSessionService({ db: options.db,
    ...(options.now ? { now: options.now } : {}),
  }) : createGymMasterMemberSessionService({
    secret,
    ...(options.now ? { now: options.now } : {}),
  });
  const mappingAuthorizer = createGymMasterMemberAuthorization({ db: options.db });
  const membershipVerifier = twoHour ? null : createGymMasterGatekeeperMembershipVerifier({
    endpoint, site, apiKey, fetchImpl: options.fetchImpl,
    ...(options.gatekeeperTimeoutMs === undefined ? {} : { timeoutMs: options.gatekeeperTimeoutMs }),
  });
  const accessAuthorizer = twoHour ? null : createGymMasterMemberAccessAuthorizer({
    mappingAuthorizer,
    membershipVerifier,
  });
  const router = createGymMasterMemberSafetyIntakeRouter({
    db: options.db,
    authenticateSession: twoHour ? createGymMasterTwoHourSessionAuthenticator({ sessionService }) : createGymMasterMemberSessionAuthenticator({ sessionService }),
    authorizeIdentity: twoHour ? async (identity) => Object.freeze({ active: true, mappingId: identity.mappingId, memberId: identity.memberId }) : accessAuthorizer.authorizeIdentity,
    origin,
    noticeVersion: MEMBER_SAFETY_NOTICE_VERSION,
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
  });
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    router,
    origin,
  });
}

module.exports = { createGymMasterMemberSafetyIntakeStartup };
