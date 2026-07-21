"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGymMasterGatekeeperMembershipVerifier,
  createGymMasterMemberAccessAuthorizer,
  membershipIsActive,
} = require("../src/goals-coach/gymmaster-gatekeeper-membership");

const ENDPOINT = "https://ugf.gymmasteronline.com/gatekeeper_api/v2/members";

test("Gatekeeper membership uses the existing stop-at-gate and non-expired-membership policy", () => {
  assert.equal(membershipIsActive({ stopatgate: false, membership: [{ expired: false }] }), true);
  assert.equal(membershipIsActive({ stopatgate: true, membership: [{ expired: false }] }), false);
  assert.equal(membershipIsActive({ stopatgate: false, memberships: [{ expired: true }] }), false);
  assert.equal(membershipIsActive({}), false);
});

test("Gatekeeper verifier requests only the exact member ID using server-side basic authentication", async () => {
  let called;
  const verifier = createGymMasterGatekeeperMembershipVerifier({
    endpoint: ENDPOINT,
    site: "ugf",
    apiKey: "gatekeeper-key",
    fetchImpl: async (url, options) => {
      called = { url, options };
      return { ok: true, json: async () => ({ members: [{ memberid: 10482, stopatgate: false, membership: [{ expired: false }] }] }) };
    },
  });
  assert.deepEqual(await verifier.verifyActiveMember("10482"), { active: true });
  assert.equal(called.url, `${ENDPOINT}?memberid=10482`);
  assert.equal(called.options.method, "GET");
  assert.equal(called.options.redirect, "error");
  assert.equal(called.options.headers.Accept, "application/json");
  assert.equal(called.options.headers.Authorization, `Basic ${Buffer.from("ugf:gatekeeper-key").toString("base64")}`);
});

test("unmatched and inactive Gatekeeper members are denied", async () => {
  const verifier = createGymMasterGatekeeperMembershipVerifier({
    endpoint: ENDPOINT,
    site: "ugf",
    apiKey: "gatekeeper-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ members: [{ memberid: 10482, stopatgate: true, membership: [{ expired: false }] }] }) }),
  });
  assert.deepEqual(await verifier.verifyActiveMember("10482"), { active: false });
  assert.deepEqual(await verifier.verifyActiveMember("0"), { active: false });
});

test("access authorizer requires a local active mapping before the Gatekeeper lookup", async () => {
  let gatekeeperCalls = 0;
  const access = createGymMasterMemberAccessAuthorizer({
    mappingAuthorizer: { authorizeIdentity: async () => ({ active: false }) },
    membershipVerifier: { verifyActiveMember: async () => { gatekeeperCalls += 1; return { active: true }; } },
  });
  assert.deepEqual(await access.authorizeIdentity({ authSubject: "gymmaster:10482" }), { active: false });
  assert.equal(gatekeeperCalls, 0);
});

test("access authorizer requires both the local mapping and active Gatekeeper result", async () => {
  const access = createGymMasterMemberAccessAuthorizer({
    mappingAuthorizer: { authorizeIdentity: async () => ({ active: true, mappingId: "9", memberId: "10482" }) },
    membershipVerifier: { verifyActiveMember: async (memberId) => ({ active: memberId === "10482" }) },
  });
  assert.deepEqual(
    await access.authorizeIdentity({ authProvider: "gymmaster", authSubject: "gymmaster:10482" }),
    { active: true, mappingId: "9", memberId: "10482" }
  );
});
