"use strict";

const cors = require("cors");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");

function createPrivateScreenCors(origin) {
  const expected = exactHttpsOrigin(origin);
  if (!expected) throw new Error("Member private screen requires one exact HTTPS origin");
  return cors({
    origin(requestOrigin, callback) {
      return callback(null, !requestOrigin || requestOrigin === expected);
    },
    credentials: true,
    methods: ["GET"],
    allowedHeaders: ["Content-Type"],
  });
}

function createPrivateScreenOriginGuard(origin) {
  const expected = exactHttpsOrigin(origin);
  if (!expected) throw new Error("Member private screen requires one exact HTTPS origin");
  return function requirePrivateScreenOrigin(req, res, next) {
    if (req.get("Origin") !== expected) {
      return res.status(403).json({ error: "MEMBER_ORIGIN_NOT_ALLOWED" });
    }
    return next();
  };
}

function composeGymMasterMemberPrivateScreenRoute(app, startup) {
  if (!app || typeof app.get !== "function" || typeof app.options !== "function") {
    throw new Error("Member private screen composition requires an Express application");
  }
  if (
    !startup
    || startup.status !== "ready_for_separate_route_composition"
    || !Array.isArray(startup.handlers)
    || startup.handlers.some((handler) => typeof handler !== "function")
    || !exactHttpsOrigin(startup.origin)
  ) return Object.freeze({ mounted: false, path: null });
  const path = "/goalscoach/member/private-screen";
  app.options(path, createPrivateScreenCors(startup.origin));
  app.get(
    path,
    createPrivateScreenCors(startup.origin),
    createPrivateScreenOriginGuard(startup.origin),
    ...startup.handlers
  );
  return Object.freeze({ mounted: true, path });
}

module.exports = {
  composeGymMasterMemberPrivateScreenRoute,
  createPrivateScreenCors,
  createPrivateScreenOriginGuard,
};
