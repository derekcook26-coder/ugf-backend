"use strict";

const {
  createMemberConversationProviderDispatchAuthorization,
  createMemberConversationProviderDispatchService,
} = require("./member-conversation-provider-dispatch-service");

const unavailableComposition = Object.freeze({
  dispatchService: null,
  externalEffectsPermitted: false,
  providerFree: true,
  runtimeWired: false,
});

function createProductionMemberConversationProviderDispatchComposition(options = {}) {
  if (!options.pool || typeof options.pool.connect !== "function") {
    return unavailableComposition;
  }
  try {
    const preDispatchAuthorization =
      createMemberConversationProviderDispatchAuthorization(options.authorizationAdapters);
    const dispatchService = createMemberConversationProviderDispatchService({
      pool: options.pool,
      preDispatchAuthorization,
    });
    return Object.freeze({
      dispatchService,
      externalEffectsPermitted: false,
      providerFree: true,
      runtimeWired: false,
    });
  } catch (_) {
    return unavailableComposition;
  }
}

module.exports = {
  createProductionMemberConversationProviderDispatchComposition,
};
