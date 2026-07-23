"use strict";

const GATEKEEPER_MEMBERS_PATH = "/gatekeeper_api/v2/members";
const memberAccessFailureStages = new WeakMap();

function inactiveMemberAccess(stage) {
  const result = Object.freeze({ active: false });
  memberAccessFailureStages.set(result, stage);
  return result;
}

function memberAccessFailureStage(result) {
  return result && memberAccessFailureStages.get(result) || null;
}

function validMemberId(value) {
  return /^(?:[1-9]\d*)$/.test(String(value || ""));
}

function membershipIsActive(member) {
  if (!member || member.stopatgate) return false;
  const memberships = member.membership || member.memberships || [];
  return Array.isArray(memberships)
    && memberships.some((membership) => membership && membership.expired === false);
}

function matchingMember(data, memberId) {
  const list = data && (data.members || data.data || (Array.isArray(data) ? data : []));
  if (!Array.isArray(list)) return null;
  return list.find((member) => String(
    member && (member.memberid || member.id || member.member_id) || ""
  ).trim() === memberId) || null;
}

function exactGatekeeperMembersEndpoint(value) {
  if (typeof value !== "string" || !value) throw new Error("GymMaster Gatekeeper endpoint is required");
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:"
    || endpoint.pathname !== GATEKEEPER_MEMBERS_PATH
    || endpoint.search
    || endpoint.hash
    || endpoint.username
    || endpoint.password
  ) {
    throw new Error("GymMaster Gatekeeper endpoint must be an exact HTTPS members URL");
  }
  return endpoint;
}

function createGymMasterGatekeeperMembershipVerifier(options = {}) {
  const endpoint = exactGatekeeperMembersEndpoint(options.endpoint);
  const site = typeof options.site === "string" && /^[a-z0-9_-]{1,40}$/i.test(options.site)
    ? options.site
    : null;
  const apiKey = typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : null;
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
  if (!site || !apiKey || !fetchImpl) {
    throw new Error("GymMaster Gatekeeper verifier requires site, server-side key, and injected fetch");
  }

  return Object.freeze({
    async verifyActiveMember(memberId) {
      if (!validMemberId(memberId)) return Object.freeze({ active: false });
      const requestUrl = new URL(endpoint);
      requestUrl.searchParams.set("memberid", String(memberId));
      const basicCredential = Buffer.from(`${site}:${apiKey}`).toString("base64");
      const response = await fetchImpl(requestUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${basicCredential}`,
        },
        redirect: "error",
      });
      if (!response || !response.ok || typeof response.json !== "function") {
        throw new Error("GymMaster Gatekeeper membership lookup failed");
      }
      const member = matchingMember(await response.json(), String(memberId));
      return Object.freeze({ active: membershipIsActive(member) });
    },
  });
}

function createGymMasterMemberAccessAuthorizer(options = {}) {
  const mappingAuthorizer = options.mappingAuthorizer;
  const membershipVerifier = options.membershipVerifier;
  if (!mappingAuthorizer || typeof mappingAuthorizer.authorizeIdentity !== "function") {
    throw new Error("GymMaster member access requires a local mapping authorizer");
  }
  if (!membershipVerifier || typeof membershipVerifier.verifyActiveMember !== "function") {
    throw new Error("GymMaster member access requires a Gatekeeper membership verifier");
  }

  return Object.freeze({
    async authorizeIdentity(identity) {
      let mapping;
      try {
        mapping = await mappingAuthorizer.authorizeIdentity(identity);
      } catch (_) {
        return inactiveMemberAccess("local_mapping");
      }
      if (!mapping || mapping.active !== true) {
        return inactiveMemberAccess("local_mapping");
      }
      const subjectMemberId = String(identity.authSubject).slice("gymmaster:".length);
      let membership;
      try {
        membership = await membershipVerifier.verifyActiveMember(subjectMemberId);
      } catch (_) {
        return inactiveMemberAccess("gatekeeper");
      }
      if (!membership || membership.active !== true) {
        return inactiveMemberAccess("gatekeeper");
      }
      return mapping;
    },
  });
}

module.exports = {
  GATEKEEPER_MEMBERS_PATH,
  createGymMasterGatekeeperMembershipVerifier,
  createGymMasterMemberAccessAuthorizer,
  exactGatekeeperMembersEndpoint,
  matchingMember,
  memberAccessFailureStage,
  membershipIsActive,
  validMemberId,
};
