"use strict";

const cors = require("cors");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");
function composeGymMasterMemberCoachingConsentRoutes(app, startup) {
  if (!app || typeof app.use !== "function") throw new Error("Member coaching consent composition requires an Express application");
  if (!startup || startup.status !== "ready_for_separate_route_composition" || typeof startup.router !== "function" || !exactHttpsOrigin(startup.origin)) return Object.freeze({ mounted: false, path: null });
  const path = "/goalscoach/member/coaching-consent";
  app.use(path, cors({ origin(requestOrigin, callback) { return callback(null, requestOrigin === startup.origin); }, credentials: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }), startup.router);
  return Object.freeze({ mounted: true, path });
}
module.exports = { composeGymMasterMemberCoachingConsentRoutes };
