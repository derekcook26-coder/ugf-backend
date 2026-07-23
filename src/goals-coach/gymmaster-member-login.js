"use strict";

const { MEMBER_PORTAL_FAILURE_STAGES } = require("./gymmaster-member-portal-client");

const GYMMASTER_AUTH_PROVIDER = "gymmaster";
const GYMMASTER_AUTH_SUBJECT_PREFIX = "gymmaster:";
const MAXIMUM_EMAIL_LENGTH = 320;
const MAXIMUM_PASSWORD_LENGTH = 1024;
const MEMBER_PORTAL_REQUEST_FAILURE = "member_portal_request_failure";

function loginError(code, memberPortalFailureStage) {
  const error = new Error("Member login could not be completed");
  error.code = code;
  error.statusCode = code === "GYMMASTER_MEMBER_LOGIN_NOT_AVAILABLE" ? 503 : 401;
  error.exposeMessage = true;
  if (typeof memberPortalFailureStage === "string") {
    error.memberPortalFailureStage = memberPortalFailureStage;
  }
  return error;
}

function normalizedEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!email || email.length > MAXIMUM_EMAIL_LENGTH || !email.includes("@")) return null;
  return email;
}

function validPassword(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAXIMUM_PASSWORD_LENGTH;
}

function positiveMemberId(value) {
  const memberId = String(value || "");
  return /^(?:[1-9]\d*)$/.test(memberId) ? memberId : null;
}

function positiveExpiry(value) {
  return Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

function createGymMasterMemberLoginService(options = {}) {
  const enabled = options.enabled === true;
  const memberApiKey = typeof options.memberApiKey === "string" && options.memberApiKey.length > 0
    ? options.memberApiKey
    : null;
  const loginClient = typeof options.loginClient === "function" ? options.loginClient : null;

  async function authenticate(input) {
    if (!enabled || !memberApiKey || !loginClient) {
      throw loginError("GYMMASTER_MEMBER_LOGIN_NOT_AVAILABLE");
    }

    const email = normalizedEmail(input && input.email);
    const password = input && input.password;
    if (!email || !validPassword(password)) {
      throw loginError("GYMMASTER_MEMBER_LOGIN_FAILED", MEMBER_PORTAL_REQUEST_FAILURE);
    }

    let response;
    try {
      response = await loginClient(Object.freeze({ email, password, memberApiKey }));
    } catch (error) {
      throw loginError(
        "GYMMASTER_MEMBER_LOGIN_FAILED",
        error && typeof error.memberPortalFailureStage === "string"
          ? error.memberPortalFailureStage
          : MEMBER_PORTAL_REQUEST_FAILURE
      );
    }

    const result = response && typeof response === "object" ? response.result : null;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw loginError(
        "GYMMASTER_MEMBER_LOGIN_FAILED",
        MEMBER_PORTAL_FAILURE_STAGES.invalidEnvelopeResult
      );
    }
    if (typeof result.token !== "string" || !result.token) {
      throw loginError(
        "GYMMASTER_MEMBER_LOGIN_FAILED",
        MEMBER_PORTAL_FAILURE_STAGES.invalidEnvelopeToken
      );
    }
    const expiresInSeconds = positiveExpiry(result.expires);
    if (!expiresInSeconds) {
      throw loginError(
        "GYMMASTER_MEMBER_LOGIN_FAILED",
        MEMBER_PORTAL_FAILURE_STAGES.invalidEnvelopeExpires
      );
    }
    const memberId = positiveMemberId(result.memberid);
    if (!memberId) {
      throw loginError(
        "GYMMASTER_MEMBER_LOGIN_FAILED",
        MEMBER_PORTAL_FAILURE_STAGES.invalidEnvelopeMemberId
      );
    }

    // Deliberately omit the member password and provider token. A future session
    // layer may consume this verified identity, but must not expose either secret.
    return Object.freeze({
      authProvider: GYMMASTER_AUTH_PROVIDER,
      authSubject: `${GYMMASTER_AUTH_SUBJECT_PREFIX}${memberId}`,
      memberId,
      expiresInSeconds,
    });
  }

  return Object.freeze({ authenticate });
}

module.exports = {
  GYMMASTER_AUTH_PROVIDER,
  GYMMASTER_AUTH_SUBJECT_PREFIX,
  MAXIMUM_EMAIL_LENGTH,
  MAXIMUM_PASSWORD_LENGTH,
  createGymMasterMemberLoginService,
  normalizedEmail,
  positiveExpiry,
  positiveMemberId,
  validPassword,
};
