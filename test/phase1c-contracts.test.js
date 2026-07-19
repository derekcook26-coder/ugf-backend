const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createVoiceCapability,
  validateVoiceCapability,
} = require("../src/goals-coach/phase1c-contracts");

const mediaTypes = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
];

function capability(overrides = {}) {
  return {
    phase: "phase_1c",
    status: "disabled",
    reason: "voice_disabled",
    transcriptionAvailable: false,
    transcriptReviewRequired: true,
    maxRecordingSeconds: 30,
    warningAtSeconds: 25,
    maxAudioBytes: 1048576,
    supportedMediaTypes: [...mediaTypes],
    ...overrides,
  };
}

test("voice capability accepts every valid status and reason combination", () => {
  assert.deepEqual(validateVoiceCapability(capability()), capability());
  for (const reason of [
    "phase_1b_not_ready",
    "transcription_disabled",
    "consent_update_required",
    "invalid_configuration",
    "transcription_provider_unavailable",
  ]) {
    assert.equal(validateVoiceCapability(capability({
      status: "unavailable",
      reason,
    })).reason, reason);
  }
  const ready = validateVoiceCapability(capability({
    status: "ready",
    reason: null,
    transcriptionAvailable: true,
  }));
  assert.equal(ready.status, "ready");
  assert.equal(ready.transcriptionAvailable, true);
});

test("voice capability rejects invalid semantic combinations", () => {
  const invalid = [
    capability({ status: "disabled", reason: "phase_1b_not_ready" }),
    capability({ status: "unavailable", reason: "voice_disabled" }),
    capability({ status: "unavailable", reason: null }),
    capability({ status: "ready", reason: "invalid_configuration", transcriptionAvailable: true }),
    capability({ status: "ready", reason: null, transcriptionAvailable: false }),
    capability({ status: "disabled", reason: "voice_disabled", transcriptionAvailable: true }),
    capability({ transcriptReviewRequired: false }),
  ];
  for (const value of invalid) {
    assert.throws(() => validateVoiceCapability(value), /Invalid Phase 1C voice capability/);
  }
});

test("voice capability enforces exact limits, ordered media types, and strict fields", () => {
  for (const value of [
    capability({ maxRecordingSeconds: 29 }),
    capability({ warningAtSeconds: 24 }),
    capability({ maxAudioBytes: 1048575 }),
    capability({ supportedMediaTypes: [...mediaTypes].reverse() }),
    capability({ supportedMediaTypes: [...mediaTypes, "audio/wav"] }),
    { ...capability(), provider: "hidden" },
    { ...capability(), model: "hidden" },
    { ...capability(), bindingKey: "hidden" },
    { ...capability(), budget: 1 },
    { ...capability(), environment: "test" },
    { ...capability(), internalError: "hidden" },
  ]) {
    assert.throws(() => validateVoiceCapability(value), /Invalid Phase 1C voice capability/);
  }
});

test("server capability creation fails closed for missing or malformed startup", () => {
  assert.deepEqual(createVoiceCapability(null), capability());
  assert.deepEqual(createVoiceCapability({ status: "unexpected", reason: null }), capability());
  assert.throws(
    () => createVoiceCapability({ status: "unavailable", reason: "internal_exception" }),
    /Invalid Phase 1C voice capability/
  );
});
