# Member conversation provider orchestrator immediate-indeterminate policy

Status: architecture-policy addendum only. It is not approval to implement an orchestrator, contact a provider, change schema or migrations, wire runtime, configure credentials, deploy, or activate the route.

Base reviewed: `ugf-backend main@662a39b330c6eb107373ce76810820aef2e00566`.

Applies to the future versioned contract `GC-MEMBER-CONVERSATION-PROVIDER-ORCHESTRATOR-1`.

## Decision

Select the conservative immediate-indeterminate late-result policy.

Once the request's shared abort signal fires or its fixed outer deadline expires after a committed `dispatch_started` event:

1. signal cancellation to the provider transport and stop awaiting it;
2. permanently revoke that request's provider-result and receipt-acceptance authority;
3. ignore every later transport success or rejection for state-transition purposes;
4. never append `provider_succeeded` or `provider_rejected`, never insert a Migration 018 replay row, and never append `finalized` from that late result;
5. if the signal represents request abort or response closure, revoke HTTP response authority and remain silent; if only the ordinary deadline expired, return the existing concealed generic unavailable outcome only when terminal response authority remains true and the response is writable; and
6. append or reconcile durable `indeterminate` only when Migration 019's database-authoritative `reconciliation_not_before` threshold permits it.

Transport cancellation is best effort. It does not prove that the provider avoided or stopped work. A committed `dispatch_started` event therefore remains the permanent no-redispatch barrier even when the transport reports that local cancellation succeeded or that no response was received.

This policy intentionally prefers at-most-one automatic dispatch and possible permanent concealed indeterminate results over accepting a late result whose originating request no longer has terminal authority. It makes no exactly-once-success claim.

## Authority boundaries

The orchestrator owns the terminal decision. The transport may report a result only while the orchestrator still owns local acceptance authority.

- One fixed outer deadline is established before authorization, safety, reservation, lease, dispatch, and transport work. Inner operations may shorten it but may not extend it.
- The same `AbortSignal` and terminal-state object flow through all awaits.
- Abort or deadline transition provider-result and receipt-acceptance authority exactly once and detach all result handlers/listeners.
- Request abort or response closure also sets HTTP response authority false and requires silence. Ordinary deadline expiry does not itself revoke HTTP response authority; it may produce the concealed generic unavailable response only when the current terminal state still permits a response and the response is writable.
- A transport promise settling after provider-result authority is revoked has no database, workout-state, logging, retry, provider-dispatch, or independent HTTP-response authority. It cannot restore HTTP authority lost to abort or response closure.
- Process-local timers do not authorize a Migration 019 transition. Database time and the stored reconciliation threshold remain authoritative.
- No PostgreSQL transaction, advisory lock, row lock, or request handler is held open while waiting for a provider or for the reconciliation threshold.
- No background task may be required for correctness. A later bounded request or separately authorized worker may attempt the threshold-gated indeterminate transition.

## State behavior

Every member-visible result below is subordinate to the current request's HTTP authority: an aborted or closed response is always silent, and generic unavailable may be written only when terminal response authority remains true and the response is writable.

| Observed point | Durable state | Allowed action | Forbidden action | Member-visible result |
| --- | --- | --- | --- | --- |
| Abort or response closure before `dispatch_started` commits | `reserved` or `lease_acquired` | Cancel local work; allow only existing pre-dispatch lease-expiry recovery | Provider contact, `dispatch_started`, or an HTTP write after response authority is lost | Silent |
| Deadline before `dispatch_started` commits | `reserved` or `lease_acquired` | Cancel local work; allow only existing pre-dispatch lease-expiry recovery | Provider contact or `dispatch_started` after terminal authority is lost | Generic unavailable only if response authority remains true and the response is writable; otherwise silent |
| Abort or response closure while `dispatch_started` commit outcome is unknown | Unknown until read-only reconciliation | Cancel transport initiation; reconcile exact durable state | Infer rollback or dispatch based on the local error; write an HTTP response | Silent |
| Deadline while `dispatch_started` commit outcome is unknown | Unknown until read-only reconciliation | Cancel transport initiation; reconcile exact durable state | Infer rollback or dispatch based on the local error | Generic unavailable only if response authority remains true and the response is writable; otherwise silent |
| Abort or response closure after committed `dispatch_started`, before transport settles | `dispatch_started` | Signal transport cancellation; revoke result/receipt acceptance; later mark indeterminate only after the stored threshold | Redispatch; accept any later success/rejection; finalize; write an HTTP response | Silent |
| Deadline after committed `dispatch_started`, before transport settles | `dispatch_started` | Signal transport cancellation; revoke result/receipt acceptance; later mark indeterminate only after the stored threshold | Redispatch; accept any later success/rejection; finalize | Generic unavailable only if response authority remains true and the response is writable; otherwise silent |
| Transport settles successfully after result authority is revoked | `dispatch_started` | Discard the late result; threshold-gated indeterminate reconciliation | `provider_succeeded`, Migration 018 insert, `finalized`, member success, or restored HTTP authority | Silent after abort/closure; after deadline, generic unavailable only if response authority remains true and the response is writable |
| Transport rejects after result authority is revoked | `dispatch_started` | Discard the late rejection; threshold-gated indeterminate reconciliation | `provider_rejected`, redispatch, treating cancellation as proof of no provider effect, or restored HTTP authority | Silent after abort/closure; after deadline, generic unavailable only if response authority remains true and the response is writable |
| Threshold has not elapsed | `dispatch_started` | Return unavailable and release resources | Early `indeterminate` insert or busy-waiting until the threshold | Generic unavailable |
| Threshold has elapsed and exact attempt remains current | `dispatch_started` | Append one Migration 019 `indeterminate` event through the reviewed repository primitive | Provider contact, replay creation, or finalization | Generic unavailable |
| Concurrent reconciliation loses to a terminal event | `indeterminate`, `provider_rejected`, or `finalized` | Read and honor the exact durable winner | Overwrite, append a conflicting terminal event, or regain old request authority | Strict replay only for an exact final Migration 018 row; otherwise unavailable |

## Late-result suppression

Late-result suppression must be mechanical rather than a metadata convention:

- capture the exact dispatch attempt and terminal generation before invoking transport;
- after every await, verify the signal, outer deadline, terminal generation, reservation identity, and attempt are still authoritative before using a result;
- race transport settlement against the shared terminal transition without leaving an unhandled rejection;
- attach cleanup that only observes/discards a late settlement and cannot call rejection, indeterminate, or finalization repositories;
- clear timers and remove abort listeners on every terminal path;
- never place raw or minimized provider output in an error, ordinary log, metric label, trace attribute, or member response after authority is revoked.

The request may not regain authority if a provider response arrives before the Migration 019 reconciliation threshold. The threshold controls when durable `indeterminate` may be appended; it is not a grace period for accepting late provider results.

## Retry and recovery

- Before `dispatch_started`, existing bounded lease-expiry recovery remains eligible only after fresh authorization and safety checks.
- After any committed `dispatch_started`, neither the original request nor an exact retry may dispatch again.
- An exact retry encountering unresolved `dispatch_started` returns generic unavailable and may attempt `indeterminate` only after the database threshold.
- An exact retry encountering `indeterminate` returns generic unavailable permanently under this contract version.
- A new idempotency key must not be generated or suggested automatically to bypass unresolved or indeterminate work.
- A future provider reconciliation mechanism may change this behavior only through a separately versioned, reviewed, and owner-authorized policy. Manual support lookup is not automated reconciliation authority.

## Privacy and observability

Persist and emit only the minimized provenance already allowed by the reviewed Migration 018/019 contracts. Do not store or log member text, prompts, transcripts, raw provider payloads, generated content, tokens, credentials, health details, names, or email addresses.

Operational signals for this policy must be categorical and content-free, for example terminal category, contract version, and whether the threshold-gated transition succeeded. Provider request/response identifiers remain sensitive operational provenance and must not appear in member responses or ordinary logs.

## Required adversarial acceptance tests

A future implementation must use only a deterministic test transport and disposable unprivileged PostgreSQL 16 to prove:

- abort or response closure before dispatch prevents provider contact and `dispatch_started`, revokes HTTP response authority, and produces no HTTP write;
- deadline before dispatch prevents provider contact and `dispatch_started`, returning generic unavailable only while response authority remains true and the response is writable;
- abort or response closure immediately after committed `dispatch_started` signals transport cancellation, revokes result/receipt and HTTP response authority, and remains silent;
- deadline immediately after committed `dispatch_started` signals transport cancellation and revokes result/receipt acceptance, but may return generic unavailable only while response authority remains true and the response is writable;
- late success is ignored and cannot create `provider_succeeded`, a Migration 018 row, or `finalized`;
- late definite rejection is ignored and cannot create `provider_rejected`;
- transport cancellation acknowledgement does not permit redispatch;
- `indeterminate` is rejected before `reconciliation_not_before` and succeeds at most once afterward using database time;
- concurrent exact retries and reconcilers produce one durable terminal state and no second dispatch;
- uncertain `dispatch_started` and uncertain `indeterminate` commits are reconciled read-only without inferring rollback;
- abort/deadline listeners, timers, and late promises are cleaned up with no unhandled rejection or late authority;
- exact key, request-signature, binding, session, mapping, conversation, consent, membership, and safety conflicts remain concealed and fail closed;
- production imports remain absent, production idempotency/provider dependencies remain null, and the route remains absent/not-ready;
- privacy scans find no content-bearing persistence, logs, fixtures, or artifacts.

No acceptance test may contact OpenAI or another live provider.

## Preserved gates

This policy selection does not authorize:

- implementation of `GC-MEMBER-CONVERSATION-PROVIDER-ORCHESTRATOR-1`;
- a concrete provider adapter, SDK, network request, model choice, or credential;
- changes to Migration 018, Migration 019, schemas, or rollback behavior;
- production imports, server/startup composition, route mounting, or feature activation;
- migration execution, configuration, deployment, Railway changes, or live/member/provider access.

Each remains a separate owner and independent-review gate. Until those gates are satisfied, production stays null/unwired and the conversation-turn route stays absent/not-ready.
