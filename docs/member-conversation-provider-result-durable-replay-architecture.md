# Member conversation provider result and durable replay architecture

Status: architecture only. This document authorizes no code, schema, migration,
runtime wiring, provider access, credential or configuration use, deployment,
activation, or live-system access.

Base reviewed: `ugf-backend main@fea65e12690dc8729a17b7b6bf40e7e90adb6e58`.

## Decision

Select a bounded provider-authored coaching result and an additive, immutable
durable replay companion. Do not overload the existing deterministic safety
tuple and do not claim that Migration 018 can replay coaching by itself.

The future member response contract is
`GC-MEMBER-CONVERSATION-TURN-RESPONSE-2`. It is produced only from:

- an exact `GC-MEMBER-CONVERSATION-TURN-1` request;
- its matching deterministic `safe_to_process` response;
- a timely provider result privately bound to the exact request-envelope
  digest, dispatch attempt UUID, and current terminal-authority generation; and
- an exact immutable coaching replay row committed with the existing
  Migration 018 tuple and Migration 019 finalization transition.

Migration 018 and Migration 019 remain unchanged files and remain unapplied by
this design. A separately reviewed additive future migration is required before
the new response can be implemented or finalized. Until that migration and its
repository contract exist, provider-authored coaching cannot reach
`provider_succeeded`, replay, `finalized`, or a member response.

## Response contract

`GC-MEMBER-CONVERSATION-TURN-RESPONSE-2` has exact root keys only:

- `contractVersion`;
- `requestContractVersion`;
- `requestId`;
- `idempotencyKey`;
- `conversation`;
- `result`; and
- `coaching`.

`contractVersion` is exactly
`GC-MEMBER-CONVERSATION-TURN-RESPONSE-2` and `requestContractVersion` is
exactly `GC-MEMBER-CONVERSATION-TURN-1`. Request ID, idempotency key, and the
exact conversation reference/version/provenance are copied locally from the
strict parsed request, never requested from or accepted from the provider.

`result` retains the existing exact keys and meanings: `state`, `reason`, and
`safety`. The deterministic safety object is copied from the matching local
response. The provider cannot set, weaken, replace, or reinterpret it.

`coaching` is:

- exactly `null` for `blocked` and `unavailable`;
- a trimmed, non-empty Unicode NFC string only for `safe_to_process`;
- at most 800 Unicode code points and at most 1,600 UTF-8 bytes; and
- included in a canonical response whose serialized UTF-8 size is at most
  4,096 bytes.

Unknown keys, sparse arrays, alternate encodings, invalid Unicode, leading or
trailing whitespace, control characters other than ordinary line breaks, and
values outside either bound fail closed. Canonical hashing uses the strict
parser's fixed field order and SHA-256 of UTF-8 `JSON.stringify` bytes.

## Provider result contract

The future private contract is
`GC-MEMBER-CONVERSATION-PROVIDER-RESULT-1`. Its public value is an opaque frozen
token. Module-private `WeakMap` state contains only:

- the exact request-envelope digest;
- exact dispatch attempt UUID;
- exact terminal-authority generation and revocation capability;
- bounded provider-generated request and response identifiers;
- the strictly parsed coaching string; and
- the canonical provider-result digest.

The provider-visible schema contains exactly one field, `coaching`, with the
same character and byte bounds. It contains no request, member, session,
conversation, binding, idempotency, safety, database, credential, or attempt
identifier. The attempt UUID remains the sole client-supplied tracing
correlation identifier outside the model content. Provider-generated request
and response identifiers remain local operational provenance and are never
returned to members or written to ordinary logs.

Every parse, bind, finalize, and replay operation must validate the private
brand and consult the current revocation/generation state. A static object or
copied digest grants no authority. Cross-request, cross-conversation,
cross-envelope, cross-attempt, cross-generation, and lookalike results fail
before durable mutation.

## Safety precedence and content boundary

Deterministic safety runs before reservation and provider contact and remains
authoritative afterward. `blocked`, `unavailable`, ambiguous discomfort,
current sharp pain, instability, weakness, numbness, tingling, or concerning
symptoms never produce a provider request or coaching result.

Provider text is never permitted to alter the safety classification, claim a
human reviewed the turn, diagnose or treat a condition, guarantee an outcome,
override restrictions, instruct the member to work through concerning
symptoms, or introduce hidden identifiers, links, tool calls, retrieval,
attachments, media, transcripts, or history. A separately versioned,
deterministic output-policy validator must reject prohibited structure and
known prohibited content before rebinding. Semantic safety that cannot be
mechanically established is a stop condition for activation, not permission to
trust the model.

A malformed, oversized, unbound, prohibited, or otherwise invalid definite
provider response yields concealed unavailable behavior. It cannot be called
success and cannot create replay/finalized state. The later implementation
design must map this outcome to a terminal database state without expanding
Migration 019's accepted rejection categories by implication.

## Durable replay direction

Select an additive future migration, provisionally Migration 020, containing
one immutable companion table. The name is provisional; no migration is
authorized by this document.

One row represents one exact provider-authored coaching replay and contains
only:

- internal row ID;
- exact reservation ID, unique;
- exact Migration 018 idempotency-row ID, unique;
- exact idempotency key;
- exact conversation binding ID, reference, version, and provenance;
- exact request-signature SHA-256;
- response contract version;
- normalized coaching text;
- canonical full-response SHA-256;
- coaching-text SHA-256;
- created-at database timestamp; and
- no member text, prompt, transcript, health detail, credential, token, raw
  provider payload, request body, or logging copy.

The duplicated identity values are immutable constraint material, not a second
source of truth. The row uses two realizable composite foreign keys:

- `(reservation_id, idempotency_key, conversation_binding_id,
  conversation_reference, conversation_version, conversation_provenance,
  request_signature_sha256)` references Migration 019's existing reservation
  exact-identity unique key; and
- `(migration_018_row_id, idempotency_key, conversation_binding_id,
  conversation_reference, conversation_version, conversation_provenance,
  request_signature_sha256)` references a new additive unique key over those
  exact immutable columns on Migration 018.

The additive Migration 018 unique key changes neither existing rows nor their
meaning. Together the two foreign keys mechanically require the selected
reservation and selected replay row to describe the same exact turn. The
companion checks require the response contract version above, both lowercase
SHA-256 values, coaching bounds, NFC normalization, and a Migration 018
`safe_to_process` tuple. Update and delete are rejected. Existing rows are not
backfilled.

Provider request/response identifiers and attempt identity remain in the
append-only Migration 019 receipt event rather than being duplicated in the
coaching row. Under the same reservation advisory transaction lock, a database
trigger must load the exact composite-linked Migration 018 row, reconstruct the
complete canonical RESPONSE-2 value from its request/conversation/safety tuple
plus the companion coaching text, recompute the full-response digest, and
require that digest to equal both the companion digest and the exact latest
`provider_succeeded` receipt digest for that reservation's current dispatch
attempt. Merely comparing caller-supplied digest strings is invalid.

The future migration must add a database-enforced finalization guard: a
provider-originated `finalized` event is invalid unless the composite-linked
Migration 018 row and coaching companion already exist, reconstruct as a valid
RESPONSE-2, and cryptographically agree with the same reservation/attempt's
latest `provider_succeeded` receipt. This may be an additive constraint trigger
or a separately reviewed replacement of the transition function, but it must be
atomic and guarded by the same namespaced per-reservation advisory transaction
lock. Application ordering alone is insufficient.

## Atomic success and replay

A definite timely provider success uses one bounded database transaction:

1. acquire the exact reservation advisory transaction lock;
2. revalidate reservation, binding, exact attempt, and current
   `dispatch_started` authority;
3. strictly parse and locally rebind the private provider result;
4. construct and hash the canonical response contract;
5. append `provider_succeeded` with minimized provider identifiers and the
   canonical full-response digest;
6. insert the unchanged truthful Migration 018 `safe_to_process` tuple;
7. insert the exact immutable coaching replay companion; and
8. append `finalized`.

Any conflict, timeout, cancellation, constraint failure, or injected failure
rolls back all four durable writes. No transaction or lock spans provider I/O.
Unknown commit outcome is reconciled only by an exact read of the immutable
event, Migration 018, and coaching rows; it never permits provider redispatch.

An exact retry reads under a bounded read-only transaction, proves the complete
reservation identity, requires current state `finalized`, reconstructs the
strict Migration 018 tuple and coaching companion, recomputes both digests,
matches the immutable provider receipt, reparses the full response contract,
and returns only the frozen response. Missing, extra, mismatched, corrupt, or
legacy-only state returns concealed unavailable and never partial coaching.

Existing Migration 018-only finalized rows remain valid only for the current
`GC-MEMBER-CONVERSATION-TURN-1` response. They are never synthesized into
version 2 coaching responses. Compatibility is explicit by response version;
there is no backfill and no in-place mutation.

## Failure and authority rules

- Provider contact occurs only after committed `dispatch_started`.
- A committed `dispatch_started` remains a permanent automatic no-redispatch
  barrier, including invalid output and uncertain contact.
- Abort or response closure revokes provider-result, receipt, replay, and HTTP
  response authority and remains silent.
- Deadline revokes provider-result and receipt acceptance; concealed generic
  unavailable may be returned only while terminal response authority remains
  true and the response is writable.
- Late success or rejection cannot regain authority or create any durable row.
- Definite provider rejection remains terminal and creates no Migration 018 or
  coaching replay row.
- Indeterminate remains concealed and unrecoverable by automatic redispatch.
- No background worker, process-memory queue, held request, busy wait, or
  unbounded lock is required for correctness.

## Required adversarial acceptance tests

Future implementation and migration tests must prove:

- exact-key parsing, version compatibility, canonical field order, NFC,
  character, byte, and total-response bounds;
- deterministic safety precedence and `coaching:null` for blocked/unavailable;
- provider attempts to set identity or safety fields, unknown keys, tool calls,
  links, hidden metadata, malformed Unicode, and oversized output fail closed;
- mismatched envelope, request, conversation, attempt, terminal generation,
  provider identifiers, or response digest cannot write or replay;
- public token enumeration, inspection, `JSON.stringify`, error paths, and
  representative logger capture reveal no private state or member content;
- abort, deadline, closure, and generation changes revoke late results before
  parsing, database writes, or HTTP response;
- injected failure after each durable write rolls back receipt, Migration 018,
  companion replay, and finalized together;
- concurrent exact finalizers converge to one receipt, one Migration 018 row,
  one companion row, and one finalized event;
- swapped concurrent results and same-key/different-content conflicts fail;
- unknown commit recovery reconstructs the exact response without redispatch;
- a missing or altered companion, receipt, digest, or legacy row never produces
  partial coaching;
- guarded rollback refuses rows, later migrations, and checksum drift;
- zero backfill and unchanged legacy replay behavior; and
- production imports, provider/idempotency dependencies, allowlists, route,
  migrations, configuration, and deployment remain disabled until separately
  authorized.

All PostgreSQL tests must use disposable unprivileged PostgreSQL 16. No live or
shared database is an acceptance environment.

## Privacy and observability

The coaching text is member-visible content and therefore sensitive. Durable
storage is selected only because exact idempotent replay requires the exact
member-visible result. Access is restricted to the exact authenticated binding
and idempotency path. Ordinary logs and metrics contain only categorical
outcomes, contract versions, bounded timings, and counts; never coaching text,
member text, identifiers, digests usable for correlation, or provider IDs.

Retention, deletion, export, and support-access handling for coaching replay
must be explicitly reviewed before migration implementation. Immutability must
not be used to evade an approved privacy deletion workflow; any such workflow
requires a separate schema and governance design rather than ad hoc updates.

## Future gates

Separate owner approval and independent review are required for:

1. the exact response/result parsers and private capability implementation;
2. the additive replay migration and guarded rollback;
3. repository atomic-finalization and strict-replay changes;
4. deterministic output-policy rules;
5. the OpenAI adapter, exact model/prompt/schema/bounds allowlists, credential
   and regional-retention controls;
6. production composition and route wiring;
7. migration execution;
8. deployment; and
9. activation and real-member acceptance.

Until every applicable gate is accepted, production remains
`idempotency:null`, `provider:null`, and route absent/not-ready. No provider
contact, migration, deployment, configuration, or live access is authorized.
