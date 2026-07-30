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

// Catch unhandled promise rejections so a single Yahoo timeout or Alpaca blip
// doesn't crash the entire strategist process.
process.on("unhandledRejection", (reason: any) => {
  console.warn(`⚠️  Strategist unhandled rejection (non-fatal): ${reason?.message ?? reason}`);
});
process.on("uncaughtException", (err: any) => {
  console.warn(`⚠️  Strategist uncaught exception (non-fatal): ${err?.message ?? err}`);
});

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
  lines.push("# 🧠 Strategist Briefing");
  lines.push("");
  lines.push(`Generated: ${now}`);
  lines.push(`Session: ${sessionType === "pre-market" ? "Pre-Market" : "Mid-Session"}`);
  lines.push("");

  // ── Brief: What changed (lifecycle actions) ────────────────────────────
  // Extract lifecycle actions from the strategist's own output
  const lifecycleActions = extractLifecycleActions(strategistOutput);
  if (lifecycleActions.length > 0) {
    lines.push("## 🔄 What Changed");
    lines.push("");
    for (const action of lifecycleActions) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  // ── Brief: Market observations (only what the structured data can't express) ──
  const observations = extractMarketObservations(strategistOutput);
  if (observations) {
    lines.push("## 👁️ Market Observations");
    lines.push("");
    lines.push(observations);
    lines.push("");
  }

  // ── Brief: Strategist's conclusions per strategy ───────────────────────
  // Just the per-strategy narrative commentary, not the fields that are in the DB
  const strategyNotes = extractStrategyCommentary(strategistOutput);
  if (strategyNotes.size > 0) {
    lines.push("## 📝 Strategist Notes");
    lines.push("");
    lines.push("Key points the strategist wants you to know about these strategies:");
    lines.push("");
    for (const [ticker, note] of strategyNotes) {
      if (note) {
        lines.push(`**${ticker}:** ${note}`);
        lines.push("");
      }
    }
  }

  // ── Brief: Warnings / cross-currents ───────────────────────────────────
  const warnings = extractWarnings(strategistOutput);
  if (warnings.length > 0) {
    lines.push("## ⚠️ Warnings & Cross-Currents");
    lines.push("");
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  // ── Fallback: If extraction produced nothing, include raw output ────────
  const hasExtractedContent = lifecycleActions.length > 0 || observations || strategyNotes.size > 0 || warnings.length > 0;
  if (!hasExtractedContent && strategistOutput.trim()) {
    lines.push("## 📝 Strategist's Analysis");
    lines.push("");
    lines.push("```");
    lines.push(strategistOutput.trim());
    lines.push("```");
    lines.push("");
  }

  // ── Check if there are any strategies at all ───────────────────────────
  const total = strategies.getTotalCount(true);
  if (total === 0) {
    lines.push("## ℹ️ No Active Strategies");
    lines.push("");
    lines.push("The strategist hasn't created any strategies yet. This is normal on first run or during quiet market periods. The trader should focus on managing existing positions and holding cash.");
    lines.push("");
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("The structured strategy data (thesis, catalyst, entry/exit conditions, historical grades) is available in the CANDIDATE STRATEGIES section above. This briefing only contains what the structured data can't express: market observations, lifecycle actions, and per-strategy narrative notes.");
  lines.push("");
  lines.push(`_Auto-generated by Scrooge Strategist at ${now}_`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Extract lifecycle actions from the strategist's output.
 * Looks for lines mentioning created/archived/promoted/demoted strategies.
 */
function extractLifecycleActions(output: string): string[] {
  const actions: string[] = [];
  const lines = output.split("\n");
  let inLifecycleSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect lifecycle action lines
    if (/ARCHIVED|CREATED|PROMOTED|DEMOTED|KILLED|ARCHIVE|FAILED/.test(trimmed)) {
      actions.push(trimmed);
      continue;
    }

    // Also catch table rows from the strategist's lifecycle actions table
    if (/^\|\s*(🗑️|📝|⬆️|⬇️|✅|❌)/.test(trimmed)) {
      // Strip markdown table formatting
      const cleaned = trimmed.replace(/^\|\s*/, "").replace(/\s*\|$/, "").trim();
      if (cleaned.length > 5) actions.push(cleaned);
    }
  }

  return actions;
}

/**
 * Extract the strategist's market-level observations (not ticker-specific).
 * Grabs the first paragraph or two of analysis text that isn't about a specific strategy.
 */
function extractMarketObservations(output: string): string | null {
  const lines = output.split("\n");
  const relevant: string[] = [];
  let inAnalysis = false;
  let seen = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Start collecting after the strategist mentions market overview or after a lifecycle header
    if (/market overview|sector rotation|broad market|bearish.*cluster|bullish.*cluster|regime|breadth/.test(trimmed.toLowerCase()) &&
        !trimmed.startsWith("#") && !trimmed.startsWith("**") && trimmed.length > 20) {
      if (!seen) {
        inAnalysis = true;
        seen = true;
      }
    }

    if (inAnalysis) {
      // Stop at lifecycle table headers or strategy sections
      if (/^\|\s*(Action|Ticker)/.test(trimmed) ||
          /^##/.test(trimmed) && !relevant.length) {
        continue;
      }
      if (trimmed.startsWith("###")) break;
      if (trimmed.length > 0) relevant.push(trimmed);
      // Stop collecting after ~15 lines (enough for a paragraph or two)
      if (relevant.length > 15) break;
    }
  }

  if (relevant.length === 0) return null;
  return relevant.join(" ").slice(0, 800);
}

/**
 * Extract per-strategy commentary from the strategist's output.
 * Returns a map of ticker -> narrative note.
 */
function extractStrategyCommentary(output: string): Map<string, string> {
  const notes = new Map<string, string>();
  const lines = output.split("\n");

  let currentTicker: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();

    // Detect strategy headers: both "### TICKER —" and "TICKER:" or "TICKER:" formats
    const headerMatch = trimmed.match(/^###\s*(\d+\.\s*)?([A-Z]+)\s*[—–-]/);
    const inlineMatch = !headerMatch && trimmed.match(/^([A-Z]{1,5})\s*[:]/);
    if (headerMatch) {
      currentTicker = headerMatch[2];
      continue;
    }
    if (inlineMatch) {
      currentTicker = inlineMatch[1];
      // If it's a TICKER: comment format, capture the rest of the line as commentary
      const rest = trimmed.slice(inlineMatch[0].length).trim();
      if (rest.length > 10) {
        const existing = notes.get(currentTicker) || "";
        notes.set(currentTicker, existing + " " + rest);
      }
      continue;
    }

    // Detect lines that look like commentary (not structured fields)
    if (currentTicker && trimmed.length > 30 &&
        !trimmed.startsWith("**") &&
        !trimmed.startsWith("|") &&
        !trimmed.startsWith("---") &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("_") &&
        !/^Thesis:|^Catalyst:|^Timeframe:|^Key Signals:|^Entry Conditions:|^Exit Conditions:|^Historical Grade:|^Why #|^Rationale:/.test(trimmed) &&
        !trimmed.startsWith("```")) {
      const existing = notes.get(currentTicker) || "";
      notes.set(currentTicker, existing + " " + trimmed);
    }
  }

  // Trim and cap length per ticker
  for (const [ticker, note] of notes) {
    notes.set(ticker, note.trim().slice(0, 400));
  }

  return notes;
}

/**
 * Extract warnings and cross-currents from the strategist's output.
 */
function extractWarnings(output: string): string[] {
  const warnings: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (/warn|risk|caution|bearish|be careful|watch out|concern|squeeze|reversal/.test(trimmed) &&
        trimmed.length > 20 && trimmed.length < 300) {
      warnings.push(trimmed.slice(0, 200));
    }
  }

  return warnings.slice(0, 3);
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
  console.log("Strategy store: data/strategies.db (" + strategies.getTotalCount() + " total, " + strategies.getTotalCount(true) + " active)");

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

  let _lastMidSessionRun = 0;

  while (true) {
    // Reload config every iteration
    reloadConfig();

    try {
      const clock = await getClock();
      const now = new Date().toISOString();

      if (!clock.isOpen) {
        // ── MARKET CLOSED ────────────────────────────────────────────────
        // Check if we're in the pre-market window (30 min before open)
        const msToOpen = new Date(clock.nextOpen).getTime() - Date.now();
        const minutesToOpen = msToOpen / 60000;

        if (minutesToOpen <= 30 && minutesToOpen > 0) {
          console.log("[" + now + "] Pre-market window (" + minutesToOpen.toFixed(0) + " min to open) — running strategist...");
          await runStrategistSession(state, strategies, cfg, "pre-market");
        } else if (minutesToOpen < 0) {
          // Market has closed — we're in after-hours
          console.log("[" + now + "] Market closed. Strategist sleeping until pre-market window.");
          console.log("  Next open: " + clock.nextOpen);
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
        // Run mid-session every ~12 minutes (at 5min poll interval, that's ~2 iterations)
        // Use a time-based check so process restarts don't affect cadence
        const nowMs = Date.now();
        if (nowMs - _lastMidSessionRun > 720000) { // 12 minutes
          _lastMidSessionRun = nowMs;
          console.log("[" + now + "] Market open — running strategist session...");
          await runStrategistSession(state, strategies, cfg, "mid-session");
        }
      }
    } catch (cycleErr: any) {
      // Individual cycle crashed (network timeout, API error, etc.) — log and continue
      console.error("[" + new Date().toISOString() + "] ⚠️  Strategist session failed (continuing loop):", cycleErr.message ?? cycleErr);
    }

    // Sleep for the poll interval
    await new Promise(r => setTimeout(r, cfg.pollIntervalMs ?? 120000));
  }
}

async function runStrategistSession(
  state: PortfolioState,
  strategies: StrategyStore,
  cfg: ReturnType<typeof getConfig>,
  sessionType: "pre-market" | "mid-session"
) {
  const clock = await getClock();

  // Format current ET time from Alpaca clock
  let etTimeStr = "";
  let etDateStr = "";
  if (clock) {
    const clockTs = new Date(clock.timestamp);
    etTimeStr = clockTs.toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
    etDateStr = clockTs.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

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
    " (" + (stateCounts.failed + stateCounts.stale) + " failed/stale)"
  );

  // Build session prompt based on session type
  const clockHeader = "Current Eastern Time: " + etDateStr + " — " + etTimeStr + "";
  const sessionPrompt = sessionType === "pre-market"
    ? "=== STRATEGIST PRE-MARKET SESSION ===\n\n" +
      clockHeader + "\n\n" +
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
      "Current strategy counts: A=" + stateCounts.anticipated + " D=" + stateCounts.developing + " R=" + stateCounts.realized +
      " | Total: " + strategies.getTotalCount(true) + " (active)" + (stateCounts.failed + stateCounts.stale > 0 ? " + " + (stateCounts.failed + stateCounts.stale) + " failed/stale" : "") + "\n\n" +
      "QUALITY OVER QUANTITY. One well-researched strategy beats 15 copies of the same idea. " +
      "Do not create strategies for tickers you already have strategies for unless the new thesis is fundamentally different.\n\n" +
      "OUTPUT FORMAT: Discuss strategies using `### TICKER —` headers followed by your narrative commentary. " +
      "Do NOT repeat thesis/catalyst/entry/exit conditions — those are in the database. " +
      "Cover: lifecycle actions, market observations, per-strategy narrative, and any warnings."
    : "=== STRATEGIST MID-SESSION UPDATE ===\n\n" +
      clockHeader + "\n\n" +
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
      " | Total: " + strategies.getTotalCount() + "\n\n" +
      "OUTPUT FORMAT: Discuss strategies using `### TICKER —` headers followed by your narrative commentary. " +
      "Do NOT repeat thesis/catalyst/entry/exit conditions — those are in the database. " +
      "Cover: lifecycle actions, market observations, per-strategy narrative, and any warnings.";

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
