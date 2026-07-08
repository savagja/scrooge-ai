/**
 * Standalone retrospective CLI.
 *
 * This is the entry point for the cron-scheduled retrospective process.
 * It is independent of both the trader and strategist processes.
 *
 * It reads state.json and strategies.db, produces the daily report,
 * and exits. Designed to be called via cron (or systemd timer) at market close.
 *
 * Usage:
 *   npx tsx retrospective.ts [date]
 *   npx tsx retrospective.ts 2026-07-07   # Force a specific date
 *   npx tsx retrospective.ts --force       # Re-run even if report exists
 */

import { config } from "dotenv";
config();

import { getConfig, getTradingDate } from "../config.js";
import { PortfolioState } from "../state/portfolio.js";
import { StrategyStore } from "../state/strategies.js";
import { runDailyRetrospective, shouldRunRetrospective } from "./retrospective.js";

async function main() {
  const args = process.argv.slice(2);
  const forceDate = args.find((a) => !a.startsWith("--"));
  const force = args.includes("--force");

  const cfg = getConfig();
  const state = new PortfolioState(cfg.initialCapital);
  const strategies = new StrategyStore("data/strategies.db");

  console.log("=".repeat(60));
  console.log("   S C R O O G E  —  Standalone Retrospective");
  console.log("=".repeat(60));
  console.log();

  const today = forceDate || getTradingDate();
  console.log(`📅 Date: ${today}`);

  // Check if we should run
  if (!force) {
    const shouldRun = await shouldRunRetrospective(state, today);
    if (!shouldRun) {
      // Double-check by looking at latest report date
      const latest = state.getLatestReport();
      if (latest && latest.date === today) {
        console.log(`✅ Report already exists for ${today}. Use --force to re-run.`);
        console.log(`   Latest report: ${latest.date} at ${latest.timestamp}`);
        process.exit(0);
      }
    }
  }

  // Gather pre-run stats
  const trades = state.getTradesForDay(today);
  const history = state.getSnapshotsForDay(today);
  const strategyCount = strategies.getTotalCount();
  const stateCounts = strategies.getStateCounts();

  console.log(`📊 Pre-run stats:`);
  console.log(`   Trades today: ${trades.length}`);
  console.log(`   Snapshots today: ${history.length}`);
  console.log(`   Total strategies: ${strategyCount}`);
  console.log(`   Strategy states: A:${stateCounts.anticipated} D:${stateCounts.developing} R:${stateCounts.realized} F:${stateCounts.failed} S:${stateCounts.stale}`);
  console.log(`   Cash: $${state.getCash().toFixed(2)}`);
  console.log(`   Positions: ${state.getPositions().length}`);
  console.log();

  // Run the retrospective
  try {
    const report = await runDailyRetrospective(state, strategies, today);
    console.log();
    console.log("=".repeat(60));
    console.log("   RETROSPECTIVE COMPLETE");
    console.log("=".repeat(60));
    console.log();
    console.log(`   Date: ${report.date}`);
    console.log(`   Trades: ${report.tradeCount}`);
    console.log(`   P&L: $${report.netPnL.toFixed(2)}`);
    console.log(`   Win Rate: ${report.winRate.toFixed(1)}%`);
    const lessons = state.getMemory().lessons as Array<{ deprecated: boolean }>;
    console.log(`   Lesson count: ${lessons.filter((l) => !l.deprecated).length} active`);
    console.log();
    process.exit(0);
  } catch (e: any) {
    console.error(`\n❌ Retrospective failed: ${e.message}`);
    if (e.stack) {
      console.error(e.stack.slice(0, 500));
    }
    process.exit(1);
  }
}

main();
