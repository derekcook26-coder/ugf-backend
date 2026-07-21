# Phase 1E private-alpha environment inventory

This is a planning inventory only. It does not set environment variables,
provision an identity provider, contact a model provider, or authorize a
deployment. Values belong only in the approved deployment environment and
must never be committed.

## Required disabled defaults

The following switches remain exactly `false` until separately approved and
verified in the private-alpha environment:

- `GOALS_COACH_ALPHA_ENABLED`
- `GOALS_COACH_AI_ENABLED`
- `GOALS_COACH_VOICE_INPUT_ENABLED`
- `GOALS_COACH_TRANSCRIPTION_ENABLED`
- `GOALS_COACH_SPEECH_OUTPUT_ENABLED`
- `GOALS_COACH_PHASE1D_SAFETY_ENABLED`

## Configuration categories for later owner review

| Category | Required decision | Safe handling |
| --- | --- | --- |
| Alpha origin | One exact HTTPS private-alpha origin | Configure server-side; no wildcard, path, or browser-provided fallback. |
| Identity | Immutable approved owner subject and MFA evidence | Store provider configuration as secrets; do not commit an email or token. |
| Consent | `GC-ALPHA-CONSENT-1.0` and current-consent enforcement | Keep consent records in the authorized database only. |
| Database | Separate, least-privilege alpha connection | Keep connection material secret; do not use shared or public credentials. |
| AI and voice | Explicit provider model, timeout, limits, and budget | Keep keys server-side; both features remain disabled until approved. |
| Safety/review | Protected primary and backup destinations | Do not put destinations or health details in browser code or logs. |
| Monitoring | Error, rate-limit, routing-failure, and availability alerts | Exclude raw conversations, audio, tokens, MFA codes, and keys. |

## Owner decisions required before configuration review

1. The exact alpha origin and the immutable approved owner subject.
2. Monthly spending ceiling and daily warning threshold.
3. Protected primary and backup review destinations.
4. Which features, if any, are proposed for a staged enablement sequence.
5. The rollback owner and verification procedure.

Completing this inventory is not approval to configure, deploy, migrate, or
activate the private alpha.
