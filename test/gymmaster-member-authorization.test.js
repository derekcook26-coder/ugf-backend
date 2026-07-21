"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGymMasterMemberAuthorization,
  validGymMasterIdentity,
} = require("../src/goals-coach/gymmaster-member-authorization");

const identity = { authProvider: "gymmaster", authSubject: "gymmaster:10482" };

test("only the GymMaster immutable member subject is accepted for local authorization", () => {
  assert.equal(validGymMasterIdentity(identity), true);
  assert.equal(validGymMasterIdentity({ authProvider: "gymmaster", authSubject: "member@example.com" }), false);
  assert.equal(validGymMasterIdentity({ authProvider: "clerk", authSubject: "gymmaster:10482" }), false);
});

test("authorization returns an active mapping only for an exact active identity", async () => {
  let query;
  const authorization = createGymMasterMemberAuthorization({
    db: { query: async (...args) => { query = args; return { rows: [{ mapping_id: 44, member_id: 10482 }] }; } },
  });
  assert.deepEqual(await authorization.authorizeIdentity(identity), {
    active: true, mappingId: "44", memberId: "10482",
  });
  assert.match(query[0], /mapping\.auth_provider = \$1/);
  assert.match(query[0], /mapping\.active = TRUE/);
  assert.deepEqual(query[1], ["gymmaster", "gymmaster:10482"]);
});

test("unmapped, inactive-shaped, and invalid identities do not authorize access", async () => {
  let calls = 0;
  const authorization = createGymMasterMemberAuthorization({
    db: { query: async () => { calls += 1; return { rows: [] }; } },
  });
  assert.deepEqual(await authorization.authorizeIdentity(identity), { active: false });
  assert.deepEqual(await authorization.authorizeIdentity({ authProvider: "gymmaster", authSubject: "gymmaster:0" }), { active: false });
  assert.equal(calls, 1);
});
