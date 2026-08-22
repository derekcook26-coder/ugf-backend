"use strict";

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function opensslExecutable() {
  const configured = process.env.OPENSSL_EXECUTABLE;
  const candidates = [
    configured,
    "openssl",
    ...(process.platform === "win32" ? [
      "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
      "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    ] : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["version"], { encoding: "utf8", windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("OpenSSL is required to generate disposable loopback TLS material");
}

function createEphemeralTlsMaterial() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ugf-bootstrap-tls-"));
  const keyPath = path.join(directory, "key.pem");
  const certificatePath = path.join(directory, "certificate.pem");
  try {
    const result = spawnSync(opensslExecutable(), [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", keyPath, "-out", certificatePath,
    ], { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to generate disposable loopback TLS material: ${result.stderr || result.error?.message}`);
    }
    return Object.freeze({
      key: fs.readFileSync(keyPath),
      certificate: fs.readFileSync(certificatePath),
      dispose() { fs.rmSync(directory, { recursive: true, force: true }); },
    });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function startEphemeralHttpsApp(app) {
  const tls = createEphemeralTlsMaterial();
  const server = https.createServer({ key: tls.key, cert: tls.certificate }, app);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    return Object.freeze({
      url: `https://127.0.0.1:${address.port}`,
      certificate: tls.certificate,
      async close() {
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        tls.dispose();
      },
    });
  } catch (error) {
    server.closeAllConnections?.();
    tls.dispose();
    throw error;
  }
}

module.exports = { createEphemeralTlsMaterial, startEphemeralHttpsApp };
