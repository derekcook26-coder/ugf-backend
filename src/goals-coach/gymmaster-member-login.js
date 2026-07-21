"use strict";

const GYMMASTER_AUTH_PROVIDER = "gymmaster";
const GYMMASTER_AUTH_SUBJECT_PREFIX = "gymmaster:";
const MAXIMUM_EMAIL_LENGTH = 320;
const MAXIMUM_PASSWORD_LENGTH = 1024;

function loginError(code) {
  const error = new Error("Member login could not be completed");
  error.code = code;
  error.statusCode = code === "GYMMASTER_MEMBER_LOGIN_NOT_AVAILABLE" ? 503 : 401;
  error.exposeMessage = true;
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
  return Number.isInteger(value) && value >= 1 && value <= 24 * 60 * 60
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
      throw loginError("GYMMASTER_MEMBER_LOGIN_FAILED");
    }

    let response;
    try {
      response = await loginClient(Object.freeze({ email, password, memberApiKey }));
    } catch (_) {
      throw loginError("GYMMASTER_MEMBER_LOGIN_FAILED");
    }

    const result = response && typeof response === "object" ? response.result : null;
    const memberId = result && positiveMemberId(result.memberid);
    const expiresInSeconds = result && positiveExpiry(result.expires);
    if (!memberId || !expiresInSeconds || typeof result.token !== "string" || !result.token) {
      throw loginError("GYMMASTER_MEMBER_LOGIN_FAILED");
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
