"use strict";

const MEMBER_LOGIN_PATH = "/portal/api/v1/login";
const MEMBER_PORTAL_FAILURE_STAGES = Object.freeze({
  request: "member_portal_request_failure",
  nonSuccessResponse: "member_portal_non_success_response",
  provider: "member_portal_provider_failure",
  invalidEnvelopeResult: "member_portal_invalid_envelope_result",
  invalidEnvelopeToken: "member_portal_invalid_envelope_token",
  invalidEnvelopeExpires: "member_portal_invalid_envelope_expires",
  invalidEnvelopeMemberId: "member_portal_invalid_envelope_memberid",
});

function memberPortalFailure(stage) {
  const error = new Error("GymMaster member login failed");
  error.memberPortalFailureStage = stage;
  return error;
}

function providerDeclaredFailure(response) {
  if (!response || typeof response !== "object") return false;
  const value = response.error;
  return value !== undefined && value !== null && value !== false && value !== "";
}

function validatedLoginEndpoint(value) {
  if (typeof value !== "string" || !value) throw new Error("GymMaster login endpoint is required");
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:"
    || endpoint.pathname !== MEMBER_LOGIN_PATH
    || endpoint.search
    || endpoint.hash
    || endpoint.username
    || endpoint.password
  ) {
    throw new Error("GymMaster login endpoint must be an exact HTTPS Member Portal login URL");
  }
  return endpoint.toString();
}

function createGymMasterMemberPortalClient(options = {}) {
  const endpoint = validatedLoginEndpoint(options.endpoint);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
  if (!fetchImpl) throw new Error("GymMaster login client requires an injected fetch implementation");

  return Object.freeze({
    async login(request) {
      const body = new URLSearchParams({
        api_key: request.memberApiKey,
        email: request.email,
        password: request.password,
      });
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          redirect: "error",
        });
      } catch (_) {
        throw memberPortalFailure(MEMBER_PORTAL_FAILURE_STAGES.request);
      }
      if (!response || response.status !== 200) {
        throw memberPortalFailure(MEMBER_PORTAL_FAILURE_STAGES.nonSuccessResponse);
      }
      if (typeof response.json !== "function") {
        throw memberPortalFailure(MEMBER_PORTAL_FAILURE_STAGES.invalidEnvelopeResult);
      }

      let parsed;
      try {
        parsed = await response.json();
      } catch (_) {
        throw memberPortalFailure(MEMBER_PORTAL_FAILURE_STAGES.invalidEnvelopeResult);
      }
      if (providerDeclaredFailure(parsed)) {
        throw memberPortalFailure(MEMBER_PORTAL_FAILURE_STAGES.provider);
      }
      return parsed;
    },
  });
}

module.exports = {
  MEMBER_LOGIN_PATH,
  MEMBER_PORTAL_FAILURE_STAGES,
  createGymMasterMemberPortalClient,
  providerDeclaredFailure,
  validatedLoginEndpoint,
};
