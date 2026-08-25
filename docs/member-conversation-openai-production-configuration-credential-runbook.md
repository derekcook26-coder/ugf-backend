# OpenAI production configuration and credential provisioning runbook

## Status and authority

This document is an architecture and operator runbook only. It selects the
shape, custody, evidence, and sequencing for a future Goals Coach production
configuration and OpenAI credential provision. It does not contain approved
production values, a secret name, a secret locator, a credential, or activation
authority.

This document does not authorize anyone or any process to read, create, rotate,
test, validate, provision, reveal, or delete a credential; change Railway or
another environment; contact OpenAI; import or wire production modules; run a
migration; deploy; activate a route or feature; or access a member, database, or
live system.

Production remains exactly disabled. The production composition has empty
allowlists, all provider dependencies remain `null`, `runtimeWired` and
`externalCallsPermitted` remain `false`, and the provider-backed route remains
absent or `not_ready`.

## Authoritative boundaries

This runbook is subordinate to the merged contracts and does not weaken them:

- `GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-RESOLVER-1` resolves one opaque
  credential lease only at the authorized call boundary;
- `GC-MEMBER-CONVERSATION-OPENAI-HTTP-CLIENT-1` permits at most one bounded
  zero-retry HTTP attempt;
- `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ADAPTER-1` and
  `GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-1` retain request, safety,
  region, deadline, and result authority;
- `GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-1` remains disabled
  while any allowlist or activation prerequisite is absent; and
- Migrations 018, 019, and 020 remain the replay, dispatch, receipt, and
  coaching-finalization authority.

Credential presence is never evidence of configuration validity, runtime
wiring, deployment readiness, or activation authority.

## Separation of records

Future configuration and credential provisioning use three separately
approved records. They must not be combined into one environment object,
secret payload, pull-request body, ticket comment, log entry, or deployment
command.

### Configuration approval record

`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-1` is an immutable,
exact-keyed approval record containing only non-secret policy identities:

- `version`;
- `environmentName`;
- `compositionVersion`;
- `credentialResolverVersion`;
- `boundedHttpInterfaceVersion`;
- `httpClientVersion`;
- `responsesHttpClientVersion`;
- `responsesClientVersion`;
- `adapterVersion`;
- `transportVersion`;
- `requestContractVersion`;
- `resultContractVersion`;
- `outputPolicyVersion`;
- `responseContractVersion`;
- `model`;
- `origin`;
- `responsesPath`;
- `regionPolicy`;
- `developerPromptVersion`;
- `developerPromptSha256`;
- `responseSchemaVersion`;
- `responseSchemaSha256`;
- `maximumOutputCharacters`;
- `maximumOutputBytes`;
- `maximumOutputTokens`;
- `requestHeaderBytes`;
- `requestBodyBytes`;
- `responseHeaderBytes`;
- `responseBodyBytes`;
- `adapterTimeoutMilliseconds`;
- `finalizationReserveMilliseconds`;
- `monthlySpendCeilingUsdCents`;
- `dailyWarningThresholdUsdCents`;
- `providerBudgetEvidenceSha256`;
- `spendingAlertEvidenceSha256`;
- `costControlEvidenceObservedAt`;
- `providerControlEvidenceSha256`;
- `providerControlEvidenceObservedAt`;
- `codeTreeSha`;
- `migrationStateEvidenceSha256`; and
- `approvalExpiresAt`.

Unknown, missing, duplicated, empty, moving-alias, non-canonical, expired, or
out-of-range values invalidate the whole record. The record contains no
project identifier, organization identifier, account email, member data,
credential name, secret locator, secret version, secret digest, or activation
generation.

Every concrete value requires a separately reviewed owner approval. Until
that approval exists, the corresponding production allowlist remains empty;
placeholders such as `TBD`, `latest`, wildcard origins, default regions, or
inferred account locations are invalid.

The two HTTP-boundary fields must respectively equal the exact reviewed
`GC-MEMBER-CONVERSATION-OPENAI-BOUNDED-HTTP-INTERFACE-1` and
`GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-HTTP-CLIENT-1` identities. The spend
ceiling and warning threshold are non-negative safe integers expressed in US
dollar cents, with the daily warning not greater than the monthly ceiling.
Budget and visible-alert evidence hashes must identify current, independently
reviewed, privacy-safe evidence for the same abstract environment label.
Missing, disabled, expired, or drifted cost controls invalidate the whole
configuration.

### Credential provision record

`GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-PROVISION-1` is a privacy-safe
receipt envelope created only after a separately authorized operator
provisions a secret. Its canonical payload contains exactly these keys in this
order and no others:

1. `version`, exactly
   `GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-PROVISION-PAYLOAD-1`;
2. `environmentName`, an owner-approved abstract label matching
   `^[a-z][a-z0-9_-]{0,63}$`, never a live service/project identifier;
3. `configurationSha256`, the lowercase 64-hex digest of the exact approved
   `GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-1` record;
4. `secretManagerNamespace`, exactly `managed_environment_secret`;
5. `secretNameIdentifier`, an NFC string matching
   `^[A-Z][A-Z0-9_]{0,63}$` and approved separately for this integration;
6. `providerProjectPurpose`, exactly `goals_coach_member_conversation` and not
   a provider project identifier;
7. `lifecycleSequence`, a safe integer from 1 through 2147483647;
8. `previousReceiptSha256`, `null` for sequence 1 and otherwise the lowercase
   64-hex digest of the immediately preceding current receipt;
9. `provisionedAt`, a UTC timestamp in canonical
   `YYYY-MM-DDTHH:mm:ss.sssZ` form;
10. `rotationDueAt`, a later UTC timestamp in the same canonical form;
11. `operatorRole`, exactly `production_secret_operator`; and
12. `outcome`, exactly `provisioned` for sequence 1 or `rotated` otherwise.

The exact outer envelope contains keys in order `version`, `payload`, and
`receiptSha256`. Its `version` is exactly
`GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-PROVISION-1`.
`receiptSha256` is `SHA-256(UTF-8(JSON.stringify(payload)))`; the digest field
is never part of the hashed payload. Before serialization, every string must
already be NFC and contain no unpaired surrogate or prohibited control; no
normalization or coercion occurs during hashing. All numbers are JSON decimal
safe integers with no exponent, fraction, sign prefix, or leading zero.
Booleans and undefined values are not permitted. Timestamps and hashes are
strings in the exact forms above. JSON uses the stated insertion order, no
whitespace, and the standard JSON escapes emitted by `JSON.stringify`.
Parsing reconstructs a fresh exact-order payload, requires every source value
to equal its reconstructed value, recomputes the digest, and requires exact
agreement before accepting the receipt.

Receipt validity also requires an authoritative non-secret
`GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-PROVISION-CURRENT-1` record with
exact keys `version`, `environmentName`, `configurationSha256`,
`lifecycleSequence`, `currentReceiptSha256`, `previousCurrentReceiptSha256`,
and `updatedAt`. It uses the same canonical strings, integers, timestamps, and
configuration digest. A consumer accepts only the receipt whose digest and
sequence equal the current record. Sequence must increase by exactly one and
the new receipt and current record must both name the immediately preceding
receipt digest. Missing, ambiguous, stale, forked, superseded, configuration-
mismatched, or non-current evidence fails closed. Creating this currentness
record is a future separately authorized evidence operation, never an
environment or secret write.

It must not contain the credential, a credential prefix or suffix, credential
length, provider account/project/organization identifiers, authorization
header, secret-manager resource path, environment value, ciphertext, secret
version token, console screenshot, provider response, or validation request.

Provisioning success means only that the authorized secret manager accepted a
write. It does not prove the credential is correct, usable, scoped correctly,
accepted by OpenAI, visible to a deployment, or safe to activate. Provisioning
must not perform a provider test call.

### Provider credential creation record

Creating or rotating a credential in the provider console is provider contact
and requires its own exact owner authorization before secret-manager
provisioning. That authorization identifies only the intended abstract
environment label, purpose, operator role, and bounded console action. It does
not authorize an API request, credential test, project/configuration change,
runtime wiring, deployment, activation, or member access. Console completion
yields only a bounded outcome enum; no provider/account identifier, credential
metadata, or authenticated console content enters repository evidence.

### Activation approval record

Activation is deliberately outside this runbook. A future
`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-ACTIVATION-*` record must be reviewed
and authorized separately after configuration, credential provisioning,
runtime wiring, deployment, and read-only verification gates complete. Neither
of the records above may contain or imply an activation generation.

## Exact configuration selection procedure

The configuration gate is document-only until a later owner authorization:

1. Pin the exact Git tree containing every branded contract and deterministic
   safety boundary. Moving branches and unreviewed working trees are invalid.
2. Reverify the current official provider retention, training, abuse
   monitoring, prompt-caching, storage, foreground Responses, and regional
   processing controls for the exact future project, model, and origin.
3. Produce a privacy-reviewed evidence bundle containing public policy pages,
   timestamps, bounded conclusions, and cryptographic identities. Exclude
   authenticated console contents and provider/account identifiers.
4. Select one immutable model identifier, HTTPS origin, `/v1/responses` path,
   region policy, prompt identity, schema identity, output bounds, HTTP bounds,
   adapter timeout, finalization reserve, monthly spending ceiling, daily
   warning threshold, and budget/visible-alert evidence identities. No value
   is inferred from a credential or provider account.
5. Verify every selected identity against the compiled implementation and the
   empty-to-exact allowlist change proposed for a later code/configuration gate.
6. Verify required migration state using a separately authorized read-only
   evidence process. The composition must not query or migrate a live database.
7. Canonicalize and hash the exact configuration approval record. Obtain an
   owner approval that identifies that hash, code tree, environment, and
   expiration.
8. Stop. Do not write the record into Railway, source code, environment
   variables, a deployment, or production composition under this gate.

Any provider-policy, model, origin, region, prompt, schema, bound, code,
migration, environment, or evidence drift invalidates the record and requires
a fresh review.

## Credential provisioning procedure

Credential creation and secret-manager provisioning are two later, separately
authorized operations performed by a human operator with the minimum required
permissions. The safe procedure is:

1. Confirm the exact environment and approved configuration-record hash using
   non-secret evidence. Stop on ambiguity.
2. Confirm the destination secret-manager namespace and approved secret-name
   identifier without reading an existing secret value.
3. Stop and obtain exact owner authorization for the provider-console
   credential creation or rotation action. Under only that authorization,
   perform the bounded console action using the narrowest available project
   and operational scope. Do not make a test API request or change provider
   project controls. Do not copy the credential into chat, source, tickets,
   terminals with command history, screenshots, logs, or clipboard managers.
4. Stop again and obtain separate exact owner authorization for the named
   secret-manager write. Only then enter the credential directly into the
   authorized secret-manager value
   field. The agent must not type, paste, receive, display, or inspect it.
5. Confirm only the secret manager's bounded success state. Do not reveal the
   stored value and do not test it against the provider.
6. Bind the canonical privacy-safe payload to the exact approved configuration
   digest and immediately preceding current receipt, compute its digest over
   the payload only, and place both in the exact receipt envelope. Under a
   separate evidence-record authorization, advance the privacy-safe current
   receipt record atomically or leave the old record current. Do not hash the
   credential: a credential digest would remain sensitive comparison material.
7. Verify that Railway remains branch-disconnected, production composition is
   still null/unwired, no deployment occurred, and no route or feature became
   available.
8. Stop and obtain only the separate local disabled configuration-loader and
   secret-manager-adapter implementation-review gate listed below. Runtime
   wiring remains prohibited until that gate completes and is followed by its
   own separate owner authorization.

A credential must never be supplied through a CLI argument, pull-request
field, repository file, test fixture, process output, or agent conversation.
The only permitted future runtime read is the merged resolver's call-time
secret boundary after committed dispatch authority and all activation gates.

## Rotation, revocation, and recovery

Rotation and revocation are separate owner-authorized operations. They must
not enable runtime wiring, deployment, or activation.

- A suspected disclosure requires immediate human-led provider revocation and
  incident handling; do not first test the credential.
- A failed or ambiguous secret-manager write leaves readiness unproven. Do not
  retry automatically or delete an existing value.
- Rotation creates a new canonical payload linked to the exact current receipt
  and configuration. It becomes usable evidence only when the authoritative
  current receipt record advances by one sequence and names its digest. The
  prior receipt then remains immutable but is superseded and must be rejected,
  without recording either credential or secret version token.
- Rollback means restoring a previously approved disabled configuration state,
  not restoring an old credential value from logs or repository history.
- Secret absence or access failure must remain concealed and fail closed at
  call time; startup must not probe it.
- No break-glass path may bypass the branded resolver, one-use lease,
  zero-retry HTTP client, or dispatch/no-redispatch authority.

## Evidence and audit requirements

Permitted evidence is limited to privacy-safe facts:

- exact code, document, configuration-record, and public-evidence hashes;
- exact non-secret contract versions and policy values;
- bounded timestamps and expiration;
- bounded role and outcome enums;
- proof that the production composition remains disabled and import-free;
- proof that Railway remains branch-disconnected and no deployment occurred;
  and
- proof that no provider request, migration, or live member/database action
  occurred.

Receipt evidence must include only the exact provision envelope and matching
current receipt record. A receipt is never accepted merely because its digest
is valid.

Forbidden evidence includes credentials, environment values, secret resource
paths, provider/account identifiers, member/provider payloads, authorization
headers, raw errors, authenticated console exports, cookies, tokens, and
screenshots containing sensitive state.

## Required offline acceptance tests for future implementation

Before a configuration loader or secret-manager adapter may be published,
deterministic offline tests must prove:

- exact-key parsing and canonical hashing of the non-secret configuration
  record;
- exact-key parsing of the credential provision envelope, deterministic
  canonicalization of its payload excluding `receiptSha256`, and rejection of
  any payload/digest mismatch;
- exact receipt field order, NFC/Unicode, timestamp, safe-integer, enum, null,
  JSON escaping, and UTF-8 hash vectors across supported environments;
- rejection of configuration-hash mismatch and every stale, forked,
  superseded, skipped-sequence, or non-current receipt/current-record pair;
- rejection of placeholders, moving aliases, wildcard origins, expired
  evidence, unknown keys, malformed bounds, and all identity drift;
- credentials and credential metadata cannot appear in the configuration
  record or satisfy any allowlist;
- a secret locator cannot be derived, inspected, serialized, logged, or used
  during construction or startup;
- disabled composition is returned for every missing gate and for structural
  lookalikes;
- secret absence and resolver failures do not reveal whether a secret exists;
- configuration parsing, credential adapter construction, and startup perform
  no DNS, socket, HTTP, database, migration, or secret read;
- production imports and runtime wiring remain absent;
- `idempotency:null`, `provider:null`, and route absent/`not_ready` remain
  exact; and
- Migrations 018, 019, and 020, package configuration, Railway configuration,
  and deployment state remain unchanged.

Tests use only synthetic identifiers and deterministic test-only secret
adapters. No test reads an environment variable or credential.

## Remaining approval gates

The sequence after this document remains deliberately separate:

1. independently review and publish this architecture/runbook;
2. reverify current provider project/model/origin controls and approve one
   exact non-secret configuration record, including approved cost controls;
3. separately authorize the exact human provider-console credential creation
   or rotation action, with no API request or project-control change;
4. separately authorize the exact secret-manager provision and privacy-safe
   current-receipt evidence update, without provider contact or activation;
5. implement and review a disabled configuration loader and secret-manager
   adapter with offline fakes while startup remains unwired;
6. separately authorize production runtime wiring while external calls and the
   route remain disabled;
7. separately authorize deployment and read-only verification;
8. independently assess migration and runtime readiness;
9. separately authorize bounded synthetic provider validation with no member
   data while the member route and feature remain disabled;
10. independently review the synthetic provider evidence and separately
    authorize feature activation;
11. separately authorize any real-member acceptance only after activation,
    with exact member, operator, environment, scope, privacy, safety, rollback,
    and observation boundaries.

No gate authorizes a later gate. Any drift in code, provider controls,
configuration, credential custody, migration state, runtime wiring, deployment,
or environment expires the relevant approval.
