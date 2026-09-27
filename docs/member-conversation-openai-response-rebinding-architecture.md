# Member conversation OpenAI response rebinding architecture

Status: architecture only. This document authorizes no code, schema, migration,
runtime wiring, provider access, credential use, configuration, deployment, or
activation.

## Problem

`GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-1` deliberately excludes member,
session, conversation, binding, idempotency, and database identifiers from the
provider request. The current strict member-turn response contract requires the
exact request ID, idempotency key, and conversation identity. Those values
cannot be reconstructed from the request signature and must not be generated
or echoed by a provider.

The current response contract also contains only the deterministic safety
state. It has no field for provider-authored coaching content. A concrete model
adapter therefore cannot truthfully claim to produce a useful current-contract
member response from the merged envelope alone.

## Decision

Keep provider-visible content and local response authority separate.

1. A future provider-invisible rebinding object may carry the exact strict
   current turn request and its matching `safe_to_process` response solely in
   process memory.
2. The rebinding object must be created by a module-private brand after
   reparsing both values, proving `responseMatchesRequest`, and proving the same
   exact clear/allow safety tuple required by the merged request envelope.
3. Creation must recompute the request signature and require it to equal the
   privately branded request envelope signature. Caller-copied signatures or
   metadata lookalikes cannot create authority.
4. The adapter may use rebinding data only after a timely, strict provider
   success to construct a locally bound response. Rebinding fields never enter
   the HTTP body, headers, provider metadata, diagnostics, digests intended for
   the provider, or ordinary logs.
5. Every result must carry a module-private capability bound to the exact
   request-envelope digest and attempt UUID. A result for another envelope or
   attempt cannot be rebound, even when both requests are otherwise valid.
6. Abort, deadline, or terminal-state generation change revokes local
   acceptance and rebinding authority. Every operation consults current private
   revocation state; a late result cannot regain authority from a static brand.

This design does not yet select a provider result schema. Adapter
implementation remains stopped until a separately reviewed response-contract
version defines the minimum provider-authored coaching result that can be
truthfully rebound into a member response.

## Rebinding contract

The future contract version is
`GC-MEMBER-CONVERSATION-PROVIDER-RESPONSE-BINDING-1` and has exact construction
inputs only:

- the privately branded provider request envelope;
- the current strict turn request; and
- the matching deterministic `safe_to_process` turn response.

The public branded value is an opaque frozen token with no enumerable sensitive
fields. A module-private `WeakMap` holds the local state needed to revalidate
and rebind:

- contract version;
- exact request-envelope digest and attempt UUID;
- exact parsed turn request;
- exact matching deterministic safety response; and
- recomputed request signature and safety rule identities;
- the current terminal-authority generation; and
- a revocation flag/capability consulted by every bind or result operation.

It exposes no parsed request, response, member text, identifier, serialization,
logging, persistence, provider-body, or header property or method. Ordinary
`JSON.stringify`, object inspection, and logger enumeration of the token reveal
no sensitive state. Validation requires the module-private brand, the private
state entry, exact envelope/attempt identity, and a still-current terminal
generation. Construction and validation perform no I/O.

The future provider-result contract also requires a separate module-private
brand. Its private state binds the result to the same request-envelope digest,
attempt UUID, and terminal generation before any response is parsed or rebound.
Caller-created result lookalikes and cross-request or cross-attempt swaps fail
before durable mutation.

## Provider-visible boundary

The OpenAI request remains limited to the already approved fields: static
approved developer instruction, transient bounded member turn, strict selected
provider-result schema, and explicit stateless controls. The rebinding object,
repository identities, request signature, safety provenance, and request
envelope digest are not provider fields.

The tracing attempt UUID remains the only client-supplied provider correlation
identifier and remains tracing-only, never idempotency or replay authority.
OpenAI may return its own bounded provider request and response identifiers;
those provider-generated values remain local result and durable Migration 019
receipt provenance required by the existing orchestrator/finalization contract.
They are not sent as additional client correlation fields, exposed to members,
or written to ordinary logs.

## Missing provider result contract

The existing member-turn response cannot represent provider-authored coaching
content. Before adapter implementation, a separate owner-reviewed design must
select one of these explicit outcomes:

- introduce a new strict versioned member response contract with a bounded,
  minimized coaching-result field; or
- establish that this provider path has no provider-authored coaching content purpose and
  should not exist.

The first option requires exact byte and character bounds, strict JSON schema,
local parsing, prohibited-content handling, safety precedence, concealed-error
behavior, and compatibility rules. It must not add transcripts, workout
history, health data, media, retrieval, or identifiers by implication.

No implementation may ask OpenAI to emit repository identifiers, accept an
unbound provider response, overload deterministic safety fields with coaching
text, or treat the request signature as reversible identity.

If a new response contract adds provider-authored coaching content, the same
design gate must select privacy-minimized durable exact replay. Migration 018
and `readFinalized` currently store and reconstruct only state, reason, and
safety; they cannot replay a coaching field. The gate must therefore either:

- introduce a separately reviewed migration and immutable replay contract that
  atomically stores the exact bounded coaching result with its required
  provenance; or
- redesign idempotency/finalization so it makes no durable coaching-replay claim.

Until one option is accepted, a coaching result cannot enter
`provider_succeeded`, Migration 018, or `finalized`. This document does not
authorize or specify that migration or redesign.

## Atomic and orchestration boundaries

Rebinding does not change the merged dispatch state machine:

- provider contact occurs only after committed `dispatch_started`;
- at most one automatic provider dispatch remains authoritative;
- no database transaction or advisory lock spans provider I/O;
- definite rejection and indeterminate outcomes remain terminal;
- abort and deadline preserve the merged immediate-indeterminate policy; and
- only a timely, strictly parsed, locally rebound response that is truthfully
  representable by the accepted durable replay contract may reach atomic
  `provider_succeeded` plus replay plus `finalized`.

Migration 018 and Migration 019 remain unchanged by this architecture slice.
The current finalization path remains usable only for its existing exact
response tuple. Rebinding is transient and creates no durable provenance; any
future coaching replay requires the separate migration/idempotency gate above.

## Required adversarial tests for a future implementation

Tests must prove:

- mismatched request, response, envelope signature, or safety provenance cannot
  create the private brand;
- metadata lookalikes, unknown keys, mutation, caller-copied digests, and
  result-capability lookalikes fail;
- blocked or unavailable safety never creates rebinding authority;
- `JSON.stringify`, enumeration, inspection, and representative logger capture
  of the opaque token reveal no member text or binding identity;
- no private binding field enters captured HTTP bodies, headers, errors, or logs;
- results bound to another envelope, attempt, or terminal generation cannot be
  parsed, rebound, replayed, or finalized, including concurrent swaps;
- abort, deadline, response closure, or terminal-generation change revokes the
  private capability before late result acceptance;
- malformed, oversized, refused, incomplete, or extra provider output cannot be
  rebound;
- abort, response closure, and deadline revocation prevent late rebinding and
  durable success;
- an exact timely provider result binds only to its original current request;
- provider-generated request/response IDs are accepted only from the exact
  bounded result, preserved for existing Migration 019 receipt provenance, and
  never confused with the client-supplied tracing attempt UUID;
- a coaching field cannot finalize through current Migration 018; future tests
  must prove exact durable replay under the separately accepted migration or
  prove the redesigned no-replay contract; and
- cross-request, cross-conversation, cross-attempt, and concurrent swaps fail
  closed; and
- production imports, allowlists, provider/idempotency dependencies, and route
  state remain empty/null/unwired/absent-not-ready.

## Future gates

Separate owner approval and independent review are required for the provider
result/member-response contract, rebinding implementation, OpenAI adapter,
exact model/prompt/schema/bounds allowlists, credentials and regional data
controls, production composition, deployment, and activation. Until all gates
are satisfied, no SDK/network call or provider contact is permitted.
