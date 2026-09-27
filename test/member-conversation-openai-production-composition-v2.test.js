"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CONFIGURATION_PAYLOAD_KEYS,
  COMPOSITION_BINDING_PAYLOAD_KEYS,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_APPROVAL_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_APPROVAL_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_V2_VERSION,
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_V2_ALLOWLISTS,
  createMemberConversationOpenAIProductionCompositionBindingV2,
  createMemberConversationOpenAIProductionConfigurationV2,
  createProductionMemberConversationOpenAICompositionV2,
  memberConversationOpenAIProductionCompositionBindingV2Digest,
  memberConversationOpenAIProductionCompositionBindingV2MatchesConfiguration,
  memberConversationOpenAIProductionConfigurationV2Digest,
  validMemberConversationOpenAIProductionCompositionBindingV2,
  validMemberConversationOpenAIProductionConfigurationV2,
} = require("../src/goals-coach/member-conversation-openai-production-composition-v2");
const {
  MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_VERSION,
  createProductionMemberConversationOpenAIComposition,
} = require("../src/goals-coach/member-conversation-openai-production-composition");

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const digestD = "d".repeat(64);
const digestE = "e".repeat(64);
const codeTreeSha = "1".repeat(40);

function configurationPayload(overrides = {}) {
  return {
    version: MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_V2_VERSION,
    environmentName: "synthetic-production",
    compositionVersion: MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_V2_VERSION,
    credentialResolverVersion: "GC-MEMBER-CONVERSATION-OPENAI-CREDENTIAL-RESOLVER-1",
    boundedHttpInterfaceVersion: "GC-MEMBER-CONVERSATION-OPENAI-BOUNDED-HTTP-INTERFACE-1",
    httpClientVersion: "GC-MEMBER-CONVERSATION-OPENAI-HTTP-CLIENT-1",
    responsesHttpClientVersion: "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-HTTP-CLIENT-1",
    responsesClientVersion: "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-CLIENT-2",
    adapterVersion: "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ADAPTER-2",
    transportVersion: "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-TRANSPORT-2",
    requestContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2",
    resultContractVersion: "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-2",
    outputPolicyVersion: "GC-MEMBER-CONVERSATION-PROVIDER-OUTPUT-POLICY-1",
    responseContractVersion: "GC-MEMBER-CONVERSATION-TURN-RESPONSE-2",
    model: "gpt-5.6-terra-2099-01-01",
    origin: "https://api.synthetic.invalid",
    responsesPath: "/v1/responses",
    regionPolicy: "synthetic-region-1",
    promptCachePolicyVersion: "GC-MEMBER-CONVERSATION-OPENAI-PROMPT-CACHE-POLICY-1",
    promptCacheMode: "explicit",
    promptCacheBreakpointCount: 0,
    developerPromptVersion: "synthetic-prompt-2",
    developerPromptSha256: digestA,
    responseSchemaVersion: "synthetic-schema-2",
    responseSchemaSha256: digestB,
    maximumOutputCharacters: 800,
    maximumOutputBytes: 1600,
    maximumOutputTokens: 4096,
    requestHeaderBytes: 8192,
    requestBodyBytes: 4096,
    responseHeaderBytes: 8192,
    responseBodyBytes: 65536,
    adapterTimeoutMilliseconds: 25000,
    finalizationReserveMilliseconds: 1000,
    monthlySpendCeilingUsdCents: 10000,
    dailyWarningThresholdUsdCents: 500,
    providerBudgetEvidenceSha256: digestC,
    spendingAlertEvidenceSha256: digestD,
    costControlEvidenceObservedAt: "2099-01-01T00:00:00Z",
    providerControlEvidenceSha256: digestE,
    providerControlEvidenceObservedAt: "2099-01-01T00:00:01Z",
    codeTreeSha,
    migrationStateEvidenceSha256: "f".repeat(64),
    approvalExpiresAt: "2099-02-01T00:00:00Z",
    ...overrides,
  };
}

function configurationEnvelope(payload = configurationPayload(), digest) {
  return {
    version: MEMBER_CONVERSATION_OPENAI_PRODUCTION_CONFIG_APPROVAL_V2_VERSION,
    payload,
    configurationSha256: digest || sha256(JSON.stringify(payload)),
  };
}

function bindingPayload(configurationSha256, overrides = {}) {
  return {
    version: MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_V2_VERSION,
    configurationSha256,
    compositionVersion: MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_V2_VERSION,
    boundedHttpInterfaceVersion: "GC-MEMBER-CONVERSATION-OPENAI-BOUNDED-HTTP-INTERFACE-1",
    httpClientVersion: "GC-MEMBER-CONVERSATION-OPENAI-HTTP-CLIENT-1",
    responsesHttpTransportVersion: "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-HTTP-TRANSPORT-2",
    orchestratorTransportVersion: "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ORCHESTRATOR-TRANSPORT-2",
    providerRequestVersion: "GC-MEMBER-CONVERSATION-PROVIDER-REQUEST-2",
    providerTransportVersion: "GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-2",
    providerResultVersion: "GC-MEMBER-CONVERSATION-PROVIDER-RESULT-2",
    providerRejectionVersion: "GC-MEMBER-CONVERSATION-PROVIDER-REJECTION-2",
    modelSnapshotEvidenceSha256: digestA,
    zeroDataRetentionEvidenceSha256: digestB,
    zeroDataRetentionEvidenceObservedAt: "2099-01-01T00:00:02Z",
    codeTreeSha,
    ...overrides,
  };
}

function bindingEnvelope(payload, digest) {
  return {
    version: MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_BINDING_APPROVAL_V2_VERSION,
    payload,
    compositionBindingSha256: digest || sha256(JSON.stringify(payload)),
  };
}

test("CONFIG-2 and composition-binding vectors are exact and capabilities are opaque", () => {
  const configPayload = configurationPayload();
  assert.deepEqual(Object.keys(configPayload), CONFIGURATION_PAYLOAD_KEYS);
  const configCanonical = JSON.stringify(configPayload);
  const configDigest = sha256(configCanonical);
  assert.equal(Buffer.byteLength(configCanonical, "utf8"), 2490);
  assert.equal(configDigest, "9b9889b903c2a7f0d7ce945dcd5a9b6ba00ace42bf5a27351e6f2c8ed072442b");
  const configuration = createMemberConversationOpenAIProductionConfigurationV2(
    configurationEnvelope(configPayload, configDigest)
  );
  assert.equal(validMemberConversationOpenAIProductionConfigurationV2(configuration), true);
  assert.equal(memberConversationOpenAIProductionConfigurationV2Digest(configuration), configDigest);
  assert.equal(Object.isFrozen(configuration), true);
  assert.deepEqual(Reflect.ownKeys(configuration), []);
  assert.equal(JSON.stringify(configuration), "{}");

  const boundPayload = bindingPayload(configDigest);
  assert.deepEqual(Object.keys(boundPayload), COMPOSITION_BINDING_PAYLOAD_KEYS);
  const bindingCanonical = JSON.stringify(boundPayload);
  const bindingDigest = sha256(bindingCanonical);
  assert.equal(Buffer.byteLength(bindingCanonical, "utf8"), 1183);
  assert.equal(bindingDigest, "d860bd3d96c370a20875ed6d78ddd8ad8b5969adf5cedc80e2c335be3a66d8e6");
  const binding = createMemberConversationOpenAIProductionCompositionBindingV2(
    bindingEnvelope(boundPayload, bindingDigest)
  );
  assert.equal(validMemberConversationOpenAIProductionCompositionBindingV2(binding), true);
  assert.equal(memberConversationOpenAIProductionCompositionBindingV2Digest(binding), bindingDigest);
  assert.equal(memberConversationOpenAIProductionCompositionBindingV2MatchesConfiguration(
    binding, configuration
  ), true);
  assert.deepEqual(Reflect.ownKeys(binding), []);
  assert.equal(JSON.stringify(binding), "{}");
});

test("digests cover payload only and reject mutation, cross-config, V1, and lookalikes", () => {
  const payload = configurationPayload();
  const envelope = configurationEnvelope(payload);
  const configuration = createMemberConversationOpenAIProductionConfigurationV2(envelope);
  assert.ok(configuration);
  assert.equal(createMemberConversationOpenAIProductionConfigurationV2({
    ...envelope,
    configurationSha256: digestA,
  }), null);
  assert.equal(createMemberConversationOpenAIProductionConfigurationV2({
    ...envelope,
    version: "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-CONFIG-1",
  }), null);
  assert.equal(validMemberConversationOpenAIProductionConfigurationV2(Object.freeze({})), false);

  const secondPayload = configurationPayload({ developerPromptSha256: digestE });
  const second = createMemberConversationOpenAIProductionConfigurationV2(
    configurationEnvelope(secondPayload)
  );
  const boundPayload = bindingPayload(envelope.configurationSha256);
  const binding = createMemberConversationOpenAIProductionCompositionBindingV2(
    bindingEnvelope(boundPayload)
  );
  assert.equal(memberConversationOpenAIProductionCompositionBindingV2MatchesConfiguration(
    binding, second
  ), false);
  assert.equal(createMemberConversationOpenAIProductionCompositionBindingV2({
    ...bindingEnvelope(boundPayload),
    compositionBindingSha256: digestC,
  }), null);
  assert.equal(validMemberConversationOpenAIProductionCompositionBindingV2(Object.freeze({})), false);
});

test("CONFIG-2 enforces every compiled boundary and synchronous expiration", () => {
  const accepted = [
    configurationPayload({ requestHeaderBytes: 16384 }),
    configurationPayload({ requestBodyBytes: 262144 }),
    configurationPayload({ responseHeaderBytes: 32768 }),
    configurationPayload({ responseBodyBytes: 262144 }),
    configurationPayload({ adapterTimeoutMilliseconds: 25000,
      finalizationReserveMilliseconds: 5000 }),
  ];
  for (const payload of accepted) {
    assert.ok(createMemberConversationOpenAIProductionConfigurationV2(
      configurationEnvelope(payload)
    ));
  }

  const rejected = [
    configurationPayload({ maximumOutputCharacters: 801 }),
    configurationPayload({ maximumOutputBytes: 1601 }),
    configurationPayload({ maximumOutputTokens: 4097 }),
    configurationPayload({ requestHeaderBytes: 16385 }),
    configurationPayload({ requestBodyBytes: 262145 }),
    configurationPayload({ responseHeaderBytes: 32769 }),
    configurationPayload({ responseBodyBytes: 262145 }),
    configurationPayload({ adapterTimeoutMilliseconds: 25001 }),
    configurationPayload({ finalizationReserveMilliseconds: 5001 }),
    configurationPayload({ approvalExpiresAt: "2000-01-01T00:00:00Z" }),
  ];
  for (const payload of rejected) {
    assert.equal(createMemberConversationOpenAIProductionConfigurationV2(
      configurationEnvelope(payload)
    ), null);
  }
});

test("proxy, accessor, callable, symbol, and malformed scalar adversaries fail without observation", () => {
  let observations = 0;
  const proxy = new Proxy(configurationPayload(), {
    ownKeys() { observations += 1; throw new Error("observed proxy"); },
  });
  assert.equal(createMemberConversationOpenAIProductionConfigurationV2(
    configurationEnvelope(proxy, digestA)
  ), null);
  assert.equal(observations, 0);

  const accessor = configurationPayload();
  Object.defineProperty(accessor, "model", {
    enumerable: true,
    get() { observations += 1; throw new Error("observed accessor"); },
  });
  assert.equal(createMemberConversationOpenAIProductionConfigurationV2(
    configurationEnvelope(accessor, digestA)
  ), null);
  assert.equal(observations, 0);

  for (const malformed of [
    configurationPayload({ developerPromptSha256: { toString() { observations += 1; return digestA; } } }),
    configurationPayload({ responseSchemaSha256() {} }),
    configurationPayload({ model: "latest" }),
    configurationPayload({ model: "gpt-5.6" }),
    configurationPayload({ model: "gpt-5.5-terra-2099-01-01" }),
    configurationPayload({ model: "synthetic-model-2099-01-01" }),
    configurationPayload({ model: "gpt-5.6-terra-2099-02-30" }),
    configurationPayload({ model: "gpt-5.6-terra-\ud83d\ude80-2099-01-01" }),
    configurationPayload({ origin: "http://api.synthetic.invalid" }),
    configurationPayload({ finalizationReserveMilliseconds: 30000 }),
    configurationPayload({ dailyWarningThresholdUsdCents: 10001 }),
  ]) {
    assert.equal(createMemberConversationOpenAIProductionConfigurationV2(
      configurationEnvelope(malformed, digestA)
    ), null);
  }
  assert.equal(observations, 0);

  const withSymbol = configurationPayload();
  withSymbol[Symbol("unexpected")] = "value";
  assert.equal(createMemberConversationOpenAIProductionConfigurationV2(
    configurationEnvelope(withSymbol, digestA)
  ), null);
});

test("production V2 composition remains exact, disabled, immutable, and input-oblivious", () => {
  assert.deepEqual(MEMBER_CONVERSATION_OPENAI_PRODUCTION_V2_ALLOWLISTS, {
    compositionBindingDigests: [],
    configurationDigests: [],
  });
  assert.equal(Object.isFrozen(MEMBER_CONVERSATION_OPENAI_PRODUCTION_V2_ALLOWLISTS), true);
  for (const item of Object.values(MEMBER_CONVERSATION_OPENAI_PRODUCTION_V2_ALLOWLISTS)) {
    assert.equal(Object.isFrozen(item), true);
  }
  let observed = 0;
  const input = {};
  Object.defineProperty(input, "configuration", {
    enumerable: true,
    get() { observed += 1; throw new Error("must not inspect"); },
  });
  const composition = createProductionMemberConversationOpenAICompositionV2(input);
  assert.equal(observed, 0);
  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(composition, {
    adapter: null,
    credentialResolver: null,
    externalCallsPermitted: false,
    httpClient: null,
    httpTransport: null,
    orchestrator: null,
    providerFree: true,
    reason: "production_configuration_unavailable",
    requestFactory: null,
    runtimeWired: false,
    status: "disabled",
    transport: null,
    version: MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_V2_VERSION,
  });
});

test("V1 remains immutable and production startup remains V2 import-free and null-unwired", () => {
  assert.equal(MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_VERSION,
    "GC-MEMBER-CONVERSATION-OPENAI-PRODUCTION-COMPOSITION-1");
  assert.equal(createProductionMemberConversationOpenAIComposition().version,
    MEMBER_CONVERSATION_OPENAI_PRODUCTION_COMPOSITION_VERSION);
  const root = path.resolve(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const startup = fs.readFileSync(
    path.join(root, "src/goals-coach/gymmaster-member-conversation-turn-startup.js"),
    "utf8"
  );
  assert.doesNotMatch(server, /member-conversation-openai-production-composition-v2/);
  assert.doesNotMatch(startup, /member-conversation-openai-production-composition-v2/);
  assert.match(server, /idempotency:\s*null/);
  assert.match(server, /provider:\s*null/);
});
