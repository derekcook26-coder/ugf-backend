"use strict";

const {
  WIDGETS_FLAG,
  createGymMasterPublicWidgetsRouter,
  createProviderClient,
  exactMemberPortalBaseUrl,
  widgetsEnabled,
} = require("./gymmaster-public-widgets");
const { exactHttpsOrigin } = require("./gymmaster-member-login-route");

function createGymMasterPublicWidgetsStartup(options = {}) {
  const environment = options.environment || process.env;
  const common = Object.freeze({
    status: "disabled",
    origin: null,
    router: null,
    externalCallsPermitted: false,
    readOnly: true,
  });
  if (!widgetsEnabled(environment[WIDGETS_FLAG])) return common;
  const origin = exactHttpsOrigin(environment.UGF_GYMMASTER_WIDGETS_ORIGIN);
  const baseUrl = exactMemberPortalBaseUrl(environment.GYMMASTER_MEMBER_PORTAL_API_BASE_URL);
  const apiKey = environment.GYMMASTER_MEMBER_PORTAL_API_KEY;
  if (!origin || !baseUrl || typeof apiKey !== "string" || apiKey.length < 8
    || typeof options.fetchImpl !== "function") {
    return Object.freeze({ ...common, status: "not_ready" });
  }
  const provider = createProviderClient({
    baseUrl,
    apiKey,
    fetchImpl: options.fetchImpl,
    ...(options.timeoutMilliseconds ? { timeoutMilliseconds: options.timeoutMilliseconds } : {}),
  });
  const router = createGymMasterPublicWidgetsRouter({
    provider,
    signupUrl: "https://ugf.gymmasteronline.com/portal/signup?logo=0",
    ...(options.now ? { now: options.now } : {}),
  });
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    origin,
    router,
    externalCallsPermitted: true,
  });
}

module.exports = { createGymMasterPublicWidgetsStartup };
