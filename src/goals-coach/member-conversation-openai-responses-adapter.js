"use strict";

const { createHash } = require("node:crypto");
const {
  monotonicNow,
  positiveRemainingMilliseconds,
} = require("./bounded-postgres-transaction");
const {
  MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
  createMemberConversationProviderRequest,
  validMemberConversationProviderRequest,
} = require("./member-conversation-provider-request-envelope");
const {
  MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS,
  MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
  createMemberConversationProviderResult,
  memberConversationProviderResultAuthorityMatchesRequest,
  revokeMemberConversationProviderResultAuthority,
  validMemberConversationProviderResultAuthority,
} = require("./member-conversation-provider-result");
const {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION,
  parseMemberConversationProviderOutput,
} = require("./member-conversation-provider-output-policy");
const {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
} = require("./member-conversation-provider-transport");

const MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-ADAPTER-1";
const MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-RESPONSES-CLIENT-1";
const VERSIONED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROVIDER_IDENTIFIER = /^[\x21-\x7e]{1,255}$/;
const ADAPTER_KEYS = Object.freeze(["client", "policy", "version"]);
const ADAPTER_REQUEST_KEYS = Object.freeze(["attemptId", "turnRequest", "turnResponse"]);
const CLIENT_KEYS = Object.freeze([
  "automaticRetries", "createResponse", "maximumAttempts", "version",
]);
const POLICY_KEYS = Object.freeze([
  "developerPrompt", "developerPromptSha256", "developerPromptVersion",
  "finalizationReserveMilliseconds", "maxOutputTokens", "model",
  "outputPolicyVersion", "regionPolicy", "responseSchema",
  "responseSchemaSha256", "responseSchemaVersion", "timeoutMilliseconds",
]);
const EXECUTE_KEYS = Object.freeze(["authority", "request"]);
const OPERATION_KEYS = Object.freeze(["outerDeadlineNs", "signal"]);
const CLIENT_RESULT_KEYS = Object.freeze([
  "output", "providerRequestId", "providerResponseId",
]);
const OUTPUT_KEYS = Object.freeze(["coaching"]);
const SCHEMA_KEYS = Object.freeze([
  "additionalProperties", "properties", "required", "type",
]);
const SCHEMA_PROPERTY_KEYS = Object.freeze(["coaching"]);
const SCHEMA_COACHING_KEYS = Object.freeze(["maxLength", "type"]);
const brandedClients = new WeakSet();
const brandedAdapters = new WeakMap();
const consumedAuthorities = new WeakSet();

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return exactObject(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactIdentifier(value) {
  return typeof value === "string" && VERSIONED_IDENTIFIER.test(value);
}

function strictResponseSchema(value) {
  if (!exactKeys(value, SCHEMA_KEYS)
    || value.type !== "object" || value.additionalProperties !== false
    || !Array.isArray(value.required) || value.required.length !== 1
    || value.required[0] !== "coaching"
    || !exactKeys(value.properties, SCHEMA_PROPERTY_KEYS)
    || !exactKeys(value.properties.coaching, SCHEMA_COACHING_KEYS)
    || value.properties.coaching.type !== "string"
    || value.properties.coaching.maxLength
      !== MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS) return null;
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["coaching"]),
    properties: Object.freeze({
      coaching: Object.freeze({
        type: "string",
        maxLength: MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS,
      }),
    }),
  });
}

function normalizedPolicy(value) {
  if (!exactKeys(value, POLICY_KEYS)
    || !exactIdentifier(value.model)
    || !exactIdentifier(value.developerPromptVersion)
    || !PROVIDER_SCHEMA_NAME.test(value.responseSchemaVersion || "")
    || value.outputPolicyVersion !== MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION
    || !exactIdentifier(value.regionPolicy)
    || typeof value.developerPrompt !== "string"
    || value.developerPrompt.length === 0
    || value.developerPrompt !== value.developerPrompt.trim()
    || !Number.isSafeInteger(value.maxOutputTokens)
    || value.maxOutputTokens < 1
    || value.maxOutputTokens > 4096
    || !Number.isSafeInteger(value.timeoutMilliseconds)
    || value.timeoutMilliseconds < 1 || value.timeoutMilliseconds > 25000
    || !Number.isSafeInteger(value.finalizationReserveMilliseconds)
    || value.finalizationReserveMilliseconds < 1
    || value.finalizationReserveMilliseconds >= value.timeoutMilliseconds
    || !SHA256.test(value.developerPromptSha256 || "")
    || !SHA256.test(value.responseSchemaSha256 || "")
    || digest(value.developerPrompt) !== value.developerPromptSha256) return null;
  const responseSchema = strictResponseSchema(value.responseSchema);
  if (!responseSchema
    || digest(JSON.stringify(responseSchema)) !== value.responseSchemaSha256) return null;
  return Object.freeze({
    model: value.model,
    developerPromptVersion: value.developerPromptVersion,
    developerPromptSha256: value.developerPromptSha256,
    developerPrompt: value.developerPrompt,
    responseSchemaVersion: value.responseSchemaVersion,
    responseSchemaSha256: value.responseSchemaSha256,
    responseSchema,
    outputPolicyVersion: value.outputPolicyVersion,
    maxOutputTokens: value.maxOutputTokens,
    regionPolicy: value.regionPolicy,
    finalizationReserveMilliseconds: value.finalizationReserveMilliseconds,
    timeoutMilliseconds: value.timeoutMilliseconds,
  });
}

function validOperation(value) {
  return exactKeys(value, OPERATION_KEYS)
    && typeof value.outerDeadlineNs === "bigint"
    && value.signal instanceof AbortSignal;
}

function createMemberConversationOpenAIResponsesClient(value = {}) {
  if (!exactKeys(value, CLIENT_KEYS)
    || value.version !== MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION
    || value.automaticRetries !== false
    || value.maximumAttempts !== 1
    || typeof value.createResponse !== "function") return null;
  const client = Object.freeze({
    createResponse: value.createResponse,
    automaticRetries: false,
    externalCallsPermitted: true,
    maximumAttempts: 1,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
  });
  brandedClients.add(client);
  return client;
}

function validMemberConversationOpenAIResponsesClient(value) {
  return Boolean(value && brandedClients.has(value) && Object.isFrozen(value)
    && value.version === MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION
    && value.automaticRetries === false && value.maximumAttempts === 1
    && value.externalCallsPermitted === true && value.runtimeWired === false
    && typeof value.createResponse === "function");
}

function requestMatchesPolicy(request, policy) {
  return request.model === policy.model
    && request.developerPromptVersion === policy.developerPromptVersion
    && request.developerPromptSha256 === policy.developerPromptSha256
    && request.responseSchemaVersion === policy.responseSchemaVersion
    && request.responseSchemaSha256 === policy.responseSchemaSha256
    && request.controls.maxOutputTokens === policy.maxOutputTokens
    && request.regionPolicy === policy.regionPolicy;
}

function providerRequest(request, policy, signal) {
  return Object.freeze({
    body: Object.freeze({
      model: policy.model,
      input: Object.freeze([
        Object.freeze({ role: "developer", content: policy.developerPrompt }),
        Object.freeze({ role: "user", content: request.memberTurn }),
      ]),
      text: Object.freeze({
        format: Object.freeze({
          type: "json_schema",
          name: policy.responseSchemaVersion,
          strict: true,
          schema: policy.responseSchema,
        }),
      }),
      max_output_tokens: policy.maxOutputTokens,
      store: false,
      background: false,
      stream: false,
      truncation: "disabled",
      tools: Object.freeze([]),
    }),
    clientRequestId: request.attemptId,
    regionPolicy: policy.regionPolicy,
    signal,
  });
}

function parseClientResult(value) {
  return exactKeys(value, CLIENT_RESULT_KEYS)
    && exactKeys(value.output, OUTPUT_KEYS)
    && PROVIDER_IDENTIFIER.test(value.providerRequestId || "")
    && PROVIDER_IDENTIFIER.test(value.providerResponseId || "")
    && typeof value.output.coaching === "string"
    ? value : null;
}

function createMemberConversationOpenAIResponsesAdapter(value = {}) {
  if (!exactKeys(value, ADAPTER_KEYS)
    || value.version !== MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION
    || !validMemberConversationOpenAIResponsesClient(value.client)) return null;
  const policy = normalizedPolicy(value.policy);
  if (!policy) return null;
  const client = value.client;

  async function execute(input = {}, operation = {}) {
    if (!exactKeys(input, EXECUTE_KEYS)
      || !validMemberConversationProviderRequest(input.request)
      || !validMemberConversationProviderResultAuthority(input.authority)
      || !memberConversationProviderResultAuthorityMatchesRequest(
        input.authority, input.request
      )
      || !requestMatchesPolicy(input.request, policy)
      || !validOperation(operation)
      || consumedAuthorities.has(input.authority)) return null;
    consumedAuthorities.add(input.authority);
    const startedAtNs = monotonicNow();
    const sharedRemaining = positiveRemainingMilliseconds(
      operation.outerDeadlineNs, startedAtNs
    );
    const adapterRemaining = policy.timeoutMilliseconds
      - policy.finalizationReserveMilliseconds;
    if (operation.signal.aborted || sharedRemaining === null
      || sharedRemaining <= policy.finalizationReserveMilliseconds) {
      revokeMemberConversationProviderResultAuthority(input.authority);
      return null;
    }
    const remaining = Math.min(
      sharedRemaining - policy.finalizationReserveMilliseconds,
      adapterRemaining
    );
    const providerDeadlineNs = startedAtNs + BigInt(remaining) * 1000000n;
    const controller = new AbortController();
    let timer;
    const timedOut = Symbol("member_conversation_openai_responses_timeout");
    const aborted = Symbol("member_conversation_openai_responses_aborted");
    let resolveAbort;
    const cancellation = new Promise((resolve) => { resolveAbort = resolve; });
    const abort = () => {
      controller.abort();
      resolveAbort(aborted);
    };
    operation.signal.addEventListener("abort", abort, { once: true });
    if (operation.signal.aborted) abort();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(timedOut);
      }, remaining);
    });
    const pending = Promise.resolve()
      .then(() => {
        const sharedBeforeContact = positiveRemainingMilliseconds(
          operation.outerDeadlineNs, monotonicNow()
        );
        if (operation.signal.aborted || controller.signal.aborted
          || sharedBeforeContact === null
          || sharedBeforeContact <= policy.finalizationReserveMilliseconds
          || positiveRemainingMilliseconds(providerDeadlineNs, monotonicNow()) === null
          || !memberConversationProviderResultAuthorityMatchesRequest(
            input.authority, input.request
          )) throw new Error("Provider contact authority expired");
        return client.createResponse(
          providerRequest(input.request, policy, controller.signal),
          Object.freeze({
            outerDeadlineNs: operation.outerDeadlineNs,
            signal: controller.signal,
          })
        );
      })
      .then((result) => ({ result }), () => ({ failed: true }));
    const winner = await Promise.race([pending, timeout, cancellation]);
    clearTimeout(timer);
    operation.signal.removeEventListener("abort", abort);
    if (winner === timedOut || winner === aborted) {
      revokeMemberConversationProviderResultAuthority(input.authority);
      pending.then(() => {}, () => {});
      return null;
    }
    if (winner.failed) {
      revokeMemberConversationProviderResultAuthority(input.authority);
      return null;
    }
    const raw = winner.result;
    const sharedAfterResult = positiveRemainingMilliseconds(
      operation.outerDeadlineNs, monotonicNow()
    );
    if (operation.signal.aborted || sharedAfterResult === null
      || sharedAfterResult <= policy.finalizationReserveMilliseconds
      || positiveRemainingMilliseconds(providerDeadlineNs, monotonicNow()) === null
      || !memberConversationProviderResultAuthorityMatchesRequest(
        input.authority, input.request
      )) {
      revokeMemberConversationProviderResultAuthority(input.authority);
      return null;
    }
    const parsed = parseClientResult(raw);
    if (!parsed) {
      revokeMemberConversationProviderResultAuthority(input.authority);
      return null;
    }
    const approved = parseMemberConversationProviderOutput({
      coaching: parsed.output.coaching,
      version: policy.outputPolicyVersion,
    });
    if (!approved) {
      revokeMemberConversationProviderResultAuthority(input.authority);
      return null;
    }
    const result = createMemberConversationProviderResult({
      version: MEMBER_CONVERSATION_PROVIDER_RESULT_VERSION,
      authority: input.authority,
      coaching: approved.coaching,
      providerRequestId: parsed.providerRequestId,
      providerResponseId: parsed.providerResponseId,
    });
    if (!result) revokeMemberConversationProviderResultAuthority(input.authority);
    return result;
  }

  const adapter = Object.freeze({
    execute,
    externalCallsPermitted: true,
    model: policy.model,
    provider: "openai",
    providerFree: false,
    responseSchemaVersion: policy.responseSchemaVersion,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION,
  });
  brandedAdapters.set(adapter, { policy });
  return adapter;
}

function createMemberConversationOpenAIResponsesRequest(adapter, value = {}) {
  const state = adapter && brandedAdapters.get(adapter);
  if (!state || !exactKeys(value, ADAPTER_REQUEST_KEYS)) return null;
  const policy = state.policy;
  return createMemberConversationProviderRequest({
    version: MEMBER_CONVERSATION_PROVIDER_REQUEST_VERSION,
    transportVersion: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
    attemptId: value.attemptId,
    model: policy.model,
    developerPromptVersion: policy.developerPromptVersion,
    developerPromptSha256: policy.developerPromptSha256,
    responseSchemaVersion: policy.responseSchemaVersion,
    responseSchemaSha256: policy.responseSchemaSha256,
    turnRequest: value.turnRequest,
    turnResponse: value.turnResponse,
    controls: {
      background: false,
      conversation: null,
      maxOutputTokens: policy.maxOutputTokens,
      metadata: null,
      previousResponseId: null,
      store: false,
      stream: false,
      tools: [],
      truncation: "disabled",
    },
    regionPolicy: policy.regionPolicy,
  });
}

function validMemberConversationOpenAIResponsesAdapter(value) {
  return Boolean(value && brandedAdapters.has(value) && Object.isFrozen(value)
    && value.version === MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION
    && value.externalCallsPermitted === true && value.providerFree === false
    && value.runtimeWired === false && value.provider === "openai"
    && exactIdentifier(value.model) && exactIdentifier(value.responseSchemaVersion)
    && typeof value.execute === "function");
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_RESPONSES_ADAPTER_VERSION,
  MEMBER_CONVERSATION_OPENAI_RESPONSES_CLIENT_VERSION,
  createMemberConversationOpenAIResponsesAdapter,
  createMemberConversationOpenAIResponsesRequest,
  createMemberConversationOpenAIResponsesClient,
  validMemberConversationOpenAIResponsesAdapter,
  validMemberConversationOpenAIResponsesClient,
};
