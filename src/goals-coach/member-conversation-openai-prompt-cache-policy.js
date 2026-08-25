"use strict";

const { types: { isProxy } } = require("node:util");

const MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION =
  "GC-MEMBER-CONVERSATION-OPENAI-PROMPT-CACHE-POLICY-1";
const POLICY_KEYS = Object.freeze(["breakpointCount", "mode", "version"]);
const brandedPolicies = new WeakSet();

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")
    || ownKeys.slice().sort().join("\0") !== keys.join("\0")) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key]
    && descriptors[key].enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptors[key], "value")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "get")
    && !Object.prototype.hasOwnProperty.call(descriptors[key], "set"));
}

function validMemberConversationOpenAIPromptCachePolicy(value) {
  return Boolean(value && brandedPolicies.has(value) && Object.isFrozen(value)
    && exactKeys(value, POLICY_KEYS)
    && value.version === MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION
    && value.mode === "explicit"
    && value.breakpointCount === 0);
}

function createMemberConversationOpenAIPromptCachePolicy(value = {}) {
  try {
    if (!exactKeys(value, POLICY_KEYS)
      || value.version !== MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION
      || value.mode !== "explicit"
      || value.breakpointCount !== 0) return null;
    const policy = Object.freeze({
      version: MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
      mode: "explicit",
      breakpointCount: 0,
    });
    brandedPolicies.add(policy);
    return policy;
  } catch (_) { return null; }
}

function readMemberConversationOpenAIPromptCachePolicy(value) {
  if (!validMemberConversationOpenAIPromptCachePolicy(value)) return null;
  return Object.freeze({
    version: value.version,
    mode: value.mode,
    breakpointCount: value.breakpointCount,
  });
}

module.exports = {
  MEMBER_CONVERSATION_OPENAI_PROMPT_CACHE_POLICY_VERSION,
  createMemberConversationOpenAIPromptCachePolicy,
  readMemberConversationOpenAIPromptCachePolicy,
  validMemberConversationOpenAIPromptCachePolicy,
};
