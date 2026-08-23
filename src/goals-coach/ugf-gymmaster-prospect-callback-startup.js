"use strict";

const { exactHttpsOrigin } = require("./gymmaster-member-login-route");
const { exactMemberPortalBaseUrl } = require("./gymmaster-public-widgets");
const {
  PROSPECT_CALLBACK_FLAG,
  createGymMasterProspectClient,
  createProspectCallbackHandler,
  enabled,
} = require("./ugf-gymmaster-prospect-callback");

function createProspectCallbackStartup(options = {}) {
  const environment = options.environment || process.env;
  const common = Object.freeze({ status: "disabled", origin: null, handler: null, externalCallsPermitted: false });
  if (!enabled(environment[PROSPECT_CALLBACK_FLAG])) return common;
  const origin = exactHttpsOrigin(environment.UGF_GYMMASTER_PROSPECT_CALLBACK_ORIGIN);
  const baseUrl = exactMemberPortalBaseUrl(environment.GYMMASTER_MEMBER_PORTAL_API_BASE_URL);
  const apiKey = environment.GYMMASTER_MEMBER_PORTAL_API_KEY;
  const companyIds = Object.freeze({
    black_hawk: Number(environment.UGF_GYMMASTER_PROSPECT_BLACK_HAWK_COMPANY_ID),
    rapid_valley: Number(environment.UGF_GYMMASTER_PROSPECT_RAPID_VALLEY_COMPANY_ID),
  });
  if (origin !== "https://ultimategoalsfitness.com" || !baseUrl || typeof apiKey !== "string"
    || apiKey.length < 8 || !Number.isInteger(companyIds.black_hawk) || companyIds.black_hawk < 1
    || !Number.isInteger(companyIds.rapid_valley) || companyIds.rapid_valley < 1
    || companyIds.black_hawk === companyIds.rapid_valley
    || typeof options.fetchImpl !== "function") {
    return Object.freeze({ ...common, status: "not_ready" });
  }
  const client = createGymMasterProspectClient({ baseUrl, apiKey, companyIds, fetchImpl: options.fetchImpl });
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    origin,
    handler: createProspectCallbackHandler({ client }),
    externalCallsPermitted: true,
  });
}

module.exports = { createProspectCallbackStartup };
