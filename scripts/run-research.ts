/**
 * Standalone research engine runner.
 * Starts the 24/7 research data ingestion pipeline independently.
 * Usage: npx tsx scripts/run-research.ts
 */

import { config } from "dotenv";
config();

import { initResearch, getResearchHealth } from "../src/research/ingestion.ts";

async function main() {
  console.log("=".repeat(50));
  console.log("📡  Scrooge Research Engine (standalone)");
  console.log("=".repeat(50));
  console.log();

  const dbPath = "data/research.db";
  console.log(`📂 DB: ${dbPath}`);

  try {
    await initResearch(dbPath, []);
    console.log("✅ Research engine started successfully");
    console.log("⏰ Timer: every 240s (4 min), prune every 60 ticks");
    console.log();
    console.log("Press Ctrl+C to stop");
    console.log();

    // Health check every 30s
    setInterval(() => {
      try {
        const health = getResearchHealth();
        if (health) {
          const total = health.totalCycles || 0;
          const sources = health.sources || {};
          const statuses = Object.entries(sources)
            .map(([name, s]: [string, any]) => `${name}: ${s.successes || 0}✅/${s.failures || 0}❌`)
            .join(" | ");
          console.log(`[${new Date().toISOString()}] Cycle ${total} | ${statuses}`);
        }
      } catch {}
    }, 30000);

    // Keep alive
    process.on("SIGINT", () => {
      console.log("\n⏹️  Shutting down research engine...");
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("\n⏹️  Shutting down research engine...");
      process.exit(0);
    });

    await new Promise(() => {});
  } catch (e) {
    console.error("❌ Failed to start research engine:", e);
    process.exit(1);
  }
}

main();