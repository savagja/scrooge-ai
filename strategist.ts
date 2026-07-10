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
import { setStrategistState } from "./src/brain/strategist-tools.js";
import { PortfolioState } from "./src/state/portfolio.js";
import { StrategyStore } from "./src/state/strategies.js";
import { getClock } from "./src/execution/alpaca.js";
import { initResearch, stopResearch, getSignalStore } from "./src/research/index.js";
import { getVix, getSpyChange } from "./src/ingestion/market.js";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const REPORT_PATH = join(process.cwd(), "data", "strategist-report.md");

/**
 * Generate a structured markdown report for the trader.
 * Written to data/strategist-report.md after each strategist session.
 * The report includes:
 *   - Market summary (regime, VIX, breadth) from the research DB
 *   - Top strategies ranked by confidence × conviction × state
 *   - Explanation of why each strategy is at the top
 *   - Strategy state distribution (overview of all strategies)
 *   - Key signals / themes the strategist is tracking
 */
async function generateStrategistReport(
  strategies: StrategyStore,
  sessionType: "pre-market" | "mid-session",
  clock: { isOpen: boolean; nextOpen: string; nextClose: string; timestamp: string },
  strategistOutput: string
): Promise<string> {
  const now = new Date().toISOString();
  const lines: string[] = [];

  // ── Header ─────────────────────────────────────────────────────────────
  lines.push("# 🧠 Strategist Report");
  lines.push("");
  lines.push(`**Generated:** ${now}`);
  lines.push(`**Session:** ${sessionType === "pre-market" ? "Pre-Market" : "Mid-Session"}`);
  lines.push(`**Market:** ${clock.isOpen ? "OPEN" : "CLOSED"}`);
  if (clock.isOpen) {
    lines.push(`**Closes:** ${clock.nextClose}`);
  } else {
    lines.push(`**Opens:** ${clock.nextOpen}`);
  }
  lines.push("");

  // ── Market Summary ─────────────────────────────────────────────────────
  lines.push("## 📊 Market Summary");
  lines.push("");
  lines.push("| Measure | Value |");
  lines.push("|---------|-------|");

  // Get VIX and SPY from market data functions
  let vix: string = "unknown";
  let spyChange: string = "unknown";
  let regime: string = "unknown";
  try {
    const vixVal = await getVix();
    if (vixVal !== null) vix = vixVal.toFixed(2);
    const spyVal = await getSpyChange();
    if (spyVal !== null) spyChange = spyVal.toFixed(2);
    // Infer regime from VIX (simple heuristic for the report)
    const vixNum = parseFloat(vix);
    if (!isNaN(vixNum)) {
      if (vixNum < 14) regime = "trending_up (low volatility)";
      else if (vixNum < 20) regime = "normal";
      else if (vixNum < 30) regime = "elevated (cautious)";
      else regime = "high volatility (defensive)";
    }
  } catch { /* fall through with defaults */ }

  lines.push(`| VIX | ${vix} |`);
  lines.push(`| SPY Change | ${spyChange}% |`);
  lines.push(`| Market Regime | ${regime} |`);
  lines.push("");

  // ── Strategy Overview ──────────────────────────────────────────────────
  lines.push("## 📋 Strategy Overview");
  lines.push("");
  const counts = strategies.getStateCounts();
  const total = strategies.getTotalCount();
  lines.push(`**Total strategies:** ${total}`);
  lines.push("");
  lines.push("| State | Count |");
  lines.push("|-------|-------|");
  if (counts.anticipated) lines.push(`| Anticipated | ${counts.anticipated} |`);
  if (counts.developing) lines.push(`| Developing | ${counts.developing} |`);
  if (counts.active) lines.push(`| Active (in position) | ${counts.active} |`);
  if (counts.realized) lines.push(`| Realized | ${counts.realized} |`);
  if (counts.failed) lines.push(`| Failed | ${counts.failed} |`);
  if (counts.stale) lines.push(`| Stale | ${counts.stale} |`);
  lines.push("");

  // ── Top Strategies ─────────────────────────────────────────────────────
  const top = strategies.getTopStrategies(20); // grab extra for selection
  const topDisplay = top.slice(0, 10); // show at most 10

  lines.push("## 🏆 Top Strategies for Trader");
  lines.push("");

  if (topDisplay.length === 0) {
    lines.push("No strategies ready for execution yet. The strategist is still analyzing the market.");
    lines.push("");
  } else {
    // Explain the ranking
    lines.push("Strategies are ranked by: developing > anticipated, then high > medium > low conviction, then confidence score, then most recently updated.");
    lines.push("A strategy in `developing` state has 2+ converging signals. `anticipated` means a single interesting sighting.");
    lines.push("");

    for (let i = 0; i < topDisplay.length; i++) {
      const s = topDisplay[i];
      const rank = i + 1;

      // Build why-this-is-at-top explanation
      const reasons: string[] = [];
      if (s.state === "developing") reasons.push("Multiple converging signals");
      if (s.conviction === "high") reasons.push("High conviction");
      if (s.confidence >= 0.5) reasons.push(`Confidence ${(s.confidence * 100).toFixed(0)}%`);
      if (rank === 1) reasons.push("Top-ranked by conviction × confidence");

      lines.push(`### ${rank}. ${s.ticker} — ${s.direction?.toUpperCase() ?? "?"} ${s.strategy_type}`);
      lines.push("");
      lines.push(`**State:** ${s.state} | **Conviction:** ${s.conviction} | **Confidence:** ${(s.confidence * 100).toFixed(0)}%`);
      lines.push("");
      lines.push(`**Thesis:** ${s.thesis}`);
      if (s.catalyst) lines.push(`**Catalyst:** ${s.catalyst}`);
      if (s.timeframe) lines.push(`**Timeframe:** ${s.timeframe}`);
      if (s.rationale) lines.push(`**Rationale:** ${s.rationale.slice(0, 300)}`);
      if (s.key_signals && (s.key_signals as string[]).length > 0)
        lines.push(`**Key Signals:** ${(s.key_signals as string[]).join(", ")}`);
      if (s.entry_conditions) lines.push(`**Entry Conditions:** ${s.entry_conditions}`);
      if (s.exit_conditions) lines.push(`**Exit Conditions:** ${s.exit_conditions}`);
      lines.push("");

      // What-If historical grade
      if (s.what_if) {
        const emoji = s.what_if.grade >= 4 ? "✅" : s.what_if.grade <= 2 ? "❌" : "➖";
        const pnlStr = s.what_if.potentialGainLoss >= 0
          ? `+$${s.what_if.potentialGainLoss.toFixed(2)}`
          : `-$${Math.abs(s.what_if.potentialGainLoss).toFixed(2)}`;
        lines.push(`**Historical Grade:** ${emoji} ${s.what_if.grade}/5 — ${pnlStr} (${s.what_if.potentialGainLossPct >= 0 ? "+" : ""}${s.what_if.potentialGainLossPct.toFixed(1)}%) | ${s.what_if.abstraction}`);
        lines.push("");
      } else {
        lines.push("**Historical Grade:** No prior trades — new setup.");
        lines.push("");
      }

      // Why this rank
      lines.push(`**Why #${rank}:** ${reasons.join(". ")}.`);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  // ── Strategist Commentary ──────────────────────────────────────────────
  if (strategistOutput.trim()) {
    lines.push("## 💬 Strategist Analysis");
    lines.push("");
    lines.push("```");
    lines.push(strategistOutput.trim());
    lines.push("```");
    lines.push("");
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push(`_Report auto-generated by Scrooge Strategist at ${now}_`);
  lines.push("");

  return lines.join("\n");
}

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
  setStrategistState(state, strategies);

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
      "1. consult_strategist_lessons — review lessons from past retrospectives about signal quality and strategy×regime fit\n" +
      "2. describe_datasets — orient yourself to what's available\n" +
      "3. search_signals (since_minutes: 1440) — scan the past 24h of signal activity\n" +
      "4. search_sector_signals — check for sector rotation patterns\n" +
      "5. get_macro_calendar — note upcoming events in next 48h\n" +
      "6. discover_opportunities — find any pre-market movers\n" +
      "7. For each signal cluster you find:\n" +
      "   - If a clear, differentiated thesis exists → create_strategy\n" +
      "   - If watching but unclear → create_strategy with state: anticipated, confidence ~0.2\n" +
      "   - Do NOT create strategies for the same theme repeatedly — one strategy per signal cluster\n" +
      "8. Review existing strategies — update their state based on overnight data\n" +
      "   - Consolidate duplicate strategies for the same ticker/theme — merge into one\n" +
      "   - Archive strategies where catalyst has expired or thesis is invalidated\n" +
      "   - Promote to developing only when 2+ independent signals converge\n\n" +
      "Current strategy counts: A=" + stateCounts.anticipated + " D=" + stateCounts.developing +
      " | Total: " + strategies.getTotalCount() + "\n\n" +
      "QUALITY OVER QUANTITY. One well-researched strategy beats 15 copies of the same idea. " +
      "Do not create strategies for tickers you already have strategies for unless the new thesis is fundamentally different."
    : "=== STRATEGIST MID-SESSION UPDATE (Cycle " + cycle + ") ===\n\n" +
      "The market is open. New signals have accumulated since your last check.\n\n" +
      "YOUR TASKS:\n" +
      "1. consult_strategist_lessons — review active lessons for signal quality patterns\n" +
      "2. search_signals (since_minutes: 30) — what's changed since last check\n" +
      "3. Review existing strategies — this is your PRIORITY. For each:\n" +
      "   a) CONSOLIDATE: merge duplicate strategies for the same ticker/theme into one\n" +
      "   b) PROMOTE: move anticipated -> developing when 2+ signals converge\n" +
      "   c) KILL: archive strategies where thesis hasn't materialized in reasonable time\n" +
      "   d) STALE: mark strategies with no new signals as stale\n" +
      "4. Create NEW strategies ONLY for tickers you don't already track with a clearly different thesis\n" +
      "5. Do NOT create duplicate strategies. One per ticker/thesis.\n\n" +
      "CRITICAL: You have " + stateCounts.anticipated + " strategies stuck in 'anticipated' — " +
      "many are duplicates. Your main job is to CONSOLIDATE and KILL, not to create more. " +
      "A strategy that doesn't develop within 24h should be archived.\n" +
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

    // Generate strategist report for the trader
    try {
      const report = await generateStrategistReport(
        strategies,
        sessionType,
        clock,
        output
      );
      mkdirSync(dirname(REPORT_PATH), { recursive: true });
      writeFileSync(REPORT_PATH, report, "utf-8");
      const lineCount = report.split("\n").length;
      console.log(`  Report written to ${REPORT_PATH} (${lineCount} lines)`);
    } catch (e: any) {
      console.warn("  Failed to generate strategist report:", e.message);
    }
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
