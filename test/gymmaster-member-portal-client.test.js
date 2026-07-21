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
      return { ok: true, json: async () => ({ result: { token: "transient", expires: 3600, memberid: 10482 } }) };
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

test("GymMaster client never follows redirects or accepts an unsuccessful response", async () => {
  const client = createGymMasterMemberPortalClient({
    endpoint: ENDPOINT,
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: "detail" }) }),
  });
  await assert.rejects(
    () => client.login({ memberApiKey: "key", email: "member@example.com", password: "member-password" }),
    /GymMaster member login failed/
  );
});
