"use strict";

const cors = require("cors");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");

function composeGymMasterMemberBootstrapRoute(app, startup) {
  if (!app || typeof app.use !== "function") {
    throw new Error("Member bootstrap composition requires an Express application");
  }
  if (!startup || startup.status !== "ready_for_separate_route_composition"
    || typeof startup.router !== "function" || !exactHttpsOrigin(startup.origin)) {
    return Object.freeze({ mounted: false, path: null });
  }
  const path = "/goalscoach/member/bootstrap";
  app.use(path, cors({
    origin: startup.origin,
    credentials: true,
    methods: ["GET", "OPTIONS"],
    allowedHeaders: [],
    optionsSuccessStatus: 204,
  }), startup.router);
  return Object.freeze({ mounted: true, path });
}

module.exports = { composeGymMasterMemberBootstrapRoute };
