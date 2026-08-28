# OpenAI V2 disabled production-composition and configuration architecture

## Status and authority

This document is architecture only. It defines the future configuration and
composition boundary for the already-merged V2 OpenAI member-conversation
chain. It authorizes no source implementation, production import, runtime
wiring, credential access, provider contact, configuration write, migration,
deployment, activation, or member/live-system action.

Production remains exactly disabled. Startup continues to receive
`idempotency:null` and `provider:null`; the provider-backed route remains
absent or `not_ready`; and
`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-1` continues to return
its frozen null/unwired result. The existence of this document, merged V2
modules, configuration evidence, or a credential must never change that state.

## Immutable V1 boundary

The V1 production composition, configuration, credential-provision receipt,
and current-receipt identities retain their existing meanings. In particular:

- `GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-1` is not extended or
  reinterpreted;
- `GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-1` remains bound only to the
  V1 request, adapter, transport, and result chain;
- V1 credential provision payload, envelope, and current-record identities
  remain bound only to CONFIG-1; and
- no V1 allowlist entry, receipt, credential authority, result authority,
  transport, or activation evidence is valid for V2.

Every cross-version pairing fails closed before credential resolution,
provider contact, route registration, or durable-attempt consumption. A V2
implementation must use new private brands and exact version identities; it
must not infer compatibility from matching field names or digests.

## V2 composition identity

The future private composition identity is
`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-2`. Its factory may
accept only one exact, frozen, non-proxy input containing genuine privately
branded dependencies, one exact approved CONFIG-2 capability, and one exact
approved `GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-BINDING-2`
capability. Both capabilities are mandatory for any enabled-path evaluation;
neither may be replaced by its public envelope, digest, or structural
lookalike. Validation must reject accessors, symbols, unknown keys, non-exact
prototypes, mutable nested values, and structural lookalikes without observing
getters or invoking caller-controlled coercion.

The dependency set is exactly:

- `GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-RESOLVER-1`;
- `GC-MEMBER-CONVERSATION-OPENAI-BOUNDED-HTTP-CLIENT-1`;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ADAPTER-2`;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-2`;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-HTTP-TRANSPORT-2`;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ORCHESTRATOR-TRANSPORT-2`;
- `GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2`;
- `GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-2`; and
- the exact reviewed V2 provider-result and rejection capabilities used by the
  merged orchestrator bridge.

Construction performs no I/O. It must not resolve a credential, read an
environment variable or secret manager, inspect a provider account, query a
database, run a migration, open a socket, register a route, schedule work, or
mutate an injected dependency. Factory validation uses a synthetic dry request
only when the relevant reviewed factory contract expressly guarantees that
construction is offline and side-effect free. The synthetic value is never
durable attempt evidence and is discarded before the factory returns.

## Exact disabled result

Until every later gate is separately approved, the only permitted public V2
composition result is one frozen exact object:

```json
{
  "adapter": null,
  "credentialResolver": null,
  "externalCallsPermitted": false,
  "httpClient": null,
  "httpTransport": null,
  "orchestrator": null,
  "providerFree": true,
  "reason": "production_configuration_unavailable",
  "requestFactory": null,
  "runtimeWired": false,
  "status": "disabled",
  "transport": null,
  "version": "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-2"
}
```

The corresponding compiled V2 allowlists are frozen empty arrays. Supplying
arguments, configuration-like objects, genuine offline dependencies,
credentials, environment variables, or activation-like values must neither
observe those values nor alter the disabled result. Serialization and
inspection expose only the fields above.

## CONFIG-2 approval record

`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-2` is a separately approved,
immutable, non-secret exact-key record. It does not replace CONFIG-1. Its
canonical payload retains every CONFIG-1 key in its original insertion order
and adds only the three cache-policy keys immediately after `regionPolicy`.
The complete order is:

1. `version`;
2. `environmentName`;
3. `compositionVersion`;
4. `credentialResolverVersion`;
5. `boundedHttpInterfaceVersion`;
6. `httpClientVersion`;
7. `responsesHttpClientVersion`;
8. `responsesClientVersion`;
9. `adapterVersion`;
10. `transportVersion`;
11. `requestContractVersion`;
12. `resultContractVersion`;
13. `outputPolicyVersion`;
14. `responseContractVersion`;
15. `model`;
16. `origin`;
17. `responsesPath`;
18. `regionPolicy`;
19. `promptCachePolicyVersion`;
20. `promptCacheMode`;
21. `promptCacheBreakpointCount`;
22. `developerPromptVersion`;
23. `developerPromptSha256`;
24. `responseSchemaVersion`;
25. `responseSchemaSha256`;
26. `maximumOutputCharacters`;
27. `maximumOutputBytes`;
28. `maximumOutputTokens`;
29. `requestHeaderBytes`;
30. `requestBodyBytes`;
31. `responseHeaderBytes`;
32. `responseBodyBytes`;
33. `adapterTimeoutMilliseconds`;
34. `finalizationReserveMilliseconds`;
35. `monthlySpendCeilingUsdCents`;
36. `dailyWarningThresholdUsdCents`;
37. `providerBudgetEvidenceSha256`;
38. `spendingAlertEvidenceSha256`;
39. `costControlEvidenceObservedAt`;
40. `providerControlEvidenceSha256`;
41. `providerControlEvidenceObservedAt`;
42. `codeTreeSha`;
43. `migrationStateEvidenceSha256`; and
44. `approvalExpiresAt`.

Unknown, omitted, duplicated, reordered, mutable, accessor-backed, proxy,
non-primitive, non-canonical, expired, or out-of-range values invalidate the
whole record. All strings are non-empty NFC strings without lone surrogates or
control characters. SHA-256 values are primitive lowercase 64-character hex;
timestamps are canonical UTC RFC 3339 strings with whole-second precision;
numeric bounds are non-negative safe integers and must also satisfy the
compiled maxima and ordering constraints.

The record contains no provider project, organization, account, credential,
secret locator, member, conversation, attempt, or provider-request identifier.
Those identities must not enter repository evidence, logs, PR metadata, or
configuration hashes.

### V2 composition-binding record

Component identities that are more granular than the immutable CONFIG-1
schema do not alter the CONFIG-2 hash domain. They belong to a separate
non-secret record named
`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-BINDING-2`.
Its canonical payload contains exactly, in order:

1. `version`;
2. `configurationSha256`;
3. `compositionVersion`;
4. `boundedHttpClientVersion`;
5. `responsesHttpTransportVersion`;
6. `orchestratorTransportVersion`;
7. `providerRequestVersion`;
8. `providerTransportVersion`;
9. `providerResultVersion`;
10. `providerRejectionVersion`;
11. `modelSnapshotEvidenceSha256`;
12. `zeroDataRetentionEvidenceSha256`;
13. `zeroDataRetentionEvidenceObservedAt`; and
14. `codeTreeSha`.

An outer envelope contains exactly `version`, `payload`, and
`compositionBindingSha256`; the digest is SHA-256 over UTF-8 canonical JSON of
the payload only. The record is accepted only when `configurationSha256`
matches the approved CONFIG-2 envelope, `compositionVersion` matches the
CONFIG-2 field, `codeTreeSha` matches CONFIG-2, every component identity
matches the privately branded dependency, and the digest is on a compiled
exact allowlist. This record cannot add, remove, rename, reorder, or reinterpret
any CONFIG-2 field and cannot substitute for configuration approval.

Successful parsing creates a module-private, frozen composition-binding
capability. The enabled-path factory must atomically validate that capability
with the CONFIG-2 capability and all dependencies in the same synchronous
pre-consumption boundary. It rechecks exact CONFIG-2 digest, code tree,
composition identity, every dependency private brand and version, evidence
freshness, and the exact allowlisted composition-binding digest. No partial
validation result is cached. A missing, stale, forged, cross-configuration,
cross-tree, or dependency-drifted capability returns the exact disabled result
before credential resolution, HTTP contact, or durable-attempt consumption.

## Cache and model binding

CONFIG-2 binds the complete reviewed cache tuple. The only currently designed
shape is:

- the exact branded cache-policy version;
- `promptCacheMode:"explicit"`;
- `promptCacheBreakpointCount:0`; and
- no cache key, retention, TTL, conversation, previous-response identifier,
  metadata, or breakpoint marker in the outbound request.

The fixed disabled request controls `tools:[]`, `background:false`, and
`stream:false` remain present; they are not omitted or reinterpreted as cache
controls. Any nonempty tools value or true background/stream value fails.

This cache shape is valid only for an exact immutable model identifier whose
current provider documentation and project controls independently establish
support. A moving model alias is invalid. If no dated immutable eligible model
identifier is available, CONFIG-2 is not approvable and all V2 allowlists stay
empty. `store:false`, explicit cache mode, and zero breakpoints do not by
themselves prove zero-data-retention eligibility or absence of provider-side
processing.

The model, prompt-cache tuple, region policy, origin, request digest, schema
digest, adapter, every transport, provider-result capability, and durable
attempt must remain exactly bound throughout construction and dispatch. Drift
at any layer fails before credential resolution or contact; after possible
contact, uncertainty remains indeterminate and cannot authorize redispatch.

## Configuration capability and digest

The future parser reconstructs the exact CONFIG-2 payload from validated data
descriptors, serializes that payload as UTF-8 canonical JSON using the key
order above and ordinary JSON string escaping, and computes
`SHA256(canonicalPayloadBytes)`. An outer approval envelope contains exactly:

```json
{
  "version": "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-APPROVAL-2",
  "payload": {},
  "configurationSha256": ""
}
```

The digest field is excluded from the hash domain. Parsing recomputes the
payload digest and requires exact primitive-string equality before creating a
private, frozen configuration capability. Callers cannot enumerate, clone,
serialize, or structurally recreate that capability.

CONFIG-2 approval is insufficient by itself. The composition must also require
an exact current V2 credential-provision envelope and authoritative current
receipt record bound to the same `configurationSha256`. V1 receipt identities
are always rejected. The V2 receipt chain requires distinct version names,
strict previous-digest and monotonically increasing sequence binding, atomic
advance-or-no-change currentness, and rejection of stale, forked, superseded,
or skipped records. Credential material and credential hashes are never part
of either record.

## Fail-closed composition rules

Even after a future CONFIG-2 parser exists, the production factory returns the
exact disabled result unless all of the following separately reviewed facts
are current and exact:

- every compiled V2 contract allowlist contains exactly the approved identity;
- the configuration envelope and private capability match the running code
  tree and unexpired evidence;
- a genuine current composition-binding capability is present and atomically
  matches the CONFIG-2 digest, code tree, compiled binding-digest allowlist,
  and every genuine dependency brand and version;
- model snapshot, origin, region, cache, retention, training, abuse-monitoring,
  logging, audit, prompt, schema, bounds, and cost controls match CONFIG-2;
- the V2 credential receipt is current and bound to CONFIG-2 without reading
  the secret;
- required migration state has separate privacy-safe evidence;
- runtime wiring has a later exact owner authorization; and
- a separately versioned activation record exists for the exact deployment
  generation.

Missing, inaccessible, malformed, ambiguous, expired, or drifted evidence is
indistinguishable at the public boundary and returns disabled. Startup must
not reveal whether configuration, receipts, or credentials exist. No failure
may fall back to CONFIG-1, a moving model alias, a default region, implicit
cache behavior, a second credential, another origin, or a less restrictive
policy.

## Privacy and observability

Permitted evidence is limited to non-secret version strings, canonical record
digests, bounded timestamps, bounded decision enums, exact code-tree identity,
and aggregate non-member metrics. Ordinary logs and errors exclude member
text, provider bodies, prompts, schemas, request digests, UUIDs, provider IDs,
credentials, headers, secret metadata, environment values, project/account
identifiers, and authenticated console content.

Construction and disabled-state evaluation emit no provider metrics because
they perform no provider operation. Future call-time metrics may contain only
reviewed bounded outcome and duration buckets and must not reveal whether a
credential exists.

## Required offline acceptance tests

Before any implementation may be published, supported Node 20 tests must
prove:

- the exact disabled public object and empty allowlists are deeply frozen;
- input proxies, accessors, functions, coercible objects, symbols, unknown
  keys, and non-exact prototypes fail with zero observation;
- V1 configuration, receipts, requests, transports, results, and activation
  evidence cannot enter V2, and V2 cannot enter V1;
- CONFIG-2 canonical bytes and digest match fixed cross-environment vectors;
- changing any exact field changes the digest and invalidates the capability;
- missing, stale, expired, forged, proxy, accessor-backed, cross-configuration,
  cross-tree, and cross-dependency composition-binding capabilities return the
  exact disabled result with zero credential, HTTP, or durable-attempt use;
- cache mode and zero-breakpoint binding propagate identically through
  REQUEST-2, provider transport, adapter, Responses transport, HTTP transport,
  and orchestrator transport;
- forbidden cache/request fields are absent while `tools:[]`,
  `background:false`, and `stream:false` remain exact;
- model alias, snapshot, origin, region, prompt, schema, bound, cost, ZDR,
  evidence, expiration, code-tree, migration, and receipt drift all return the
  disabled result before credential resolution or HTTP contact;
- construction, parsing, and disabled evaluation perform zero secret reads,
  DNS, socket, HTTP, provider, database, migration, timer, listener, or route
  operations;
- deterministic credential and HTTP helpers remain test-only and production
  import scans stay empty;
- startup still supplies null idempotency/provider dependencies and the route
  remains absent or `not_ready`;
- Migrations 018, 019, and 020, package configuration, server composition,
  Railway configuration, and deployment state remain unchanged; and
- focused, combined V1/V2, repository check, and unprivileged disposable-PG16
  full suites complete with zero failures and zero skips.

## Separate future owner gates

The remaining work is deliberately ordered and non-transitive:

1. independently review and, under a separate publication gate, publish this
   architecture document;
2. implement and review only the offline CONFIG-2 parser, canonical digest,
   private capability, COMPOSITION-BINDING-2 parser, canonical digest and
   private capability, frozen empty configuration and binding allowlists, and
   exact disabled COMPOSITION-2 while production remains null/unwired;
3. define and review distinct CONFIG-2-bound credential receipt V2 contracts;
4. independently verify current exact model/project/origin/cache/ZDR and cost
   controls and draft one non-secret CONFIG-2 record;
5. separately authorize any provider-console credential creation or rotation;
6. separately authorize any secret-manager write and privacy-safe V2 receipt
   currentness update;
7. separately implement and review a disabled configuration loader and
   secret-manager adapter while startup remains unwired;
8. separately authorize production runtime wiring while the route and
   external calls remain disabled;
9. separately authorize deployment and read-only verification;
10. independently assess migration/runtime readiness;
11. separately authorize bounded synthetic provider validation with no member
    data while the member route remains disabled;
12. independently review that evidence and separately authorize activation;
13. separately authorize any real-member acceptance with exact privacy,
    safety, operator, rollback, and observation boundaries.

No gate authorizes the next. Any relevant code, configuration, provider,
policy, credential, migration, deployment, or environment drift expires the
corresponding approval.
