# Goals Coach Phase 1E: private-alpha readiness

Phase 1E is an owner-only verification and deployment-readiness phase. It does
not activate the alpha, contact a provider, configure an external service, or
authorize a deployment.

## Safe pre-activation rule

Before an Owner configuration review, the following values must remain exactly
`false`:

- `GOALS_COACH_ALPHA_ENABLED`
- `GOALS_COACH_AI_ENABLED`
- `GOALS_COACH_VOICE_INPUT_ENABLED`
- `GOALS_COACH_TRANSCRIPTION_ENABLED`
- `GOALS_COACH_SPEECH_OUTPUT_ENABLED`
- `GOALS_COACH_PHASE1D_SAFETY_ENABLED`

The Phase 1E readiness evaluator is a local/offline report. Its best possible
result is `ready_for_configuration_review`; it never grants permission to
activate features or make external calls.

## Required owner decisions

Configuration review requires a separately recorded decision for the exact
alpha origin, owner subject, monthly budget, daily warning threshold, protected
review destination, and backup review destination. Secrets, API keys, MFA
codes, and full conversation content are not inputs to this evaluator.

The evaluator accepts only one exact HTTPS origin with no path, trailing slash,
or wildcard. Spending values must be positive USD amounts, and the daily
warning must be lower than the monthly ceiling.

## Later gated work

Only after a separate written Owner approval may the project configure Clerk,
providers, Railway, a production database migration, or private-alpha access.
Public launch remains outside Phase 1E.

## Unsigned approval record

`phase1e-approval-record` creates an in-memory draft for the required release
and evidence fields. It has no signing feature, no filesystem or network
operation, and never authorizes deployment or activation. A complete draft is
still only evidence for a later Owner decision.

## Environment inventory

`phase-1e-environment-inventory.md` is a secret-free checklist of the later
private-alpha configuration categories and their safe defaults. It must not be
used as a source of real credentials or activation values.
