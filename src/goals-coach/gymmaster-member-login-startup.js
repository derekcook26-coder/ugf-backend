"use strict";

const { createGymMasterGatekeeperMembershipVerifier, createGymMasterMemberAccessAuthorizer } = require("./gymmaster-gatekeeper-membership");
const { createGymMasterMemberAuthorization } = require("./gymmaster-member-authorization");
const {
  OWNER_LOGIN_STAGE_DIAGNOSTIC_FLAG,
  createGymMasterMemberLoginHandler,
  exactHttpsOrigin,
} = require("./gymmaster-member-login-route");
const { createGymMasterMemberLoginRateLimiter } = require("./gymmaster-member-login-rate-limit");
const { createGymMasterMemberLoginService } = require("./gymmaster-member-login");
const { createGymMasterMemberPortalClient, validatedLoginEndpoint } = require("./gymmaster-member-portal-client");
const { TWO_HOUR_SESSION_FLAG, buildGymMasterTwoHourSessionCookie, clearGymMasterTwoHourSessionCookie, createGymMasterMemberSessionService, createGymMasterTwoHourSessionService, createTwoHourSessionRequestContext, extractCookie, twoHourSessionEnabled } = require("./gymmaster-member-session");
const { exactGatekeeperMembersEndpoint } = require("./gymmaster-gatekeeper-membership");

const MEMBER_LOGIN_ENABLE_FLAG = "GOALS_COACH_MEMBER_LOGIN_ENABLED";

function exactTrue(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validEndpoint(value, validate) {
  try {
    validate(value);
    return true;
  } catch (_) {
    return false;
  }
}

function loadGymMasterMemberLoginConfiguration(environment = process.env) {
  const enabled = exactTrue(environment[MEMBER_LOGIN_ENABLE_FLAG]);
  const blockers = [];
  const origin = environment.GOALS_COACH_MEMBER_LOGIN_ORIGIN || "";
  const memberLoginEndpoint = environment.GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL || "";
  const gatekeeperEndpoint = environment.GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL || "";
  const memberApiKey = environment.GOALS_COACH_GYMMASTER_MEMBER_API_KEY || "";
  const gatekeeperApiKey = environment.GYMMASTER_API_KEY || "";
  const gatekeeperSite = environment.GYMMASTER_SITE || "";
  const sessionSecret = environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET || "";

  if (!enabled) blockers.push("member_login_feature_flag_disabled");
  if (!exactHttpsOrigin(origin)) blockers.push("exact_https_member_login_origin_required");
  if (!validEndpoint(memberLoginEndpoint, validatedLoginEndpoint)) blockers.push("exact_member_login_endpoint_required");
  if (!validEndpoint(gatekeeperEndpoint, exactGatekeeperMembersEndpoint)) blockers.push("exact_gatekeeper_members_endpoint_required");
  if (!nonEmptyString(memberApiKey)) blockers.push("member_api_key_required");
  if (!nonEmptyString(gatekeeperApiKey)) blockers.push("gatekeeper_api_key_required");
  if (!/^[a-z0-9_-]{1,40}$/i.test(gatekeeperSite)) blockers.push("gatekeeper_site_required");
  if (!(typeof sessionSecret === "string" && sessionSecret.length >= 32)) blockers.push("member_session_secret_required");

  return Object.freeze({
    enabled,
    origin: exactHttpsOrigin(origin) ? origin : null,
    memberLoginEndpoint: validEndpoint(memberLoginEndpoint, validatedLoginEndpoint) ? memberLoginEndpoint : null,
    gatekeeperEndpoint: validEndpoint(gatekeeperEndpoint, exactGatekeeperMembersEndpoint) ? gatekeeperEndpoint : null,
    blockers: Object.freeze(blockers),
    valid: blockers.length === 0,
  });
}

function createGymMasterMemberLoginStartup(options = {}) {
  const environment = options.environment || process.env;
  const configuration = loadGymMasterMemberLoginConfiguration(environment);
  const common = {
    status: configuration.enabled ? "not_ready" : "disabled",
    configuration,
    handler: null,
    sessionService: null,
    logoutHandler: null,
    activationPermitted: false,
    externalCallsPermitted: false,
  };
  const useTwoHourSession = twoHourSessionEnabled(environment[TWO_HOUR_SESSION_FLAG]);
  if (!configuration.valid || !options.db || typeof options.db.query !== "function"
    || (useTwoHourSession && typeof options.db.connect !== "function")
    || typeof options.fetchImpl !== "function") {
    return Object.freeze(common);
  }

  const portalClient = createGymMasterMemberPortalClient({
    endpoint: environment.GOALS_COACH_GYMMASTER_MEMBER_LOGIN_URL,
    fetchImpl: options.fetchImpl,
    ...(options.memberPortalTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.memberPortalTimeoutMs }),
  });
  const loginService = createGymMasterMemberLoginService({
    enabled: true,
    memberApiKey: environment.GOALS_COACH_GYMMASTER_MEMBER_API_KEY,
    loginClient: portalClient.login,
  });
  const mappingAuthorizer = createGymMasterMemberAuthorization({
    db: options.db,
    requirePendingEnrollmentEmail: true,
  });
  const membershipVerifier = createGymMasterGatekeeperMembershipVerifier({
    endpoint: environment.GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL,
    site: environment.GYMMASTER_SITE,
    apiKey: environment.GYMMASTER_API_KEY,
    fetchImpl: options.fetchImpl,
    ...(options.gatekeeperTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.gatekeeperTimeoutMs }),
  });
  const accessAuthorizer = createGymMasterMemberAccessAuthorizer({ mappingAuthorizer, membershipVerifier });
  const sessionService = useTwoHourSession
    ? createGymMasterTwoHourSessionService({ db: options.db, ...(options.now ? { now: options.now } : {}), ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}), ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}), ...(options.sessionDatabaseMilliseconds ? { databaseMilliseconds: options.sessionDatabaseMilliseconds } : {}) })
    : createGymMasterMemberSessionService({ secret: environment.GOALS_COACH_MEMBER_LOGIN_SESSION_SECRET, ...(options.now ? { now: options.now } : {}), ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}) });
  const handler = createGymMasterMemberLoginHandler({
    enabled: true,
    origin: configuration.origin,
    loginService,
    sessionService,
    authorizeIdentity: accessAuthorizer.authorizeIdentity,
    ...(typeof options.completePendingEnrollment === "function"
      ? { completePendingEnrollment: options.completePendingEnrollment }
      : {}),
    ...(typeof options.authorizeOwner === "function" ? { authorizeOwner: options.authorizeOwner } : {}),
    attemptLimiter: options.attemptLimiter || createGymMasterMemberLoginRateLimiter(),
    ownerLoginStageDiagnostic: environment[OWNER_LOGIN_STAGE_DIAGNOSTIC_FLAG],
    ...(useTwoHourSession ? { buildSessionCookie: buildGymMasterTwoHourSessionCookie } : {}),
    ...(useTwoHourSession ? { createSessionOperationContext: (req, res) => createTwoHourSessionRequestContext(req, res, { ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}), ...(options.sessionDatabaseMilliseconds ? { overallMilliseconds: options.sessionDatabaseMilliseconds } : {}) }) } : {}),
    ...(typeof options.diagnosticSink === "function" ? { diagnosticSink: options.diagnosticSink } : {}),
  });
  const logoutHandler = useTwoHourSession ? async function logout(req, res) {
    if (!req || typeof req.get !== "function" || req.get("Origin") !== configuration.origin) {
      return res.status(403).json({ error: "MEMBER_LOGIN_ORIGIN_NOT_ALLOWED" });
    }
    const route = createTwoHourSessionRequestContext(req, res, { ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}), ...(options.sessionDatabaseMilliseconds ? { overallMilliseconds: options.sessionDatabaseMilliseconds } : {}) });
    try {
      const token = extractCookie(req.headers && req.headers.cookie);
      if (token) await sessionService.revoke(token, route);
      if (route.terminalState.isTerminal()) { if (!route.responseAllowed()) return undefined; throw new Error("Member session revocation crossed its terminal deadline"); }
      res.setHeader("Set-Cookie", clearGymMasterTwoHourSessionCookie());
      return res.status(204).send();
    } catch (_) { return route.responseAllowed() ? res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" }) : undefined; }
    finally { route.cleanup(); }
  } : null;
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    handler,
    sessionService,
    logoutHandler,
  });
}

module.exports = {
  MEMBER_LOGIN_ENABLE_FLAG,
  createGymMasterMemberLoginStartup,
  exactTrue,
  loadGymMasterMemberLoginConfiguration,
};
