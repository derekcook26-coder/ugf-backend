# Phase 1E verification matrix

This matrix is an evidence plan for the private, owner-only alpha. A completed
row is not an authorization to deploy or activate the alpha. No production,
provider, or member-data action is implied by this document.

## Offline gates

| Area | Evidence required | Pass condition |
| --- | --- | --- |
| Feature gates | Automated readiness tests | Alpha, AI, voice, speech, and Phase 1D safety stay disabled by default. |
| Authorization | Existing alpha/member/staff contract tests | Unknown origins, invalid tokens, missing consent, and incorrect ownership fail closed. |
| Safety | Existing deterministic safety tests | Urgent safety stops normal coaching; review-routing failures remain visible. |
| Privacy | Route and logging review | No API key, token, MFA code, raw audio, or full conversation is added to logs or browser output. |
| Recovery | Migration and rollback tests on disposable databases | Additive migrations and their guarded rollback behavior are evidenced without a production database. |
| Approval record | Unsigned-record tests | The record is complete only as a draft and never authorizes activation. |

## Later owner-controlled gates

These require separate written approval and cannot be satisfied from local code
alone:

| Area | Required evidence |
| --- | --- |
| Identity and consent | Dedicated owner authentication identity, MFA, current consent, and separate reviewer authorization. |
| Exact origin | One approved HTTPS alpha origin; no wildcard or browser-supplied authorization. |
| Cost controls | Approved monthly budget, daily warning, message/audio limits, provider timeouts, and visible spending alerts. |
| Review routing | Protected primary and backup destinations, tested routing confirmation, and an actionable routing-failure path. |
| Browser and network | Owner-device tests, slow/offline/retry behavior, refresh-during-processing, and visible delivery state. |
| Deployment and rollback | Staging or isolated migration evidence, disabled deployment verification, kill-switch exercise, and safe rollback instructions. |

## Required negative scenarios

- Unknown or wrong browser origin.
- Invalid, expired, wrong-issuer, wrong-audience, and unmapped identity.
- Missing or withdrawn consent.
- Cross-conversation and cross-review ownership attempts.
- Disabled alpha or unavailable safety/review capability.
- Safety-classifier and review-routing failures.
- Provider timeout, interrupted audio upload, duplicate retry, refresh while processing, and temporary network loss.

Any failed safety, authorization, privacy, routing, or cost-control gate blocks
the unsigned record from progressing to Owner configuration review.
