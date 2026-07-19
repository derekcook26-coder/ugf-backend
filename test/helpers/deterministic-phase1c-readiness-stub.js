function createDeterministicPhase1cReadinessStub() {
  let calls = 0;
  return {
    adapter: Object.freeze({
      async transcribe() {
        calls += 1;
        throw new Error("Phase 1C readiness stub must not transcribe");
      },
    }),
    get calls() {
      return calls;
    },
  };
}

module.exports = { createDeterministicPhase1cReadinessStub };
