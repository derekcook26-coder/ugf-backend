const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { loadPhase1cConfiguration } = require("../src/goals-coach/phase1c-config");
const { createPhase1cStartup } = require("../src/goals-coach/phase1c-startup");
const {
  createDeterministicPhase1cReadinessStub,
} = require("./helpers/deterministic-phase1c-readiness-stub");

const projectRoot = path.resolve(__dirname, "..");
const testConsent = "GC-ALPHA-CONSENT-PHASE1C-TEST";

function readyPhase1b() {
  const configuration = Object.freeze({ aiEnabled: true, generationReady: true });
  return Object.freeze({
    status: "ready",
    configuration,
    engine: Object.freeze({ configuration, async generateTurn() {} }),
  });
}

function phase1cEnvironment(overrides = {}) {
  return {
    GOALS_COACH_VOICE_INPUT_ENABLED: "true",
    GOALS_COACH_TRANSCRIPTION_ENABLED: "true",
    GOALS_COACH_PHASE1C_CONSENT_VERSION: testConsent,
    GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD: "1.00",
    GOALS_COACH_TRANSCRIPTION_BINDING_KEY: "synthetic-test-binding-key",
    ...overrides,
  };
}

function readyConfiguration(overrides = {}) {
  return loadPhase1cConfiguration(phase1cEnvironment(overrides), {
    approvedConsentVersion: testConsent,
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(child, port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Backend exited before becoming healthy");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch (_) {
      // The local process may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Backend did not become healthy in the startup test window");
}

test("Phase 1C startup reports each fail-closed state in protective order", () => {
  const stub = createDeterministicPhase1cReadinessStub();
  const disabled = createPhase1cStartup({
    phase1bStartup: readyPhase1b(),
    transcriptionAdapter: stub.adapter,
    environment: {},
  });
  assert.deepEqual([disabled.status, disabled.reason], ["disabled", "voice_disabled"]);

  const phase1bUnavailable = createPhase1cStartup({
    phase1bStartup: null,
    configuration: readyConfiguration(),
    transcriptionAdapter: stub.adapter,
  });
  assert.deepEqual(
    [phase1bUnavailable.status, phase1bUnavailable.reason],
    ["unavailable", "phase_1b_not_ready"]
  );

  const transcriptionDisabled = createPhase1cStartup({
    phase1bStartup: readyPhase1b(),
    configuration: readyConfiguration({ GOALS_COACH_TRANSCRIPTION_ENABLED: "false" }),
    transcriptionAdapter: stub.adapter,
  });
  assert.deepEqual(
    [transcriptionDisabled.status, transcriptionDisabled.reason],
    ["unavailable", "transcription_disabled"]
  );

  const consentUnresolved = createPhase1cStartup({
    phase1bStartup: readyPhase1b(),
    environment: phase1cEnvironment(),
    transcriptionAdapter: stub.adapter,
  });
  assert.deepEqual(
    [consentUnresolved.status, consentUnresolved.reason],
    ["unavailable", "consent_update_required"]
  );

  for (const configuration of [
    readyConfiguration({ GOALS_COACH_MAX_AUDIO_SECONDS: "31" }),
    readyConfiguration({ GOALS_COACH_TRANSCRIPTION_BINDING_KEY: "" }),
    readyConfiguration({ GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD: "0.00" }),
  ]) {
    const invalid = createPhase1cStartup({
      phase1bStartup: readyPhase1b(),
      configuration,
      transcriptionAdapter: stub.adapter,
    });
    assert.deepEqual(
      [invalid.status, invalid.reason],
      ["unavailable", "invalid_configuration"]
    );
  }
  assert.equal(stub.calls, 0);
});

test("missing or invalid adapter remains unavailable and a valid injected test stub can be ready", () => {
  const configuration = readyConfiguration();
  const noAdapter = createPhase1cStartup({
    phase1bStartup: readyPhase1b(),
    configuration,
  });
  assert.deepEqual(
    [noAdapter.status, noAdapter.reason],
    ["unavailable", "transcription_provider_unavailable"]
  );

  const invalidAdapter = createPhase1cStartup({
    phase1bStartup: readyPhase1b(),
    configuration,
    transcriptionAdapter: { generate() {} },
  });
  assert.deepEqual(
    [invalidAdapter.status, invalidAdapter.reason],
    ["unavailable", "transcription_provider_unavailable"]
  );

  const stub = createDeterministicPhase1cReadinessStub();
  const ready = createPhase1cStartup({
    phase1bStartup: readyPhase1b(),
    configuration,
    transcriptionAdapter: stub.adapter,
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.reason, null);
  assert.equal(ready.adapter, stub.adapter);
  assert.equal(stub.calls, 0);
});

test("actual startup remains healthy with Phase 1B and Phase 1C disabled and no live credentials", async (t) => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      GYMMASTER_API_KEY: "",
      GYMMASTER_MEMBER_PORTAL_API_KEY: "",
      ZAPIER_TRAINER_SUMMARY_WEBHOOK: "",
      GOALS_COACH_ALPHA_ENABLED: "false",
      GOALS_COACH_AI_ENABLED: "false",
      GOALS_COACH_VOICE_INPUT_ENABLED: "false",
      GOALS_COACH_TRANSCRIPTION_ENABLED: "false",
      GOALS_COACH_SPEECH_OUTPUT_ENABLED: "false",
      GOALS_COACH_PHASE1C_CONSENT_VERSION: "",
      GOALS_COACH_TRANSCRIPTION_BINDING_KEY: "",
      GOALS_COACH_TRANSCRIPTION_DAILY_BUDGET_USD: "0.00",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
    });
  });

  assert.deepEqual(await waitForHealth(child, port), { ok: true });
  assert.equal(child.exitCode, null);
  assert.equal(stderr, "");
});

test("production startup and Goals Coach sources do not import the test readiness stub", () => {
  const productionFiles = [path.join(projectRoot, "server.js")];
  const goalsCoachDirectory = path.join(projectRoot, "src", "goals-coach");
  for (const name of fs.readdirSync(goalsCoachDirectory)) {
    if (name.endsWith(".js")) productionFiles.push(path.join(goalsCoachDirectory, name));
  }
  for (const file of productionFiles) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes("test/helpers"), false, `${path.basename(file)} imports tests`);
    assert.equal(
      source.includes("deterministic-phase1c-readiness-stub"),
      false,
      `${path.basename(file)} imports the Phase 1C stub`
    );
  }
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  assert.match(serverSource, /createPhase1cStartup\(\{ phase1bStartup: phase1bStartup \}\)/);
  assert.doesNotMatch(serverSource, /transcriptionAdapter\s*:/);
});
