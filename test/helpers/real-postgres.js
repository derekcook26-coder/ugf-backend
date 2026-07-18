const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const EmbeddedPostgres = require("embedded-postgres").default;
const { Pool } = require("pg");
const { runMigration } = require("../../migrate_002");
const { runMigration: runPhase1aMigration } = require("../../migrate_003");
const { runMigration: runPhase1bMigration } = require("../../migrate_004");

const projectRoot = path.resolve(__dirname, "../..");

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

async function createRealDisposablePostgres(options = {}) {
  const port = await availablePort();
  const databaseDir = path.join(
    os.tmpdir(),
    `ugf-phase2-postgres-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: "ugf_test",
    password: "local-disposable-only",
    port,
    persistent: false,
    onLog() {},
    onError() {},
  });
  await postgres.initialise();
  await postgres.start();
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "ugf_test",
    password: "local-disposable-only",
    database: "postgres",
    max: 10,
  });
  const migration001 = fs.readFileSync(
    path.join(projectRoot, "migration_001_checkin_tables.sql"),
    "utf8"
  );
  await pool.query(migration001);
  await runMigration({ pool });
  await runPhase1aMigration({ pool });
  if (options.phase1b === true) await runPhase1bMigration({ pool });
  return {
    pool,
    async close() {
      await pool.end();
      await postgres.stop();
    },
  };
}

module.exports = { createRealDisposablePostgres };
