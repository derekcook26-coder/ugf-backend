"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGymMasterMemberPortalClient,
  validatedLoginEndpoint,
} = require("../src/goals-coach/gymmaster-member-portal-client");

const ENDPOINT = "https://ugf.gymmasteronline.com/portal/api/v1/login";

test("GymMaster client accepts only an exact HTTPS member-login endpoint", () => {
  assert.equal(validatedLoginEndpoint(ENDPOINT), ENDPOINT);
  for (const endpoint of [
    "http://ugf.gymmasteronline.com/portal/api/v1/login",
    "https://ugf.gymmasteronline.com/portal/api/v1/login/",
    "https://ugf.gymmasteronline.com/portal/api/v1/login?debug=true",
    "https://member:password@ugf.gymmasteronline.com/portal/api/v1/login",
  ]) {
    assert.throws(() => validatedLoginEndpoint(endpoint), /exact HTTPS/);
  }
});

test("GymMaster client uses only the documented member password form fields", async () => {
  let called;
  const client = createGymMasterMemberPortalClient({
    endpoint: ENDPOINT,
    fetchImpl: async (url, options) => {
      called = { url, options };
      return { status: 200, json: async () => ({ result: { token: "transient", expires: 3600, memberid: 10482 } }) };
    },
  });
  const result = await client.login({
    memberApiKey: "members-api-key", email: "member@example.com", password: "member-password",
  });
  assert.equal(called.url, ENDPOINT);
  assert.deepEqual(called.options.headers, { "Content-Type": "application/x-www-form-urlencoded" });
  assert.equal(called.options.method, "POST");
  assert.equal(called.options.redirect, "error");
  assert.equal(called.options.body.toString(), "api_key=members-api-key&email=member%40example.com&password=member-password");
  assert.deepEqual(result, { result: { token: "transient", expires: 3600, memberid: 10482 } });
});

test("GymMaster client classifies only fixed request, status, provider, and envelope failures", async () => {
  const cases = [
    {
      stage: "member_portal_request_failure",
      fetchImpl: async () => { throw new Error("raw request failure"); },
    },
    {
      stage: "member_portal_non_success_response",
      fetchImpl: async () => ({ status: 201, ok: true, json: async () => ({ result: {} }) }),
    },
    {
      stage: "member_portal_provider_failure",
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({
          error: "raw provider detail",
          result: { token: "must-not-win", expires: 3600, memberid: 10482 },
        }),
      }),
    },
    {
      stage: "member_portal_invalid_envelope_result",
      fetchImpl: async () => ({ status: 200, json: async () => { throw new Error("raw JSON detail"); } }),
    },
  ];

  for (const { stage, fetchImpl } of cases) {
    const client = createGymMasterMemberPortalClient({ endpoint: ENDPOINT, fetchImpl });
    await assert.rejects(
      () => client.login({ memberApiKey: "key", email: "member@example.com", password: "member-password" }),
      (error) => error.message === "GymMaster member login failed"
        && error.memberPortalFailureStage === stage
    );
  }
});
