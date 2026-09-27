# Member conversation OpenAI provider-adapter boundary

Status: architecture only. This document does not authorize implementation,
credentials, provider access, configuration, migration, runtime wiring,
deployment, activation, or member testing.

## Purpose and accepted tradeoff

This design defines the narrow boundary for a future concrete OpenAI Responses
API adapter behind `GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-1`. It preserves
the accepted product tradeoff: at most one automatic provider dispatch, with a
possible permanent concealed indeterminate result, and no exactly-once-success
claim.

The adapter is not a safety, authorization, idempotency, or response-authority
component. The orchestrator remains the sole sequencer of those concerns. The
adapter may make exactly one bounded provider request only after receiving an
exact committed `dispatch_started` authority from the orchestrator.

## Current-contract gap and stop condition

The merged orchestrator currently passes only identifiers, versions, and
digests to `transport.dispatch`. It does not pass member turn text or any other
content from which a provider could produce a coaching response. The exact-key
transport request therefore cannot support a concrete model adapter as-is.

Before implementation, a separate owner-reviewed contract change must define a
transient, bounded `memberTurn` input and any strictly necessary minimized
conversation context. That change must:

- carry content in memory only for the single authorized call;
- accept only the current member turn, not a transcript by default;
- exclude member, session, conversation, binding, and idempotency identifiers
  from the provider request;
- never persist or ordinarily log member text, prompt text, provider request or
  response bodies, or token-level content;
- preserve deterministic safety screening before provider dispatch; and
- define an exact byte and character bound before the provider adapter exists.

If useful coaching cannot be produced within that minimized envelope, stop for
a privacy and product-contract review. Do not silently add transcripts, workout
history, health data, files, images, audio, or retrieval.

## Versioned and branded contracts

The concrete adapter requires two new private brands; metadata lookalikes must
fail validation:

1. `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ADAPTER-1` brands the concrete
   adapter. It is constructible only from the exact approved model/schema
   policy, an exact credential-at-call-time dependency, and a bounded HTTP
   transport. Construction performs no I/O.
2. `GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-1` brands the transient request
   envelope. It is created only after strict parsing and canonicalization. It
   is frozen, exact-keyed, and valid for one attempt.

The adapter may be wrapped by the existing
`GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-1` only when its provider, model, and
response-schema metadata exactly match the approved closed policy. The wrapper
remains `runtimeWired:false` until a separate production-composition gate.

No generic object, environment value, model alias, or credential presence may
create either brand or enable the adapter.

## Closed model, prompt, and schema policy

The initial production allowlists are empty. A later owner gate must select:

- one exact immutable model identifier, not `latest` or another moving alias;
- one exact developer-prompt version and SHA-256 identity;
- one exact strict JSON response-schema version and SHA-256 identity;
- one bounded output-token limit; and
- one approved regional API origin.

Dispatch fails closed unless all five values match the compiled policy. A model,
prompt, schema, token limit, or region change is a new reviewed version, not a
configuration-only substitution.

The response request uses strict JSON Schema Structured Outputs. It permits no
additional properties and represents only the existing strict member-turn
response contract. The adapter must still parse the returned object through the
repository's production response parser; provider schema enforcement is not a
substitute for local validation.

## Canonical minimized request envelope

The normalized envelope has a fixed field order and exact keys:

- request-envelope contract version;
- existing transport contract version;
- exact attempt UUID, used only as the tracing request ID;
- exact immutable model identifier;
- developer-prompt version and digest, but not a dynamic prompt body in
  provenance;
- response-schema version and digest;
- existing request-signature and safety-rule provenance;
- the bounded transient current member turn;
- fixed controls: `store:false`, `background:false`, no conversation,
  `previous_response_id`, metadata, tools, files, images, audio, or remote
  prompt template; streaming off; truncation disabled; and
- the fixed output-token limit and regional API origin policy identifier.

Conversation UUIDs, member/session/binding IDs, idempotency keys, provider
credentials, and database IDs are not provider fields. The attempt UUID may be
sent as `X-Client-Request-Id` for tracing/support correlation only. It is never
treated as provider deduplication, replay, or idempotency.

The concrete HTTP body contains only the static approved developer instruction,
the transient member turn, the strict response schema, and the fixed controls.
It does not include repository provenance fields that the model does not need.

## Request-envelope digest and provenance

After strict normalization, compute
`SHA-256(UTF-8(JSON.stringify(normalizedEnvelope)))`. Fixed construction order,
exact keys, normalized strings, and explicit booleans make those bytes
deterministic. The digest binds the actual transient member turn without storing
that text.

The current Migration 019 schema has no request-envelope-digest column. The
digest may therefore be used transiently for validation and privacy-safe
categorical diagnostics, but it cannot be claimed as durable provenance under
the current schema. Durable storage requires a separate migration and review.
It must not be overloaded into the existing request signature or response
digest.

Permitted future durable provenance is limited to versions/digests, bounded
provider request/response identifiers already approved by Migration 019, and
categorical terminal outcomes. Member text, the developer prompt, provider
payloads, credentials, tokens, raw responses, and usage detail remain excluded.

## Credential-at-call-time isolation

Adapter construction neither reads configuration nor resolves a secret. The
adapter accepts a separately branded credential resolver whose only method is
invoked immediately before the one authorized HTTP attempt. The resolver:

- returns an opaque, short-lived authorization value to the HTTP boundary;
- never exposes the value through metadata or errors;
- is not invoked for construction, validation, replay, rejection, or a barred
  dispatch;
- does not cache the value beyond the call;
- scrubs references after request setup; and
- fails closed as `not_contacted` when a credential cannot be obtained before
  network contact.

No environment-variable name or secret-provider configuration is selected by
this design. That is a separate configuration and credential gate.

## Provider data controls and region gate

Provider policy is an activation prerequisite, not an adapter assumption. A
future gate must record current official evidence for the exact OpenAI project:

- API data sharing/training is disabled;
- `store:false` and foreground Responses behavior are enforced;
- the project's abuse-monitoring retention mode, including whether Modified
  Abuse Monitoring or Zero Data Retention is approved;
- prompt-caching retention behavior for the selected project and model;
- the exact eligible regional API origin and whether storage and processing
  both occur in the approved region; and
- absence of enabled provider tools, files, vector stores, conversations, or
  background responses.

OpenAI currently documents that API data is not used for training by default,
while abuse-monitoring logs may be retained for up to 30 days unless eligible
controls alter that behavior. `store:false` does not by itself prove zero
retention or disable every caching path. The production gate must reverify these
facts against the current [OpenAI data controls documentation](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint).

No region is silently inferred from account location. A region or retention
policy mismatch makes adapter construction unavailable.

## One-call HTTP boundary and bounds

The approved SDK or HTTP client must be configured for exactly zero automatic
retries. Redirects are disabled. The adapter issues at most one foreground
`POST /v1/responses` after committed dispatch authority.

The adapter deadline is the lesser of the shared remaining monotonic deadline
and a compiled adapter maximum that leaves a fixed finalization budget inside
the orchestrator's 30-second outer limit. The exact adapter and finalization
budgets require a later performance gate. No adapter timer may extend the outer
deadline.

The response body is read through a hard byte limit before JSON parsing. The
exact raw-body maximum and output-token maximum are compiled policy values.
Exceeding either bound, incomplete output, invalid JSON/schema, an unexpected
content type, extra output items, a refusal outside the approved response
contract, or a locally invalid strict response is an indeterminate contacted
result, never a redispatch opportunity.

The Responses API request remains stateless: no conversation,
`previous_response_id`, background mode, metadata, or hosted tools. The official
[Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
documents `store`, structured output, tools, background operation, and
truncation; the implementation must pin and test every relevant field rather
than rely on defaults.

## Error classification

The adapter returns only the existing exact transport result categories:

- `not_contacted`: a provable local failure before any request byte could be
  sent, including failed credential resolution, invalid envelope, exhausted
  deadline, or local policy mismatch;
- `rejected/authentication_rejected`: a complete, definite 401 or 403 response;
- `rejected/rate_limited`: a complete, definite 429 response;
- `rejected/request_rejected`: another complete, definite non-retryable 4xx
  response attributable to the request; or
- `indeterminate`: timeout, abort after contact may have begun, DNS/TLS/socket
  ambiguity, connection reset, partial response, 5xx, redirect, oversized body,
  malformed or incomplete provider output, local parse failure after contact,
  or any unclassified condition.

Provider error bodies are neither returned nor logged. Only the bounded
category, status class when safely available, duration bucket, and approved
request correlation identifier may be emitted as categorical diagnostics.

Even `not_contacted` occurs after durable `dispatch_started`; the orchestrator
must not redispatch it. The category describes contact evidence, not renewed
dispatch authority.

## Abort, deadline, and late results

The merged immediate-indeterminate policy is authoritative:

- abort or response closure revokes provider-result, receipt, database, and HTTP
  response authority; the member-visible outcome is silent;
- ordinary deadline expiry revokes provider-result and receipt acceptance, but
  may yield the existing concealed unavailable response only while terminal
  response authority remains true and the response is writable;
- cancellation of the HTTP request is best effort only;
- every success or rejection arriving after authority revocation is discarded
  locally and cannot create `provider_succeeded`, `provider_rejected`, a
  Migration 018 row, or `finalized`; and
- durable indeterminate reconciliation occurs only when Migration 019's
  database-authoritative threshold permits it.

No transaction, advisory lock, request handler, busy-wait, or background task is
held across provider I/O or until the reconciliation threshold. Process memory
is not a correctness boundary.

## Fail-closed composition

Production remains exactly `idempotency:null` and `provider:null`; the member
conversation route remains absent/not-ready. The concrete adapter source, SDK,
credential resolver, and orchestrator must not be imported by production
startup under this design.

Future activation requires independent gates for the transient content contract,
adapter implementation, exact model/prompt/schema/bounds allowlist, credential
and regional data controls, provider sandbox evidence, production composition,
migrations, deployment, and feature activation. Any missing or malformed gate
returns one concealed unavailable composition with no startup I/O.

## Required adversarial acceptance tests

Future tests must use a deterministic local HTTP fake and synthetic content.
They must prove:

- lookalike brands, unknown keys, moving model aliases, schema/prompt drift,
  wrong region policy, and non-allowlisted values fail before credential or
  network access;
- credential resolution happens once at call time and secrets never appear in
  results, errors, diagnostics, digests, or captured provenance;
- the canonical request digest is stable for normalized equivalent input and
  changes for member text, model, prompt, schema, control, or region drift;
- the exact provider body excludes repository/member identifiers and prohibited
  stateful/tool fields and sets every required privacy control explicitly;
- zero client retries and exactly one HTTP attempt under timeout, reset, 5xx,
  partial, oversized, malformed, refusal, and strict-schema failures;
- definite 401/403/429/other 4xx classifications are exact and content-free;
- abort is silent, deadline response authority is conditional, and late success
  or rejection cannot mutate durable state;
- committed `dispatch_started` never redispatches, including `not_contacted`;
- only a timely strict success reaches the existing canonical-digest atomic
  finalization path; and
- production import scans remain empty, composition remains disabled, and
  Migrations 018/019 remain unchanged and unapplied outside disposable tests.

Before any member-facing activation, the Legacy-to-2.0 guide additionally
requires privacy-safe categorical instrumentation, stale-result cleanup, and
real-device/mobile-network acceptance without weakening deterministic safety or
member dignity.
