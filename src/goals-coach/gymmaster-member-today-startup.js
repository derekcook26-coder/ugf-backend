"use strict";
const { createGymMasterGatekeeperMembershipVerifier, createGymMasterMemberAccessAuthorizer, exactGatekeeperMembersEndpoint } = require("./gymmaster-gatekeeper-membership");
const { createGymMasterMemberAuthorization } = require("./gymmaster-member-authorization");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");
const { createGymMasterMemberSessionAuthenticator, createGymMasterMemberSessionService } = require("./gymmaster-member-session");
const { MEMBER_TODAY_FLAG, createRouter, enabled } = require("./gymmaster-member-today");
function validEndpoint(value) { try { exactGatekeeperMembersEndpoint(value); return true; } catch (_) { return false; } }
function createGymMasterMemberTodayStartup(options = {}) {
  const environment = options.environment || process.env;
  const on = enabled(environment[MEMBER_TODAY_FLAG]);
  const origin = exactHttpsOrigin(environment.GOALS_COACH_MEMBER_LOGIN_ORIGIN);
  const endpoint = environment.GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL;
  const common = Object.freeze({ status: on ? "not_ready" : "disabled", router: null, origin: null, activationPermitted: false, providerCallsPermitted: false });
  if (!on || !origin || !validEndpoint(endpoint) || !/^[a-z0-9_-]{1,40}$/i.test(environment.GYMMASTER_SITE || "") || !environment.GYMMASTER_API_KEY || typeof environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET !== "string" || environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET.length < 32 || !options.db || typeof options.db.connect !== "function" || typeof options.fetchImpl !== "function") return common;
  const session = createGymMasterMemberSessionService({ secret: environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET, ...(options.now ? { now: options.now } : {}) });
  const access = createGymMasterMemberAccessAuthorizer({ mappingAuthorizer: createGymMasterMemberAuthorization({ db: options.db }), membershipVerifier: createGymMasterGatekeeperMembershipVerifier({ endpoint, site: environment.GYMMASTER_SITE, apiKey: environment.GYMMASTER_API_KEY, fetchImpl: options.fetchImpl, ...(options.gatekeeperTimeoutMs === undefined ? {} : { timeoutMs: options.gatekeeperTimeoutMs }) }) });
  return Object.freeze({ ...common, status: "ready_for_separate_route_composition", origin, router: createRouter({ db: options.db, authenticateSession: createGymMasterMemberSessionAuthenticator({ sessionService: session }), authorizeIdentity: access.authorizeIdentity, origin, ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}) }) });
}
module.exports = { createGymMasterMemberTodayStartup };
