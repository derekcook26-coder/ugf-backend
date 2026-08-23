"use strict";

const MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-TRANSPORT-1";
const PROVIDER_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const VERSIONED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRANSPORT_KEYS = Object.freeze([
  "dispatch",
  "model",
  "provider",
  "responseSchemaVersion",
  "version",
]);
const brandedTransports = new WeakSet();

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === keys.join("\0"));
}

function exactString(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function createMemberConversationProviderTransport(options = {}) {
  if (!exactKeys(options, TRANSPORT_KEYS)
    || options.version !== MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION
    || typeof options.dispatch !== "function") return null;

  const provider = exactString(options.provider, PROVIDER_NAME);
  const model = exactString(options.model, VERSIONED_IDENTIFIER);
  const responseSchemaVersion = exactString(
    options.responseSchemaVersion,
    VERSIONED_IDENTIFIER
  );
  if (!provider || !model || !responseSchemaVersion) return null;

  const transport = Object.freeze({
    dispatch: options.dispatch,
    externalCallsPermitted: true,
    model,
    provider,
    providerFree: false,
    responseSchemaVersion,
    runtimeWired: false,
    version: MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
  });
  brandedTransports.add(transport);
  return transport;
}

function validMemberConversationProviderTransport(value) {
  return Boolean(value && brandedTransports.has(value)
    && Object.isFrozen(value)
    && value.version === MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION
    && value.externalCallsPermitted === true
    && value.providerFree === false
    && value.runtimeWired === false
    && exactString(value.provider, PROVIDER_NAME)
    && exactString(value.model, VERSIONED_IDENTIFIER)
    && exactString(value.responseSchemaVersion, VERSIONED_IDENTIFIER)
    && typeof value.dispatch === "function");
}

module.exports = {
  MEMBER_CONVERSATION_PROVIDER_TRANSPORT_VERSION,
  createMemberConversationProviderTransport,
  validMemberConversationProviderTransport,
};
