# OpenAI client and disabled production-composition architecture

## Status and authority

This document is architecture only. It defines a future concrete HTTP client,
credential-at-call-time boundary, and disabled production-composition boundary
for Goals Coach member conversation. It does not authorize code, credentials,
configuration, provider contact, migration execution, runtime wiring,
deployment, activation, or live access.

Production remains exactly as merged: member-conversation startup receives
`idempotency:null` and `provider:null`, and the provider-backed route remains
absent or `not_ready`. Credentials, configuration presence, imported modules,
and successful tests must never change that state implicitly.

## Existing contracts remain authoritative

This design composes, but does not weaken or replace, the merged boundaries:

- `GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-1` is the only approved minimized
  provider request envelope;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ADAPTER-1` is the only adapter that
  may shape the fixed stateless Responses request;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-1` binds the exact safe
  turn, dispatch attempt, outer deadline, terminal state, and result authority;
- `GC-MEMBER-CONVERSATION-PROVIDER-RESULT-1` is the only accepted provider
  result capability;
- `GC-MEMBER-CONVERSATION-TURN-RESPONSE-2` is the strict member-visible result;
  and
- Migrations 018, 019, and 020 remain the database authority for replay,
  dispatch state, receipt provenance, and coaching finalization.

Deterministic safety screening, authorization, reservation, committed
`dispatch_started`, no-redispatch, immediate-indeterminate, and atomic replay
rules continue to take precedence over provider behavior.

## Selected boundary

The future concrete path has three separately branded and versioned layers:

1. `GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-RESOLVER-1` resolves one transient
   credential at call time.
2. `GC-MEMBER-CONVERSATION-OPENAI-HTTP-CLIENT-1` performs at most one bounded
   `POST /v1/responses` attempt using an injected HTTP implementation.
3. `GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-1` may construct the
   already-merged adapter and transport only after a separate activation gate.

Each layer uses a module-private brand. Frozen metadata lookalikes, structural
duck typing, environment values, SDK instances, and arbitrary callbacks fail
closed. Factories perform no startup I/O, credential lookup, DNS, network call,
provider health check, or migration work.

The production composition factory is permitted to return only a frozen
unavailable result while production allowlists or activation authority are
absent. Its disabled result contains no credential resolver, HTTP client,
adapter, transport, or callable provider function.

## Credential-at-call-time contract

The credential resolver factory accepts an exact dependency object and returns
an opaque, privately branded resolver. The public object exposes only frozen
version metadata. Resolution is available only through the narrow exported
`resolveMemberConversationOpenAICredential(resolver, operation)` function,
which validates the private resolver brand. Secret material is held behind
module-private state and has no enumerable property, serializer, inspection
method, debug representation, or logger field.

Resolution occurs only after all of the following are true:

- the orchestrator committed `dispatch_started` for the exact attempt;
- the branded transport accepted the exact request and operation context;
- the operation is not terminal or aborted;
- the monotonic outer deadline retains positive time after the finalization
  reserve; and
- the client has synchronously consumed the one-call authority.

The resolver receives only the shared abort signal, monotonic deadline, and an
opaque call capability. It does not receive member text, turn identifiers,
conversation identity, request envelopes, provider bodies, database handles,
or logging dependencies.

One resolution attempt may return an opaque credential lease or `null`. A
lease is valid for this one call only and is privately bound to the exact call
capability and terminal generation. The HTTP client reads it through one
module-private operation; callers cannot extract or stringify the credential.
The lease is revoked immediately after header construction, abort, deadline,
terminal transition, or any failure. No refresh, fallback credential, second
resolver, cache, global singleton, disk write, or process-memory correctness is
allowed.

Credential absence, malformed resolver output, revoked authority, or failure
before any connection attempt is `not_contacted`. Logs and metrics may record
only the fixed resolver version and a bounded reason enum. They must never
record a secret, header, token fragment, resolver error body, environment
value, project identifier, or member/provider payload.

## Exact HTTP client contract

The concrete client implements the existing branded OpenAI client declaration:

- `automaticRetries:false`;
- `maximumAttempts:1`;
- one exact client version;
- one exact `createResponse(body, operation)` method; and
- no generic request, streaming, upload, tool, or SDK escape hatch.

The implementation uses an injected, separately branded bounded HTTP
interface. The interface permits only HTTPS, the exact configured OpenAI API
origin, the exact `/v1/responses` path, and `POST`. The resolved host, port,
scheme, method, and path cannot be overridden per request. Proxy discovery,
ambient agent configuration, cookies, authentication negotiation, and provider
SDK retries are prohibited.

The HTTP interface must enforce:

- TLS certificate and hostname verification with no insecure override;
- no HTTP redirect following and a redirect limit of zero;
- no automatic retry for DNS, connect, TLS, reset, timeout, 408, 409, 429,
  5xx, or any other response;
- a hard request-header byte limit and the already-approved bounded request
  body produced by the adapter;
- a hard response-header byte limit;
- a hard raw response-body byte limit before JSON parsing;
- no decompression expansion beyond that same post-decompression byte limit;
- no streaming result, background response, connection-upgrade, push, or
  unbounded buffering;
- one internal abort signal combining the shared signal and bounded monotonic
  timer; and
- timer, socket, body-reader, and listener cleanup on every settlement path.

The timeout is the lesser of the shared remaining monotonic budget and the
closed adapter timeout, after subtracting the exact finalization reserve. An
expired or aborted operation before the connection boundary must make zero
HTTP attempts. Immediately before the boundary, the client rechecks the shared
signal, both deadlines, exact call capability, and credential lease. After any
settlement it rechecks deadline, terminal generation, and result authority
before parsing or returning.

The only provider-visible correlation supplied by Goals Coach is the already
approved dispatch attempt UUID. Provider-generated request and response IDs
are parsed as bounded operational provenance and passed privately to the
provider-result contract. They are not member-visible and are excluded from
ordinary logs.

## Response and error classification

The client never returns raw headers, raw JSON, usage detail, provider errors,
or provider content to the orchestrator. It returns one exact internal result
to the merged adapter, which still performs strict schema, deterministic output
policy, provider identifier, request binding, and private result-capability
validation.

Classification is conservative:

- `not_contacted` is permitted only when the client can prove that no network
  boundary was crossed, including pre-contact abort, expired deadline, invalid
  capability, or unavailable credential;
- a complete, attributable 401 or 403 may be a definite
  `authentication_rejected` result;
- a complete, attributable 429 may be a definite `rate_limited` result;
- a complete, attributable, explicitly allowlisted provider rejection may be
  a definite rejection only under a separately reviewed enum contract; and
- every ambiguous contact or outcome is `indeterminate`, including DNS/TLS or
  socket ambiguity, redirect, timeout, abort after contact may have begun,
  connection reset, partial or oversized response, decompression failure,
  malformed content type or JSON, unexpected schema, 5xx, and unknown status.

No classification authorizes another call. Once contact may have begun, the
attempt is permanently consumed and the existing committed `dispatch_started`
barrier prevents redispatch. Late provider settlement is discarded and cannot
restore receipt, response, database, or HTTP authority.

Provider error text is neither persisted nor logged. Bounded local metrics may
record only the fixed client version, a coarse outcome enum, and duration
buckets that do not identify a member, conversation, attempt, credential,
provider request, or provider response.

## Disabled production composition

The future production-composition module must not be imported by `server.js`,
turn startup, or the current dormant provider-free composition until a separate
owner gate authorizes a reviewed wiring change. Merely merging the credential
resolver or HTTP client keeps all production imports and behavior unchanged.

Even after a future import is approved, construction remains disabled unless
one immutable configuration object satisfies every exact-key condition:

- one approved client, credential-resolver, adapter, transport, request,
  result, output-policy, and response-contract version;
- one exact OpenAI origin and Responses path;
- one exact model, developer-prompt version and digest, response-schema
  version and digest, output bounds, timeout, finalization reserve, and region
  policy;
- an explicit production activation generation approved for this environment;
- current provider retention, training, regional-processing, and project data
  controls independently verified for the exact project and model; and
- all required migrations and runtime prerequisites independently verified,
  without the composition executing a migration or probing live state.

Initial production allowlists are empty and the activation generation is
absent. Therefore the only valid current production result is unavailable,
with `client:null`, `adapter:null`, `transport:null`, `runtimeWired:false`, and
`externalCallsPermitted:false`.

Credentials are not configuration fields. Credential presence must not satisfy
an allowlist, enable composition, change metadata, register a route, or trigger
startup validation. A missing or inaccessible credential must not make startup
fail open or reveal whether a secret exists.

Production activation, provider configuration, credential provisioning,
runtime wiring, deployment, migration execution, and live verification remain
separate owner approvals. None may be bundled with implementation publication
or inferred from merge readiness.

## Privacy and logging invariants

The concrete boundary must never persist or ordinarily log:

- member text, prompt content, coaching output, transcripts, or raw provider
  bodies;
- request envelopes, response objects, authorization/binding identities,
  idempotency keys, conversation references, safety provenance, or digests;
- credentials, authorization headers, environment values, cookies, TLS data,
  provider error bodies, or stack objects containing them; or
- provider request/response IDs outside the exact durable receipt provenance
  already approved by Migration 019.

Opaque credential leases and call capabilities must pass representative
`JSON.stringify`, enumeration, inspection, and logger-capture tests without
revealing private state. Errors crossing the boundary are newly constructed
bounded enums, not wrapped provider or resolver exceptions.

## Required adversarial acceptance tests

Future implementation is incomplete without offline tests proving:

- structural resolver, lease, HTTP-client, operation, and activation
  lookalikes fail before credential resolution or contact;
- construction performs no I/O and disabled composition returns exact null
  dependencies with false runtime/external-call metadata;
- missing, malformed, throwing, late, reused, cross-attempt, and revoked
  credential leases produce zero or at most one call as appropriate and never
  expose secret material;
- sequential and concurrent execution, including failure, timeout, malformed
  output, and late settlement, makes at most one HTTP attempt;
- zero redirects and zero retries hold for every network error and status;
- outer abort, terminal transition, and both deadline boundaries cancel the
  one client signal, suppress late results, and clean timers, listeners,
  sockets, and readers;
- request/header/response/decompression bounds fail closed without partial
  parsing or unbounded allocation;
- hostname, scheme, port, path, method, proxy, TLS, and content-type drift fail
  closed;
- only the minimized adapter body and attempt correlation cross the fake HTTP
  boundary;
- provider IDs and strict coaching enter only the private result capability;
- member text, secrets, headers, raw errors, IDs, and provenance do not appear
  in serialization, inspection, logs, metrics, or returned failures;
- every possibly contacted failure is indeterminate and no path retries;
- production import scans remain empty, startup still receives null
  idempotency/provider dependencies, and the route remains absent/not_ready;
  and
- Migration 018/019/020 files, schema, package boundaries, and deployment
  configuration remain unchanged.

Tests use only deterministic synthetic credential and HTTP fakes. No test may
read a real environment credential, perform DNS, open a socket, contact OpenAI,
or depend on process memory for correctness.

## Future approval gates

The remaining work is deliberately split:

1. implement and review only the branded credential resolver contract with a
   deterministic test fake;
2. implement and review only the bounded zero-retry HTTP client using an
   injected deterministic HTTP fake;
3. independently verify current OpenAI project/model retention, training,
   region, caching, and request-control prerequisites;
4. implement the disabled production-composition validator while production
   allowlists remain empty and startup remains unwired;
5. separately approve exact configuration and credential provisioning without
   activation;
6. separately approve production runtime wiring while the feature remains
   disabled;
7. separately approve deployment and read-only verification; and
8. only after all prior evidence, separately assess migration/runtime/provider
   activation and controlled live acceptance.

Every gate expires on relevant code, policy, model, schema, provider control,
configuration, credential, migration, runtime, or deployment drift. No gate in
this document authorizes a later one.
