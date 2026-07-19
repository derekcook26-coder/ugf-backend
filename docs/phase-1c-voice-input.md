# Goals Coach Phase 1C voice-input capability boundary

Status: local disabled-capability implementation prepared for review. It does not add audio upload, transcription, voice message provenance, spoken output, a provider, a migration, deployment, or activation.

## Startup and capability

Production startup creates a Phase 1C startup result without a transcription adapter. `GOALS_COACH_VOICE_INPUT_ENABLED` and `GOALS_COACH_TRANSCRIPTION_ENABLED` use exact-string `true` parsing and default disabled. No environment value selects a deterministic adapter.

No production Phase 1C consent version is approved in this commit. `GOALS_COACH_PHASE1C_CONSENT_VERSION` therefore cannot make production startup ready. A nonzero budget, binding key, valid limits, ready Phase 1B composition, approved consent, and an explicitly injected valid adapter are all required before readiness is possible.

`POST /alpha/goals-coach/session` includes a server-authored `voiceCapability` while preserving every existing session field. The member-visible capability contains only status, a safe reason, transcript-review requirement, fixed recording limits, and the fixed media allowlist. It does not expose provider, model, credential, binding, budget, environment, or diagnostic values.

## Server-only configuration

| Variable | Default | Boundary |
| --- | --- | --- |
| `GOALS_COACH_VOICE_INPUT_ENABLED` | `false` | Exact `true` only. |
| `GOALS_COACH_TRANSCRIPTION_ENABLED` | `false` | Exact `true` only. |
| `GOALS_COACH_PHASE1C_CONSENT_VERSION` | empty | No production version is approved. |
| `GOALS_COACH_TRANSCRIPTION_TIMEOUT_MS` | `15000` | Must be a positive integer. |
| `GOALS_COACH_TRANSCRIPTION_REQUEST_TIMEOUT_MS` | `20000` | Must exceed provider timeout. |
| `GOALS_COACH_MAX_AUDIO_SECONDS` | `30` | Locked to the approved private-alpha boundary. |
| `GOALS_COACH_AUDIO_WARNING_SECONDS` | `25` | Locked below the duration limit. |
| `GOALS_COACH_MAX_AUDIO_BYTES` | `1048576` | Locked to one MiB. |
| `GOALS_COACH_TRANSCRIPTION_MAX_PER_MINUTE` | `3` | Must be positive. |
| `GOALS_COACH_TRANSCRIPTION_MAX_PER_DAY` | `30` | Must be at least the per-minute value. |
| `GOALS_COACH_TRANSCRIPTION_MAX_CONCURRENCY` | `1` | Must remain one. |
| `GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD` | `0.00` | Zero prevents readiness. |
| `GOALS_COACH_TRANSCRIPTION_BINDING_KEY` | empty | Missing prevents readiness. |
| `GOALS_COACH_SPEECH_OUTPUT_ENABLED` | `false` | Reserved and unused. |

All variables are server-only. No Phase 1C variable is browser-visible or `NEXT_PUBLIC_*`.

## Test composition

Tests may inject a shape-only deterministic readiness stub directly into `createPhase1cStartup`. Production startup does not import the stub, does not call a provider, and cannot report ready in this commit.

This capability boundary does not authorize Phase 1B or Phase 1C activation.
