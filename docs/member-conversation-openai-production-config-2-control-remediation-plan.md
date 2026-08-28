# Goals Coach OpenAI CONFIG-2 control remediation and evidence plan

## Status and authority

This document is a local, non-operational plan. It does not approve a
configuration and does not authorize a provider-console write, Admin API
request, credential action, Railway change, runtime wiring, migration,
deployment, activation, or member/live-system access.

The source inspection record is
`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-EVIDENCE-2`, SHA-256
`FAB4A6BC3874CCE94CB31A117047FDE477F6CF0D7361EF2DEECB67E88800972B`,
at code tree `76253efe297b88f1bb6f7858352f31117d7dc680`. Its decision is
`not_approvable` and its `configurationApprovalRecord` is `null`.

## Governing principles

- Every console mutation, API read, credential action, configuration approval,
  runtime change, deployment, validation, and activation is a separate gate.
- Missing, ambiguous, inaccessible, expired, or drifted evidence fails closed.
- A successful console setting does not authorize a credential, request,
  deployment, or activation.
- Provider organization, account, project, and resource identifiers never
  enter source, chat, logs, screenshots, evidence, hashes, or receipts.
- A live project identifier may be compared only ephemerally in one authorized
  authenticated session to prove that all controls describe the same project.
  It is discarded immediately and is never serialized, hashed, or printed.
- Evidence contains no credential, secret metadata, provider payload, member
  data, authenticated console export, cookie, token, or raw error.
- Production configuration and composition allowlists remain empty until a
  complete CONFIG-2 record is independently reviewed and separately approved.

## Target control set

No value in this section is approved merely because it is described here.

### Dedicated project

The target must be one active project used only for Goals Coach production
member-conversation requests. It must not be the organization default or a
shared development/staging project. A later exact console-write gate must
either create that project or prove that an existing project satisfies the
same isolation boundary. The project remains credential-free until the later
credential gates.

Required attributable evidence:

- bounded result `dedicated_project_verified`;
- abstract environment label `production`;
- project state `active`;
- purpose `goals_coach_member_conversation`;
- `sameProjectAcrossControls:true`; and
- observed-at and evidence-expiration timestamps.

### Immutable model permission

The project must explicitly permit one immutable, dated GPT-5.6-or-later
snapshot that supports `/v1/responses`, strict structured outputs, and the
reviewed cache fields. A moving alias, family name, undocumented slug, or
model shown only in public documentation is insufficient. If official OpenAI
documentation does not publish an immutable dated snapshot and the project
does not expose attributable permission for that exact snapshot, this control
remains blocked.

Required evidence binds the exact model string, the official documentation
URL and observation time, project permission `allowed`, Responses support,
strict structured-output support, and explicit prompt-cache support. The
model string is non-secret but becomes configuration authority only after
independent review and owner approval.

### Region and origin

An owner must separately select one region policy from the provider-supported
options after privacy review. The selected policy must map to one exact HTTPS
origin documented for that project and model. Wildcards, redirects, aliases,
fallback origins, inferred account location, and default-region assumptions
are invalid.

Required evidence binds, in one same-project observation:

- the bounded region-policy enum;
- the exact HTTPS origin;
- storage-region support;
- regional-processing support;
- the selected model snapshot;
- `/v1/responses`; and
- any documented eligibility, retention-control, or pricing prerequisite.

### Retention, abuse monitoring, and prompt caching

The project must expose an attributable data-retention value. Acceptable
configuration requires a separately approved project-level Zero Data
Retention decision; `store:false`, default inheritance, or absence of a
visible value is not proof of ZDR. Modified Abuse Monitoring is recorded as a
different enum and cannot be silently treated as ZDR.

The request contract remains `store:false`, `background:false`, and
`stream:false`. The cache policy remains exact explicit mode with zero
breakpoint markers. Official OpenAI documentation currently states that
`prompt_cache_options` is supported for GPT-5.6 and later, `explicit` disables
the implicit breakpoint, and the only documented `ttl` is `30m`. It also
states that prompt caching can retain encrypted GPU-local application state;
therefore cache behavior must be reviewed separately from response storage
and ZDR.

Required evidence records exact bounded enums for project retention,
organization inheritance, cache mode, cache TTL, breakpoint count, response
storage, background mode, streaming, and the official-documentation digest.
Any missing or changed value invalidates CONFIG-2.

### Audit and operator accountability

The organization/project must provide attributable audit evidence for project
creation, control changes, access changes, credential lifecycle operations,
and later activation changes. A generic API-request log or billing usage view
is not an audit trail.

Required evidence records only `auditControlEnabled:true`, bounded covered
event classes, retention/availability enum, observation and expiration times,
and a canonical evidence digest. It never records actor identity, provider
resource identity, raw events, or screenshots.

### Cost controls

The owner must separately approve exact non-negative safe-integer values for:

- `monthlySpendCeilingUsdCents`; and
- `dailyWarningThresholdUsdCents`, not greater than the monthly ceiling.

The previously discussed USD 50 monthly / USD 5 daily values are merely an
unapproved conservative proposal. They do not enter CONFIG-2 unless Derek
explicitly selects them after the provider exposes enforceable spending-limit
and visible-alert controls.

Required evidence records the approved values, `spendLimitEnabled:true`,
`visibleAlertEnabled:true`, bounded alert channel class, observation and
expiration times, same-project confirmation, and separate canonical evidence
digests. A billing balance or usage total is not a spending ceiling or alert.

## Privacy-safe attributable evidence record

After the required controls exist, a separately authorized read-only session
may create
`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONTROL-EVIDENCE-PAYLOAD-2`.
Its exact keys, in order, are:

1. `version`;
2. `environmentName`;
3. `codeTreeSha`;
4. `sameProjectAcrossControls`;
5. `dedicatedProjectStatus`;
6. `model`;
7. `modelPermission`;
8. `responsesSupported`;
9. `strictStructuredOutputsSupported`;
10. `regionPolicy`;
11. `origin`;
12. `regionalStorageSupported`;
13. `regionalProcessingSupported`;
14. `projectRetentionControl`;
15. `organizationRetentionInheritance`;
16. `promptCacheMode`;
17. `promptCacheTtl`;
18. `promptCacheBreakpointCount`;
19. `responsesStore`;
20. `background`;
21. `stream`;
22. `auditControlEnabled`;
23. `auditCoverageClass`;
24. `monthlySpendCeilingUsdCents`;
25. `dailyWarningThresholdUsdCents`;
26. `spendLimitEnabled`;
27. `visibleAlertEnabled`;
28. `alertChannelClass`;
29. `officialDocumentationSha256`;
30. `observedAt`; and
31. `expiresAt`.

Strings must be primitive, NFC, free of unpaired surrogates and prohibited
controls, and match their field-specific reviewed regex or enum. Hashes are
lowercase 64-hex strings. Booleans are primitive. Integers are non-negative
safe integers. Timestamps are canonical UTC whole-millisecond strings, with
`expiresAt` later than `observedAt` and future at parsing time.

The outer envelope has exact keys `version`, `payload`, and
`controlEvidenceSha256`, where `version` is
`GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONTROL-EVIDENCE-2` and the digest is
`SHA-256(UTF-8(JSON.stringify(payload)))`. The outer digest field is excluded
from the hash domain. Parsing reconstructs the exact ordered payload and
rejects unknown keys, coercion, proxies, accessors, malformed values, expired
evidence, or digest disagreement.

The record must contain no provider identifier or identifier digest. During
collection, every control surface is checked against one ephemeral project
identifier held only in memory. Any mismatch returns
`sameProjectAcrossControls:false`, emits no record, and stops the review.

## Canonical documentation manifest and required evidence projections

The `officialDocumentationSha256` field binds a separate exact payload named
`GC-MEMBER-CONVERSATION-OPENAI-OFFICIAL-DOCUMENTATION-MANIFEST-PAYLOAD-2`.
Its keys, in order, are `version`, `entries`, `observedAt`, and `expiresAt`.
`entries` contains exactly four objects in the following fixed order:

1. OpenAI data-controls guide,
   `https://developers.openai.com/api/docs/guides/your-data`;
2. Responses create reference,
   `https://developers.openai.com/api/reference/cli/resources/responses/methods/create`;
3. the exact selected immutable model-snapshot documentation URL; and
4. project data-retention retrieval reference,
   `https://developers.openai.com/api/reference/java/resources/admin/subresources/organization/subresources/projects/subresources/data_retention/methods/retrieve`.

Each entry has exact keys `url`, `documentObservedAt`, `claimVersion`, and
`claimSha256`. `claimVersion` is a reviewed bounded version string.
`claimSha256` is SHA-256 over UTF-8 `JSON.stringify` bytes of an independently
reviewed exact-key canonical claim payload for only the claims consumed by
CONFIG-2. Raw web pages, authenticated content, snippets, and screenshots are
not hash inputs. Entries are never reordered, deduplicated, redirected, or
substituted. The manifest digest is
`SHA-256(UTF-8(JSON.stringify(manifestPayload)))`; no outer envelope or digest
field participates. Any changed URL, claim, observation, expiry, ordering, or
selected model documentation changes the digest and requires re-review.

Every `claimSha256` uses one of the following four exact claim payloads. Each
payload is a plain object reconstructed in the listed insertion order. Its
`url` and `observedAt` must exactly equal its enclosing manifest entry's `url`
and `documentObservedAt`; its `version` must exactly equal the entry's
`claimVersion`. The digest is
`SHA-256(UTF-8(JSON.stringify(claimPayload)))`. Unknown keys, alternative
ordering, aliases, coercion, inherited values, or entry/payload mismatch fail
closed.

### Data-controls documentation claim

Version
`GC-MEMBER-CONVERSATION-OPENAI-DATA-CONTROLS-DOCUMENT-CLAIM-2` has keys:
`version`, `url`, `apiTrainingDefault`,
`abuseMonitoringDefaultMaximumRetentionDays`, `zdrRequiresProviderApproval`,
`projectRetentionControlSupported`, `responsesStoreForcedFalseUnderZdr`,
`promptCacheEncryptedGpuStatePossible`,
`promptCacheMaximumApplicationStateRetentionHours`,
`dataResidencyConfiguredPerProject`, and `observedAt`.

The exact value domains are:

- `apiTrainingDefault`: `not_used_unless_opted_in`;
- retention days: safe integer `30`;
- retention hours: safe integer `24`; and
- each remaining claim value: primitive boolean `true`.

Its URL is exactly the first manifest URL.

### Responses-reference documentation claim

Version
`GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-DOCUMENT-CLAIM-2` has keys:
`version`, `url`, `endpointPath`, `structuredOutputsSupported`,
`promptCacheOptionsMinimumModelFamily`, `promptCacheMode`,
`explicitModeDisablesImplicitBreakpoint`, `promptCacheTtl`,
`storeFalseDisablesLaterResponseRetrieval`, and `observedAt`.

The exact values are `/v1/responses`, primitive boolean `true`, `gpt-5.6`,
`explicit`, primitive boolean `true`, `30m`, primitive boolean `true`, in the
same order as their fields. Its URL is exactly the second manifest URL.

### Selected-model documentation claim

Version
`GC-MEMBER-CONVERSATION-OPENAI-MODEL-SNAPSHOT-DOCUMENT-CLAIM-2` has keys:
`version`, `url`, `model`, `immutableDatedSnapshot`, `responsesSupported`,
`strictStructuredOutputsSupported`, `promptCacheOptionsSupported`, and
`observedAt`.

`model` must equal the exact selected immutable dated GPT-5.6-or-later model
string in the control evidence and match the compiled model-snapshot syntax.
Each capability value is primitive boolean `true`. The URL must be the exact
official model page for that same snapshot and equal the third manifest URL.
An alias page, family page without a dated snapshot, or URL/model mismatch
cannot produce this claim.

### Project-retention-reference documentation claim

Version
`GC-MEMBER-CONVERSATION-OPENAI-PROJECT-RETENTION-DOCUMENT-CLAIM-2` has keys:
`version`, `url`, `method`, `pathTemplate`, `returnsProjectRetentionControl`,
`resultObjectType`, and `observedAt`.

The exact values are `GET`,
`/organization/projects/{project_id}/data_retention`, primitive boolean
`true`, and `project.data_retention`, in field order. Its URL is exactly the
fourth manifest URL. `{project_id}` is literal documentation syntax; no live
identifier is substituted into or retained by this claim.

For all claim payloads, strings are primitive, NFC, contain no unpaired
surrogate or prohibited control, and are serialized without normalization or
coercion. Safe integers use ordinary JSON decimal form. Booleans are
primitive. `observedAt` is a canonical UTC whole-millisecond timestamp equal
to the manifest entry timestamp. No claim payload contains webpage text,
provider/account/project identifiers, redirects, screenshots, or
authenticated content.

One accepted control-evidence payload deterministically produces five
separate evidence projections. Each projection is a freshly reconstructed
plain object with the exact keys below, in order, and its digest is SHA-256 of
the UTF-8 `JSON.stringify` bytes. It never includes an outer digest field or a
provider identifier.

### Budget projection

`GC-MEMBER-CONVERSATION-OPENAI-PROVIDER-BUDGET-EVIDENCE-PAYLOAD-2` keys:
`version`, `environmentName`, `sameProjectAcrossControls`,
`monthlySpendCeilingUsdCents`, `spendLimitEnabled`, `observedAt`, `expiresAt`.

- CONFIG-2 `providerBudgetEvidenceSha256` equals this projection digest.
- CONFIG-2 `costControlEvidenceObservedAt` equals its `observedAt`.

### Spending-alert projection

`GC-MEMBER-CONVERSATION-OPENAI-SPENDING-ALERT-EVIDENCE-PAYLOAD-2` keys:
`version`, `environmentName`, `sameProjectAcrossControls`,
`dailyWarningThresholdUsdCents`, `visibleAlertEnabled`, `alertChannelClass`,
`observedAt`, `expiresAt`.

- CONFIG-2 `spendingAlertEvidenceSha256` equals this projection digest.
- Its `observedAt` must equal CONFIG-2 `costControlEvidenceObservedAt` and the
  budget projection `observedAt`; unequal observations fail closed.

### Provider-control projection

`GC-MEMBER-CONVERSATION-OPENAI-PROVIDER-CONTROL-EVIDENCE-PAYLOAD-2` keys:
`version`, `environmentName`, `codeTreeSha`, `sameProjectAcrossControls`,
`dedicatedProjectStatus`, `model`, `modelPermission`, `responsesSupported`,
`strictStructuredOutputsSupported`, `regionPolicy`, `origin`,
`regionalStorageSupported`, `regionalProcessingSupported`,
`auditControlEnabled`, `auditCoverageClass`, `officialDocumentationSha256`,
`observedAt`, `expiresAt`.

- CONFIG-2 `providerControlEvidenceSha256` equals this projection digest.
- CONFIG-2 `providerControlEvidenceObservedAt` equals its `observedAt`.

### Model-snapshot projection

`GC-MEMBER-CONVERSATION-OPENAI-MODEL-SNAPSHOT-EVIDENCE-PAYLOAD-2` keys:
`version`, `environmentName`, `codeTreeSha`, `sameProjectAcrossControls`,
`model`, `modelPermission`, `responsesSupported`,
`strictStructuredOutputsSupported`, `promptCacheMode`, `promptCacheTtl`,
`officialDocumentationSha256`, `observedAt`, `expiresAt`.

- COMPOSITION-BINDING-2 `modelSnapshotEvidenceSha256` equals this projection
  digest.
- Its `model`, `codeTreeSha`, and `observedAt` must equal the corresponding
  accepted CONFIG-2/provider-control values.

### Zero-data-retention projection

`GC-MEMBER-CONVERSATION-OPENAI-ZERO-DATA-RETENTION-EVIDENCE-PAYLOAD-2` keys:
`version`, `environmentName`, `codeTreeSha`, `sameProjectAcrossControls`,
`projectRetentionControl`, `organizationRetentionInheritance`,
`promptCacheMode`, `promptCacheTtl`, `promptCacheBreakpointCount`,
`responsesStore`, `background`, `stream`, `officialDocumentationSha256`,
`observedAt`, `expiresAt`.

- COMPOSITION-BINDING-2 `zeroDataRetentionEvidenceSha256` equals this
  projection digest.
- COMPOSITION-BINDING-2 `zeroDataRetentionEvidenceObservedAt` equals its
  `observedAt`.

All five projections must derive from the same accepted
CONTROL-EVIDENCE-PAYLOAD-2 object, carry identical `environmentName`,
`codeTreeSha` where present, `sameProjectAcrossControls:true`,
`officialDocumentationSha256` where present, `observedAt`, and `expiresAt`,
and be recomputed during parsing. A caller cannot supply projection digests.
Missing, stale, independently assembled, cross-record, or mismatched
projections invalidate both CONFIG-2 and COMPOSITION-BINDING-2 before any
credential resolution, network contact, or durable authority consumption.

## Ordered remediation gates

1. Independently review this plan and the blocked evidence artifact.
2. Obtain exact owner selections for region/origin, immutable model snapshot,
   ZDR, cache policy, audit coverage, monthly ceiling, daily warning, and
   evidence expiration. This is documentation only.
3. Obtain a separate exact provider-console authorization for only the
   dedicated project and selected non-secret controls. No credential action or
   API request is included.
4. Perform the authorized console changes once, stop on ambiguity, and verify
   that no credential, API request, deployment, or activation occurred.
5. Obtain a separate read-only evidence-collection authorization. Compare the
   live project identifier ephemerally, emit only the canonical privacy-safe
   evidence payload/envelope, and independently review its bytes and digest.
6. Draft the exact CONFIG-2 payload/envelope from the approved values and
   evidence hashes. Keep configuration and binding allowlists empty.
7. Independently review and separately approve CONFIG-2. Approval does not
   authorize credential creation, provisioning, runtime wiring, deployment,
   validation, or activation.
8. Continue only with the later credential, disabled-loader, wiring,
   deployment, synthetic-validation, and activation gates in the merged
   architecture/runbook. No gate authorizes the next.

## Offline review requirements

- JSON examples and canonical vectors use synthetic values only.
- Cross-control tests prove ephemeral same-project comparison without storing,
  hashing, logging, or serializing the provider identifier.
- Missing, stale, expired, cross-project, defaulted, inherited-but-ambiguous,
  or drifted controls produce no evidence envelope.
- Cost evidence distinguishes enforceable limits and visible alerts from
  balances and usage totals.
- ZDR, response storage, prompt-cache storage, and audit logging remain four
  distinct controls.
- Production remains import-free, null/unwired, externally disabled, and has
  empty CONFIG-2 and COMPOSITION-BINDING-2 allowlists.
