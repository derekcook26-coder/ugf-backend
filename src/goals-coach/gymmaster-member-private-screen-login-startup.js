"use strict";

const {
  MEMBER_LOGIN_ENABLE_FLAG,
  createGymMasterMemberLoginStartup,
} = require("./gymmaster-member-login-startup");
const {
  OWNER_LOGIN_STAGE_DIAGNOSTIC_FLAG,
} = require("./gymmaster-member-login-route");

const MEMBER_PRIVATE_SCREEN_LOGIN_ENABLE_FLAG =
  "GOALS_COACH_MEMBER_PRIVATE_SCREEN_LOGIN_ENABLED";
const MEMBER_PRIVATE_SCREEN_LOGIN_PORTAL_TIMEOUT_MS = 5000;

function memberPrivateScreenLoginEnabled(value) {
  return value === "true";
}

function createGymMasterMemberPrivateScreenLoginStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = memberPrivateScreenLoginEnabled(
    environment[MEMBER_PRIVATE_SCREEN_LOGIN_ENABLE_FLAG]
  );
  const common = {
    status: enabled ? "not_ready" : "disabled",
    handler: null,
    origin: null,
    activationPermitted: false,
    externalCallsPermitted: false,
  };
  if (!enabled) return Object.freeze(common);

  // Reuse the reviewed member authentication components without inheriting
  // activation from any other member-login capability.
  const memberLoginStartup = createGymMasterMemberLoginStartup({
    db: options.db,
    fetchImpl: options.fetchImpl,
    ...(options.now ? { now: options.now } : {}),
    ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
    ...(options.attemptLimiter ? { attemptLimiter: options.attemptLimiter } : {}),
    memberPortalTimeoutMs: options.memberPortalTimeoutMs === undefined
      ? MEMBER_PRIVATE_SCREEN_LOGIN_PORTAL_TIMEOUT_MS
      : options.memberPortalTimeoutMs,
    ...(options.gatekeeperTimeoutMs === undefined
      ? {}
      : { gatekeeperTimeoutMs: options.gatekeeperTimeoutMs }),
    environment: {
      ...environment,
      [MEMBER_LOGIN_ENABLE_FLAG]: "true",
      [OWNER_LOGIN_STAGE_DIAGNOSTIC_FLAG]: "false",
    },
  });
  if (memberLoginStartup.status !== "ready_for_separate_route_composition") {
    return Object.freeze(common);
  }
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    handler: memberLoginStartup.handler,
    origin: memberLoginStartup.configuration.origin,
  });
}

module.exports = {
  MEMBER_PRIVATE_SCREEN_LOGIN_ENABLE_FLAG,
  MEMBER_PRIVATE_SCREEN_LOGIN_PORTAL_TIMEOUT_MS,
  createGymMasterMemberPrivateScreenLoginStartup,
  memberPrivateScreenLoginEnabled,
};
