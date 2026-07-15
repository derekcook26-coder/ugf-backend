"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is not configured.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function runMigration() {
  const migrationPath = path.join(
    __dirname,
    "migration_001_checkin_tables.sql"
  );

  if (!fs.existsSync(migrationPath)) {
    throw new Error(
      "migration_001_checkin_tables.sql was not found."
    );
  }

  const sql = fs.readFileSync(migrationPath, "utf8");
  const client = await pool.connect();

  try {
    console.log("Starting UGF database migration...");
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("UGF database migration completed successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration failed:", error.message);
    process.exit(1);
  });
