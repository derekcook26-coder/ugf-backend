# Provider-free member “today” boundary

Slice B adds only `POST /goalscoach/member/today`, behind the exact-string
`GOALS_COACH_MEMBER_TODAY_ENABLED=true` gate (default `false`). Requests require
the configured HTTPS member origin, credentials, `application/json`, no query
parameters, and a strict closed-choice body. Responses are always `no-store`
and `nosniff`.

Safety stops precede consent and plan disclosure. The boundary reads only the
current Safety Intake V2 result, accepted `GC-MEMBER-COACHING-CONSENT-1`
consent, the member's latest owned plan, and its validated plan items. It makes
no workout, plan, conversation, safety, consent, enrollment, or profile
mutation and imports no AI/provider adapter.

Migration 014 stores minimized ownership, request, state, plan/item/option
identifiers and canonical SHA-256 hashes of the live item fields exposed by the
API. It stores no response prose, health answers, plan markdown, provider
payloads, or member text. Replay and continuation recompute every stored item
binding and hash and fail closed if any binding is missing, stale, cross-scope,
or changed.
