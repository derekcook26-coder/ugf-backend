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
5. Abort, deadline, or terminal-state revocation destroys local acceptance and
   rebinding authority. A late result cannot regain it.

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

The normalized branded value contains only local, frozen fields needed to
revalidate and rebind:

- contract version;
- request-envelope digest;
- exact parsed turn request;
- exact matching deterministic safety response; and
- recomputed request signature and safety rule identities.

It exposes no serialization, logging, persistence, provider-body, or header
method. Validation requires the module-private brand, exact keys, frozen state,
and revalidation of every invariant. Construction and validation perform no
I/O.

## Provider-visible boundary

The OpenAI request remains limited to the already approved fields: static
approved developer instruction, transient bounded member turn, strict selected
provider-result schema, and explicit stateless controls. The rebinding object,
repository identities, request signature, safety provenance, and request
envelope digest are not provider fields.

The tracing attempt UUID remains the only permitted provider correlation
identifier and remains tracing-only, never idempotency or replay authority.

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

## Atomic and orchestration boundaries

Rebinding does not change the merged dispatch state machine:

- provider contact occurs only after committed `dispatch_started`;
- at most one automatic provider dispatch remains authoritative;
- no database transaction or advisory lock spans provider I/O;
- definite rejection and indeterminate outcomes remain terminal;
- abort and deadline preserve the merged immediate-indeterminate policy; and
- only a timely, strictly parsed, locally rebound response may reach atomic
  `provider_succeeded` plus Migration 018 replay plus `finalized`.

Migration 018 and Migration 019 remain unchanged. Rebinding is transient and
does not create new durable provenance.

## Required adversarial tests for a future implementation

Tests must prove:

- mismatched request, response, envelope signature, or safety provenance cannot
  create the private brand;
- metadata lookalikes, unknown keys, mutation, and caller-copied digests fail;
- blocked or unavailable safety never creates rebinding authority;
- no binding field enters captured HTTP bodies, headers, errors, or logs;
- malformed, oversized, refused, incomplete, or extra provider output cannot be
  rebound;
- abort, response closure, and deadline revocation prevent late rebinding and
  durable success;
- an exact timely provider result binds only to its original current request;
- cross-request, cross-conversation, and concurrent swaps fail closed; and
- production imports, allowlists, provider/idempotency dependencies, and route
  state remain empty/null/unwired/absent-not-ready.

## Future gates

Separate owner approval and independent review are required for the provider
result/member-response contract, rebinding implementation, OpenAI adapter,
exact model/prompt/schema/bounds allowlists, credentials and regional data
controls, production composition, deployment, and activation. Until all gates
are satisfied, no SDK/network call or provider contact is permitted.
