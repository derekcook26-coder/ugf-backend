const express = require("express");
const {
  MAXIMUM_TRANSCRIPTION_AUDIO_BYTES,
  SUPPORTED_TRANSCRIPTION_MIME_TYPES,
  canonicalUuid,
} = require("./transcription-adapter");

const canonicalContentLength = /^(?:0|[1-9][0-9]*)$/;
const canonicalDatabaseId = /^[1-9][0-9]{0,15}$/;
const maximumConversationId = "9007199254740991";
const canonicalUtcIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const supportedMimeTypes = new Set(SUPPORTED_TRANSCRIPTION_MIME_TYPES);
const functionalTranscriptionPath = /^\/alpha\/goals-coach\/conversations\/([^/]+)\/transcriptions\/([^/]+)$/;
const missingRequestIdPath = /^\/alpha\/goals-coach\/conversations\/([^/]+)\/transcriptions$/;
const encodedPathSeparator = /%(?:2f|5c)/i;
const serviceResultFields = Object.freeze([
  "transcriptionId",
  "requestId",
  "attemptNumber",
  "transcript",
  "durationMs",
  "expiresAt",
]);

const serviceErrors = Object.freeze({
  TRANSCRIPTION_REQUEST_INVALID: [400, "Invalid transcription request."],
  TRANSCRIPTION_REQUEST_ID_INVALID: [400, "Invalid transcription request ID."],
  TRANSCRIPTION_RETRY_INVALID: [400, "Invalid transcription retry request."],
  TRANSCRIPTION_NOT_FOUND: [404, "Transcription not found."],
  TRANSCRIPTION_REQUEST_CONFLICT: [409, "The transcription request conflicts with an existing request."],
  TRANSCRIPTION_IN_PROGRESS: [409, "Transcription is already in progress."],
  TRANSCRIPTION_ALREADY_COMPLETED: [409, "Transcription was already completed."],
  TRANSCRIPTION_RETRY_REQUIRED: [409, "An explicit retry is required."],
  TRANSCRIPTION_RETRY_NOT_AVAILABLE: [409, "No failed transcription is available to retry."],
  TRANSCRIPTION_RETRY_DELAY: [409, "Retry is not available yet."],
  TRANSCRIPTION_ATTEMPT_LIMIT_REACHED: [409, "No additional transcription attempts are allowed."],
  TRANSCRIPTION_AUDIO_TOO_LARGE: [413, "Audio exceeds the size limit."],
  TRANSCRIPTION_MIME_UNSUPPORTED: [415, "Audio type is unsupported."],
  TRANSCRIPTION_INVALID_AUDIO: [422, "Audio could not be processed."],
  TRANSCRIPTION_AUDIO_UNINTELLIGIBLE: [422, "Audio could not be understood."],
  TRANSCRIPTION_MINUTE_LIMIT: [429, "Transcription rate limit reached."],
  TRANSCRIPTION_DAILY_LIMIT: [429, "Transcription daily limit reached."],
  TRANSCRIPTION_PROVIDER_TIMEOUT: [503, "Transcription is temporarily unavailable."],
  TRANSCRIPTION_PROVIDER_UNAVAILABLE: [503, "Transcription is temporarily unavailable."],
});

function routeError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.exposeMessage = true;
  return error;
}

function unavailableResponse(res) {
  return res.status(503).json({
    error: "TRANSCRIPTION_NOT_AVAILABLE",
    message: "Transcription is not available.",
  });
}

function bodyError() {
  return routeError(
    400,
    "TRANSCRIPTION_BODY_INVALID",
    "Invalid transcription request body."
  );
}

function classifyTranscriptionRouteRequest(req) {
  if (!req || req.method !== "POST") return false;
  const originalUrl = typeof req.originalUrl === "string" ? req.originalUrl : "";
  const queryOffset = originalUrl.indexOf("?");
  const rawPath = queryOffset === -1 ? originalUrl : originalUrl.slice(0, queryOffset);
  if (encodedPathSeparator.test(rawPath)) return false;
  if (rawPath.split("/").some((segment) => segment === "." || segment === "..")) return false;
  const functional = functionalTranscriptionPath.exec(rawPath);
  if (functional) {
    return Object.freeze({
      type: "functional",
      rawPath,
      conversationId: functional[1],
      requestId: functional[2],
    });
  }
  const missing = missingRequestIdPath.exec(rawPath);
  if (missing) {
    return Object.freeze({
      type: "missing_request_id",
      rawPath,
      conversationId: missing[1],
      requestId: null,
    });
  }
  return false;
}

function isTranscriptionRouteRequest(req) {
  return Boolean(classifyTranscriptionRouteRequest(req));
}

function createApplicationJsonParser() {
  const applicationJsonParser = express.json();
  return function parseApplicationJson(req, res, next) {
    if (isTranscriptionRouteRequest(req)) return next();
    return applicationJsonParser(req, res, next);
  };
}

function normalizedServiceError(error) {
  const definition = error && serviceErrors[error.code];
  if (!definition) {
    return routeError(
      503,
      "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
      "Transcription is temporarily unavailable."
    );
  }
  return routeError(definition[0], error.code, definition[1]);
}

function canonicalConversationId(value) {
  return canonicalDatabaseId.test(value)
    && (value.length < maximumConversationId.length || value <= maximumConversationId);
}

function rawHeaderValues(req, headerName) {
  if (!Array.isArray(req.rawHeaders)) return [];
  const values = [];
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    if (typeof name === "string" && name.toLowerCase() === headerName) {
      values.push(req.rawHeaders[index + 1]);
    }
  }
  return values;
}

function canonicalExpiry(value) {
  if (typeof value !== "string" || !canonicalUtcIsoTimestamp.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validatedServiceResult(result, expectedRequestId) {
  try {
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const ownKeys = Reflect.ownKeys(result);
    if (
      ownKeys.length !== serviceResultFields.length
      || ownKeys.some((key) => typeof key !== "string")
      || serviceResultFields.some((field) => !ownKeys.includes(field))
    ) return null;
    const descriptors = Object.getOwnPropertyDescriptors(result);
    if (serviceResultFields.some((field) => (
      !descriptors[field]
      || descriptors[field].enumerable !== true
      || !Object.hasOwn(descriptors[field], "value")
    ))) return null;

    const transcriptionId = descriptors.transcriptionId.value;
    const requestId = descriptors.requestId.value;
    const attemptNumber = descriptors.attemptNumber.value;
    const transcript = descriptors.transcript.value;
    const durationMs = descriptors.durationMs.value;
    const expiresAt = descriptors.expiresAt.value;
    if (!canonicalUuid(transcriptionId)) return null;
    if (!canonicalUuid(requestId) || requestId !== expectedRequestId) return null;
    if (attemptNumber !== 1 && attemptNumber !== 2) return null;
    if (
      typeof transcript !== "string"
      || transcript.length < 1
      || transcript.length > 8000
      || transcript !== transcript.trim()
    ) return null;
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 30000) return null;
    if (!canonicalExpiry(expiresAt)) return null;
    return Object.freeze({
      transcriptionId,
      requestId,
      attemptNumber,
      transcript,
      durationMs,
      expiresAt,
    });
  } catch (_) {
    return null;
  }
}

function createTranscriptionRoute(options = {}) {
  const db = options.db;
  const phase1cStartup = options.phase1cStartup || null;
  const transcriptionService = options.transcriptionService || null;
  const rawAudio = express.raw({
    type: () => true,
    limit: MAXIMUM_TRANSCRIPTION_AUDIO_BYTES,
    inflate: false,
  });

  function setResponseProtections(req, res, next) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return next();
  }

  function requireReadiness(req, res, next) {
    if (
      !phase1cStartup
      || phase1cStartup.status !== "ready"
      || !transcriptionService
      || typeof transcriptionService.transcribe !== "function"
    ) {
      return unavailableResponse(res);
    }
    return next();
  }

  function validateRequestMetadata(req, res, next) {
    try {
      const path = classifyTranscriptionRouteRequest(req);
      if (!path) {
        return res.status(400).json({
          error: "TRANSCRIPTION_REQUEST_INVALID",
          message: "Invalid transcription request.",
        });
      }
      if (path.type === "missing_request_id") {
        throw routeError(
          400,
          "TRANSCRIPTION_REQUEST_ID_INVALID",
          "Invalid transcription request ID."
        );
      }
      const conversationId = path.conversationId;
      if (!canonicalConversationId(conversationId)) {
        throw routeError(
          400,
          "TRANSCRIPTION_CONVERSATION_ID_INVALID",
          "Invalid conversation ID."
        );
      }
      const requestId = path.requestId;
      if (!canonicalUuid(requestId)) {
        throw routeError(
          400,
          "TRANSCRIPTION_REQUEST_ID_INVALID",
          "Invalid transcription request ID."
        );
      }

      const queryOffset = req.originalUrl.indexOf("?");
      const retry = queryOffset === -1
        ? false
        : req.originalUrl.slice(queryOffset + 1) === "retry=true";
      if (queryOffset !== -1 && !retry) {
        throw routeError(
          400,
          "TRANSCRIPTION_RETRY_INVALID",
          "Invalid transcription retry request."
        );
      }

      const contentTypes = rawHeaderValues(req, "content-type");
      const mimeType = contentTypes.length === 1 ? contentTypes[0] : null;
      if (typeof mimeType !== "string" || !supportedMimeTypes.has(mimeType)) {
        throw routeError(
          415,
          "TRANSCRIPTION_MIME_UNSUPPORTED",
          "Audio type is unsupported."
        );
      }
      const contentEncodings = rawHeaderValues(req, "content-encoding");
      const contentEncoding = contentEncodings.length === 1 ? contentEncodings[0] : null;
      if (
        contentEncodings.length > 1
        || (contentEncodings.length === 1 && contentEncoding !== "identity")
      ) {
        throw routeError(
          415,
          "TRANSCRIPTION_ENCODING_UNSUPPORTED",
          "Content encoding is unsupported."
        );
      }

      const declaredLength = req.headers["content-length"];
      if (declaredLength !== undefined) {
        if (typeof declaredLength !== "string" || !canonicalContentLength.test(declaredLength)) {
          throw bodyError();
        }
        if (BigInt(declaredLength) > BigInt(MAXIMUM_TRANSCRIPTION_AUDIO_BYTES)) {
          throw routeError(
            413,
            "TRANSCRIPTION_AUDIO_TOO_LARGE",
            "Audio exceeds the size limit."
          );
        }
      }

      req.transcriptionRoute = Object.freeze({
        conversationId,
        requestId,
        retry,
        mimeType,
        declaredLength: declaredLength === undefined ? null : Number(declaredLength),
      });
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function normalizeRawParserError(error, req, res, next) {
    if (!error) return next();
    if (error.statusCode && error.code && error.exposeMessage) return next(error);
    if (error.type === "entity.too.large") {
      return next(routeError(
        413,
        "TRANSCRIPTION_AUDIO_TOO_LARGE",
        "Audio exceeds the size limit."
      ));
    }
    if (error.type === "encoding.unsupported") {
      return next(routeError(
        415,
        "TRANSCRIPTION_ENCODING_UNSUPPORTED",
        "Content encoding is unsupported."
      ));
    }
    if (
      error.type === "request.aborted"
      || error.type === "request.size.invalid"
      || error.type === "entity.parse.failed"
      || error.code === "ECONNABORTED"
    ) {
      return next(bodyError());
    }
    return next(bodyError());
  }

  async function transcribe(req, res, next) {
    try {
      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const metadata = req.transcriptionRoute;
      if (metadata.declaredLength !== null && metadata.declaredLength !== audio.length) {
        throw bodyError();
      }
      if (audio.length < 1) {
        throw routeError(422, "TRANSCRIPTION_INVALID_AUDIO", "Audio is required.");
      }
      if (audio.length > MAXIMUM_TRANSCRIPTION_AUDIO_BYTES) {
        throw routeError(
          413,
          "TRANSCRIPTION_AUDIO_TOO_LARGE",
          "Audio exceeds the size limit."
        );
      }

      const conversation = await db.query(
        `SELECT plan_id
         FROM coaching_conversations
         WHERE id = $1
           AND member_id = $2
           AND status = 'active'
         LIMIT 1`,
        [metadata.conversationId, req.alphaMember.memberId]
      );
      if (!conversation.rows.length) {
        throw routeError(404, "TRANSCRIPTION_NOT_FOUND", "Transcription not found.");
      }
      const planId = String(conversation.rows[0].plan_id);
      let result;
      try {
        result = await transcriptionService.transcribe({
          member: {
            mappingId: req.alphaMember.mappingId,
            memberId: req.alphaMember.memberId,
            authProvider: req.alphaMember.authProvider,
            authSubject: req.alphaMember.authSubject,
          },
          authenticatedSessionId: req.alphaMemberIdentity.sessionId,
          conversationId: metadata.conversationId,
          planId,
          requestId: metadata.requestId,
          audio,
          mimeType: metadata.mimeType,
          retry: metadata.retry,
        });
      } catch (error) {
        throw normalizedServiceError(error);
      }
      const validatedResult = validatedServiceResult(result, metadata.requestId);
      if (!validatedResult) throw normalizedServiceError(null);
      return res.status(201).json({
        transcriptionId: validatedResult.transcriptionId,
        requestId: validatedResult.requestId,
        attemptNumber: validatedResult.attemptNumber,
        transcript: validatedResult.transcript,
        durationMs: validatedResult.durationMs,
        expiresAt: validatedResult.expiresAt,
      });
    } catch (error) {
      return next(error);
    }
  }

  return Object.freeze([
    setResponseProtections,
    requireReadiness,
    validateRequestMetadata,
    rawAudio,
    normalizeRawParserError,
    transcribe,
  ]);
}

module.exports = {
  classifyTranscriptionRouteRequest,
  createApplicationJsonParser,
  createTranscriptionRoute,
  isTranscriptionRouteRequest,
};
