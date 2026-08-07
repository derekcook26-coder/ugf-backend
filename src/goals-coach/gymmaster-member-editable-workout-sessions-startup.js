"use strict";

const express = require("express");
const {
  createGymMasterMemberLoginStartup,
} = require("./gymmaster-member-login-startup");
const {
  createGymMasterMemberSessionAuthenticator,
} = require("./gymmaster-member-session");
const {
  createGymMasterMemberAuthorization,
} = require("./gymmaster-member-authorization");
const {
  MEMBER_EDITABLE_WORKOUT_SESSIONS_FLAG,
  createGymMasterMemberEditableWorkoutSessionsRouter,
  memberEditableWorkoutSessionsEnabled,
} = require("./gymmaster-member-editable-workout-sessions");
const {
  MEMBER_SAFETY_INTAKE_FLAG,
  MEMBER_SAFETY_INTAKE_NOTICE_VERSION_CONFIGURATION,
  approvedNoticeVersion,
  createGymMasterMemberSafetyIntakeRouter,
  memberSafetyIntakeEnabled,
} = require("./gymmaster-member-safety-intake");

function createGymMasterMemberEditableWorkoutSessionsStartup(options = {}) {
  const environment = options.environment || process.env;
  const enabled = memberEditableWorkoutSessionsEnabled(
    environment[MEMBER_EDITABLE_WORKOUT_SESSIONS_FLAG]
  );
  const common = {
    status: enabled ? "not_ready" : "disabled",
    router: null,
    origin: null,
    activationPermitted: false,
    externalCallsPermitted: false,
  };
  if (!enabled) return Object.freeze(common);

  const memberLoginStartup = createGymMasterMemberLoginStartup({
    ...options,
    environment,
    ...(typeof options.completePendingEnrollment === "function"
      ? { completePendingEnrollment: options.completePendingEnrollment }
      : {}),
  });
  if (memberLoginStartup.status !== "ready_for_separate_route_composition") {
    return Object.freeze(common);
  }

  const authenticateSession = createGymMasterMemberSessionAuthenticator({
    sessionService: memberLoginStartup.sessionService,
  });
  const mappingAuthorization = createGymMasterMemberAuthorization({ db: options.db });
  const capabilityRouter = createGymMasterMemberEditableWorkoutSessionsRouter({
    db: options.db,
    authenticateSession,
    origin: memberLoginStartup.configuration.origin,
    mappingAuthorization,
    ...(options.editableWorkoutSessionsRateLimits
      ? { rateLimits: options.editableWorkoutSessionsRateLimits }
      : {}),
  });
  const safetyIntakeNoticeVersion = approvedNoticeVersion(
    environment[MEMBER_SAFETY_INTAKE_NOTICE_VERSION_CONFIGURATION]
  );
  const safetyIntakeReady = memberSafetyIntakeEnabled(
    environment[MEMBER_SAFETY_INTAKE_FLAG]
  ) && Boolean(safetyIntakeNoticeVersion);
  const safetyIntakeRouter = safetyIntakeReady
    ? createGymMasterMemberSafetyIntakeRouter({
      db: options.db,
      authenticateSession,
      origin: memberLoginStartup.configuration.origin,
      mappingAuthorization,
      noticeVersion: safetyIntakeNoticeVersion,
      ...(options.safetyIntakeRateLimits
        ? { rateLimits: options.safetyIntakeRateLimits }
        : {}),
    })
    : null;
  const router = express.Router();
  router.use((req, res, next) => {
    if (safetyIntakeReady && req.path === "/safety-intake") {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
    }
    if (req.headers.origin !== memberLoginStartup.configuration.origin) {
      return res.status(403).json({ error: "MEMBER_ORIGIN_NOT_ALLOWED" });
    }
    return next();
  });
  router.post("/login", memberLoginStartup.handler);
  router.get("/session", authenticateSession, async (req, res, next) => {
    try {
      const authorization = await mappingAuthorization.authorizeIdentity(req.alphaMemberIdentity);
      if (!authorization.active) {
        return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      }
      return res.status(200).json({
        access: "member_editable_workout_alpha",
        coaching: "not_available",
        activationPermitted: false,
        externalCallsPermitted: false,
      });
    } catch (error) {
      return next(error);
    }
  });
  if (safetyIntakeRouter) router.use(safetyIntakeRouter);
  router.use((req, res, next) => {
    if (
      req.path === "/tracked-workout-sessions"
      || req.path.startsWith("/tracked-workout-sessions/")
    ) {
      return capabilityRouter(req, res, next);
    }
    return next();
  });

  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    origin: memberLoginStartup.configuration.origin,
    router,
  });
}

module.exports = {
  MEMBER_EDITABLE_WORKOUT_SESSIONS_FLAG,
  MEMBER_SAFETY_INTAKE_FLAG,
  createGymMasterMemberEditableWorkoutSessionsStartup,
};
