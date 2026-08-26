# Provider result V2 authority architecture

## Scope

This document defines the private result boundary required by
`GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2`. It does not modify or reinterpret
V1. It authorizes no HTTP implementation, credential or provider access,
production wiring, migration, configuration, deployment, activation, or live
action.

Two distinct opaque contracts are required:

- `GC-MEMBER-CONVERSATION-PROVIDER-RESULT-AUTHORITY-2` and its success token;
- `GC-MEMBER-CONVERSATION-PROVIDER-REJECTION-2`, a one-read rejection token.

Both are module-private capabilities. Public tokens have null prototypes, are
frozen, contain no enumerable fields, serialize to no sensitive value, and
cannot be recreated from structural data.

## Shared authority binding

The authority factory accepts exactly a genuine branded
`GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2` and genuine bounded-transaction
terminal state. Proxy, accessor, symbol, unknown-key, structural-lookalike,
terminal, or malformed input fails closed without observation.

Private state captures only:

- canonical `PROVIDER-REQUEST-2` digest;
- exact attempt UUID;
- terminal-state identity;
- positive private generation;
- contacted, consumed, and revoked flags; and
- the minimum bounded result state needed for one-read enforcement.

Authority validation and every operation freshly require the exact private
token, matching request digest and attempt, unchanged positive generation,
`revoked:false`, and `terminalState.isTerminal() === false`. Revocation is
idempotent, increments generation, invalidates every child token, and clears
private references that are no longer required.

Contact state is owned only by this module. Immediately before the injected HTTP
invocation, the caller must synchronously call the exported narrow operation
`markMemberConversationProviderResultAuthorityV2Contacted(authority)`. It
accepts only the genuine active exact-generation authority, atomically changes
`contacted:false` to `contacted:true`, and returns true once. Repeated,
concurrent, forged, proxied, revoked, terminal, or generation-drifted calls
return false without revealing private state or mutating another authority.
The HTTP invocation may occur only when this transition returns true, in the
same synchronous callback with no intervening promise or user callback.

One authority may authorize at most one terminal provider outcome. Success and
rejection require `contacted:true` and compete for the same synchronous private
consumed transition before any promise or callback boundary. Concurrent or
repeated creation cannot mint two outcomes. After the contact transition, any
malformed, unknown, or failed outcome attempt permanently consumes and revokes
the authority. Before contact, structural validation is zero-observation and
non-consuming; success/rejection creation returns null and cannot be used as
proof of contact. No caller-supplied boolean or structural contact evidence is
accepted.

## Success token

Success creation accepts the genuine authority as a separate positional
capability and an untrusted exact-key payload containing:

- coaching;
- provider request ID;
- provider response ID; and
- version `GC-MEMBER-CONVERSATION-PROVIDER-RESULT-2`.

Coaching uses the existing RESPONSE-2 rules exactly: primitive string, nonempty,
boundary-trimmed, NFC, no unpaired surrogate, maximum 800 Unicode characters,
maximum 1600 UTF-8 bytes, and no prohibited C0/DEL controls while permitting
interior LF. Provider identifiers are primitive printable ASCII, 1-255 bytes.

The private success record stores canonical `{coaching}` and its SHA-256 plus
the bounded provider identifiers, request digest, attempt, terminal-state
identity, and captured generation. The public token exposes none of them.

Reading requires the exact success token and authority and is one-read. It
atomically consumes the token before returning a frozen exact-key value:

`{attemptId, coaching, providerRequestId, providerResponseId,
providerResultDigestSha256, requestEnvelopeDigestSha256, version}`.

The version is exactly `GC-MEMBER-CONVERSATION-PROVIDER-RESULT-2`. A second
read, cross-authority read, cross-request read, generation drift, revocation,
terminal transition, or V1 reader returns null without mutating another token.

## Rejection token

Rejection creation likewise accepts the genuine authority as a separate
positional capability and an untrusted exact-key payload containing:

- provider request ID;
- terminal category; and
- version `GC-MEMBER-CONVERSATION-PROVIDER-REJECTION-2`.

Terminal category is exactly one of `authentication_rejected`, `rate_limited`,
or `request_rejected`. No provider body, message, status text, headers, account
identity, request body, member content, or credential metadata is retained.

The private rejection record binds the same request digest, attempt,
terminal-state identity, and generation. Reading is one-read and atomically
returns only the frozen exact-key value
`{attemptId, providerRequestId, requestEnvelopeDigestSha256,
terminalCategory, version}`. All late, repeated, cross-authority, cross-version,
revoked, or terminal reads return null.

Separating authority from payload is mandatory: the module can synchronously
consume/revoke a genuine contacted authority even when the untrusted payload is
a proxy, accessor object, or otherwise impossible to inspect safely. No payload
field may select, substitute, or reveal an authority.

## Safety, privacy, and compatibility

Neither token changes deterministic member safety or creates durable authority.
The future orchestrator must revalidate the exact request/digest/attempt and
shared operation state before converting either token into repository input.
Durable success remains governed by the existing M018/M019/M020 atomic replay
and finalization constraints. Rejection remains bounded provenance only.

V1 factories, validators, readers, and versions remain byte-for-byte unchanged.
V1 must reject V2 authorities/tokens; V2 must reject every V1 authority/token.
No fallback, coercion, version alias, or structural bridge is permitted.

Tokens, private state, digests, UUIDs, provider identifiers, coaching, and
terminal reasons must not be logged or serialized. Production startup and
disabled composition do not import this module. Server/package configuration,
Migrations 018/019/020, Railway, and the member route remain unchanged.

## Deterministic offline acceptance

Focused tests must prove:

- genuine REQUEST-2 and terminal-state brand binding;
- proxy/accessor/lookalike rejection with zero observation;
- exact digest, attempt, generation, and terminal checks on every operation;
- synchronous single-outcome competition under success/rejection concurrency;
- exact synchronous contact marking, including concurrent/double marking,
  forged/proxied marks, malformed post-contact revocation, and pre-contact
  validation proving no authority mutation;
- exact coaching and provider-ID bounds, including NFC, surrogate, control,
  multiline, character, and UTF-8-byte adversaries;
- opaque frozen tokens and privacy-safe serialization;
- success and rejection one-read behavior and revocation cleanup;
- cross-request, cross-attempt, cross-authority, cross-generation, and
  cross-version rejection without foreign mutation;
- terminal/abort/deadline-driven revocation and late-result suppression; and
- production/test-helper isolation with V1 unchanged.

Acceptance requires supported Node 20 focused tests, repository checks, and a
clean unprivileged disposable-PostgreSQL full suite with zero failures or skips.
Implementation, publication, HTTP composition, runtime wiring, provider access,
configuration, migration, deployment, and activation remain separate gates.
