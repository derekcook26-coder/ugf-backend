"use strict";

const { MEMBER_CONVERSATION_TURN_CONTRACT_VERSION } = require("./member-conversation-turn-contract");

function validMemberConversationTurnOwnership(value) {
  return Boolean(value
    && value.contractVersion === MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    && value.providerFree === true
    && value.readOnly === true
    && value.concealUnknown === true
    && value.exactConversationBinding === true
    && typeof value.authorize === "function");
}

function validConversationOwnershipResult(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.owned === true);
}

module.exports = { validConversationOwnershipResult, validMemberConversationTurnOwnership };
