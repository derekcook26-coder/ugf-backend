const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { createPhase1bStartup } = require("../src/goals-coach/phase1b-startup");

const projectRoot = path.resolve(__dirname, "..");

function validEnvironment() {
  return {
    GOALS_COACH_AI_ENABLED: "true",
    GOALS_COACH_AI_PROVIDER: "synthetic-startup-provider",
    GOALS_COACH_OPENAI_MODEL: "synthetic-startup-model",
    GOALS_COACH_PROMPT_VERSION: "GC-PROMPT-1B-1.0",
    GOALS_COACH_STRUCTURED_OUTPUT_VERSION: "GC-OUTPUT-1B-1.0",
    GOALS_COACH_SAFETY_RULE_VERSION: "GC-SAFETY-PLACEHOLDER-1B",
    GOALS_COACH_PROVIDER_TIMEOUT_MS: "250",
  };
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
      // The local test process may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Backend did not become healthy in the startup test window");
}

test("disabled and incomplete startup configuration fail closed before provider creation", () => {
  let factoryCalls = 0;
  const createProvider = () => {
    factoryCalls += 1;
    return { async generate() { throw new Error("must not run"); } };
  };
  const disabled = createPhase1bStartup({ environment: {}, createProvider });
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.engine, null);

  const incomplete = createPhase1bStartup({
    environment: {
      GOALS_COACH_AI_ENABLED: "true",
      GOALS_COACH_AI_PROVIDER: "synthetic-provider",
    },
    createProvider,
  });
  assert.equal(incomplete.status, "invalid_configuration");
  assert.equal(incomplete.engine, null);
  assert.equal(factoryCalls, 0);
});

test("valid configuration without an approved provider remains unavailable", () => {
  const unavailable = createPhase1bStartup({ environment: validEnvironment() });
  assert.equal(unavailable.status, "provider_unavailable");
  assert.equal(unavailable.engine, null);

  const failed = createPhase1bStartup({
    environment: validEnvironment(),
    createProvider() { throw new Error("synthetic initialization detail"); },
  });
  assert.equal(failed.status, "provider_initialization_failed");
  assert.equal(failed.engine, null);
});

test("valid test configuration constructs an engine without contacting a live service", () => {
  let generateCalls = 0;
  const provider = {
    async generate() {
      generateCalls += 1;
      throw new Error("generation is not part of startup");
    },
  };
  const startup = createPhase1bStartup({ environment: validEnvironment(), provider });
  assert.equal(startup.status, "ready");
  assert.ok(startup.engine);
  assert.equal(startup.engine.configuration.generationReady, true);
  assert.equal(generateCalls, 0);
});

test("actual backend startup remains healthy and external-service-free with test identifiers", async (t) => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...validEnvironment(),
      PORT: String(port),
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      GYMMASTER_API_KEY: "",
      GYMMASTER_MEMBER_PORTAL_API_KEY: "",
      ZAPIER_TRAINER_SUMMARY_WEBHOOK: "",
      GOALS_COACH_ALPHA_ENABLED: "false",
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

  const health = await waitForHealth(child, port);
  assert.deepEqual(health, { ok: true });
  assert.equal(child.exitCode, null);
  assert.equal(stderr, "");
});

test("production startup wiring and sources contain no test-only imports", () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  const environmentExample = fs.readFileSync(path.join(projectRoot, ".env.example"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.match(serverSource, /createPhase1bStartup\(\)/);
  assert.match(serverSource, /coachingEngine: phase1bStartup\.engine/);
  assert.match(environmentExample, /GOALS_COACH_AI_ENABLED=false/);
  assert.equal(packageJson.scripts["migrate:phase1b"], "node migrate_004.js");
  assert.equal(packageJson.scripts["rollback:phase1b"], "node rollback_004.js");

  const productionFiles = [path.join(projectRoot, "server.js")];
  const goalsCoachDirectory = path.join(projectRoot, "src", "goals-coach");
  for (const name of fs.readdirSync(goalsCoachDirectory)) {
    if (name.endsWith(".js")) productionFiles.push(path.join(goalsCoachDirectory, name));
  }
  for (const file of productionFiles) {
    const source = fs.readFileSync(file, "utf8");
    for (const prohibited of [
      "test/helpers",
      "deterministic-alpha-responder",
      "fake-goals-coach-responder",
      "coaching-scenarios.test",
      "phase1b-startup.test",
    ]) {
      assert.equal(source.includes(prohibited), false, `${path.basename(file)} imports ${prohibited}`);
    }
  }
});
