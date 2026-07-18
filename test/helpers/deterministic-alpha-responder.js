async function deterministicAlphaResponder() {
  return {
    content: "PRIVATE ALPHA TEST: Message storage is working. Real coaching is not active.",
    structuredResponse: {
      phase: "1A",
      testOnly: true,
      coachingActive: false,
    },
  };
}

module.exports = { deterministicAlphaResponder };
