/**
 * Test runner for the new retrospective
 * Run: STRATEGIES_DB_PATH=data/strategies.pi.db npx tsx scripts/retro-test.ts
 */
import { config } from "dotenv";
config();

import { PortfolioState } from "../src/state/portfolio.js";
import { StrategyStore } from "../src/state/strategies.js";
import { runDailyRetrospective, shouldRunRetrospective } from "../src/retrospective/retrospective.js";

async function main() {
  const state = new PortfolioState(100);
  const strategies = new StrategyStore("data/strategies.pi.db");
  
  const today = "2026-07-09";
  console.log("Checking if retro should run for", today, "...");
  const should = await shouldRunRetrospective(state, today);
  console.log("Should run:", should);
  
  console.log("\nState pre-run:");
  console.log("  Trades today:", state.getTradesForDay(today).length);
  console.log("  Snapshots today:", state.getSnapshotsForDay(today).length);
  console.log("  Strategies total:", strategies.getTotalCount());
  console.log("  State counts:", JSON.stringify(strategies.getStateCounts()));
  console.log("  Strategist lessons:", strategies.getStrategistLessons(true).length);
  
  const mem = state.getMemory();
  console.log("  Existing trader lessons (active):", mem.lessons.filter(l => !l.deprecated).length);
  
  console.log("\nRunning retrospective for 2026-07-09...");
  const report = await runDailyRetrospective(state, strategies, today);
  
  console.log("\n=== REPORT COMPLETE ===");
  console.log("Date:", report.date);
  console.log("Trades:", report.tradeCount);
  console.log("Net P&L:", report.netPnL);
  console.log("Win Rate:", report.winRate);
  console.log("What-If strategies:", report.whatIfAnalysis?.totalStrategiesAnalyzed ?? 0);
  
  const mem2 = state.getMemory();
  const activeTrader = mem2.lessons.filter(l => !l.deprecated);
  console.log("\nActive trader lessons after retro:", activeTrader.length);
  for (const l of activeTrader) {
    console.log(`  [${l.category}] w:${l.weight.toFixed(2)} r:${l.reinforcementCount}x ${l.insight.slice(0, 100)}`);
  }
  const stratLessons = strategies.getStrategistLessons(true);
  console.log("\nActive strategist lessons after retro:", stratLessons.length);
  for (const l of stratLessons) {
    console.log(`  [${l.category}] w:${l.weight.toFixed(2)} r:${l.reinforcementCount}x ${l.insight.slice(0, 100)}`);
  }
  
  strategies.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });