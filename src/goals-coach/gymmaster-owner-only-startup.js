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

const OWNER_ONLY_ENABLE_FLAG = "GOALS_COACH_OWNER_ONLY_ALPHA_ENABLED";
const OWNER_MEMBER_ID = "GOALS_COACH_OWNER_GYMMASTER_MEMBER_ID";

function ownerOnlyEnabled(value) {
  return value === "true";
}

function createGymMasterOwnerOnlyStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = ownerOnlyEnabled(environment[OWNER_ONLY_ENABLE_FLAG]);
  const configuredOwnerId = ownerMemberId(environment[OWNER_MEMBER_ID]);
  const common = {
    status: enabled ? "not_ready" : "disabled",
    router: null,
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

  const router = createGymMasterOwnerOnlyRouter({
    loginHandler: memberLoginStartup.handler,
    authenticateSession: createGymMasterMemberSessionAuthenticator({
      sessionService: memberLoginStartup.sessionService,
    }),
    authorizeOwner: ownerAuthorizer.authorizeOwner,
  });
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    router,
  });
}

module.exports = {
  OWNER_MEMBER_ID,
  OWNER_ONLY_ENABLE_FLAG,
  createGymMasterOwnerOnlyStartup,
  ownerOnlyEnabled,
};
