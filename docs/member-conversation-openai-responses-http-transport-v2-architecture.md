# OpenAI Responses HTTP transport V2 architecture

## Status and scope

This document specifies the next offline, disabled-by-default composition
boundary after `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-2`.
It does not authorize or implement production startup wiring, credential
resolution, provider contact, configuration, migration, deployment,
activation, or live/member access.

The future implementation may compose only genuine, privately branded
instances of:

- `GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2`;
- `GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-2`;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ADAPTER-2`;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-2`;
- `GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-RESOLVER-1`; and
- `GC-MEMBER-CONVERSATION-OPENAI-BOUNDED-HTTP-CLIENT-1`.

V1 contracts remain immutable and cannot cross this boundary.

## Proposed contract

The new private contract identity is
`GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-HTTP-TRANSPORT-2`.
Its factory accepts one exact-key frozen input containing the genuine V2
request, adapter, and provider transport, plus the genuine credential resolver
and bounded HTTP client and the approved non-secret origin and region policy.
Structural lookalikes, proxies, accessors, symbols, unknown keys, and version
drift fail closed without invoking getters or external dependencies.

Construction performs no I/O. It validates and privately captures:

- the canonical V2 request digest;
- attempt UUID, model, response-schema identity, and region policy;
- cache policy version, mode, and zero breakpoint count;
- the exact bounded HTTP-client origin; and
- every versioned adapter and transport identity.

The returned object is frozen, privately branded, `runtimeWired:false`, and
exposes no credential, header, request body, member turn, or mutable state.

## One-call execution

Dispatch accepts only the exact genuine request and a shared operation context
containing an active `AbortSignal`, monotonic `outerDeadlineNs`, and the genuine
terminal state created by the existing bounded-transaction terminal-state
factory. Structural terminal-state lookalikes fail before any authority or
asynchronous boundary. Before that boundary, dispatch validates the complete
request digest and captured identity and synchronously consumes a private
per-request execution brand. Sequential or concurrent reuse cannot create a
credential authority, resolve credentials, or contact HTTP.

The execution brand is internal to this boundary and is not credential
authority. After consuming it, the implementation creates the existing genuine
`GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-AUTHORITY-1` from exactly the captured
request attempt UUID and the shared genuine terminal state. The credential
authority's private generation and attempt binding must remain current and
exact through resolution. Dispatch passes the resolver exactly
`{authority, outerDeadlineNs, signal}` and never substitutes a structural
lookalike or a boundary-local token.

Immediately before credential resolution, wire creation, and HTTP invocation,
the implementation rechecks the shared signal, monotonic deadline, execution
brand, credential-authority attempt and generation, request digest, and genuine
terminal state. A cancellation that
wins before the injected HTTP invocation is provably `not_contacted`. Once the
invocation begins, timeout, abort, reset, partial response, malformed response,
and unknown settlement are conservatively `indeterminate`.

Credential resolution receives only the genuine credential authority and
shared deadline/signal described above. The credential lease is one-read,
exact-attempt bound, never logged or serialized, and the credential authority
is revoked in `finally` on every path. That revocation aborts its active
resolution, invalidates its generation and leases, and prevents a late result
from regaining execution authority. The adapter-produced wire
request is the sole body authority. The HTTP boundary remains exact HTTPS
`POST /v1/responses`, TLS verified, zero redirects, one maximum attempt, and
automatic retries disabled.

## Response and rejection handling

Only a complete, bounded `application/json` response may be parsed. Success
requires status 200, fatal UTF-8 decoding, one completed Responses object, one
completed assistant `output_text` item, no annotations, and the exact bounded
structured coaching shape. Provider request and response identifiers must pass
the existing bounded ASCII contract before entering private result provenance.

Complete attributable 401/403, 429, and the existing explicit nonretryable
400/404/405/413/415/422 allowlist preserve only the bounded provider request ID
and map respectively to `authentication_rejected`, `rate_limited`, and
`request_rejected`. Provider error bodies are never parsed or exposed.
408/409/425, 5xx, partial or oversized bodies, invalid content type, malformed
JSON, abort, deadline, and unknown results remain `indeterminate`. No outcome
authorizes retry or redispatch.

The existing `GC-MEMBER-CONVERSATION-PROVIDER-RESULT-1` authority is bound to
`GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-1` and must not be reused or
reinterpreted for V2. Consequently this HTTP-transport implementation remains
blocked from emitting a success result until a separately reviewed, privately
branded V2 provider-result authority is defined and implemented with exact
`PROVIDER-REQUEST-2` digest, attempt, terminal-state, and generation binding.
No V1 fallback or structural adapter is permitted.

Likewise, a V2 rejection outcome must use a separately reviewed private
one-read contract before it may cross into a future V2 orchestrator. Until
those contracts exist, an offline HTTP executor may parse bounded synthetic
responses only inside tests and must discard them without exposing a dispatch
success or rejection authority. Fresh shared signal/deadline/authority checks
remain required immediately before any future result is returned. Late results
are consumed and discarded.

## Cleanup and privacy

Every terminal path clears timers, removes listeners, revokes credential and
result authorities, and releases response buffers. Logging and serialization
must exclude credentials, headers, bodies, member text, provider error bodies,
request digests, UUIDs, and provider identifiers. Only bounded static outcome
enums and aggregate metrics may cross failure handling.

The deterministic HTTP interface and credential resolver remain test-only.
Production startup, server composition, package configuration, Migrations 018,
019, and 020, Railway settings, and the member route remain unchanged and
null/unwired.

## Offline acceptance tests

Focused tests must prove:

- genuine-brand and complete version/digest/cache/origin/region binding;
- proxy/accessor/lookalike rejection with zero observation;
- exact minimized wire bytes and zero explicit cache breakpoints;
- synchronous one-use behavior under sequential and concurrent dispatch, with
  a genuine terminal state and exact separation of execution and credential
  authorities;
- queued pre-contact abort, revocation, terminal, and deadline races produce
  zero resolver/HTTP calls and `not_contacted`;
- post-contact cancellation, malformed/oversized/partial responses, ambiguous
  status, and late settlement are `indeterminate` with cleanup;
- no V1 result authority accepts V2, and success/rejection remain unavailable
  until separately versioned V2 result contracts are reviewed;
- credential/header/body/provider payload privacy scans remain clean;
- V1 cannot enter V2 and V2 cannot enter V1; and
- production imports remain absent and disabled composition remains exact.

Acceptance additionally requires supported Node 20 focused tests, repository
checks, and one clean unprivileged disposable-PostgreSQL full suite with zero
failures or skips. Implementation, publication, runtime wiring, provider access,
configuration, deployment, and activation remain separate approval gates.
