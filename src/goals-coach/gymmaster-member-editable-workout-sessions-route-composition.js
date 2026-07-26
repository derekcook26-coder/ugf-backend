"use strict";

const cors = require("cors");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");

function composeGymMasterMemberEditableWorkoutSessionsRoutes(app, startup) {
  if (!app || typeof app.use !== "function") {
    throw new Error("Member editable workout route composition requires an Express application");
  }
  if (
    !startup
    || startup.status !== "ready_for_separate_route_composition"
    || typeof startup.router !== "function"
    || !exactHttpsOrigin(startup.origin)
  ) {
    return Object.freeze({ mounted: false, path: null });
  }

  app.use("/goalscoach/member", cors({
    origin(requestOrigin, callback) {
      if (!requestOrigin || requestOrigin === startup.origin) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT"],
    allowedHeaders: ["Content-Type"],
  }), startup.router);
  return Object.freeze({ mounted: true, path: "/goalscoach/member" });
}

module.exports = { composeGymMasterMemberEditableWorkoutSessionsRoutes };
