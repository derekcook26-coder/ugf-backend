"use strict";

const {
  MEMBER_CONVERSATION_COACHING_MAXIMUM_BYTES,
  MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS,
} = require("./member-conversation-provider-result");

const MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION =
  "GC-MEMBER-CONVERSATION-PROVIDER-OUTPUT-POLICY-1";
const INPUT_KEYS = Object.freeze(["coaching", "version"]);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const HIDDEN_DIGEST = /\b[0-9a-f]{64}\b/i;
const PROHIBITED_CONTENT = Object.freeze([
  /\b(?:human|coach|trainer|staff|clinician|doctor)\b.{0,40}\b(?:reviewed|received|notified|alerted|reviewing)\b/i,
  /\b(?:diagnos(?:e|ed|is)|prescrib(?:e|ed|ing)|medical advice|treat(?:ment|ing)?)\b/i,
  /\b(?:guarantee(?:d)?|promise(?:d)?)\b/i,
  /\b(?:ignore|disregard|override|violate)\b.{0,40}\b(?:restriction|limitation|instruction|medical advice)\b/i,
  /\b(?:push|work|train|exercise|continue)\b.{0,40}\b(?:through|despite)\b.{0,40}\b(?:pain|numbness|tingling|weakness|instability|symptoms?)\b/i,
  /https?:\/\/|www\.|(?:^|\s)\[[^\]]+\]\([^)]+\)/i,
  /\b(?:tool[_ -]?call|function[_ -]?call|retrieval|attachment|transcript)\b/i,
  UUID,
  HIDDEN_DIGEST,
]);

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === keys.join("\0"));
}

function parseMemberConversationProviderOutput(value = {}) {
  if (!exactKeys(value, INPUT_KEYS)
    || value.version !== MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION
    || typeof value.coaching !== "string"
    || value.coaching.length === 0
    || value.coaching !== value.coaching.trim()
    || value.coaching !== value.coaching.normalize("NFC")
    || /[\uD800-\uDFFF]/u.test(value.coaching)
    || [...value.coaching].length > MEMBER_CONVERSATION_COACHING_MAXIMUM_CHARACTERS
    || Buffer.byteLength(value.coaching, "utf8")
      > MEMBER_CONVERSATION_COACHING_MAXIMUM_BYTES
    || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value.coaching)
    || PROHIBITED_CONTENT.some((pattern) => pattern.test(value.coaching))) return null;
  return Object.freeze({
    coaching: value.coaching,
    version: MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION,
  });
}

module.exports = {
  MEMBER_CONVERSATION_PROVIDER_OUTPUT_POLICY_VERSION,
  parseMemberConversationProviderOutput,
};
