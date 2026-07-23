"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGymMasterMemberLoginService,
  positiveExpiry,
} = require("../src/goals-coach/gymmaster-member-login");

function service(overrides = {}) {
  return createGymMasterMemberLoginService({
    enabled: true,
    memberApiKey: "member-key-kept-server-side",
    loginClient: async () => ({
      result: { token: "provider-token", expires: 3600, memberid: 10482 },
    }),
    ...overrides,
  });
}

test("member login is unavailable unless explicitly enabled and composed", async () => {
  const unavailable = createGymMasterMemberLoginService();
  await assert.rejects(
    () => unavailable.authenticate({ email: "member@example.com", password: "password" }),
    (error) => error.code === "GYMMASTER_MEMBER_LOGIN_NOT_AVAILABLE"
  );
});

test("a successful injected provider response exposes only the verified identity", async () => {
  let received;
  const memberLogin = service({
    loginClient: async (request) => {
      received = request;
      return { result: { token: "provider-token", expires: 3600, memberid: 10482 } };
    },
  });
  const identity = await memberLogin.authenticate({
    email: " member@example.com ", password: "correct horse battery staple",
  });
  assert.deepEqual(received, {
    email: "member@example.com",
    password: "correct horse battery staple",
    memberApiKey: "member-key-kept-server-side",
  });
  assert.deepEqual(identity, {
    authProvider: "gymmaster",
    authSubject: "gymmaster:10482",
    memberId: "10482",
    expiresInSeconds: 3600,
  });
  assert.equal(JSON.stringify(identity).includes("token"), false);
  assert.equal(JSON.stringify(identity).includes("password"), false);
});

test("expiry validation accepts only positive JavaScript safe integers", () => {
  for (const value of [1, 3600, 86400, 86401, Number.MAX_SAFE_INTEGER]) {
    assert.equal(positiveExpiry(value), value);
  }
  for (const value of [
    "1",
    "3600",
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
  ]) {
    assert.equal(positiveExpiry(value), null);
  }
});

test("login validation never calls the provider for invalid input", async () => {
  let calls = 0;
  const memberLogin = service({ loginClient: async () => { calls += 1; } });
  await assert.rejects(
    () => memberLogin.authenticate({ email: "member@example.com", password: "" }),
    (error) => error.code === "GYMMASTER_MEMBER_LOGIN_FAILED"
  );
  assert.equal(calls, 0);
});

test("provider errors and malformed responses are reduced to a generic login failure", async () => {
  for (const loginClient of [
    async () => { throw new Error("provider failure containing member data"); },
    async () => ({ result: { token: "provider-token", expires: 0, memberid: 10482 } }),
    async () => ({ result: { token: "provider-token", expires: 3600, memberid: "0" } }),
  ]) {
    await assert.rejects(
      () => service({ loginClient }).authenticate({ email: "member@example.com", password: "password" }),
      (error) => error.code === "GYMMASTER_MEMBER_LOGIN_FAILED"
        && error.message === "Member login could not be completed"
        && !error.message.includes("provider")
    );
  }
});
