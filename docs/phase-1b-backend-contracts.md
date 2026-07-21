# Goals Coach 2.0 Phase 1B backend contracts

Status: local contract-completion implementation prepared for review. It is not deployed, activated, migrated in production, or approved for frontend implementation or release.

All endpoints below remain under the existing `/alpha/goals-coach` feature gate, exact-origin boundary, dedicated member authentication, active member mapping, and current-consent middleware. Browser-supplied member, plan, role, ownership, and account-state values are not authorization inputs.

## Session restoration and capability

`POST /alpha/goals-coach/session` retains all Phase 1A fields and adds:

```json
{
  "coachingCapability": {
    "phase": "phase_1b",
    "status": "disabled | unavailable | ready",
    "reason": "ai_disabled | provider_unavailable | null",
    "structuredResponses": true,
    "workoutStateRead": true,
    "turnStatusRead": true
  },
  "workoutState": null
}
```

`workoutState` is either `null` or the same authoritative serialized workout state returned after a coaching turn:

```json
{
  "id": "123",
  "planId": "45",
  "workoutSessionKey": "2026-07-18:45:default",
  "workoutDayKey": "2026-07-18",
  "status": "active",
  "currentExerciseIndex": 0,
  "currentExerciseKey": "comfortable-walking",
  "currentExerciseName": "Comfortable walking",
  "currentSet": 1,
  "targetSets": 2,
  "targetRepetitions": null,
  "targetDurationSeconds": 300,
  "selectedModification": {},
  "completedExercises": [],
  "skippedExercises": [],
  "reportedEffort": null,
  "reportedDiscomfort": {},
  "stateVersion": 1,
  "startedAt": "timestamp",
  "lastActivityAt": "timestamp",
  "completedAt": null
}
```

The server resolves the active workout from the authenticated mapping, current saved plan, and server-owned active conversation. It never accepts or infers workout ownership or state from request content or message prose. Reading the workout state does not mutate workout-session, event, turn, or message records. `coachingMode` remains present for backward compatibility and is not a readiness signal.

Capability semantics are server authoritative:

- `disabled` / `ai_disabled`: `GOALS_COACH_AI_ENABLED` is not exactly `true`.
- `unavailable` / `provider_unavailable`: AI was enabled but no valid enabled provider composition is available. Invalid or failed provider composition is also unavailable and cannot appear ready.
- `ready` / `null`: startup has explicit AI enablement, complete generation configuration, a valid provider adapter, and a configured coaching engine.

Production startup does not add a provider adapter in this change. Its capability therefore cannot become ready merely because configuration strings exist.

## Message submission

`POST /alpha/goals-coach/conversations/:conversationId/messages` accepts a strict JSON object. A typed message remains backward compatible:

```json
{
  "content": "Typed message",
  "clientMessageId": "7d25d744-a1e5-4caf-aac1-0f263e6ecbef"
}
```

Omitted `inputMethod` means `text`. An explicit `"inputMethod": "text"` is also accepted, but text input cannot include `transcriptionId`. A reviewed Phase 1C transcript uses:

```json
{
  "content": "Reviewed transcript, possibly edited",
  "clientMessageId": "7d25d744-a1e5-4caf-aac1-0f263e6ecbef",
  "inputMethod": "voice",
  "transcriptionId": "4a53bfa5-51a7-4ccc-9a0d-f1696eb8e021"
}
```

The body may contain only `content`, `clientMessageId`, `inputMethod`, and the conditionally required `transcriptionId`. Browser-supplied member, mapping, session, conversation, plan, provider, model, attempt, or other fields are rejected before mutation. `content` must be an actual JSON string before trimming; numbers, booleans, arrays, objects, and `null` are rejected without coercion. The trimmed string must contain 1 through 8,000 characters; identifiers must be canonical UUIDs, and the transcription UUID must be lowercase.

Voice submission also requires an explicitly injected ready Phase 1C startup composition and server-only transcription binding key. Authenticated session identity comes separately from server authentication state and is never accepted from JSON. Production composes neither requirement, so environment values alone cannot activate voice submission. Typed submission retains its independent Migration 001–004 SQL path and never queries Migration 005 storage.

Voice staging uses the global overlapping lock order: active mapping and consent, authoritative conversation, coaching-turn target/table, then transcription attempt. Phase 1B provider finalization follows the same prefix by locking mapping/consent and the authoritative conversation before its coaching turn. It locks and fully validates the supplied attempt before considering an unrelated pending coaching turn. Unknown, cross-scope, non-completed, expired, or improperly consumed attempts therefore share the same concealed `404 TRANSCRIPTION_NOT_FOUND`; only an otherwise eligible attempt can be rejected with `409 COACHING_TURN_IN_PROGRESS`. A completed attempt that expires during the transaction is committed as `expired` before the concealed response.

## Turn reconciliation

`GET /alpha/goals-coach/conversations/:conversationId/turns/:clientMessageId`

`clientMessageId` must be a UUID. The endpoint is read-only and returns the latest authoritative attempt for the mapped member's message:

```json
{
  "conversationId": "12",
  "clientMessageId": "7d25d744-a1e5-4caf-aac1-0f263e6ecbef",
  "memberMessageId": "100",
  "status": "processing | completed | retryable_failure | failed",
  "messageSaved": true,
  "retrySafe": false,
  "attemptNumber": 1,
  "result": null,
  "updatedAt": "timestamp"
}
```

Status semantics:

- `processing`: the saved message has a pending provider attempt. `result` is `null`; no response or workout state is fabricated; `retrySafe` is `false` while it is running.
- `completed`: `result` is the existing authoritative `CoachingTurnResult`, including stored structured response and linked current workout state. The read is identified as an idempotent replay.
- `retryable_failure`: the member message was saved and the latest failure category is approved as retryable. `result` is `null`, `messageSaved` and `retrySafe` are `true`.
- `failed`: the turn ended in a non-retryable conflict or control failure. `result` is `null` and `retrySafe` is `false`.

Unknown turns, unknown conversations, and cross-member requests all return concealed `404 COACHING_TURN_NOT_FOUND`. Invalid UUIDs return `400 INVALID_REQUEST`. Responses never expose prompts, provider payloads, credentials, stack traces, or provider error detail.

## Message-history discovery

`GET /alpha/goals-coach/conversations/:conversationId/messages` preserves its existing cursor pagination and message fields. Member-authored messages additionally return:

```json
{
  "clientMessageId": "7d25d744-a1e5-4caf-aac1-0f263e6ecbef",
  "turn": {
    "status": "processing | completed | retryable_failure | failed",
    "retrySafe": false,
    "attemptNumber": 1,
    "updatedAt": "timestamp"
  }
}
```

`clientMessageId` and `turn` are `null` when no corresponding value exists. When multiple attempts exist, the summary describes the latest attempt. Coach-authored messages continue to return their stored `structuredResponse`. Internal provider identifiers, request payloads, prompts, context digests, and failure details are not included.

## Refresh restoration procedure

1. Authenticate through the dedicated alpha member application and obtain current consent.
2. Call `POST /session` without browser-supplied ownership identifiers.
3. Use returned `conversation`, `plan`, `coachingCapability`, and `workoutState` as the authoritative current session state.
4. Load paginated conversation messages.
5. For a member message whose latest turn is unresolved, use its server-returned `clientMessageId` with the turn endpoint.
6. Render workout progress only from returned authoritative workout state. Do not reconstruct state from conversation text.

This procedure requires no browser persistence of protected conversation or workout information.

## Safe retry procedure

1. If message submission returns `COACHING_TEMPORARILY_UNAVAILABLE` with `messageSaved: true` and `retrySafe: true`, retain the same normalized content, `clientMessageId`, and input method for the retry. Voice retries also retain the exact `transcriptionId`.
2. After refresh, discover the server-backed `clientMessageId` and turn summary in message history.
3. Reconcile the latest attempt through the turn endpoint.
4. Retry only when the authoritative response is `retryable_failure` with `retrySafe: true`.
5. Submit the exact original content and same `clientMessageId`. Different content, transcription identity, or text/voice conversion returns `409 CLIENT_MESSAGE_ID_CONFLICT`.
6. A completed retry returns the existing logical member message with the new completed attempt; duplicate completed requests return the existing result without duplicating workout state or provenance.

## Human-review boundary

When the separate Phase 1D private-alpha composition is explicitly injected,
its deterministic safety boundary runs before ordinary Phase 1B provider
generation and may create a protected concern/review response. Default startup
does not inject that composition or configure a route. Member-facing code must
not claim that a human received, accepted, or reviewed a request unless a
configured protected destination returns a receipt. Review-required and
safety-stop outputs cannot mutate workout state.

## Activation boundary

This contract work does not authorize enabling Phase 1B, adding a provider adapter, configuring credentials, running a production migration, deploying a service, implementing the frontend, or contacting a live provider or other external production service.
