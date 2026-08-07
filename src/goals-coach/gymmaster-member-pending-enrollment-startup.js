"use strict";

const {
  createGymMasterGatekeeperMembershipVerifier,
  exactGatekeeperMembersEndpoint,
} = require("./gymmaster-gatekeeper-membership");
const {
  MEMBER_PENDING_ENROLLMENT_FLAG,
  createGymMasterMemberPendingEnrollmentService,
  memberPendingEnrollmentEnabled,
} = require("./gymmaster-member-pending-enrollment");

function validEndpoint(value) {
  try {
    exactGatekeeperMembersEndpoint(value);
    return true;
  } catch (_) {
    return false;
  }
}

function injectedVerifier(value) {
  return value && typeof value.verifyActiveMember === "function" ? value : null;
}

function createGymMasterMemberPendingEnrollmentStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = memberPendingEnrollmentEnabled(
    environment[MEMBER_PENDING_ENROLLMENT_FLAG]
  );
  const common = {
    status: enabled ? "not_ready" : "disabled",
    service: null,
    activationPermitted: false,
    startupExternalCallsPermitted: false,
  };
  if (!enabled) return Object.freeze(common);
  if (
    !options.db
    || typeof options.db.query !== "function"
    || typeof options.db.connect !== "function"
  ) {
    return Object.freeze(common);
  }

  let membershipVerifier = injectedVerifier(options.membershipVerifier);
  if (!membershipVerifier) {
    const endpoint = environment.GOALS_COACH_GYMMASTER_GATEKEEPER_MEMBERS_URL;
    const site = environment.GYMMASTER_SITE;
    const apiKey = environment.GYMMASTER_API_KEY;
    if (
      !validEndpoint(endpoint)
      || typeof site !== "string"
      || !/^[a-z0-9_-]{1,40}$/i.test(site)
      || typeof apiKey !== "string"
      || !apiKey
      || typeof options.fetchImpl !== "function"
    ) {
      return Object.freeze(common);
    }
    membershipVerifier = createGymMasterGatekeeperMembershipVerifier({
      endpoint,
      site,
      apiKey,
      fetchImpl: options.fetchImpl,
    });
  }

  const service = createGymMasterMemberPendingEnrollmentService({
    db: options.db,
    membershipVerifier,
    ...(typeof options.now === "function" ? { now: options.now } : {}),
  });
  return Object.freeze({
    ...common,
    status: "ready_for_existing_boundaries",
    service,
  });
}

module.exports = {
  MEMBER_PENDING_ENROLLMENT_FLAG,
  createGymMasterMemberPendingEnrollmentStartup,
};
