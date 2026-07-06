/**
 * Strategist entry point.
 * Starts the strategist process which forms hypotheses and writes to strategies.db.
 * Run with: npx tsx strategist.ts
 *
 * Timing:
 *   - Pre-market (T-30min): Full sweep of overnight data, build initial strategy slate
 *   - During market (every 6th trader cycle ~12-20min): Refine strategies
 *   - Market close: Wrap-up
 */

import { config } from "dotenv";
config();

import { getConfig, reloadConfig } from "./src/config.js";
import { createStrategistBrain } from "./src/brain/strategist-agent.js";
import { setStrategistState, getWatchlist } from "./src/brain/strategist-tools.js";
import { PortfolioState } from "./src/state/portfolio.js";
import { StrategyStore } from "./src/state/strategies.js";
import { getClock } from "./src/execution/alpaca.js";
import { initResearch, stopResearch } from "./src/research/index.js";

async function main() {
  const cfg = getConfig();

  console.log("=".repeat(60));
  console.log("   S C R O O G E  —  Strategist");
  console.log("   Forms hypotheses. Does NOT trade.");
  console.log("=".repeat(60));
  console.log();

  // Initialize strategy store
  const strategies = new StrategyStore(cfg.research?.dbPath?.replace("research.db", "strategies.db") ?? "data/strategies.db");
  console.log("Strategy store: data/strategies.db (" + strategies.getTotalCount() + " existing)");

  // Initialize portfolio state (for reading positions/memory only)
  const state = new PortfolioState(cfg.initialCapital);
  setStrategistState(state, strategies, cfg.watchlist);

  // Start research engine if configured
  if (cfg.research?.enabled) {
    await initResearch(cfg.research.dbPath ?? "data/research.db", cfg.watchlist)
      .then(() => console.log("Research engine connected"))
      .catch((e: any) => console.warn("Research engine init failed: " + e.message));
  }

  console.log("OpenRouter: " + (process.env.OPENROUTER_API_KEY ? "configured" : "NOT SET"));
  console.log();

  // ═══════════════════════════════════════════════════════════════════════
  // POSITION BACKFILL: Create strategies for existing positions without links
  // ═══════════════════════════════════════════════════════════════════════

  const positions = state.getPositions();
  let backfilled = 0;
  for (const pos of positions) {
    // Check if this ticker already has an active/realized strategy
    const existing = strategies.getByTicker(pos.symbol, 3);
    const hasStrategy = existing.some(s => s.state === "active" || s.state === "realized" || s.state === "developing");
    if (!hasStrategy) {
      strategies.create({
        ticker: pos.symbol,
        strategy_type: (pos.strategy as any) ?? "momentum",
        direction: pos.direction ?? "long",
        thesis: "Backfilled from existing position — " + (pos.entrySignalSource ?? "manual") + " signal at " + (pos.entrySignalConfidence * 100).toFixed(0) + "% confidence",
        catalyst: pos.entrySignalSource ?? "pre-existing position",
        timeframe: "1-3_days",
        confidence: pos.entrySignalConfidence ?? 0.4,
        rationale: "Auto-generated strategy for position opened before strategist existed. Entry regime: " + pos.entryRegime + ", VIX: " + (pos.entryVix?.toFixed(1) ?? "?"),
        risk_factors: ["regime shift from " + pos.entryRegime, "original catalyst expired"],
        state: "active",
        created_by: "strategist",
      });
      // Link the strategy to the position
      // (position_id is set when trader executes, but for backfill we set it directly)
      backfilled++;
    }
  }
  if (backfilled > 0) {
    console.log("Backfilled " + backfilled + " strategies for existing positions without strategy links.");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MAIN LOOP
  // ═══════════════════════════════════════════════════════════════════════

  let cycleNumber = 0;

  while (true) {
    cycleNumber++;

    // Reload config periodically
    if (cycleNumber % 10 === 0) {
      reloadConfig();
    }

    const clock = await getClock();
    const now = new Date().toISOString();

    if (!clock.isOpen) {
      // ── MARKET CLOSED ────────────────────────────────────────────────
      // Check if we're in the pre-market window (30 min before open)
      const msToOpen = new Date(clock.nextOpen).getTime() - Date.now();
      const minutesToOpen = msToOpen / 60000;

      if (minutesToOpen <= 30 && minutesToOpen > 0 && cycleNumber % 3 === 0) {
        console.log("[" + now + "] Pre-market window (" + minutesToOpen.toFixed(0) + " min to open) — running strategist...");
        await runStrategistSession(state, strategies, cfg, "pre-market", cycleNumber);
      } else if (minutesToOpen < 0) {
        // Market has closed — we're in after-hours
        console.log("[" + now + "] Market closed. Strategist sleeping until pre-market window.");
        console.log("  Next open: " + clock.nextOpen);
        // Sleep for 5 minutes before checking again
        await new Promise(r => setTimeout(r, 300000));
        continue;
      } else {
        // Regular closed hours
        console.log("[" + now + "] Market closed. Next open: " + clock.nextOpen + " (" + minutesToOpen.toFixed(0) + " min)");
        await new Promise(r => setTimeout(r, 300000));
        continue;
      }
    } else {
      // ── MARKET OPEN ──────────────────────────────────────────────────
      // Run strategist every N cycles (e.g., every 6th ~= every 12 min)
      if (cycleNumber % 6 === 0 || cycleNumber === 1) {
        console.log("[" + now + "] Market open — running strategist cycle " + cycleNumber + "...");
        await runStrategistSession(state, strategies, cfg, "mid-session", cycleNumber);
      }
    }

    // Sleep for the poll interval
    await new Promise(r => setTimeout(r, cfg.pollIntervalMs ?? 120000));
  }
}

async function runStrategistSession(
  state: PortfolioState,
  strategies: StrategyStore,
  cfg: ReturnType<typeof getConfig>,
  sessionType: "pre-market" | "mid-session",
  cycle: number
) {
  const clock = await getClock();
  console.log("  Strategist session: " + sessionType + " | Market: " + (clock.isOpen ? "OPEN" : "CLOSED"));

  // Prune stale candidates first
  const staleCandidates = strategies.getStaleCandidates(48);
  for (const s of staleCandidates) {
    strategies.archive(s.id, "stale", "No updates in 48h");
    console.log("  Pruned stale strategy: " + s.ticker + " (" + s.id.slice(0, 16) + "...)");
  }
  if (staleCandidates.length > 0) {
    console.log("  Pruned " + staleCandidates.length + " stale strategies");
  }

  // Count current state
  const stateCounts = strategies.getStateCounts();
  console.log("  Strategies: " +
    "A:" + stateCounts.anticipated +
    " D:" + stateCounts.developing +
    " R:" + stateCounts.realized +
    " F:" + stateCounts.failed +
    " S:" + stateCounts.stale
  );

  // Build session prompt based on session type
  const sessionPrompt = sessionType === "pre-market"
    ? "=== STRATEGIST PRE-MARKET SESSION ===\n\n" +
      "The market opens in ~30 minutes. The research DB has been accumulating signals overnight.\n\n" +
      "YOUR TASKS:\n" +
      "1. describe_datasets — orient yourself to what's available\n" +
      "2. search_signals (since_minutes: 1440) — scan the past 24h of signal activity\n" +
      "3. search_sector_signals — check for sector rotation patterns\n" +
      "4. get_macro_calendar — note upcoming events in next 48h\n" +
      "5. discover_opportunities — find any pre-market movers\n" +
      "6. For each signal cluster you find:\n" +
      "   - If a clear thesis exists → create_strategy\n" +
      "   - If watching but unclear → create_strategy with state: anticipated, confidence ~0.2\n" +
      "7. Review existing strategies — update their state based on overnight data\n\n" +
      "Current strategy counts: A=" + stateCounts.anticipated + " D=" + stateCounts.developing +
      " | Total: " + strategies.getTotalCount() + "\n\n" +
      "Be prolific. Better 50 watching than miss one that develops."
    : "=== STRATEGIST MID-SESSION UPDATE (Cycle " + cycle + ") ===\n\n" +
      "The market is open. New signals have accumulated since your last check.\n\n" +
      "YOUR TASKS:\n" +
      "1. search_signals (since_minutes: 30) — what's changed since last check\n" +
      "2. Update existing strategies based on new data (update_strategy)\n" +
      "3. Create new strategies for newly observed signal clusters (create_strategy)\n" +
      "4. Archive strategies where thesis is invalidated (archive_strategy)\n" +
      "5. Promote strategies where signals are converging (anticipated -> developing)\n\n" +
      "Focus on CROSS-SOURCE CONVERGENCE: tickers appearing in 2+ different signal types are strongest.\n" +
      "Current strategy counts: A=" + stateCounts.anticipated + " D=" + stateCounts.developing +
      " | Total: " + strategies.getTotalCount();

  // Create the strategist brain and run session
  try {
    const session = await createStrategistBrain(process.env.OPENROUTER_API_KEY);
    console.log("  Strategist agent ready. Running session...");

    // Collect output
    let output = "";
    session.subscribe((event: any) => {
      if (event.type === "message_update") {
        if (event.assistantMessageEvent?.type === "text_delta") {
          output += event.assistantMessageEvent.delta;
        }
      }
      if (event.type === "tool_execution_start") {
        console.log("    [TOOL] " + event.toolName + "...");
      }
      if (event.type === "tool_execution_end") {
        const status = event.isError ? "ERROR" : "DONE";
        console.log("    [TOOL] " + event.toolName + " " + status);
      }
    });

    await session.prompt(sessionPrompt);

    if (output.trim()) {
      console.log("\n" + "=".repeat(40));
      console.log("STRATEGIST OUTPUT:");
      console.log("=".repeat(40));
      console.log(output.trim());
      console.log("=".repeat(40) + "\n");
    }

    session.dispose();
  } catch (e: any) {
    console.error("  Strategist session failed: " + e.message);
  }

  // After session, prune stale and purge old
  try {
    const purged = strategies.purgeRetained(14);
    if (purged > 0) {
      console.log("  Purged " + purged + " old archived strategies");
    }
  } catch {
    // non-critical
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nStrategist shutting down...");
  stopResearch();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\nStrategist received SIGTERM...");
  stopResearch();
  process.exit(0);
});
