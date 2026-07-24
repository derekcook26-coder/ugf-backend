"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { createGymMasterMemberAuthorization } = require("./gymmaster-member-authorization");

const OWNER_WORKOUT_TRACKING_FLAG = "GOALS_COACH_OWNER_WORKOUT_TRACKING_ALPHA_ENABLED";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function ownerWorkoutTrackingEnabled(value) {
  return value === "true";
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.exposeMessage = true;
  return error;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed) {
  if (!exactObject(value)) throw httpError(400, "INVALID_REQUEST", "A JSON object is required");
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw httpError(400, "UNKNOWN_FIELD", "Request contains an unknown field");
}

function boundedString(value, name, maximum, optional = false) {
  if (value === undefined && optional) return null;
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > maximum) {
    throw httpError(400, "INVALID_REQUEST", `${name} is invalid`);
  }
  return value;
}

function requestId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw httpError(400, "INVALID_REQUEST", "clientRequestId must be a lowercase UUID");
  }
  return value;
}

function calendarDate(value, name) {
  if (typeof value !== "string" || !DATE.test(value)) {
    throw httpError(400, "INVALID_REQUEST", `${name} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw httpError(400, "INVALID_REQUEST", `${name} is invalid`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (value < "1900-01-01" || value > today) {
    throw httpError(400, "INVALID_REQUEST", `${name} cannot be in the future`);
  }
  return value;
}

function parseWorkoutLog(body) {
  rejectUnknownKeys(body, [
    "clientRequestId", "performedOn", "workoutName", "durationMinutes", "notes",
  ]);
  const duration = body.durationMinutes;
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 1440)) {
    throw httpError(400, "INVALID_REQUEST", "durationMinutes is invalid");
  }
  return {
    clientRequestId: requestId(body.clientRequestId),
    performedOn: calendarDate(body.performedOn, "performedOn"),
    workoutName: boundedString(body.workoutName, "workoutName", 200),
    durationMinutes: duration === undefined ? null : duration,
    notes: boundedString(body.notes, "notes", 4000, true),
  };
}

function parseAchievement(body) {
  rejectUnknownKeys(body, [
    "clientRequestId", "achievementType", "title", "achievedOn",
    "metricValue", "metricUnit", "workoutLogId", "notes",
  ]);
  if (!["personal_record", "achievement"].includes(body.achievementType)) {
    throw httpError(400, "INVALID_REQUEST", "achievementType is invalid");
  }
  const hasMetricValue = body.metricValue !== undefined;
  const hasMetricUnit = body.metricUnit !== undefined;
  if (hasMetricValue !== hasMetricUnit) {
    throw httpError(400, "INVALID_REQUEST", "metricValue and metricUnit must be provided together");
  }
  if (
    hasMetricValue
    && (typeof body.metricValue !== "number" || !Number.isFinite(body.metricValue)
      || body.metricValue <= 0 || body.metricValue > 1000000000)
  ) {
    throw httpError(400, "INVALID_REQUEST", "metricValue is invalid");
  }
  if (
    body.workoutLogId !== undefined
    && (!Number.isSafeInteger(body.workoutLogId) || body.workoutLogId < 1)
  ) {
    throw httpError(400, "INVALID_REQUEST", "workoutLogId is invalid");
  }
  return {
    clientRequestId: requestId(body.clientRequestId),
    achievementType: body.achievementType,
    title: boundedString(body.title, "title", 200),
    achievedOn: calendarDate(body.achievedOn, "achievedOn"),
    metricValue: hasMetricValue ? body.metricValue : null,
    metricUnit: hasMetricUnit ? boundedString(body.metricUnit, "metricUnit", 50) : null,
    workoutLogId: body.workoutLogId === undefined ? null : String(body.workoutLogId),
    notes: boundedString(body.notes, "notes", 4000, true),
  };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ performedOn: row.performed_on, id: String(row.id) }))
    .toString("base64url");
}

function parseListQuery(query) {
  rejectUnknownKeys(query, ["limit", "cursor"]);
  const rawLimit = query.limit === undefined ? "20" : query.limit;
  if (typeof rawLimit !== "string" || !/^[1-9]\d*$/.test(rawLimit)) {
    throw httpError(400, "INVALID_REQUEST", "limit is invalid");
  }
  const limit = Number(rawLimit);
  if (limit > 50) throw httpError(400, "INVALID_REQUEST", "limit is invalid");
  if (query.cursor === undefined) return { limit, cursorDate: null, cursorId: null };
  try {
    const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
    if (
      !exactObject(cursor)
      || Object.keys(cursor).sort().join(",") !== "id,performedOn"
      || !/^[1-9]\d*$/.test(cursor.id)
    ) throw new Error("invalid");
    return {
      limit,
      cursorDate: calendarDate(cursor.performedOn, "cursor.performedOn"),
      cursorId: cursor.id,
    };
  } catch (_) {
    throw httpError(400, "INVALID_REQUEST", "cursor is invalid");
  }
}

function publicWorkoutLog(row) {
  return {
    id: String(row.id),
    performedOn: row.performed_on,
    workoutName: row.workout_name,
    durationMinutes: row.duration_minutes,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function publicAchievement(row) {
  return {
    id: String(row.id),
    achievementType: row.achievement_type,
    title: row.title,
    achievedOn: row.achieved_on,
    metricValue: row.metric_value === null ? null : Number(row.metric_value),
    metricUnit: row.metric_unit,
    workoutLogId: row.workout_log_id === null ? null : String(row.workout_log_id),
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function createRateLimits() {
  const shared = {
    windowMs: 15 * 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "RATE_LIMITED" }),
  };
  return {
    read: rateLimit({ ...shared, max: 120 }),
    mutation: rateLimit({ ...shared, max: 30 }),
  };
}

function createOwnerWorkoutTrackingRouter(options = {}) {
  const db = options.db;
  const authenticateSession = options.authenticateSession;
  const authorizeOwner = options.authorizeOwner;
  const expectedOrigin = options.origin;
  if (!db || typeof db.query !== "function") throw new Error("Workout tracking requires a database");
  if (typeof authenticateSession !== "function" || typeof authorizeOwner !== "function") {
    throw new Error("Workout tracking requires owner session authorization");
  }
  const mappingAuthorization = options.mappingAuthorization
    || createGymMasterMemberAuthorization({ db });
  const rateLimits = options.rateLimits || createRateLimits();
  const router = express.Router();

  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== expectedOrigin) {
      return res.status(403).json({ error: "OWNER_ORIGIN_NOT_ALLOWED" });
    }
    return next();
  });
  router.use(authenticateSession);
  router.use((req, _res, next) => {
    if (req.method === "GET" && req.path === "/workout-logs") {
      try {
        req.ownerWorkoutListQuery = parseListQuery(req.query);
      } catch (error) {
        return next(error);
      }
    }
    return next();
  });
  router.use(async (req, res, next) => {
    try {
      if (authorizeOwner(req.alphaMemberIdentity) !== true) {
        return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      }
      const authorization = await mappingAuthorization.authorizeIdentity(req.alphaMemberIdentity);
      if (!authorization.active) {
        return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      }
      req.ownerWorkoutMemberId = authorization.memberId;
      return next();
    } catch (error) {
      return next(error);
    }
  });

  router.post("/workout-logs", rateLimits.mutation, async (req, res, next) => {
    try {
      const input = parseWorkoutLog(req.body);
      const result = await db.query(
        `INSERT INTO goals_coach_workout_logs
          (member_id, client_request_id, performed_on, workout_name, duration_minutes, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (member_id, client_request_id)
         DO UPDATE SET client_request_id = EXCLUDED.client_request_id
         RETURNING id, performed_on::text, workout_name, duration_minutes, notes, created_at`,
        [
          req.ownerWorkoutMemberId, input.clientRequestId, input.performedOn,
          input.workoutName, input.durationMinutes, input.notes,
        ]
      );
      return res.status(200).json({ workoutLog: publicWorkoutLog(result.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/workout-logs", rateLimits.read, async (req, res, next) => {
    try {
      const input = req.ownerWorkoutListQuery;
      const result = await db.query(
        `SELECT id, performed_on::text, workout_name, duration_minutes, notes, created_at
         FROM goals_coach_workout_logs
         WHERE member_id = $1
           AND ($2::date IS NULL OR (performed_on, id) < ($2::date, $3::bigint))
         ORDER BY performed_on DESC, id DESC
         LIMIT $4`,
        [req.ownerWorkoutMemberId, input.cursorDate, input.cursorId, input.limit + 1]
      );
      const hasMore = result.rows.length > input.limit;
      const rows = result.rows.slice(0, input.limit);
      return res.status(200).json({
        workoutLogs: rows.map(publicWorkoutLog),
        nextCursor: hasMore ? encodeCursor(rows[rows.length - 1]) : null,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/achievements", rateLimits.mutation, async (req, res, next) => {
    try {
      const input = parseAchievement(req.body);
      const result = await db.query(
        `INSERT INTO goals_coach_achievements
          (member_id, client_request_id, achievement_type, title, achieved_on,
           metric_value, metric_unit, workout_log_id, notes)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
         WHERE $8::bigint IS NULL
            OR EXISTS (
              SELECT 1 FROM goals_coach_workout_logs
              WHERE id = $8 AND member_id = $1
            )
         ON CONFLICT (member_id, client_request_id)
         DO UPDATE SET client_request_id = EXCLUDED.client_request_id
         RETURNING id, achievement_type, title, achieved_on::text, metric_value,
                   metric_unit, workout_log_id, notes, created_at`,
        [
          req.ownerWorkoutMemberId, input.clientRequestId, input.achievementType,
          input.title, input.achievedOn, input.metricValue, input.metricUnit,
          input.workoutLogId, input.notes,
        ]
      );
      if (!result.rows.length) {
        throw httpError(404, "WORKOUT_LOG_NOT_FOUND", "Workout log not found");
      }
      return res.status(200).json({ achievement: publicAchievement(result.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  OWNER_WORKOUT_TRACKING_FLAG,
  createOwnerWorkoutTrackingRouter,
  ownerWorkoutTrackingEnabled,
  parseAchievement,
  parseListQuery,
  parseWorkoutLog,
};
