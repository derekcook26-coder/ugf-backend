# Provider-free member “today” boundary

Slice B adds only `POST /goalscoach/member/today`, behind the exact-string
`GOALS_COACH_MEMBER_TODAY_ENABLED=true` gate (default `false`). The route accepts
credentialed requests from the single configured HTTPS member origin, requires
`application/json`, rejects query parameters and unknown keys, and always emits
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

An initial body is `{ "clientRequestId": "<uuid>" }`. A single closed-choice
continuation uses a new request UUID and
`{ "clientRequestId": "<uuid>", "continuation": { "attemptId": "<original uuid>", "optionId": "option-1" } }`.
No free text is accepted. Authentication precedes the member-keyed limiter;
mapping and current Gatekeeper membership follow it.

The deterministic states are `SAFETY_REQUIRED`, `URGENT_STOP`,
`MEDICAL_REVIEW_REQUIRED`, `CONSENT_REQUIRED`, `UNAVAILABLE`,
`QUESTION_REQUIRED`, and `READY`. Safety stops precede consent and disclose no
plan. Only a current Safety Intake V2 result, accepted
`GC-MEMBER-COACHING-CONSENT-1` consent, the member's latest owned plan, and its
active validated items are read. Multiple eligible items produce one
server-defined closed choice; one eligible item is immediately `READY`.
`MODIFICATION_REQUIRED` always includes the fixed comfortable/pain-free,
reduced-intensity-or-range, stop-on-increase constraint.

Migration 014 is required for cross-process idempotent replay and one-time
continuation consumption. It stores hashes, ownership IDs, minimized state and
plan/item/option provenance only—never response prose, health answers, plan
markdown, provider payloads, or member text. The capability makes no workout,
plan, message, conversation, safety, consent, enrollment, or profile mutation,
and imports no AI/provider adapter.
