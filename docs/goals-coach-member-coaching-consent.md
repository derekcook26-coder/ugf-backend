# Goals Coach member coaching consent foundation

## Status and boundary

This additive Slice A records a general GymMaster member's versioned coaching-consent choice. It is disabled by default with the exact-string gate `GOALS_COACH_MEMBER_COACHING_CONSENT_ENABLED=false`. Consent does not mount or authorize coaching, AI providers, plans, voice, editable workouts, Safety Intake, private alpha, owner access, pending enrollment, or human review. Production activation and the notice wording each require Derek Cook's separate explicit approval.

This authority is separate from `goals_coach_alpha_consents` and Safety Intake V2. Only an `accepted` current state for the exact required notice version may be consulted by a later, separately approved coaching slice. Declining or withdrawing does not affect gym membership, and withdrawal never erases immutable history.

## Notice candidate — `GC-MEMBER-COACHING-CONSENT-1`

> Goals Coach may use your approved membership context, current safety result, current Goals Coach plan, and answers you deliberately submit to personalize coaching. Goals Coach does not replace medical care or medical advice, and safety rules may pause or limit coaching. An AI service may be used only when separately approved, gated, and available. You may decline or later withdraw consent; that prevents personalized coaching but does not affect your gym membership. Coaching, AI-provider access, plans, voice, and human review are not activated by this consent.

The wording is a draft for owner review. Implementation approval is not approval to publish or activate this notice.

## Contract

When separately configured, `GET /goalscoach/member/coaching-consent` returns only the notice, required version, and minimized current state. `POST` accepts exactly `clientRequestId` (UUID), `noticeVersion`, and `action` (`accept`, `decline`, or `withdraw`). Unknown fields, prose, query parameters, unsupported media, malformed JSON, and oversized requests are rejected.

The request boundary applies exact credentialed origin CORS, signed GymMaster session authentication, member/session rate limiting, active local mapping, and current Gatekeeper membership before consent logic. Unknown, inactive, or cross-member identities receive the same concealed `401`; authenticated dependency failures receive a minimized `503`. Responses are `no-store` and `nosniff`.

Migration 013 is explicit-only, checksum/order guarded, transactionally advisory-locked, and bounded by checkout, lock, statement, and overall deadlines. Rollback requires explicit confirmation and refuses later migrations or immutable consent events. Neither migration is run at application startup.
