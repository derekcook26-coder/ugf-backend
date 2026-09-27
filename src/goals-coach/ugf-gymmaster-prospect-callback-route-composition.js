"use strict";

const cors = require("cors");
const rateLimit = require("express-rate-limit");

const PATH = "/public/help/prospect";

function composeProspectCallbackRoute(app, startup) {
  if (!app || typeof app.post !== "function" || typeof app.use !== "function") {
    throw new Error("Prospect callback composition requires an Express application");
  }
  if (!startup || startup.status !== "ready_for_separate_route_composition" || !startup.handler) {
    return Object.freeze({ mounted: false, path: null });
  }
  app.use(PATH, cors({
    origin(requestOrigin, callback) { callback(null, requestOrigin === startup.origin ? startup.origin : false); },
    credentials: false,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    optionsSuccessStatus: 204,
  }), function prospectSecurityHeaders(_req, res, next) {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  }, rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many callback requests. Please try again later." },
  }));
  app.post(PATH, startup.handler);
  return Object.freeze({ mounted: true, path: PATH });
}

module.exports = { PATH, composeProspectCallbackRoute };
