"use strict";

const {
  createGymMasterMemberLoginStartup,
} = require("./gymmaster-member-login-startup");
const {
  MEMBER_PENDING_ENROLLMENT_FLAG,
  memberPendingEnrollmentEnabled,
} = require("./gymmaster-member-pending-enrollment");

const MEMBER_PENDING_ENROLLMENT_LOGIN_FLAG =
  "GOALS_COACH_MEMBER_PENDING_ENROLLMENT_LOGIN_ENABLED";

function memberPendingEnrollmentLoginEnabled(value) {
  return value === "true";
}

function readyPendingEnrollmentService(startup) {
  if (
    !startup
    || startup.status !== "ready_for_existing_boundaries"
    || !startup.service
    || typeof startup.service.completeAuthenticatedEnrollment !== "function"
  ) {
    return null;
  }
  return startup.service;
}

function createGymMasterMemberPendingEnrollmentLoginStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = memberPendingEnrollmentLoginEnabled(
    environment[MEMBER_PENDING_ENROLLMENT_LOGIN_FLAG]
  );
  const pendingEnrollmentEnabled = memberPendingEnrollmentEnabled(
    environment[MEMBER_PENDING_ENROLLMENT_FLAG]
  );
  const common = {
    status: enabled ? "not_ready" : "disabled",
    handler: null,
    origin: null,
    activationPermitted: false,
    externalCallsPermitted: false,
  };
  // The login-only boundary cannot become usable merely because a ready
  // service was injected. It is subordinate to the separately approved
  // pending-enrollment lifecycle flag.
  if (!enabled || !pendingEnrollmentEnabled) return Object.freeze(common);

  const pendingEnrollmentService = readyPendingEnrollmentService(
    options.pendingEnrollmentStartup
  );
  if (!pendingEnrollmentService) return Object.freeze(common);

  const memberLoginStartup = createGymMasterMemberLoginStartup({
    ...options,
    environment,
    completePendingEnrollment:
      pendingEnrollmentService.completeAuthenticatedEnrollment,
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
  MEMBER_PENDING_ENROLLMENT_LOGIN_FLAG,
  createGymMasterMemberPendingEnrollmentLoginStartup,
  memberPendingEnrollmentLoginEnabled,
  readyPendingEnrollmentService,
};
