const PHASE1C_CONSENT_APPROVAL_PLACEHOLDER = "OWNER_APPROVED_PHASE1C_CONSENT_VERSION_REQUIRED";
const APPROVED_PHASE1C_CONSENT_VERSION = null;

const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 15000;
const DEFAULT_TRANSCRIPTION_REQUEST_TIMEOUT_MS = 20000;
const APPROVED_MAX_AUDIO_SECONDS = 30;
const APPROVED_AUDIO_WARNING_SECONDS = 25;
const APPROVED_MAX_AUDIO_BYTES = 1048576;
const DEFAULT_TRANSCRIPTION_MAX_PER_MINUTE = 3;
const DEFAULT_TRANSCRIPTION_MAX_PER_DAY = 30;
const APPROVED_TRANSCRIPTION_MAX_CONCURRENCY = 1;

const SUPPORTED_PHASE1C_MEDIA_TYPES = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
]);

function exactEnabled(value) {
  return value === "true";
}

function integerSetting(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return { value: fallback, valid: true };
  }
  const source = String(value);
  if (!/^\d+$/.test(source)) return { value: fallback, valid: false };
  const parsed = Number(source);
  return {
    value: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback,
    valid: Number.isSafeInteger(parsed) && parsed > 0,
  };
}

function budgetSetting(value) {
  if (value === undefined || value === null || value === "") {
    return { value: 0, valid: true };
  }
  const source = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(source)) {
    return { value: 0, valid: false };
  }
  const parsed = Number(source);
  return {
    value: parsed,
    valid: Number.isFinite(parsed) && parsed >= 0,
  };
}

function loadPhase1cConfiguration(environment = process.env, options = {}) {
  const transcriptionTimeout = integerSetting(
    environment.GOALS_COACH_TRANSCRIPTION_TIMEOUT_MS,
    DEFAULT_TRANSCRIPTION_TIMEOUT_MS
  );
  const requestTimeout = integerSetting(
    environment.GOALS_COACH_TRANSCRIPTION_REQUEST_TIMEOUT_MS,
    DEFAULT_TRANSCRIPTION_REQUEST_TIMEOUT_MS
  );
  const maximumSeconds = integerSetting(
    environment.GOALS_COACH_MAX_AUDIO_SECONDS,
    APPROVED_MAX_AUDIO_SECONDS
  );
  const warningSeconds = integerSetting(
    environment.GOALS_COACH_AUDIO_WARNING_SECONDS,
    APPROVED_AUDIO_WARNING_SECONDS
  );
  const maximumBytes = integerSetting(
    environment.GOALS_COACH_MAX_AUDIO_BYTES,
    APPROVED_MAX_AUDIO_BYTES
  );
  const perMinute = integerSetting(
    environment.GOALS_COACH_TRANSCRIPTION_MAX_PER_MINUTE,
    DEFAULT_TRANSCRIPTION_MAX_PER_MINUTE
  );
  const perDay = integerSetting(
    environment.GOALS_COACH_TRANSCRIPTION_MAX_PER_DAY,
    DEFAULT_TRANSCRIPTION_MAX_PER_DAY
  );
  const concurrency = integerSetting(
    environment.GOALS_COACH_TRANSCRIPTION_MAX_CONCURRENCY,
    APPROVED_TRANSCRIPTION_MAX_CONCURRENCY
  );
  const budget = budgetSetting(environment.GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD);
  const consentVersion = String(environment.GOALS_COACH_PHASE1C_CONSENT_VERSION || "").trim();
  const approvedConsentVersion = options.approvedConsentVersion === undefined
    ? APPROVED_PHASE1C_CONSENT_VERSION
    : options.approvedConsentVersion;

  const numericConfigurationValid = Boolean(
    transcriptionTimeout.valid
      && requestTimeout.valid
      && requestTimeout.value > transcriptionTimeout.value
      && maximumSeconds.valid
      && maximumSeconds.value === APPROVED_MAX_AUDIO_SECONDS
      && warningSeconds.valid
      && warningSeconds.value === APPROVED_AUDIO_WARNING_SECONDS
      && warningSeconds.value < maximumSeconds.value
      && maximumBytes.valid
      && maximumBytes.value === APPROVED_MAX_AUDIO_BYTES
      && perMinute.valid
      && perDay.valid
      && perDay.value >= perMinute.value
      && concurrency.valid
      && concurrency.value === APPROVED_TRANSCRIPTION_MAX_CONCURRENCY
      && budget.valid
  );

  return Object.freeze({
    voiceInputEnabled: exactEnabled(environment.GOALS_COACH_VOICE_INPUT_ENABLED),
    transcriptionEnabled: exactEnabled(environment.GOALS_COACH_TRANSCRIPTION_ENABLED),
    speechOutputEnabled: exactEnabled(environment.GOALS_COACH_SPEECH_OUTPUT_ENABLED),
    consentVersion,
    consentApproved: Boolean(
      approvedConsentVersion
        && consentVersion
        && consentVersion === approvedConsentVersion
    ),
    transcriptionTimeoutMs: transcriptionTimeout.value,
    transcriptionRequestTimeoutMs: requestTimeout.value,
    maxAudioSeconds: maximumSeconds.value,
    audioWarningSeconds: warningSeconds.value,
    maxAudioBytes: maximumBytes.value,
    transcriptionMaxPerMinute: perMinute.value,
    transcriptionMaxPerDay: perDay.value,
    transcriptionMaxConcurrency: concurrency.value,
    transcriptionDailyBudgetUsd: budget.value,
    bindingKeyConfigured: Boolean(
      String(environment.GOALS_COACH_TRANSCRIPTION_BINDING_KEY || "").trim()
    ),
    numericConfigurationValid,
  });
}

module.exports = {
  APPROVED_AUDIO_WARNING_SECONDS,
  APPROVED_MAX_AUDIO_BYTES,
  APPROVED_MAX_AUDIO_SECONDS,
  APPROVED_PHASE1C_CONSENT_VERSION,
  APPROVED_TRANSCRIPTION_MAX_CONCURRENCY,
  DEFAULT_TRANSCRIPTION_MAX_PER_DAY,
  DEFAULT_TRANSCRIPTION_MAX_PER_MINUTE,
  DEFAULT_TRANSCRIPTION_REQUEST_TIMEOUT_MS,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  PHASE1C_CONSENT_APPROVAL_PLACEHOLDER,
  SUPPORTED_PHASE1C_MEDIA_TYPES,
  exactEnabled,
  loadPhase1cConfiguration,
};
