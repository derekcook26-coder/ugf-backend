"use strict";

const {
  MEMBER_SAFETY_INTAKE_RULE_VERSION,
  MEMBER_SAFETY_NOTICE_VERSION,
} = require("./gymmaster-member-safety-intake");
const {
  MEMBER_COACHING_CONSENT_NOTICE_VERSION,
} = require("./gymmaster-member-coaching-consent");

const MEMBER_BOOTSTRAP_CONTRACT_VERSION = "GC-MEMBER-BOOTSTRAP-1";
const MEMBER_TODAY_CONTRACT_VERSION = "GC-MEMBER-TODAY-1";
const MEMBER_CONVERSATION_CONTRACT_VERSION = "GC-PHASE1B-CONTRACT-1";
const MEMBER_BOOTSTRAP_MAXIMUM_BYTES = 2048;
const ACCESS_CLASS = "authenticated_member";
const CAPABILITY_NAMES = Object.freeze(["consent", "safety", "workout", "conversation"]);
const ROOT_KEYS = Object.freeze(["contractVersion", "accessClass", "capabilities", "requiredVersions"]);
const CAPABILITY_KEYS = Object.freeze(["status", "reason"]);
const VERSION_KEYS = Object.freeze([
  "consentNotice",
  "safetyNotice",
  "safetyRule",
  "workoutContract",
  "conversationContract",
]);
const REASONS = Object.freeze({
  consent: Object.freeze({ disabled: "consent_disabled", unavailable: "consent_unavailable" }),
  safety: Object.freeze({ disabled: "safety_disabled", unavailable: "safety_unavailable" }),
  workout: Object.freeze({ disabled: "workout_disabled", unavailable: "workout_unavailable" }),
  conversation: Object.freeze({
    disabled: "conversation_disabled",
    unavailable: "conversation_unavailable",
    productionRouteUnavailable: "production_route_unavailable",
  }),
});

function exactObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return exactObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function invalidContract() {
  const error = new Error("Invalid member bootstrap contract");
  error.code = "MEMBER_BOOTSTRAP_CONTRACT_INVALID";
  return error;
}

function parseCapability(name, value) {
  if (!exactKeys(value, CAPABILITY_KEYS) || !["disabled", "unavailable", "ready"].includes(value.status)) {
    throw invalidContract();
  }
  const allowedUnavailableReasons = [REASONS[name].unavailable, "dependencies_unavailable"];
  if (name === "conversation") allowedUnavailableReasons.push(REASONS.conversation.productionRouteUnavailable);
  if ((value.status === "ready" && value.reason !== null)
    || (value.status === "disabled" && value.reason !== REASONS[name].disabled)
    || (value.status === "unavailable" && !allowedUnavailableReasons.includes(value.reason))) {
    throw invalidContract();
  }
  return Object.freeze({ status: value.status, reason: value.reason });
}

function parseMemberBootstrap(value) {
  if (!exactKeys(value, ROOT_KEYS)
    || value.contractVersion !== MEMBER_BOOTSTRAP_CONTRACT_VERSION
    || value.accessClass !== ACCESS_CLASS
    || !exactKeys(value.capabilities, CAPABILITY_NAMES)
    || !exactKeys(value.requiredVersions, VERSION_KEYS)) {
    throw invalidContract();
  }
  const capabilities = Object.freeze(Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [name, parseCapability(name, value.capabilities[name])])
  ));
  if ((capabilities.workout.status === "ready"
      && (capabilities.consent.status !== "ready" || capabilities.safety.status !== "ready"))
    || (capabilities.conversation.status === "ready"
      && CAPABILITY_NAMES.slice(0, 3).some((name) => capabilities[name].status !== "ready"))) {
    throw invalidContract();
  }
  const expectedVersions = {
    consentNotice: MEMBER_COACHING_CONSENT_NOTICE_VERSION,
    safetyNotice: MEMBER_SAFETY_NOTICE_VERSION,
    safetyRule: MEMBER_SAFETY_INTAKE_RULE_VERSION,
    workoutContract: MEMBER_TODAY_CONTRACT_VERSION,
    conversationContract: MEMBER_CONVERSATION_CONTRACT_VERSION,
  };
  if (VERSION_KEYS.some((key) => value.requiredVersions[key] !== expectedVersions[key])) {
    throw invalidContract();
  }
  const parsed = {
    contractVersion: MEMBER_BOOTSTRAP_CONTRACT_VERSION,
    accessClass: ACCESS_CLASS,
    capabilities,
    requiredVersions: Object.freeze(expectedVersions),
  };
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MEMBER_BOOTSTRAP_MAXIMUM_BYTES) {
    throw invalidContract();
  }
  return Object.freeze(parsed);
}

function routeCapability(name, startup, origin) {
  if (!startup || startup.status === "disabled") {
    return { status: "disabled", reason: REASONS[name].disabled };
  }
  if (startup.status === "ready_for_separate_route_composition"
    && typeof startup.router === "function" && startup.origin === origin) {
    return { status: "ready", reason: null };
  }
  return { status: "unavailable", reason: REASONS[name].unavailable };
}

function conversationCapability(startup, origin) {
  if (startup && startup.status === "disabled") {
    return { status: "disabled", reason: REASONS.conversation.disabled };
  }
  if (startup && startup.status === "ready_for_separate_route_composition"
    && typeof startup.router === "function" && startup.origin === origin) {
    return { status: "ready", reason: null };
  }
  return { status: "unavailable", reason: REASONS.conversation.productionRouteUnavailable };
}

function createMemberBootstrap(options = {}) {
  const consent = routeCapability("consent", options.consentStartup, options.origin);
  const safety = routeCapability("safety", options.safetyStartup, options.origin);
  let workout = routeCapability("workout", options.workoutStartup, options.origin);
  if (workout.status === "ready" && (consent.status !== "ready" || safety.status !== "ready")) {
    workout = { status: "unavailable", reason: "dependencies_unavailable" };
  }
  let conversation = conversationCapability(options.conversationStartup, options.origin);
  if (conversation.status === "ready" && [consent, safety, workout].some((item) => item.status !== "ready")) {
    conversation = { status: "unavailable", reason: "dependencies_unavailable" };
  }
  return parseMemberBootstrap({
    contractVersion: MEMBER_BOOTSTRAP_CONTRACT_VERSION,
    accessClass: ACCESS_CLASS,
    capabilities: { consent, safety, workout, conversation },
    requiredVersions: {
      consentNotice: MEMBER_COACHING_CONSENT_NOTICE_VERSION,
      safetyNotice: MEMBER_SAFETY_NOTICE_VERSION,
      safetyRule: MEMBER_SAFETY_INTAKE_RULE_VERSION,
      workoutContract: MEMBER_TODAY_CONTRACT_VERSION,
      conversationContract: MEMBER_CONVERSATION_CONTRACT_VERSION,
    },
  });
}

module.exports = {
  ACCESS_CLASS,
  CAPABILITY_NAMES,
  MEMBER_BOOTSTRAP_CONTRACT_VERSION,
  MEMBER_BOOTSTRAP_MAXIMUM_BYTES,
  MEMBER_CONVERSATION_CONTRACT_VERSION,
  MEMBER_TODAY_CONTRACT_VERSION,
  REASONS,
  createMemberBootstrap,
  parseMemberBootstrap,
};
