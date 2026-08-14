"use strict";

const cors = require("cors");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");

const MEMBER_PRIVATE_SCREEN_LOGIN_PATH =
  "/goalscoach/member/private-screen/login";

function privacySafeLoginHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return next();
}

function composeGymMasterMemberPrivateScreenLoginRoute(app, startup) {
  if (!app || typeof app.post !== "function" || typeof app.options !== "function") {
    throw new Error("Member private-screen login composition requires an Express application");
  }
  if (
    !startup
    || startup.status !== "ready_for_separate_route_composition"
    || typeof startup.handler !== "function"
    || !exactHttpsOrigin(startup.origin)
  ) return Object.freeze({ mounted: false, path: null });

  const routeCors = cors({
    origin(requestOrigin, callback) {
      return callback(null, requestOrigin === startup.origin);
    },
    credentials: true,
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
  });
  app.options(
    MEMBER_PRIVATE_SCREEN_LOGIN_PATH,
    privacySafeLoginHeaders,
    routeCors
  );
  app.post(
    MEMBER_PRIVATE_SCREEN_LOGIN_PATH,
    privacySafeLoginHeaders,
    routeCors,
    startup.handler
  );
  return Object.freeze({ mounted: true, path: MEMBER_PRIVATE_SCREEN_LOGIN_PATH });
}

module.exports = {
  MEMBER_PRIVATE_SCREEN_LOGIN_PATH,
  composeGymMasterMemberPrivateScreenLoginRoute,
  privacySafeLoginHeaders,
};
