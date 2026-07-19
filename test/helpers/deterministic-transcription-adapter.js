function categorizedFailure(failureCategory) {
  const error = new Error("Synthetic deterministic transcription failure");
  error.failureCategory = failureCategory;
  return error;
}

function wait(milliseconds, signal, honorAbort) {
  if (!(milliseconds > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (honorAbort) signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(categorizedFailure("provider_timeout"));
    }
    if (honorAbort) {
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    }
  });
}

function createDeterministicTranscriptionAdapter(options = {}) {
  const outcomes = Array.isArray(options.outcomes)
    ? options.outcomes.map((outcome) => ({ ...outcome }))
    : [{
      type: options.type || "success",
      text: options.text,
      durationMs: options.durationMs,
      delayMs: options.delayMs,
      failureCategory: options.failureCategory,
    }];
  const calls = [];
  let outcomeIndex = 0;

  const adapter = Object.freeze({
    providerIdentifier: options.providerIdentifier || "deterministic-test-provider",
    modelIdentifier: options.modelIdentifier || "deterministic-test-model",
    async transcribe(request) {
      calls.push(Object.freeze({
        requestId: request.requestId,
        mimeType: request.mimeType,
        audioByteCount: request.audio.length,
        maximumDurationMs: request.maximumDurationMs,
        signalProvided: Boolean(request.signal),
      }));
      if (typeof options.onCall === "function") {
        await options.onCall(calls.length, request.signal);
      }
      const outcome = outcomes[Math.min(outcomeIndex, outcomes.length - 1)] || {};
      outcomeIndex += 1;
      const type = outcome.type || "success";

      if (type === "timeout") {
        await new Promise((_, reject) => {
          function aborted() {
            request.signal.removeEventListener("abort", aborted);
            reject(categorizedFailure("provider_timeout"));
          }
          if (request.signal.aborted) aborted();
          else request.signal.addEventListener("abort", aborted, { once: true });
        });
      }

      if (type === "late_completion") {
        await wait(outcome.delayMs || 30, request.signal, false);
      } else {
        await wait(outcome.delayMs || 0, request.signal, true);
      }

      if (type === "failure") {
        throw categorizedFailure(outcome.failureCategory || "provider_error");
      }
      return {
        text: outcome.text === undefined ? "Deterministic transcript" : outcome.text,
        durationMs: outcome.durationMs === undefined ? 1200 : outcome.durationMs,
      };
    },
  });

  return Object.freeze({
    adapter,
    getCallCount: () => calls.length,
    getCalls: () => calls.slice(),
  });
}

module.exports = { createDeterministicTranscriptionAdapter };
