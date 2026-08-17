"use strict";

const { createGymMasterGatekeeperMembershipVerifier, createGymMasterMemberAccessAuthorizer, exactGatekeeperMembersEndpoint } = require("./gymmaster-gatekeeper-membership");
const { createGymMasterMemberAuthorization } = require("./gymmaster-member-authorization");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");
const { createGymMasterMemberSessionAuthenticator, createGymMasterMemberSessionService, createGymMasterTwoHourSessionAuthenticator, createGymMasterTwoHourSessionService, TWO_HOUR_SESSION_FLAG, twoHourSessionEnabled } = require("./gymmaster-member-session");
const { MEMBER_COACHING_CONSENT_FLAG, MEMBER_COACHING_CONSENT_NOTICE_VERSION, createGymMasterMemberCoachingConsentRouter, memberCoachingConsentEnabled } = require("./gymmaster-member-coaching-consent");

function validEndpoint(value) { try { exactGatekeeperMembersEndpoint(value); return true; } catch (_) { return false; } }
function createGymMasterMemberCoachingConsentStartup(options = {}) {
  const environment = options.environment || process.env; const enabled = memberCoachingConsentEnabled(environment[MEMBER_COACHING_CONSENT_FLAG]);
  const origin = exactHttpsOrigin(environment.GOALS_COACH_MEMBER_LOGIN_ORIGIN); const endpoint = environment.GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL;
  const twoHour = twoHourSessionEnabled(environment[TWO_HOUR_SESSION_FLAG]);
  const common = Object.freeze({ status: enabled ? "not_ready" : "disabled", router: null, origin: null, activationPermitted: false, externalCallsPermitted: false });
  if (!enabled || !origin || (!twoHour && (!validEndpoint(endpoint) || typeof environment.GYMMASTER_SITE !== "string" || !/^[a-z0-9_-]{1,40}$/i.test(environment.GYMMASTER_SITE) || typeof environment.GYMMASTER_API_KEY !== "string" || !environment.GYMMASTER_API_KEY || typeof environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET !== "string" || environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET.length < 32 || typeof options.fetchImpl !== "function")) || !options.db || typeof options.db.query !== "function" || typeof options.db.connect !== "function") return common;
  const sessionService = twoHour ? createGymMasterTwoHourSessionService({ db: options.db, ...(options.now ? { now: options.now } : {}) }) : createGymMasterMemberSessionService({ secret: environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET, ...(options.now ? { now: options.now } : {}) });
  const mappingAuthorizer = createGymMasterMemberAuthorization({ db: options.db });
  const membershipVerifier = twoHour ? null : createGymMasterGatekeeperMembershipVerifier({ endpoint, site: environment.GYMMASTER_SITE, apiKey: environment.GYMMASTER_API_KEY, fetchImpl: options.fetchImpl, ...(options.gatekeeperTimeoutMs === undefined ? {} : { timeoutMs: options.gatekeeperTimeoutMs }) });
  const access = twoHour ? null : createGymMasterMemberAccessAuthorizer({ mappingAuthorizer, membershipVerifier });
  const router = createGymMasterMemberCoachingConsentRouter({ db: options.db, authenticateSession: twoHour ? createGymMasterTwoHourSessionAuthenticator({ sessionService }) : createGymMasterMemberSessionAuthenticator({ sessionService }), authorizeIdentity: twoHour ? async (identity) => Object.freeze({ active: true, mappingId: identity.mappingId, memberId: identity.memberId }) : access.authorizeIdentity, origin, noticeVersion: MEMBER_COACHING_CONSENT_NOTICE_VERSION, ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}) });
  return Object.freeze({ ...common, status: "ready_for_separate_route_composition", router, origin });
}
module.exports = { createGymMasterMemberCoachingConsentStartup };
