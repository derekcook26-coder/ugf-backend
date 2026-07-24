"use strict";

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { createGymMasterMemberAuthorization } = require("./gymmaster-member-authorization");

const OWNER_EDITABLE_WORKOUT_SESSIONS_FLAG =
  "GOALS_COACH_OWNER_EDITABLE_WORKOUT_SESSIONS_ALPHA_ENABLED";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const MAXIMUM_EXERCISES = 100;
const MAXIMUM_SETS_PER_EXERCISE = 50;
const MAXIMUM_TOTAL_SETS = 500;

function ownerEditableWorkoutSessionsEnabled(value) {
  return value === "true";
}

function httpError(statusCode, code, message, publicDetails) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.exposeMessage = true;
  if (publicDetails) error.publicDetails = publicDetails;
  return error;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, name = "Request") {
  if (!exactObject(value)) throw httpError(400, "INVALID_REQUEST", `${name} must be a JSON object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw httpError(400, "UNKNOWN_FIELD", `${name} contains an unknown field`);
}

function boundedString(value, name, maximum) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length < 1
    || value.length > maximum
  ) {
    throw httpError(400, "INVALID_REQUEST", `${name} is invalid`);
  }
  return value;
}

function optionalBoundedString(value, name, maximum) {
  if (value === undefined || value === null) return null;
  return boundedString(value, name, maximum);
}

function parseRequestId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw httpError(400, "INVALID_REQUEST", "clientRequestId must be a lowercase UUID");
  }
  return value;
}

function parseVersion(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw httpError(400, "INVALID_REQUEST", "version is invalid");
  }
  return value;
}

function parseSessionId(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) {
    throw httpError(404, "TRACKED_WORKOUT_SESSION_NOT_FOUND", "Workout session not found");
  }
  try {
    if (BigInt(value) > 9223372036854775807n) throw new Error("outside bigint range");
  } catch (_) {
    throw httpError(404, "TRACKED_WORKOUT_SESSION_NOT_FOUND", "Workout session not found");
  }
  return value;
}

function parseSet(value, expectedOrder) {
  rejectUnknownKeys(
    value,
    ["order", "actualReps", "load", "unit", "notes"],
    "Set"
  );
  if (value.order !== expectedOrder) {
    throw httpError(400, "INVALID_REQUEST", "Set order must be contiguous and start at 1");
  }
  if (!Number.isInteger(value.actualReps) || value.actualReps < 0 || value.actualReps > 10000) {
    throw httpError(400, "INVALID_REQUEST", "actualReps is invalid");
  }
  const hasLoad = value.load !== undefined && value.load !== null;
  const hasUnit = value.unit !== undefined && value.unit !== null;
  if (hasLoad !== hasUnit) {
    throw httpError(400, "INVALID_REQUEST", "load and unit must be supplied together");
  }
  if (
    hasLoad
    && (
      typeof value.load !== "number"
      || !Number.isFinite(value.load)
      || value.load <= 0
      || value.load > 1000000000
      || !Number.isInteger(value.load * 1000000)
    )
  ) {
    throw httpError(400, "INVALID_REQUEST", "load is invalid");
  }
  return {
    order: value.order,
    actualReps: value.actualReps,
    load: hasLoad ? value.load : null,
    unit: hasUnit ? boundedString(value.unit, "unit", 20) : null,
    notes: optionalBoundedString(value.notes, "set notes", 2000),
  };
}

function parseExercise(value, expectedOrder) {
  rejectUnknownKeys(
    value,
    ["order", "name", "state", "notes", "sets"],
    "Exercise"
  );
  if (value.order !== expectedOrder) {
    throw httpError(400, "INVALID_REQUEST", "Exercise order must be contiguous and start at 1");
  }
  if (!["planned", "completed", "skipped"].includes(value.state)) {
    throw httpError(400, "INVALID_REQUEST", "Exercise state is invalid");
  }
  if (!Array.isArray(value.sets) || value.sets.length > MAXIMUM_SETS_PER_EXERCISE) {
    throw httpError(400, "INVALID_REQUEST", "Exercise sets are invalid");
  }
  if (value.state === "completed" && value.sets.length === 0) {
    throw httpError(400, "INVALID_REQUEST", "A completed exercise requires at least one set");
  }
  if (value.state !== "completed" && value.sets.length !== 0) {
    throw httpError(400, "INVALID_REQUEST", "Only completed exercises may contain actual sets");
  }
  return {
    order: value.order,
    name: boundedString(value.name, "exercise name", 200),
    state: value.state,
    notes: optionalBoundedString(value.notes, "exercise notes", 4000),
    sets: value.sets.map((set, index) => parseSet(set, index + 1)),
  };
}

function parseExercises(value) {
  if (!Array.isArray(value) || value.length > MAXIMUM_EXERCISES) {
    throw httpError(400, "INVALID_REQUEST", "exercises is invalid");
  }
  const exercises = value.map((exercise, index) => parseExercise(exercise, index + 1));
  const totalSets = exercises.reduce((total, exercise) => total + exercise.sets.length, 0);
  if (totalSets > MAXIMUM_TOTAL_SETS) {
    throw httpError(400, "INVALID_REQUEST", "Workout contains too many sets");
  }
  return exercises;
}

function parseCreate(body) {
  rejectUnknownKeys(body, ["clientRequestId", "workoutName", "notes", "exercises"]);
  return {
    clientRequestId: parseRequestId(body.clientRequestId),
    workoutName: boundedString(body.workoutName, "workoutName", 200),
    notes: optionalBoundedString(body.notes, "notes", 4000),
    exercises: parseExercises(body.exercises),
  };
}

function parseDraftReplacement(body) {
  rejectUnknownKeys(body, ["version", "workoutName", "notes", "exercises"]);
  return {
    version: parseVersion(body.version),
    workoutName: boundedString(body.workoutName, "workoutName", 200),
    notes: optionalBoundedString(body.notes, "notes", 4000),
    exercises: parseExercises(body.exercises),
  };
}

function parseCompletion(body) {
  rejectUnknownKeys(body, ["version"]);
  return { version: parseVersion(body.version) };
}

function requestHash(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isoTimestamp(value) {
  return new Date(value).toISOString();
}

function encodeCursor(session) {
  return Buffer.from(JSON.stringify({ createdAt: session.createdAt, id: session.id }))
    .toString("base64url");
}

function parseCursor(value) {
  if (typeof value !== "string" || !CURSOR.test(value)) {
    throw httpError(400, "INVALID_REQUEST", "cursor is invalid");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== value) throw new Error("non-canonical");
    const cursor = JSON.parse(decoded);
    if (
      !exactObject(cursor)
      || Object.keys(cursor).sort().join(",") !== "createdAt,id"
      || typeof cursor.createdAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.createdAt)
      || new Date(cursor.createdAt).toISOString() !== cursor.createdAt
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt: cursor.createdAt, id: parseSessionId(cursor.id) };
  } catch (_) {
    throw httpError(400, "INVALID_REQUEST", "cursor is invalid");
  }
}

function parseListQuery(query) {
  rejectUnknownKeys(query, ["limit", "cursor"], "Query");
  const rawLimit = query.limit === undefined ? "20" : query.limit;
  if (typeof rawLimit !== "string" || !/^[1-9]\d*$/.test(rawLimit)) {
    throw httpError(400, "INVALID_REQUEST", "limit is invalid");
  }
  const limit = Number(rawLimit);
  if (limit > 50) throw httpError(400, "INVALID_REQUEST", "limit is invalid");
  const cursor = query.cursor === undefined ? null : parseCursor(query.cursor);
  return {
    limit,
    cursorCreatedAt: cursor ? cursor.createdAt : null,
    cursorId: cursor ? cursor.id : null,
  };
}

function publicSessionRow(row) {
  return {
    id: String(row.id),
    source: row.source,
    status: row.status,
    version: Number(row.version),
    workoutName: row.workout_name,
    notes: row.notes,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    completedAt: row.completed_at === null ? null : isoTimestamp(row.completed_at),
  };
}

function publicSet(row) {
  return {
    id: String(row.id),
    order: Number(row.set_order),
    actualReps: Number(row.actual_reps),
    load: row.load === null ? null : Number(row.load),
    unit: row.unit,
    notes: row.notes,
  };
}

function publicExercise(row, sets) {
  return {
    id: String(row.id),
    order: Number(row.exercise_order),
    name: row.name,
    state: row.state,
    notes: row.notes,
    sets,
  };
}

async function fetchOwnedSession(client, sessionId, memberId) {
  const sessionResult = await client.query(
    `SELECT id, source, status, version, workout_name, notes,
            created_at, updated_at, completed_at
     FROM goals_coach_tracked_workout_sessions
     WHERE id = $1 AND member_id = $2`,
    [sessionId, memberId]
  );
  if (!sessionResult.rows.length) return null;
  const session = sessionResult.rows[0];
  const exercisesResult = await client.query(
    `SELECT id, exercise_order, name, state, notes
     FROM goals_coach_tracked_workout_exercises
     WHERE session_id = $1 AND member_id = $2 AND session_version = $3
     ORDER BY exercise_order`,
    [sessionId, memberId, session.version]
  );
  const setsResult = await client.query(
    `SELECT id, exercise_id, set_order, actual_reps, load, unit, notes
     FROM goals_coach_tracked_workout_sets
     WHERE session_id = $1 AND member_id = $2 AND session_version = $3
     ORDER BY exercise_id, set_order`,
    [sessionId, memberId, session.version]
  );
  const setsByExercise = new Map();
  for (const set of setsResult.rows) {
    const exerciseId = String(set.exercise_id);
    if (!setsByExercise.has(exerciseId)) setsByExercise.set(exerciseId, []);
    setsByExercise.get(exerciseId).push(publicSet(set));
  }
  return {
    ...publicSessionRow(session),
    exercises: exercisesResult.rows.map((exercise) => (
      publicExercise(exercise, setsByExercise.get(String(exercise.id)) || [])
    )),
  };
}

async function insertRevision(client, sessionId, memberId, version, exercises) {
  for (const exercise of exercises) {
    const result = await client.query(
      `INSERT INTO goals_coach_tracked_workout_exercises
        (session_id, member_id, session_version, exercise_order, name, state, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        sessionId, memberId, version, exercise.order,
        exercise.name, exercise.state, exercise.notes,
      ]
    );
    const exerciseId = result.rows[0].id;
    for (const set of exercise.sets) {
      await client.query(
        `INSERT INTO goals_coach_tracked_workout_sets
          (exercise_id, session_id, member_id, session_version,
           set_order, actual_reps, load, unit, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          exerciseId, sessionId, memberId, version, set.order,
          set.actualReps, set.load, set.unit, set.notes,
        ]
      );
    }
  }
}

async function withTransaction(db, action) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
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

function createOwnerEditableWorkoutSessionsRouter(options = {}) {
  const db = options.db;
  const authenticateSession = options.authenticateSession;
  const authorizeOwner = options.authorizeOwner;
  const expectedOrigin = options.origin;
  if (!db || typeof db.query !== "function" || typeof db.connect !== "function") {
    throw new Error("Editable workout sessions require a transactional database");
  }
  if (typeof authenticateSession !== "function" || typeof authorizeOwner !== "function") {
    throw new Error("Editable workout sessions require owner session authorization");
  }
  if (typeof expectedOrigin !== "string" || !expectedOrigin) {
    throw new Error("Editable workout sessions require one exact origin");
  }
  const mappingAuthorization = options.mappingAuthorization
    || createGymMasterMemberAuthorization({ db });
  const rateLimits = options.rateLimits || createRateLimits();
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.headers.origin !== expectedOrigin) {
      return res.status(403).json({ error: "OWNER_ORIGIN_NOT_ALLOWED" });
    }
    return next();
  });
  router.use(authenticateSession);
  router.use(async (req, res, next) => {
    try {
      if (authorizeOwner(req.alphaMemberIdentity) !== true) {
        return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      }
      const authorization = await mappingAuthorization.authorizeIdentity(req.alphaMemberIdentity);
      if (!authorization.active) {
        return res.status(401).json({ error: "MEMBER_AUTHENTICATION_REQUIRED" });
      }
      req.ownerEditableWorkoutMemberId = authorization.memberId;
      return next();
    } catch (error) {
      return next(error);
    }
  });

  router.post("/tracked-workout-sessions", rateLimits.mutation, async (req, res, next) => {
    try {
      const input = parseCreate(req.body);
      const hash = requestHash(input);
      const result = await withTransaction(db, async (client) => {
        const inserted = await client.query(
          `INSERT INTO goals_coach_tracked_workout_sessions
            (member_id, client_request_id, client_request_hash,
             source, source_snapshot, workout_name, notes)
           VALUES ($1, $2, $3, 'manual', NULL, $4, $5)
           ON CONFLICT (member_id, client_request_id) DO NOTHING
           RETURNING id, version`,
          [
            req.ownerEditableWorkoutMemberId, input.clientRequestId,
            hash, input.workoutName, input.notes,
          ]
        );
        if (!inserted.rows.length) {
          const existing = await client.query(
            `SELECT id, client_request_hash
             FROM goals_coach_tracked_workout_sessions
             WHERE member_id = $1 AND client_request_id = $2`,
            [req.ownerEditableWorkoutMemberId, input.clientRequestId]
          );
          if (!existing.rows.length || existing.rows[0].client_request_hash !== hash) {
            throw httpError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "clientRequestId was already used for a different workout session"
            );
          }
          return {
            created: false,
            session: await fetchOwnedSession(
              client,
              String(existing.rows[0].id),
              req.ownerEditableWorkoutMemberId
            ),
          };
        }
        const sessionId = String(inserted.rows[0].id);
        const version = Number(inserted.rows[0].version);
        await insertRevision(
          client,
          sessionId,
          req.ownerEditableWorkoutMemberId,
          version,
          input.exercises
        );
        await client.query(
          `INSERT INTO goals_coach_tracked_workout_events
            (session_id, member_id, event_type, session_version, event_data)
           VALUES ($1, $2, 'created', $3, '{"source":"manual"}'::jsonb)`,
          [sessionId, req.ownerEditableWorkoutMemberId, version]
        );
        return {
          created: true,
          session: await fetchOwnedSession(
            client,
            sessionId,
            req.ownerEditableWorkoutMemberId
          ),
        };
      });
      return res.status(result.created ? 201 : 200).json({
        workoutSession: result.session,
        idempotentReplay: !result.created,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/tracked-workout-sessions", rateLimits.read, async (req, res, next) => {
    try {
      const input = parseListQuery(req.query);
      const result = await db.query(
        `SELECT id, source, status, version, workout_name, notes,
                created_at, updated_at, completed_at
         FROM goals_coach_tracked_workout_sessions
         WHERE member_id = $1
           AND (
             $2::timestamptz IS NULL
             OR created_at < $2::timestamptz
             OR (created_at = $2::timestamptz AND id < $3::bigint)
           )
         ORDER BY created_at DESC, id DESC
         LIMIT $4`,
        [
          req.ownerEditableWorkoutMemberId,
          input.cursorCreatedAt,
          input.cursorId,
          input.limit + 1,
        ]
      );
      const hasMore = result.rows.length > input.limit;
      const sessions = result.rows.slice(0, input.limit).map(publicSessionRow);
      return res.status(200).json({
        workoutSessions: sessions,
        nextCursor: hasMore ? encodeCursor(sessions[sessions.length - 1]) : null,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/tracked-workout-sessions/:id", rateLimits.read, async (req, res, next) => {
    try {
      const session = await fetchOwnedSession(
        db,
        parseSessionId(req.params.id),
        req.ownerEditableWorkoutMemberId
      );
      if (!session) {
        throw httpError(404, "TRACKED_WORKOUT_SESSION_NOT_FOUND", "Workout session not found");
      }
      return res.status(200).json({ workoutSession: session });
    } catch (error) {
      return next(error);
    }
  });

  router.put(
    "/tracked-workout-sessions/:id/draft",
    rateLimits.mutation,
    async (req, res, next) => {
      try {
        const sessionId = parseSessionId(req.params.id);
        const input = parseDraftReplacement(req.body);
        const session = await withTransaction(db, async (client) => {
          const current = await client.query(
            `SELECT id, status, version
             FROM goals_coach_tracked_workout_sessions
             WHERE id = $1 AND member_id = $2
             FOR UPDATE`,
            [sessionId, req.ownerEditableWorkoutMemberId]
          );
          if (!current.rows.length) {
            throw httpError(
              404,
              "TRACKED_WORKOUT_SESSION_NOT_FOUND",
              "Workout session not found"
            );
          }
          const row = current.rows[0];
          if (row.status === "completed") {
            throw httpError(
              409,
              "TRACKED_WORKOUT_SESSION_COMPLETED",
              "Completed workout execution data cannot be edited"
            );
          }
          if (Number(row.version) !== input.version) {
            throw httpError(
              409,
              "TRACKED_WORKOUT_SESSION_VERSION_CONFLICT",
              "Workout session version is stale",
              { currentVersion: Number(row.version) }
            );
          }
          const nextVersion = input.version + 1;
          await client.query(
            `UPDATE goals_coach_tracked_workout_sessions
             SET workout_name = $3, notes = $4, version = $5, updated_at = NOW()
             WHERE id = $1 AND member_id = $2`,
            [
              sessionId, req.ownerEditableWorkoutMemberId,
              input.workoutName, input.notes, nextVersion,
            ]
          );
          await insertRevision(
            client,
            sessionId,
            req.ownerEditableWorkoutMemberId,
            nextVersion,
            input.exercises
          );
          await client.query(
            `INSERT INTO goals_coach_tracked_workout_events
              (session_id, member_id, event_type, session_version, event_data)
             VALUES ($1, $2, 'draft_replaced', $3, $4::jsonb)`,
            [
              sessionId,
              req.ownerEditableWorkoutMemberId,
              nextVersion,
              JSON.stringify({ previousVersion: input.version }),
            ]
          );
          return fetchOwnedSession(
            client,
            sessionId,
            req.ownerEditableWorkoutMemberId
          );
        });
        return res.status(200).json({ workoutSession: session });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.post(
    "/tracked-workout-sessions/:id/complete",
    rateLimits.mutation,
    async (req, res, next) => {
      try {
        const sessionId = parseSessionId(req.params.id);
        const input = parseCompletion(req.body);
        const result = await withTransaction(db, async (client) => {
          const current = await client.query(
            `SELECT id, status, version
             FROM goals_coach_tracked_workout_sessions
             WHERE id = $1 AND member_id = $2
             FOR UPDATE`,
            [sessionId, req.ownerEditableWorkoutMemberId]
          );
          if (!current.rows.length) {
            throw httpError(
              404,
              "TRACKED_WORKOUT_SESSION_NOT_FOUND",
              "Workout session not found"
            );
          }
          const row = current.rows[0];
          if (Number(row.version) !== input.version) {
            throw httpError(
              409,
              "TRACKED_WORKOUT_SESSION_VERSION_CONFLICT",
              "Workout session version is stale",
              { currentVersion: Number(row.version) }
            );
          }
          if (row.status === "completed") {
            return {
              replay: true,
              session: await fetchOwnedSession(
                client,
                sessionId,
                req.ownerEditableWorkoutMemberId
              ),
            };
          }
          const planned = await client.query(
            `SELECT COUNT(*)::int AS count
             FROM goals_coach_tracked_workout_exercises
             WHERE session_id = $1 AND member_id = $2
               AND session_version = $3 AND state = 'planned'`,
            [sessionId, req.ownerEditableWorkoutMemberId, input.version]
          );
          if (Number(planned.rows[0].count) !== 0) {
            throw httpError(
              409,
              "TRACKED_WORKOUT_SESSION_HAS_PLANNED_EXERCISES",
              "Every exercise must be completed or skipped before completion"
            );
          }
          await client.query(
            `UPDATE goals_coach_tracked_workout_sessions
             SET status = 'completed', completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND member_id = $2`,
            [sessionId, req.ownerEditableWorkoutMemberId]
          );
          await client.query(
            `INSERT INTO goals_coach_tracked_workout_events
              (session_id, member_id, event_type, session_version, event_data)
             VALUES ($1, $2, 'completed', $3, '{"completion":"explicit"}'::jsonb)`,
            [sessionId, req.ownerEditableWorkoutMemberId, input.version]
          );
          return {
            replay: false,
            session: await fetchOwnedSession(
              client,
              sessionId,
              req.ownerEditableWorkoutMemberId
            ),
          };
        });
        return res.status(200).json({
          workoutSession: result.session,
          idempotentReplay: result.replay,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}

module.exports = {
  OWNER_EDITABLE_WORKOUT_SESSIONS_FLAG,
  createOwnerEditableWorkoutSessionsRouter,
  ownerEditableWorkoutSessionsEnabled,
  parseCompletion,
  parseCreate,
  parseDraftReplacement,
  parseListQuery,
};
