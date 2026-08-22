"use strict";

const { MEMBER_CONVERSATION_TURN_CONTRACT_VERSION } = require("./member-conversation-turn-contract");

function validMemberConversationTurnIdempotency(value) {
  return Boolean(value
    && value.contractVersion === MEMBER_CONVERSATION_TURN_CONTRACT_VERSION
    && value.conflictMode === "reject_exact_key_signature_mismatch"
    && value.replayMode === "replay_exact_result"
    && value.persistenceMode === "required_external_dependency"
    && typeof value.execute === "function");
}

module.exports = { validMemberConversationTurnIdempotency };
