# Member conversation provider idempotency architecture

Status: architecture-only proposal; not approved for implementation, migration, wiring, activation, deployment, or provider access.

Base reviewed: `ugf-backend main@e03d11384e0af4e8eb6202210917519bde7190cd`.

## Decision

Do not make the rejected final-row repository satisfy the current turn idempotency dependency. Migration 018 and a transaction-scoped advisory lock can serialize live callers and replay a committed final result, but they cannot make an external provider call atomic with the later PostgreSQL insert.

Adopt a two-stage design only after separate schema and implementation review:

1. Preserve Migration 018 as the immutable, final replay record.
2. Add a separate durable reservation and append-only dispatch-event state machine.
3. Permit at most one automatic provider dispatch for an exact key, request signature, and conversation binding.
4. If provider contact may have occurred but no final receipt was committed, enter a concealed `indeterminate` state and never dispatch automatically again.
5. Return a generic unavailable response for reserved, leased, or indeterminate work; never claim completion, human review, or provider acceptance without a committed final receipt.

This provides crash-safe duplicate prevention by sacrificing automatic recovery after uncertain provider contact. It does **not** promise exactly-once successful provider completion. That stronger property remains impossible across PostgreSQL and an external provider unless the provider supplies a separately reviewed, durable idempotency and reconciliation contract.

The current route contract is intentionally not a live-provider contract: `validProvider` requires `externalCallsPermitted === false`, production supplies `provider:null` and `idempotency:null`, and the route is absent/not-ready. A future external provider adapter must use a new, separately versioned interface and must not be smuggled through the current provider validator. The rejected opaque-operation repository must not be accepted by `validMemberConversationTurnIdempotency`.

## Why provider-enforced idempotency is not selected now

The current official OpenAI API reference documents a client-supplied `X-Client-Request-Id` for tracing and support lookup, not as a deduplication or replay key. The Responses create reference documents response IDs and optional storage, but it does not establish an exact-key/same-payload replay guarantee or programmatic lookup by client request ID.

- OpenAI API request IDs: <https://developers.openai.com/api/reference/overview#debugging-requests>
- Responses create reference: <https://developers.openai.com/api/reference/resources/responses/methods/create>

Therefore `X-Client-Request-Id`, response storage, prompt caching, and an application UUID must not be treated as provider idempotency. Provider-enforced idempotency becomes eligible only if current official provider documentation or a signed provider contract guarantees all of the following:

- exact key scope and retention duration;
- atomic same-key/same-payload replay without a second billable/effectful execution;
- same-key/different-payload conflict rejection;
- programmatic reconciliation by the exact key after timeout or connection loss;
- a durable receipt containing an immutable provider operation identifier and terminal status;
- behavior across provider regions, retries, SDK versions, and service restarts;
- privacy and retention compatibility with Goals Coach.

## Safety properties

The future implementation must mechanically preserve these properties:

- deterministic safety classification runs before provider reservation or dispatch;
- blocked and unavailable safety results never contact a provider;
- current membership, accepted consent, safety eligibility, and exact conversation ownership are revalidated before reservation and again immediately before dispatch;
- an idempotency key is permanently bound to one request signature and one exact conversation binding;
- no opaque callback accepted by the idempotency component can contact a provider;
- only a dedicated dispatcher may contact the provider, and only after a committed `dispatch_started` event;
- no process may automatically dispatch when a `dispatch_started` event already exists;
- provider output is strictly parsed and rebound to the exact request before a final replay row is committed;
- cancellation or deadline revokes HTTP response authority but never authorizes a second provider dispatch;
- unknown, cross-member, stale, conflicted, and indeterminate states remain concealed;
- provider payloads, prompts, member text, transcripts, tokens, credentials, names, emails, and health details are not stored in reservation or event rows.

## Proposed durable model

The names below are design placeholders, not approved schema.

### Immutable reservation

`goals_coach_member_conversation_turn_reservations`

- internal numeric ID;
- exact UUID idempotency key, globally unique;
- exact Migration 017 conversation binding composite identity;
- exact request signature SHA-256;
- immutable turn contract, safety rule, and source-rule versions;
- created timestamp;
- no request text or provider payload.

The reservation rejects same-key/different-signature or same-key/different-binding attempts before any dispatch work. It is never updated or deleted.

### Append-only events

`goals_coach_member_conversation_turn_dispatch_events`

Each event is append-only and bound to the reservation. Event sequence is database-assigned and unique per reservation. Allowed transitions are enforced from the current locked event history:

- `reserved`: reservation exists; no worker owns it;
- `lease_acquired`: one bounded worker owns pre-dispatch preparation;
- `dispatch_started`: committed immediately before the provider transport is invoked;
- `provider_succeeded`: exact minimized receipt and validated response digest are available;
- `provider_rejected`: provider returned a definite terminal rejection; this is terminal, has no Migration 018 row, and can never transition to `finalized` under the unchanged response contract;
- `indeterminate`: provider contact may have occurred but cannot be reconciled;
- `finalized`: a truthfully representable Migration 018 final replay row was committed. After provider dispatch, this transition is permitted only with a validated `provider_succeeded` receipt whose result maps exactly to Migration 018's `safe_to_process` tuple. Deterministic pre-provider `blocked` and `unavailable` tuples may also finalize without a provider receipt.

Minimized event data may include only:

- random lease/attempt UUID;
- bounded lease deadline;
- event type and timestamp;
- provider contract version;
- `X-Client-Request-Id` value generated from the attempt UUID;
- after a definite response only, bounded opaque provider response/request identifiers and a response digest;
- minimized terminal category.

Opaque provider identifiers must be treated as sensitive operational provenance: never logged to ordinary application logs or returned over the member HTTP contract.

### Lease rules

- A lease is acquired under a row lock with an exact bounded expiry.
- A lease may be reclaimed after expiry only while no `dispatch_started` event exists.
- The dispatcher commits `dispatch_started` before opening provider transport.
- After `dispatch_started`, lease expiry never permits automatic redispatch.
- A sweeper or subsequent request may append `indeterminate` after the bounded reconciliation window, but may not contact the provider.
- Clock decisions use database time and exact bounded intervals; process-local wall clocks are not authoritative.

## Request flow

1. Authenticate the durable member session and map the exact member.
2. Revalidate current Gatekeeper membership, consent, safety eligibility, and exact conversation ownership under the shared deadline.
3. Strictly parse the request and compute the canonical request signature.
4. Run deterministic safety classification.
5. For `blocked` or deterministic `unavailable`, atomically create/reuse the exact reservation and write the final Migration 018 replay row without provider dispatch.
6. For `safe_to_process`, atomically create/reuse the reservation.
7. If a final Migration 018 row exists, strictly parse and replay it. If a terminal `provider_rejected` event exists without a final row, return generic unavailable and never dispatch again.
8. If an exact reservation conflicts, reject before dispatch.
9. If `dispatch_started`, `provider_rejected`, or `indeterminate` exists without a final row, return generic unavailable and never redispatch; append `indeterminate` only from unresolved `dispatch_started` through the bounded recovery rule.
10. Otherwise acquire a pre-dispatch lease, revalidate all current authorization prerequisites, and commit `dispatch_started` with a random attempt UUID.
11. Invoke the provider once using the dedicated dispatcher. Supply the attempt UUID as `X-Client-Request-Id` for tracing only, never as an assumed idempotency guarantee.
12. Strictly validate and minimize a definite provider response without changing its meaning or the deterministic safety provenance.
13. For definite provider success, in one database transaction lock the reservation, revalidate the exact attempt and binding, append `provider_succeeded`, insert the exact truthfully representable Migration 018 `safe_to_process` row, and append `finalized`.
14. For definite provider rejection, append only the terminal minimized `provider_rejected` event. Do not insert Migration 018, do not append `finalized`, return generic unavailable, and make every exact retry return generic unavailable without provider contact. Only a future separately reviewed response-contract/schema version may represent and replay a provider rejection.
15. Return a successful response only if the request still owns response authority and the Migration 018 final row committed. Otherwise retain any committed final replay for a later exact retry.

The HTTP path must not hold a PostgreSQL transaction or row lock open during network I/O. Durable state, not a live database lock, controls dispatch authority.

## Failure and recovery matrix

| Failure point | Durable evidence | Automatic action | Member-visible result |
| --- | --- | --- | --- |
| Before reservation commit | None | Exact retry may reserve | Generic unavailable for failed request |
| Reservation committed, before lease | `reserved` | Exact retry/worker may lease | Generic unavailable until completed |
| Lease committed, before `dispatch_started` | `lease_acquired` | Reclaim only after lease expiry and prerequisite revalidation | Generic unavailable |
| `dispatch_started` commit is uncertain | Unknown until DB reconciliation | Do not call provider; read exact state after DB returns | Generic unavailable |
| `dispatch_started` committed, crash before network call | `dispatch_started` | Never redispatch; become `indeterminate` after window | Generic unavailable |
| Connection fails or times out during provider call | `dispatch_started`; receipt unknown | Never redispatch; reconcile only through a provider contract, otherwise `indeterminate` | Generic unavailable |
| Provider succeeds, process crashes before receipt transaction | `dispatch_started`; provider may have acted | Never redispatch; `indeterminate` absent provider reconciliation | Generic unavailable |
| Provider gives definite rejection | `provider_rejected` only; no Migration 018 row | Record the terminal minimized event; never finalize or redispatch under the unchanged contract | Generic unavailable on the original request and every exact retry |
| Provider-success receipt/final commit outcome is uncertain | Possibly `provider_succeeded`, `finalized`, and a Migration 018 row | Read exact reservation/events/final row; replay only if the strict final row exists; otherwise no redispatch | Replay or generic unavailable |
| Provider-rejection event commit outcome is uncertain | `provider_rejected` may exist; otherwise `dispatch_started` remains | Reconcile exact events; never insert Migration 018 and never redispatch in either case | Generic unavailable |
| Final commit succeeds, HTTP response is lost | `finalized` plus Migration 018 row | Exact retry replays | Exact stored response |
| Concurrent same key/same signature/binding | One reservation/event stream | One lease and at most one `dispatch_started`; others wait boundedly or return unavailable | Replay or generic unavailable |
| Same key with different signature/binding | Conflicting immutable identity | Reject before lease/provider | Concealed conflict/generic unavailable |
| Membership/mapping/session/consent/safety becomes stale before dispatch | No `dispatch_started` | Release/expire lease; no provider call | Concealed or generic unavailable |
| State becomes stale after provider dispatch | `dispatch_started` | No redispatch and no workout mutation; finalize only a validated provider success that remains truthfully representable under the exact approved contract | Generic unavailable or strict replay |

## Uncertain commit rules

- Never infer rollback from a timeout, dropped connection, or client release.
- Destroy clients with uncertain transaction outcomes using the repository's bounded transaction helper.
- Reconnect read-only and reconcile by exact reservation ID and idempotency key.
- A strict Migration 018 row with matching signature, binding, contract, and safety provenance is the only replay authority.
- `dispatch_started` without that final row is not permission to repeat the provider call.
- Missing data while the database is unavailable is not proof that the transaction failed.

## Concurrency rules

- PostgreSQL unique constraints own reservation identity.
- Transactional row locks serialize event transitions, but no lock spans provider I/O.
- Every transition verifies the latest sequence and lease/attempt UUID.
- A stale worker cannot append a receipt after another terminal transition.
- A late provider response may be recorded only when its exact `dispatch_started` attempt remains authoritative and no indeterminate/final transition superseded it.
- After `indeterminate`, late provider results are ignored unless a separately reviewed reconciliation flow proves the exact provider receipt and authorizes a deterministic transition. No member response authority is regained.

## Retry policy

- Before `dispatch_started`: bounded automatic recovery is allowed after lease expiry.
- After `dispatch_started`: no automatic provider retry under the current provider contract.
- Completed exact requests replay Migration 018 only when its tuple truthfully represents the terminal result.
- Exact requests with `provider_rejected` and no Migration 018 row always return generic unavailable and never redispatch. Rejection cannot become replayable unless a future separately reviewed response-contract/schema version explicitly represents it.
- Conflicts never retry.
- Indeterminate requests remain unavailable; they require a future provider-reconciliation design or a new member request with a new idempotency key and an explicitly reviewed product policy. A new key must not be silently generated by the server to bypass an indeterminate prior attempt.

## Privacy and minimization

The reservation/event foundation stores no member text, transcript, prompt, generated content, raw provider response, token, credential, cookie, name, email, health response, or provider payload. The request signature binds content without retaining it. Final replay remains limited to Migration 018's strict response tuple. Operational identifiers are bounded, access-controlled, and excluded from member responses and ordinary logs.

## Required adversarial validation for a future implementation

- real PostgreSQL 16 concurrent reservations across separate processes;
- same-key/same-input convergence and every signature/binding conflict;
- lease expiry before dispatch and prohibition on reclaim after dispatch;
- crash simulation at every row in the failure matrix;
- uncertain `BEGIN`, event insert, receipt insert, final insert, and `COMMIT` outcomes;
- provider timeout, connection reset, definite rejection, malformed response, and late response;
- definite provider success atomically creates `provider_succeeded`, the exact Migration 018 row, and `finalized`;
- definite provider rejection creates only one terminal `provider_rejected` event, creates no Migration 018 row, cannot transition to `finalized`, returns generic unavailable on every exact retry, and never invokes the provider twice;
- uncertain `provider_rejected` event commit reconciles to either the terminal rejection event or unresolved `dispatch_started`, with no Migration 018 insert and no redispatch in either case;
- no second provider invocation after any committed `dispatch_started` event;
- exact strict replay only after a committed Migration 018 row;
- abort/deadline listener cleanup and suppression of late HTTP authority;
- current authorization becoming stale before and after dispatch;
- no provider call for blocked, ambiguous, or unavailable safety states;
- production import isolation and disabled/not-ready route until every separately reviewed dependency is present;
- privacy scans proving no request/provider/member content is persisted or logged.

Tests must use a deterministic test-only provider transport and disposable unprivileged PostgreSQL 16. No test may contact OpenAI or another live provider.

## Gates and unresolved decisions

Before implementation, Derek and independent review must separately approve:

1. Whether at-most-one automatic dispatch with possible permanent indeterminate results is acceptable product behavior.
2. A Migration 019 schema and guarded rollback for reservations/events; Migration 018 remains unchanged.
3. Exact retention and operational handling for indeterminate records.
4. Whether provider request/response identifiers may be stored as minimized operational provenance.
5. The provider adapter contract, including exact model/version, structured response schema, bounded timeouts, data controls, and explicit prohibition on assuming `X-Client-Request-Id` is idempotency.
6. A future provider-reconciliation flow, if desired; it must not rely on manual support lookup as an automated correctness mechanism.
7. Separate runtime composition, environment, deployment, migration, feature activation, and live-provider test gates.

Until those gates are approved, keep idempotency and provider dependencies null, the route absent/not-ready, Migration 018 unapplied outside authorized migration work, and the rejected opaque-operation service unpublished.
