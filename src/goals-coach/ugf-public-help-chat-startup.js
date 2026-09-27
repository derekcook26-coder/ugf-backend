"use strict";

const { exactHttpsOrigin } = require("./gymmaster-member-login-route");
const { HELP_CHAT_FLAG, createPublicHelpChat, enabled, exactAllowedUrl } = require("./ugf-public-help-chat");

const UGF_SITE = Object.freeze([{ hostname: "ultimategoalsfitness.com", pathPrefix: "/" }]);
const GYMMASTER_SITE = Object.freeze([{ hostname: "ugf.gymmasteronline.com", pathPrefix: "/portal/" }]);

function createPublicHelpChatStartup(options = {}) {
  const environment = options.environment || process.env;
  const common = Object.freeze({ status: "disabled", origin: null, chat: null, readOnly: true });
  if (!enabled(environment[HELP_CHAT_FLAG])) return common;
  const origin = exactHttpsOrigin(environment.UGF_PUBLIC_HELP_CHAT_ORIGIN);
  const links = {
    membershipUrl: exactAllowedUrl(environment.UGF_HELP_MEMBERSHIP_URL, GYMMASTER_SITE),
    scheduleUrl: exactAllowedUrl(environment.UGF_HELP_SCHEDULE_URL, UGF_SITE),
    workoutUrl: exactAllowedUrl(environment.UGF_HELP_WORKOUT_URL, UGF_SITE),
    portalUrl: exactAllowedUrl(environment.UGF_HELP_MEMBER_PORTAL_URL, GYMMASTER_SITE),
    contactUrl: exactAllowedUrl(environment.UGF_HELP_CONTACT_URL, UGF_SITE),
  };
  if (!origin || origin !== "https://ultimategoalsfitness.com"
    || Object.values(links).some((value) => !value)) {
    return Object.freeze({ ...common, status: "not_ready" });
  }
  return Object.freeze({
    ...common,
    status: "ready_for_separate_route_composition",
    origin,
    chat: createPublicHelpChat({ links }),
  });
}

module.exports = { createPublicHelpChatStartup };
