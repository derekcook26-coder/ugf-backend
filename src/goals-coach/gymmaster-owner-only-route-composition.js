"use strict";

const cors = require("cors");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");

function exactOwnerOnlyOrigin(value) {
  return exactHttpsOrigin(value);
}

function createOwnerOnlyCors(origin) {
  const expectedOrigin = exactOwnerOnlyOrigin(origin);
  if (!expectedOrigin) throw new Error("Owner-only route composition requires one exact HTTPS origin");
  return cors({
    origin(requestOrigin, callback) {
      if (!requestOrigin || requestOrigin === expectedOrigin) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  });
}

function composeGymMasterOwnerOnlyRoutes(app, startup) {
  if (!app || typeof app.use !== "function") {
    throw new Error("Owner-only route composition requires an Express application");
  }
  if (
    !startup
    || startup.status !== "ready_for_separate_route_composition"
    || typeof startup.router !== "function"
    || !exactOwnerOnlyOrigin(startup.origin)
  ) {
    return Object.freeze({ mounted: false, path: null });
  }

  app.use("/goalscoach", createOwnerOnlyCors(startup.origin), startup.router);
  return Object.freeze({ mounted: true, path: "/goalscoach" });
}

module.exports = {
  composeGymMasterOwnerOnlyRoutes,
  createOwnerOnlyCors,
  exactOwnerOnlyOrigin,
};
