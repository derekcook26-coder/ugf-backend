const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_TRANSCRIPT_CHARACTERS = 8000;
const MAXIMUM_TRANSCRIPTION_AUDIO_BYTES = 1048576;
const MAXIMUM_TRANSCRIPTION_DURATION_MS = 30000;
const SUPPORTED_TRANSCRIPTION_MIME_TYPES = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
]);
const TRANSCRIPTION_FAILURE_CATEGORIES = Object.freeze([
  "invalid_audio",
  "unintelligible_audio",
  "provider_timeout",
  "provider_unavailable",
  "provider_error",
]);
const failureCategories = new Set(TRANSCRIPTION_FAILURE_CATEGORIES);

class TranscriptionAdapterError extends Error {
  constructor(failureCategory) {
    super("Transcription provider could not complete the request");
    this.name = "TranscriptionAdapterError";
    this.failureCategory = failureCategories.has(failureCategory)
      ? failureCategory
      : "provider_error";
    this.code = this.failureCategory;
  }
}

function canonicalUuid(value) {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function boundedIdentifier(value, maximumLength) {
  return typeof value === "string"
    && value === value.trim()
    && value.length >= 1
    && value.length <= maximumLength;
}

function abortSignal(value) {
  return Boolean(
    value
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function"
      && typeof value.removeEventListener === "function"
  );
}

function validateTranscriptionAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("A transcription adapter is required");
  }
  if (!boundedIdentifier(adapter.providerIdentifier, 100)) {
    throw new Error("Transcription adapter providerIdentifier is invalid");
  }
  if (!boundedIdentifier(adapter.modelIdentifier, 200)) {
    throw new Error("Transcription adapter modelIdentifier is invalid");
  }
  if (typeof adapter.transcribe !== "function") {
    throw new Error("Transcription adapter transcribe function is required");
  }
  return adapter;
}

function validateAdapterRequest(request) {
  if (!request || typeof request !== "object") {
    throw new TranscriptionAdapterError("invalid_audio");
  }
  if (!canonicalUuid(request.requestId)) {
    throw new TranscriptionAdapterError("invalid_audio");
  }
  if (
    !Buffer.isBuffer(request.audio)
    || request.audio.length < 1
    || request.audio.length > MAXIMUM_TRANSCRIPTION_AUDIO_BYTES
  ) {
    throw new TranscriptionAdapterError("invalid_audio");
  }
  if (!SUPPORTED_TRANSCRIPTION_MIME_TYPES.includes(request.mimeType)) {
    throw new TranscriptionAdapterError("invalid_audio");
  }
  if (request.maximumDurationMs !== MAXIMUM_TRANSCRIPTION_DURATION_MS) {
    throw new TranscriptionAdapterError("invalid_audio");
  }
  if (!abortSignal(request.signal)) {
    throw new TranscriptionAdapterError("provider_error");
  }
  return request;
}

function minimizedAdapterError(error, signal) {
  if (error instanceof TranscriptionAdapterError) return error;
  if (signal.aborted || (error && error.name === "AbortError")) {
    return new TranscriptionAdapterError("provider_timeout");
  }
  const category = error && error.failureCategory;
  if (failureCategories.has(category)) {
    return new TranscriptionAdapterError(category);
  }
  return new TranscriptionAdapterError("provider_error");
}

function normalizeAdapterResult(result) {
  if (!result || typeof result !== "object" || typeof result.text !== "string") {
    throw new TranscriptionAdapterError("provider_error");
  }
  let text = result.text.trim();
  if (!text) throw new TranscriptionAdapterError("unintelligible_audio");
  if (text.length > MAXIMUM_TRANSCRIPT_CHARACTERS) {
    text = text.slice(0, MAXIMUM_TRANSCRIPT_CHARACTERS).trimEnd();
  }
  if (!text) throw new TranscriptionAdapterError("unintelligible_audio");
  if (
    !Number.isInteger(result.durationMs)
    || result.durationMs < 1
    || result.durationMs > MAXIMUM_TRANSCRIPTION_DURATION_MS
  ) {
    throw new TranscriptionAdapterError("provider_error");
  }
  return Object.freeze({ text, durationMs: result.durationMs });
}

async function transcribeWithAdapter(adapter, request) {
  validateTranscriptionAdapter(adapter);
  validateAdapterRequest(request);
  let result;
  try {
    result = await adapter.transcribe(request);
  } catch (error) {
    throw minimizedAdapterError(error, request.signal);
  }
  return normalizeAdapterResult(result);
}

module.exports = {
  MAXIMUM_TRANSCRIPT_CHARACTERS,
  MAXIMUM_TRANSCRIPTION_AUDIO_BYTES,
  MAXIMUM_TRANSCRIPTION_DURATION_MS,
  SUPPORTED_TRANSCRIPTION_MIME_TYPES,
  TRANSCRIPTION_FAILURE_CATEGORIES,
  TranscriptionAdapterError,
  canonicalUuid,
  normalizeAdapterResult,
  transcribeWithAdapter,
  validateTranscriptionAdapter,
};
