/**
 * Emergency research.db recovery using sql.js (same library the app uses).
 * Run: npx tsx tools/recover_db.ts
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";

async function main() {
  const dbPath = process.argv[2] || "data/research.db";
  const bakPath = dbPath + ".bak";
  const outPath = dbPath + ".recovered";

  console.log(`Attempting to recover: ${dbPath}`);

  // 1. Try to open with sql.js
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();

  if (!existsSync(dbPath)) {
    console.log("File not found!");
    process.exit(1);
  }

  const buffer = readFileSync(dbPath);
  console.log(`File size: ${buffer.length} bytes`);

  try {
    const db = new SQL.Database(buffer);
    console.log("Database opened successfully!");

    // Check integrity
    const integrityResult = db.exec("PRAGMA integrity_check");
    if (integrityResult.length > 0) {
      const result = integrityResult[0].values[0][0];
      console.log(`Integrity check: ${result}`);
    }

    // Export all tables
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    for (const table of tables) {
      for (const row of table.values) {
        const name = String(row[0]);
        const countResult = db.exec(`SELECT COUNT(*) as c FROM "${name}"`);
        const count = countResult.length > 0 ? Number(countResult[0].values[0][0]) : 0;
        console.log(`  ${name}: ${count} rows`);
      }
    }

    // Export to new file
    const exported = db.export();
    writeFileSync(outPath, Buffer.from(exported));
    console.log(`\nRecovered database written to: ${outPath}`);
    console.log(`Size: ${exported.length} bytes`);

    db.close();

    // Backup original and move recovered to active
    if (existsSync(bakPath)) {
      console.log("Backup already exists, overwriting NOT doing backup");
    } else {
      renameSync(dbPath, bakPath);
      console.log(`Original backed up to: ${bakPath}`);
    }
    renameSync(outPath, dbPath);
    console.log(`Recovered database moved to: ${dbPath}`);

  } catch (e: any) {
    console.error(`Failed to open database: ${e.message}`);
    process.exit(1);
  }
}

main().catch(console.error);