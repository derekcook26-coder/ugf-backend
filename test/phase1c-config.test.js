const assert = require("node:assert/strict");
const test = require("node:test");
const {
  APPROVED_AUDIO_WARNING_SECONDS,
  APPROVED_MAX_AUDIO_BYTES,
  APPROVED_MAX_AUDIO_SECONDS,
  APPROVED_PHASE1C_CONSENT_VERSION,
  PHASE1C_CONSENT_APPROVAL_PLACEHOLDER,
  SUPPORTED_PHASE1C_MEDIA_TYPES,
  exactEnabled,
  loadPhase1cConfiguration,
} = require("../src/goals-coach/phase1c-config");

function readyEnvironment(overrides = {}) {
  return {
    GOALS_COACH_VOICE_INPUT_ENABLED: "true",
    GOALS_COACH_TRANSCRIPTION_ENABLED: "true",
    GOALS_COACH_PHASE1C_CONSENT_VERSION: "GC-ALPHA-CONSENT-PHASE1C-TEST",
    GOALS_COACH_TRANSCRIPTION_TIMEOUT_MS: "15000",
    GOALS_COACH_TRANSCRIPTION_REQUEST_TIMEOUT_MS: "20000",
    GOALS_COACH_MAX_AUDIO_SECONDS: "30",
    GOALS_COACH_AUDIO_WARNING_SECONDS: "25",
    GOALS_COACH_MAX_AUDIO_BYTES: "1048576",
    GOALS_COACH_TRANSCRIPTION_MAX_PER_MINUTE: "3",
    GOALS_COACH_TRANSCRIPTION_MAX_PER_DAY: "30",
    GOALS_COACH_TRANSCRIPTION_MAX_CONCURRENCY: "1",
    GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD: "1.00",
    GOALS_COACH_TRANSCRIPTION_BINDING_KEY: "synthetic-test-binding-key",
    GOALS_COACH_SPEECH_OUTPUT_ENABLED: "false",
    ...overrides,
  };
}

test("Phase 1C configuration defaults are disabled and fail closed", () => {
  const configuration = loadPhase1cConfiguration({});
  assert.equal(configuration.voiceInputEnabled, false);
  assert.equal(configuration.transcriptionEnabled, false);
  assert.equal(configuration.speechOutputEnabled, false);
  assert.equal(configuration.consentVersion, "");
  assert.equal(configuration.consentApproved, false);
  assert.equal(configuration.transcriptionTimeoutMs, 15000);
  assert.equal(configuration.transcriptionRequestTimeoutMs, 20000);
  assert.equal(configuration.maxAudioSeconds, APPROVED_MAX_AUDIO_SECONDS);
  assert.equal(configuration.audioWarningSeconds, APPROVED_AUDIO_WARNING_SECONDS);
  assert.equal(configuration.maxAudioBytes, APPROVED_MAX_AUDIO_BYTES);
  assert.equal(configuration.transcriptionMaxPerMinute, 3);
  assert.equal(configuration.transcriptionMaxPerDay, 30);
  assert.equal(configuration.transcriptionMaxConcurrency, 1);
  assert.equal(configuration.transcriptionDailyBudgetUsd, 0);
  assert.equal(configuration.bindingKeyConfigured, false);
  assert.equal(configuration.numericConfigurationValid, true);
  assert.equal(APPROVED_PHASE1C_CONSENT_VERSION, null);
  assert.equal(PHASE1C_CONSENT_APPROVAL_PLACEHOLDER, "OWNER_APPROVED_PHASE1C_CONSENT_VERSION_REQUIRED");
  assert.deepEqual(SUPPORTED_PHASE1C_MEDIA_TYPES, [
    "audio/webm;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ]);
});

test("only the exact string true enables Phase 1C boolean gates", () => {
  for (const value of [undefined, null, "", "false", "TRUE", "True", " true", "true ", true, 1]) {
    assert.equal(exactEnabled(value), false, `unexpected enabled value ${String(value)}`);
  }
  assert.equal(exactEnabled("true"), true);

  const configuration = loadPhase1cConfiguration({
    GOALS_COACH_VOICE_INPUT_ENABLED: "true",
    GOALS_COACH_TRANSCRIPTION_ENABLED: "TRUE",
    GOALS_COACH_SPEECH_OUTPUT_ENABLED: "true",
  });
  assert.equal(configuration.voiceInputEnabled, true);
  assert.equal(configuration.transcriptionEnabled, false);
  assert.equal(configuration.speechOutputEnabled, true);
});

test("numeric and security settings fail closed outside the approved boundary", () => {
  const invalidCases = [
    { GOALS_COACH_TRANSCRIPTION_TIMEOUT_MS: "not-a-number" },
    { GOALS_COACH_TRANSCRIPTION_TIMEOUT_MS: "20000", GOALS_COACH_TRANSCRIPTION_REQUEST_TIMEOUT_MS: "20000" },
    { GOALS_COACH_MAX_AUDIO_SECONDS: "31" },
    { GOALS_COACH_MAX_AUDIO_SECONDS: "29" },
    { GOALS_COACH_AUDIO_WARNING_SECONDS: "30" },
    { GOALS_COACH_AUDIO_WARNING_SECONDS: "24" },
    { GOALS_COACH_MAX_AUDIO_BYTES: "1048577" },
    { GOALS_COACH_MAX_AUDIO_BYTES: "1048575" },
    { GOALS_COACH_TRANSCRIPTION_MAX_PER_MINUTE: "0" },
    { GOALS_COACH_TRANSCRIPTION_MAX_PER_DAY: "2", GOALS_COACH_TRANSCRIPTION_MAX_PER_MINUTE: "3" },
    { GOALS_COACH_TRANSCRIPTION_MAX_CONCURRENCY: "2" },
    { GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD: "-1" },
    { GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD: "1.001" },
  ];
  for (const invalid of invalidCases) {
    assert.equal(
      loadPhase1cConfiguration(readyEnvironment(invalid), {
        approvedConsentVersion: "GC-ALPHA-CONSENT-PHASE1C-TEST",
      }).numericConfigurationValid,
      false,
      JSON.stringify(invalid)
    );
  }

  const missingBinding = loadPhase1cConfiguration(readyEnvironment({
    GOALS_COACH_TRANSCRIPTION_BINDING_KEY: "",
  }), { approvedConsentVersion: "GC-ALPHA-CONSENT-PHASE1C-TEST" });
  assert.equal(missingBinding.bindingKeyConfigured, false);

  const zeroBudget = loadPhase1cConfiguration(readyEnvironment({
    GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD: "0.00",
  }), { approvedConsentVersion: "GC-ALPHA-CONSENT-PHASE1C-TEST" });
  assert.equal(zeroBudget.transcriptionDailyBudgetUsd, 0);
  assert.equal(zeroBudget.numericConfigurationValid, true);
});

test("consent remains unapproved in production and can be injected only through test composition", () => {
  const environment = readyEnvironment();
  const production = loadPhase1cConfiguration(environment);
  assert.equal(production.consentApproved, false);

  const unknown = loadPhase1cConfiguration({
    ...environment,
    GOALS_COACH_PHASE1C_CONSENT_VERSION: "UNKNOWN-CONSENT",
  });
  assert.equal(unknown.consentApproved, false);

  const testConfiguration = loadPhase1cConfiguration(environment, {
    approvedConsentVersion: "GC-ALPHA-CONSENT-PHASE1C-TEST",
  });
  assert.equal(testConfiguration.consentApproved, true);
  assert.equal(testConfiguration.numericConfigurationValid, true);
  assert.equal(testConfiguration.bindingKeyConfigured, true);
});
