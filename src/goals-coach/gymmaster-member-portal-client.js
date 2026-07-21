"use strict";

const MEMBER_LOGIN_PATH = "/portal/api/v1/login";

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
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        redirect: "error",
      });
      if (!response || !response.ok || typeof response.json !== "function") {
        throw new Error("GymMaster member login failed");
      }
      return response.json();
    },
  });
}

module.exports = {
  MEMBER_LOGIN_PATH,
  createGymMasterMemberPortalClient,
  validatedLoginEndpoint,
};
