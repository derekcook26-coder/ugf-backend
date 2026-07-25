"use strict";

const {
  createGymMasterMemberLoginStartup,
} = require("./gymmaster-member-login-startup");
const {
  createGymMasterMemberSessionAuthenticator,
} = require("./gymmaster-member-session");
const {
  createGymMasterOwnerAuthorizer,
  createGymMasterOwnerOnlyRouter,
  ownerMemberId,
} = require("./gymmaster-owner-only-access");
const {
  OWNER_WORKOUT_TRACKING_FLAG,
  createOwnerWorkoutTrackingRouter,
  ownerWorkoutTrackingEnabled,
} = require("./owner-workout-tracking");
const {
  OWNER_EDITABLE_WORKOUT_SESSIONS_FLAG,
  createOwnerEditableWorkoutSessionsRouter,
  ownerEditableWorkoutSessionsEnabled,
} = require("./owner-editable-workout-sessions");

const OWNER_ONLY_ENABLE_FLAG = "GOALS_COACH_OWNER_ONLY_ALPHA_ENABLED";
const OWNER_MEMBER_ID = "GOALS_COACH_OWNER_GYMMASTER_MEMBER_ID";

function ownerOnlyEnabled(value) {
  return value === "true";
}

function createOwnerCapabilityRouter(capabilities) {
  return function routeOwnerCapability(req, res, next) {
    const capability = capabilities.find(({ paths }) => (
      paths.some((path) => req.path === path || req.path.startsWith(`${path}/`))
    ));
    if (!capability) return next();
    return capability.router(req, res, next);
  };
}

function createGymMasterOwnerOnlyStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = ownerOnlyEnabled(environment[OWNER_ONLY_ENABLE_FLAG]);
  const configuredOwnerId = ownerMemberId(environment[OWNER_MEMBER_ID]);
  const common = {
    status: enabled ? "not_ready" : "disabled",
    router: null,
    origin: null,
    activationPermitted: false,
    externalCallsPermitted: false,
  };
  if (!enabled || !configuredOwnerId) return Object.freeze(common);

  const ownerAuthorizer = createGymMasterOwnerAuthorizer({ memberId: configuredOwnerId });
  const memberLoginStartup = createGymMasterMemberLoginStartup({
    ...options,
    environment,
    authorizeOwner: ownerAuthorizer.authorizeOwner,
  });
  if (memberLoginStartup.status !== "ready_for_separate_route_composition") {
    return Object.freeze(common);
  }

  const authenticateSession = createGymMasterMemberSessionAuthenticator({
    sessionService: memberLoginStartup.sessionService,
  });
  const capabilities = [];
  if (ownerWorkoutTrackingEnabled(environment[OWNER_WORKOUT_TRACKING_FLAG])) {
    capabilities.push({
      paths: ["/workout-logs", "/achievements"],
      router: createOwnerWorkoutTrackingRouter({
        db: options.db,
        authenticateSession,
        authorizeOwner: ownerAuthorizer.authorizeOwner,
        origin: memberLoginStartup.configuration.origin,
        ...(options.workoutTrackingRateLimits
          ? { rateLimits: options.workoutTrackingRateLimits }
          : {}),
      }),
    });
  }
  if (
    ownerEditableWorkoutSessionsEnabled(
      environment[OWNER_EDITABLE_WORKOUT_SESSIONS_FLAG]
    )
  ) {
    capabilities.push({
      paths: ["/tracked-workout-sessions"],
      router: createOwnerEditableWorkoutSessionsRouter({
        db: options.db,
        authenticateSession,
        authorizeOwner: ownerAuthorizer.authorizeOwner,
        origin: memberLoginStartup.configuration.origin,
        ...(options.editableWorkoutSessionsRateLimits
          ? { rateLimits: options.editableWorkoutSessionsRateLimits }
          : {}),
      }),
    });
  }

  const router = createGymMasterOwnerOnlyRouter({
    loginHandler: memberLoginStartup.handler,
    authenticateSession,
    authorizeOwner: ownerAuthorizer.authorizeOwner,
    ...(capabilities.length
      ? { workoutTrackingRouter: createOwnerCapabilityRouter(capabilities) }
      : {}),
  });
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    router,
    origin: memberLoginStartup.configuration.origin,
  });
}

module.exports = {
  OWNER_MEMBER_ID,
  OWNER_ONLY_ENABLE_FLAG,
  createGymMasterOwnerOnlyStartup,
  ownerOnlyEnabled,
};
