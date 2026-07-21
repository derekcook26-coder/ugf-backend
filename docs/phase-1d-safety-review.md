# Goals Coach Phase 1D safety and human-review boundary

Phase 1D is a server-side, private-alpha safety boundary. It is disabled unless
the private-alpha composition explicitly injects its safety service after
Migration 006 has been applied. Production startup does not inject it in this
checkpoint, does not configure a delivery destination, and does not contact a
provider or a human reviewer.

## Safety decision order

Every enabled message is screened by versioned deterministic rules before
ordinary coaching generation. Direct, current urgent safety language stops
ordinary coaching and returns immediate assistance wording. Quoted,
hypothetical, negated, and historical language is not promoted to an emergency
by keywords alone. An optional classifier may only make the result more
protective; a missing, malformed, or failing classifier fails closed to a
protected review response.

For voice input, the certified Phase 1C transcription ownership and consumption
boundary runs before Phase 1D suppresses ordinary generation. The transcription
attempt is therefore still consumed exactly once, but no coaching provider is
called for a safety response.

## Durable records and routing

An enabled review or safety decision creates one member message, one official
concern, one review, one review-created event, and one deterministic Goals
Coach response. The persisted classification stores only the minimized
decision, category, priority, rule/version references, and reason code—not raw
audio, transcript text, provider payloads, session identifiers, or tokens.

Routing is adapter-based. A destination is considered delivered only after it
returns a receipt reference. The payload contains only a review reference,
priority, category, and time. A failed primary route creates an auditable alert
and may use one configured private backup route, subject to a capped attempt
count. A member response never states that a human has received the review.

## Human restrictions

An owner administrator may add a linked human restriction only through the
explicitly enabled protected staff API. An active restriction stops ordinary
coaching and creates a protected review rather than leaving a model to decide
whether the restriction applies. The endpoint is not registered by default.

## Operations and rollback

`npm run migrate:phase1d-safety-review` requires the existing database URL and
Migration 005. It is not part of startup. `npm run rollback:phase1d-safety-review`
requires `CONFIRM_PHASE1D_SAFETY_REVIEW_ROLLBACK=YES` and refuses to run after
any Phase 1D concern provenance, routing attempt, alert, restriction, or
extended review lifecycle evidence exists.

This checkpoint does not activate the alpha feature, configure a secure review
destination, send a notification, deploy, or assert that a human is watching.
