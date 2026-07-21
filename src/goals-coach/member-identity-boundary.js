"use strict";

const SUPPORTED_DELEGATED_AUTH_METHODS = Object.freeze([
  "signed_provider_assertion",
  "delegated_oidc_session",
]);

const KNOWN_PROVIDER_PASSWORD_GRANT = "provider_password_grant";
const OWNER_APPROVED_PASSWORD_TRANSIT = "transient_server_side_only";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function createMemberIdentityBoundaryReport(options = {}) {
  const plan = options.plan || {};
  const blockers = [];

  if (plan.provider !== "gymmaster_member_portal") {
    blockers.push("gymmaster_member_portal_provider_required");
  }
  if (plan.memberIdentifier !== "gymmaster_verified_email") {
    blockers.push("gymmaster_verified_email_identifier_required");
  }
  if (plan.memberIdentifier === "gymmaster_member_id_with_staff_key") {
    blockers.push("gymmaster_staff_key_member_impersonation_not_permitted");
  }
  const delegatedMethod = SUPPORTED_DELEGATED_AUTH_METHODS.includes(plan.authorizationMethod);
  const approvedPasswordGrant = plan.authorizationMethod === KNOWN_PROVIDER_PASSWORD_GRANT
    && plan.passwordHandling === OWNER_APPROVED_PASSWORD_TRANSIT
    && nonEmptyString(plan.ownerSecurityDecisionReference);
  if (!delegatedMethod && !approvedPasswordGrant) {
    blockers.push("gymmaster_supported_auth_contract_required");
  }
  if (plan.authorizationMethod === KNOWN_PROVIDER_PASSWORD_GRANT) {
    if (plan.passwordHandling !== OWNER_APPROVED_PASSWORD_TRANSIT) {
      blockers.push("gymmaster_password_transit_model_required");
    }
    if (!nonEmptyString(plan.ownerSecurityDecisionReference)) {
      blockers.push("gymmaster_password_grant_requires_separate_owner_security_decision");
    }
  } else if (plan.passwordHandling !== "provider_hosted_only") {
    blockers.push("member_passwords_must_remain_provider_hosted");
  }
  if (!nonEmptyString(plan.providerEvidenceReference)) {
    blockers.push("gymmaster_provider_evidence_required");
  }

  return Object.freeze({
    status: blockers.length === 0
      ? "ready_for_provider_configuration_review"
      : "provider_contract_pending",
    blockers: Object.freeze(blockers),
    activationPermitted: false,
    externalCallsPermitted: false,
    passwordCollectionPermitted: false,
  });
}

module.exports = {
  KNOWN_PROVIDER_PASSWORD_GRANT,
  OWNER_APPROVED_PASSWORD_TRANSIT,
  SUPPORTED_DELEGATED_AUTH_METHODS,
  createMemberIdentityBoundaryReport,
  nonEmptyString,
};
