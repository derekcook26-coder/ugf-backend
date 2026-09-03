"use strict";

const cors = require("cors");
const rateLimit = require("express-rate-limit");

const PATH = "/public/help/chat";

function composePublicHelpChatRoute(app, startup) {
  if (!app || typeof app.post !== "function" || typeof app.use !== "function") {
    throw new Error("Public help chat composition requires an Express application");
  }
  if (!startup || startup.status !== "ready_for_separate_route_composition" || !startup.chat) {
    return Object.freeze({ mounted: false, path: null });
  }
  app.use(PATH, cors({
    origin(requestOrigin, callback) {
      callback(null, requestOrigin === startup.origin ? startup.origin : false);
    },
    credentials: false,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    optionsSuccessStatus: 204,
  }), function helpChatHeaders(_req, res, next) {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  }, rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many help requests. Please try again shortly." },
  }));
  app.post(PATH, startup.chat.answer);
  return Object.freeze({ mounted: true, path: PATH });
}

module.exports = { PATH, composePublicHelpChatRoute };
