"use strict";

const { MEMBER_COACHING_CONSENT_NOTICE_VERSION } = require("./gymmaster-member-coaching-consent");
const { MEMBER_SAFETY_NOTICE_VERSION } = require("./gymmaster-member-safety-intake");
const { MEMBER_CONVERSATION_TURN_CONTRACT_VERSION } = require("./member-conversation-turn-contract");

function validCurrentMembership(value) {
  return Boolean(value
    && value.contractVersion === MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    && value.source === "gymmaster_gatekeeper"
    && value.readOnly === true
    && value.currentRequestVerification === true
    && typeof value.verify === "function");
}

function validCurrentConsent(value) {
  return Boolean(value
    && value.contractVersion === MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    && value.noticeVersion === MEMBER_COACHING_CONSENT_NOTICE_VERSION
    && value.providerFree === true
    && value.readOnly === true
    && value.currentAcceptedConsentRequired === true
    && typeof value.verify === "function");
}

function validCurrentSafetyEligibility(value) {
  return Boolean(value
    && value.contractVersion === MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    && value.noticeVersion === MEMBER_SAFETY_NOTICE_VERSION
    && value.providerFree === true
    && value.readOnly === true
    && value.currentScreenCompleteRequired === true
    && typeof value.verify === "function");
}

function exactPositiveResult(value, key) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && value[key] === true);
}

function validCurrentMembershipResult(value) { return exactPositiveResult(value, "active"); }
function validCurrentConsentResult(value) { return exactPositiveResult(value, "accepted"); }
function validCurrentSafetyEligibilityResult(value) { return exactPositiveResult(value, "eligible"); }

module.exports = {
  validCurrentConsent,
  validCurrentConsentResult,
  validCurrentMembership,
  validCurrentMembershipResult,
  validCurrentSafetyEligibility,
  validCurrentSafetyEligibilityResult,
};
