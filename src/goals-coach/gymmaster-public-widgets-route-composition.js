"use strict";

const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");

function composeGymMasterPublicWidgetsRoutes(app, startup) {
  if (!app || typeof app.get !== "function" || typeof app.use !== "function") {
    throw new Error("GymMaster widgets composition requires an Express application");
  }
  if (!startup || startup.status !== "ready_for_separate_route_composition"
    || !startup.router || !exactHttpsOrigin(startup.origin)) {
    return Object.freeze({ mounted: false, paths: [] });
  }
  const paths = Object.freeze([
    "/public/gymmaster/classes",
    "/public/gymmaster/memberships",
  ]);
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many widget requests. Please try again shortly." },
  });
  app.use(paths, cors({
    origin(requestOrigin, callback) {
      callback(null, requestOrigin === startup.origin ? startup.origin : false);
    },
    credentials: false,
    methods: ["GET", "OPTIONS"],
    allowedHeaders: [],
    optionsSuccessStatus: 204,
  }), function publicWidgetSecurityHeaders(_req, res, next) {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  }, limiter);
  app.get(paths[0], startup.router.schedule);
  app.get(paths[1], startup.router.memberships);
  return Object.freeze({ mounted: true, paths });
}

module.exports = { composeGymMasterPublicWidgetsRoutes };
