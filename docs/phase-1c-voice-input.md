# Goals Coach Phase 1C voice-input capability boundary

Status: local disabled-capability implementation plus authenticated, bounded transcription and reviewed-message provenance boundaries prepared for review. Migration 005, a provider-agnostic adapter contract, the service lifecycle, the explicitly injected raw-audio route, and atomic reviewed-transcript consumption exist without a production adapter, production service composition, spoken output, deployment, or activation.

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

The transcription service has a separate deterministic adapter under `test/helpers`. It is injected explicitly by focused tests, performs no network activity, and is not imported by production source or `server.js`. No environment variable can select it.

## Authenticated raw-audio route

`POST /alpha/goals-coach/conversations/:conversationId/transcriptions/:requestId` is mounted after the existing exact-origin, feature, authenticated-session, active-member, and current-consent boundaries. It rejects before its raw parser unless Phase 1C reports `ready` and an explicitly injected transcription service exposes `transcribe`. Production startup injects no service or provider, so the route remains unavailable with a minimized `503` response.

One shared raw-path classifier controls both the global JSON-parser exclusion and route validation. It accepts POST only, the exact lowercase functional path without a trailing slash, or the exact missing-request-ID fallback. Mixed-case, duplicate-slash, encoded-separator, suffixed, prefixed, or otherwise noncanonical paths cannot reach raw parsing, database resolution, or transcription. The missing-ID fallback can return only the safe request-ID validation error.

The route accepts only a canonical positive conversation ID from 1 through `9007199254740991`, retained as a decimal string, a canonical lowercase UUID, no query or exactly `retry=true`, identity or absent content encoding, and one of `audio/webm;codecs=opus`, `audio/mp4;codecs=mp4a.40.2`, or `audio/mp4`. It inspects physical raw header lines and requires exactly one unambiguous `Content-Type`; `Content-Encoding` may be absent or one exact `identity` line. Duplicate or comma-joined representations are rejected before parsing. Its route-specific `express.raw` parser disables inflation and enforces 1 through 1,048,576 bytes. All unrelated endpoints retain the existing global JSON parser.

Member, mapping, authentication subject, and session scope come only from authenticated request state. The active conversation query resolves `plan_id` by conversation and member; missing, inactive, and cross-member records share a concealed not-found response. The service independently revalidates the full active mapping, member, conversation, and plan scope.

A successful service result must be a non-array object containing exactly six own enumerable data fields: canonical `transcriptionId`, the canonical path-bound `requestId`, attempt number 1 or 2, an already-trimmed nonempty transcript of at most 8,000 characters, an integer duration from 1 through 30,000 milliseconds, and an exact millisecond UTC ISO expiry string. Missing, extra, malformed, or mismatched results fail closed as minimized provider-unavailable responses; their contents are never logged. A successful HTTP response contains only those six fields, with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. The raw-audio route itself does not persist transcript text or create messages, coaching turns, consumption links, workouts, or automatic retries. A member must review or edit the returned transcript before explicitly sending it through the Phase 1B message path described below.

## Reviewed transcript submission

A reviewed transcript is submitted to the existing message endpoint with `inputMethod: "voice"` and the canonical lowercase `transcriptionId`. The JSON body is strict and cannot supply member, mapping, authenticated session, conversation plan, provider, model, attempt, or other authoritative values. `content` must be an actual JSON string before trimming or digest comparison; no number, boolean, array, object, or `null` value is coerced. Authenticated session identity is passed separately from server authentication state.

Voice submission fails before Migration 005 access unless the router and service receive both an explicitly injected ready Phase 1C startup composition and the server-only transcription binding key. Production `server.js` remains unchanged, provider-free, and unable to compose this readiness. The deterministic test responder is text-only. Typed messages retain a distinct SQL path that works when Migration 005 is absent and does not mention its table or turn-link column.

Voice staging stays inside the Phase 1B transaction. It revalidates mapping and current consent, locks the active conversation, explicitly takes `ROW EXCLUSIVE` ownership of `goals_coach_coaching_turns`, resolves the member message and turns, and only then locks `goals_coach_transcription_attempts`. This implements the overlapping global order of mapping/consent, conversation, coaching-turn target, and transcription attempt. The attempt must exactly match the authenticated member, active mapping, HMAC session digest, conversation, and authoritative plan, and must be completed, unexpired, and unconsumed.

The attempt is locked and fully evaluated before an unrelated pending coaching turn can cause `409 COACHING_TURN_IN_PROGRESS`. Unknown, cross-scope, pending, failed, expired, or improperly consumed attempts all use the identical concealed `404 TRANSCRIPTION_NOT_FOUND` response, including while another coaching turn is pending. Only an otherwise eligible completed attempt can receive the generic pending-turn conflict. A completed attempt that expires during this transaction commits only its transition to `expired` before the concealed response; rejected requests do not consume the attempt or create a message, turn, workout, or provider call.

The first successful voice staging transaction inserts the member message, inserts a voice turn with the sole transcription provenance link, and moves the attempt to `consumed` with its member-message reference and edit flag. The edit flag compares SHA-256 of the final trimmed UTF-8 message content with the stored normalized transcript digest; interior changes are edits, while trim-only changes are not. Transcript text is not copied into provenance. A staging failure rolls back all three changes.

Exact replay requires the same normalized content, client-message UUID, voice input method, and transcription UUID. A consumed attempt may identify only its original member message. A provider failure after staging leaves the attempt consumed; a later provider retry creates another voice turn with a null transcription link so the first turn remains the only provenance link. Expiry changes commit before the concealed not-found response, and replay or retry never rewrites a terminal attempt.

## Migration 005 privacy boundary

`goals_coach_transcription_attempts` stores only request and ownership provenance, exact MIME, byte count, authoritative duration, SHA-256 audio and transcript digests, minimized provider identity, minimized failure category, and lifecycle timestamps. It has no raw-audio, transcript-text, device-label, provider-payload, coaching-content, credential, bearer-token, or session-token column. The authenticated session is represented only by an HMAC-SHA256 digest made with the server-only Phase 1C binding key.

Migration 005 also adds nullable `goals_coach_coaching_turns.transcription_attempt_id`. The first reviewed voice-message turn populates it atomically with attempt consumption; later provider retries leave it null. A composite foreign key requires the turn and transcription attempt to match on transcription ID, member, conversation, and plan, and a partial unique index limits an attempt to at most one coaching turn.

Rollback 005 runs in an explicit `READ COMMITTED` transaction, acquires the migration advisory lock, verifies the recorded Migration 005 checksum and later-migration boundary, and then locks `goals_coach_coaching_turns` followed by `goals_coach_transcription_attempts` in `ACCESS EXCLUSIVE` mode. Only after both table locks are held does it check attempts and turn links and begin destructive DDL. This target-before-reference order matches a non-null coaching-turn transcription link: the writer first obtains its target lock on the coaching-turn table and then validates the referenced attempt. It avoids the backwards dependency that would exist if rollback locked attempts before waiting for coaching turns. The locks remain held until rollback or commit.

Attempt insertion and failure-only lifecycle updates lock only `goals_coach_transcription_attempts` and never request an earlier authoritative lock afterward; identity-changing updates and deletion are rejected by its `BEFORE` preservation trigger before they can require a coaching-turn referential action. Successful transcription finalization instead locks the authoritative mapping and conversation before locking and reselecting the exact attempt. A coaching-turn insert with a null transcription link locks only the turn table. A non-null insert or a null-to-non-null update locks the coaching-turn target before consulting the referenced attempt. Updates or deletions involving an existing link also begin at the coaching-turn target, and no production path takes an attempt lock before requesting a mapping, consent, conversation, or coaching-turn lock. Rollback therefore remains compatible with the only cross-table provenance direction: coaching turns, then transcription attempts.

If rollback owns the coaching-turn lock first, link writers wait before they can own the target and cannot wait backwards on attempts; rollback then locks attempts, checks, and removes an empty Migration 005 boundary. If a link writer owns the target first, rollback waits on its first lock, the writer completes, and the fresh preservation snapshot observes the committed link. If an attempt writer owns the attempt table first, rollback may own coaching turns while waiting for attempts, but the attempt writer has no dependency on coaching turns and can finish; the fresh snapshot then observes the committed attempt. If rollback owns both locks first, attempt writers wait and fail safely after the relation is removed. These paths contain no lock cycle and do not use deadlock detection or automatic `40P01` retries as control flow.

## Service transaction and locking strategy

The service receives already-resolved member, mapping, authenticated-session, conversation, and plan inputs and verifies them against active database records. Its staging transaction locks the authoritative auth-mapping and conversation rows, resolves replay and expiry, checks persisted minute/day attempt counts, and inserts exactly one pending attempt. A partial unique index on pending `member_id` is the process-independent concurrency backstop. Attempt-two insertion is also protected by a database trigger that requires a byte-identical, MIME-identical failed first attempt. Retry configuration cannot be less than 2,000 milliseconds, and attempt two becomes eligible only once the full 2,000 milliseconds have elapsed after failed provider completion.

The provider call occurs only after the staging transaction commits. No database transaction or row lock is held across provider latency. The pending row is the durable ownership lease: duplicates observe it and cannot invoke the adapter, while unrelated request IDs for the same member are rejected by the partial unique rule. Finalization opens a new transaction and acquires the active mapping and authoritative conversation locks before selecting the exact attempt `FOR UPDATE`. After that attempt lock is held, it revalidates the exact attempt identity, member, mapping, HMAC session digest, conversation, plan, request ID, attempt number, immutable provider/audio provenance, pending lifecycle, and operation deadline before any update. No preliminary or provider-era value can authorize completion. An ownership change is minimized and fails the exact pending attempt closed; a late adapter result cannot overwrite a completed, failed, consumed, or expired state, even if the adapter ignores cancellation.

Provider timeout is 15 seconds and the whole service deadline is 20 seconds. Both the service and the exported adapter boundary independently reject raw audio above 1,048,576 bytes before provider invocation. Adapter exceptions are reduced to the approved failure categories before persistence. Successful finalization stores the adapter-reported duration and transcript digest atomically, sets expiry ten minutes after completion, and returns transcript text only to the immediate caller. Transcript text is never persisted, so a lost completed response cannot be reconstructed or replayed.

## Committed expiry before concealment

When replay resolution finds a completed attempt whose expiry has passed, the staging transaction updates that attempt to `expired` and returns an internal sentinel. The transaction commits normally. Only after commit does the service raise the concealed safe not-found response. The concealed response is deliberately never thrown inside the expiry transaction, so it cannot roll back the authoritative expiry transition.

This capability boundary does not authorize Phase 1B or Phase 1C activation.
