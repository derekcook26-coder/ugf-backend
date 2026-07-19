const {
  APPROVED_AUDIO_WARNING_SECONDS,
  APPROVED_MAX_AUDIO_BYTES,
  APPROVED_MAX_AUDIO_SECONDS,
  SUPPORTED_PHASE1C_MEDIA_TYPES,
} = require("./phase1c-config");

const VOICE_CAPABILITY_REASONS = Object.freeze([
  "voice_disabled",
  "phase_1b_not_ready",
  "transcription_disabled",
  "consent_update_required",
  "invalid_configuration",
  "transcription_provider_unavailable",
]);

const REQUIRED_FIELDS = Object.freeze([
  "phase",
  "status",
  "reason",
  "transcriptionAvailable",
  "transcriptReviewRequired",
  "maxRecordingSeconds",
  "warningAtSeconds",
  "maxAudioBytes",
  "supportedMediaTypes",
]);

function invalidCapability() {
  const error = new Error("Invalid Phase 1C voice capability");
  error.code = "INVALID_PHASE1C_VOICE_CAPABILITY";
  throw error;
}

function validateVoiceCapability(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidCapability();
  if (Object.keys(value).length !== REQUIRED_FIELDS.length) invalidCapability();
  if (REQUIRED_FIELDS.some((field) => !Object.hasOwn(value, field))) invalidCapability();
  if (value.phase !== "phase_1c") invalidCapability();
  if (!['disabled', 'unavailable', 'ready'].includes(value.status)) invalidCapability();

  if (value.status === "disabled") {
    if (value.reason !== "voice_disabled") invalidCapability();
  } else if (value.status === "unavailable") {
    if (!VOICE_CAPABILITY_REASONS.includes(value.reason) || value.reason === "voice_disabled") {
      invalidCapability();
    }
  } else if (value.reason !== null) {
    invalidCapability();
  }

  if (value.transcriptionAvailable !== (value.status === "ready")) invalidCapability();
  if (value.transcriptReviewRequired !== true) invalidCapability();
  if (value.maxRecordingSeconds !== APPROVED_MAX_AUDIO_SECONDS) invalidCapability();
  if (value.warningAtSeconds !== APPROVED_AUDIO_WARNING_SECONDS) invalidCapability();
  if (value.maxAudioBytes !== APPROVED_MAX_AUDIO_BYTES) invalidCapability();
  if (!Array.isArray(value.supportedMediaTypes)) invalidCapability();
  if (value.supportedMediaTypes.length !== SUPPORTED_PHASE1C_MEDIA_TYPES.length) {
    invalidCapability();
  }
  for (let index = 0; index < SUPPORTED_PHASE1C_MEDIA_TYPES.length; index += 1) {
    if (value.supportedMediaTypes[index] !== SUPPORTED_PHASE1C_MEDIA_TYPES[index]) {
      invalidCapability();
    }
  }

  return Object.freeze({
    phase: value.phase,
    status: value.status,
    reason: value.reason,
    transcriptionAvailable: value.transcriptionAvailable,
    transcriptReviewRequired: true,
    maxRecordingSeconds: value.maxRecordingSeconds,
    warningAtSeconds: value.warningAtSeconds,
    maxAudioBytes: value.maxAudioBytes,
    supportedMediaTypes: SUPPORTED_PHASE1C_MEDIA_TYPES,
  });
}

function createVoiceCapability(startup) {
  const status = startup && startup.status;
  const reason = startup && startup.reason;
  const normalizedStatus = ["disabled", "unavailable", "ready"].includes(status)
    ? status
    : "disabled";
  const normalizedReason = normalizedStatus === "ready"
    ? null
    : normalizedStatus === "disabled"
      ? "voice_disabled"
      : reason;

  return validateVoiceCapability({
    phase: "phase_1c",
    status: normalizedStatus,
    reason: normalizedReason,
    transcriptionAvailable: normalizedStatus === "ready",
    transcriptReviewRequired: true,
    maxRecordingSeconds: APPROVED_MAX_AUDIO_SECONDS,
    warningAtSeconds: APPROVED_AUDIO_WARNING_SECONDS,
    maxAudioBytes: APPROVED_MAX_AUDIO_BYTES,
    supportedMediaTypes: [...SUPPORTED_PHASE1C_MEDIA_TYPES],
  });
}

module.exports = {
  REQUIRED_FIELDS,
  VOICE_CAPABILITY_REASONS,
  createVoiceCapability,
  validateVoiceCapability,
};
