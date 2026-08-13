"use strict";

const cors = require("cors");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");

const MEMBER_PENDING_ENROLLMENT_LOGIN_PATH =
  "/goalscoach/member/pending-enrollment/login";

function composeGymMasterMemberPendingEnrollmentLoginRoute(app, startup) {
  if (!app || typeof app.post !== "function" || typeof app.options !== "function") {
    throw new Error("Member pending-enrollment login composition requires an Express application");
  }
  if (
    !startup
    || startup.status !== "ready_for_separate_route_composition"
    || typeof startup.handler !== "function"
    || !exactHttpsOrigin(startup.origin)
  ) {
    return Object.freeze({ mounted: false, path: null });
  }

  const routeCors = cors({
    origin(requestOrigin, callback) {
      if (!requestOrigin || requestOrigin === startup.origin) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
  });
  // application/json causes browsers to preflight this credentialed request.
  // Keep the exact-origin policy identical for preflight and the POST itself.
  app.options(MEMBER_PENDING_ENROLLMENT_LOGIN_PATH, routeCors);
  app.post(MEMBER_PENDING_ENROLLMENT_LOGIN_PATH, routeCors, startup.handler);
  return Object.freeze({
    mounted: true,
    path: MEMBER_PENDING_ENROLLMENT_LOGIN_PATH,
  });
}

module.exports = {
  MEMBER_PENDING_ENROLLMENT_LOGIN_PATH,
  composeGymMasterMemberPendingEnrollmentLoginRoute,
};
