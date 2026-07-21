"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  KNOWN_PROVIDER_PASSWORD_GRANT,
  OWNER_APPROVED_PASSWORD_TRANSIT,
  SUPPORTED_DELEGATED_AUTH_METHODS,
  createMemberIdentityBoundaryReport,
} = require("../src/goals-coach/member-identity-boundary");

function safePlan(overrides = {}) {
  return {
    provider: "gymmaster_member_portal",
    memberIdentifier: "gymmaster_verified_email",
    passwordHandling: "provider_hosted_only",
    authorizationMethod: "signed_provider_assertion",
    providerEvidenceReference: "owner-reviewed-provider-contract",
    ...overrides,
  };
}

test("GymMaster member identity stays pending until a delegated sign-in contract is documented", () => {
  const report = createMemberIdentityBoundaryReport();
  assert.equal(report.status, "provider_contract_pending");
  assert.equal(report.activationPermitted, false);
  assert.equal(report.externalCallsPermitted, false);
  assert.equal(report.passwordCollectionPermitted, false);
  assert.ok(report.blockers.includes("gymmaster_delegated_sign_in_contract_required"));
});

test("member passwords can never be collected by the Goals Coach boundary", () => {
  const report = createMemberIdentityBoundaryReport({
    plan: safePlan({ passwordHandling: "goals_coach_collects_password" }),
  });
  assert.equal(report.status, "provider_contract_pending");
  assert.ok(report.blockers.includes("member_passwords_must_remain_provider_hosted"));
  assert.equal(report.passwordCollectionPermitted, false);
});

test("an email alone is not treated as an authenticated GymMaster session", () => {
  const report = createMemberIdentityBoundaryReport({
    plan: safePlan({ authorizationMethod: "email_lookup" }),
  });
  assert.ok(report.blockers.includes("gymmaster_delegated_sign_in_contract_required"));
});

test("the documented GymMaster password-grant login remains blocked pending an owner security decision", () => {
  const report = createMemberIdentityBoundaryReport({
    plan: safePlan({ authorizationMethod: KNOWN_PROVIDER_PASSWORD_GRANT }),
  });
  assert.equal(report.status, "provider_contract_pending");
  assert.ok(report.blockers.includes("gymmaster_password_transit_model_required"));
  assert.ok(report.blockers.includes("gymmaster_password_grant_requires_separate_owner_security_decision"));
  assert.equal(report.passwordCollectionPermitted, false);
  assert.equal(report.externalCallsPermitted, false);
});

test("the owner-approved password-transit model remains review-only and disconnected", () => {
  const report = createMemberIdentityBoundaryReport({
    plan: safePlan({
      passwordHandling: OWNER_APPROVED_PASSWORD_TRANSIT,
      authorizationMethod: KNOWN_PROVIDER_PASSWORD_GRANT,
      ownerSecurityDecisionReference: "owner-approved-gymmaster-password-transit",
    }),
  });
  assert.equal(report.status, "ready_for_provider_configuration_review");
  assert.equal(report.activationPermitted, false);
  assert.equal(report.externalCallsPermitted, false);
  assert.equal(report.passwordCollectionPermitted, false);
});

test("the Staff-key member-ID login option is never accepted for member-facing access", () => {
  const report = createMemberIdentityBoundaryReport({
    plan: safePlan({ memberIdentifier: "gymmaster_member_id_with_staff_key" }),
  });
  assert.equal(report.status, "provider_contract_pending");
  assert.ok(report.blockers.includes("gymmaster_staff_key_member_impersonation_not_permitted"));
  assert.equal(report.externalCallsPermitted, false);
});

test("a documented delegated sign-in plan remains review-only and disconnected", () => {
  for (const authorizationMethod of SUPPORTED_DELEGATED_AUTH_METHODS) {
    const report = createMemberIdentityBoundaryReport({
      plan: safePlan({ authorizationMethod }),
    });
    assert.equal(report.status, "ready_for_provider_configuration_review");
    assert.equal(report.activationPermitted, false);
    assert.equal(report.externalCallsPermitted, false);
    assert.equal(report.passwordCollectionPermitted, false);
  }
});
