/**
 * Main event loop for Scrooge.
 *
 * Architecture: The pi.dev agent IS the brain. We feed it market state via prompt(),
 * it reasons using custom tools, and it can directly execute trades.
 *
 * The loop:
 * 1. Build multi-source market context (programmatic — VIX, SPY, news, EDGAR, volume, Reddit, gaps, sector movers)
 * 2. Prompt the agent with pre-digested context + instructions
 * 3. Agent calls tools to dive deeper or execute trades
 * 4. Risk guardrails embedded in execution tools
 * 5. Sleep and repeat
 */

import { config } from "dotenv";
config();

// Catch unhandled promise rejections so a single Yahoo timeout or Alpaca blip
// doesn't crash the entire trader process.
process.on("unhandledRejection", (reason: any) => {
  console.warn(`⚠️  Unhandled rejection (non-fatal): ${reason?.message ?? reason}`);
});
process.on("uncaughtException", (err: any) => {
  console.warn(`⚠️  Uncaught exception (non-fatal): ${err?.message ?? err}`);
});

import { getConfig, reloadConfig, getTradingDate } from "./config.js";
import { createTradingBrain } from "./brain/agent.js";
import { setGlobalState, setStrategyStore, requireState, getWatchlist } from "./brain/tools.js";
import { PortfolioState } from "./state/portfolio.js";
import { StrategyStore } from "./state/strategies.js";
type Strategy = import("./types.js").Strategy;
import { getAccount, getOpenPositions, getClock, buildTickerContext } from "./execution/alpaca.js";
import { getVix, getSpyChange } from "./ingestion/market.js";
import { buildMarketContext, formatContextForPrompt, buildPreMarketBriefing, resetContextHistory } from "./context/builder.js";
import { runDailyRetrospective, shouldRunRetrospective } from "./retrospective/retrospective.js";
import { checkExitConditions } from "./risk/guardrails.js";
import { initResearch, stopResearch } from "./research/index.js";
import type { MarketState } from "./types.js";
import { join } from "path";
import { readFileSync } from "fs";

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main(isRetry = false) {
  const cfg = getConfig();

  if (!isRetry) {
    console.log("=".repeat(60));
    console.log("   S C R O O G E   —  AI Portfolio Manager (pi.dev + OpenRouter)");
    console.log("=".repeat(60));
    console.log();

    // Initialize state
    const state = new PortfolioState(cfg.initialCapital);
    const strategies = new StrategyStore("data/strategies.db");
    setGlobalState(state, cfg.watchlist);
    setStrategyStore(strategies);

    // Check for positions without strategies
    const positions = state.getPositions();
    let unlinkedCount = 0;
    for (const pos of positions) {
      const existing = strategies.getByTicker(pos.symbol, 3);
      const hasStrategy = existing.some(s => s.state === "active" || s.state === "realized" || s.state === "developing");
      if (!hasStrategy) unlinkedCount++;
    }
    if (unlinkedCount > 0) {
      console.log('⚠️  ' + unlinkedCount + ' position(s) without strategy links. The strategist will backfill on next cycle.');
    }

    console.log('💰 Initial Capital: $' + cfg.initialCapital);
    console.log('🧪 Dry Run: ' + (cfg.execution.dryRun ? 'YES - no real trades' : 'NO'));
    console.log('📋 Seed Watchlist: ' + cfg.watchlist.slice(0, 5).join(',') + '... (' + cfg.watchlist.length + ' tickers)');
    console.log('🔑 OpenRouter: ' + (process.env.OPENROUTER_API_KEY ? 'configured' : 'NOT SET'));
    console.log('🔑 Alpaca: ' + (process.env.ALPACA_API_KEY ? 'configured' : 'NOT SET'));
    console.log('⚙️  Config: stop=' + (cfg.risk.stopLossPct * 100).toFixed(0) + '%, trailing=' + (cfg.risk.trailingStopPct * 100).toFixed(0) + '%, hold=' + cfg.signal.holdMinutes + 'min');
    console.log();

    // ════════════════════════════════════════════════════════════
    // RESEARCH ENGINE — Starts its own independent timer, runs 24/7
    // ════════════════════════════════════════════════════════════
    if (cfg.research.enabled) {
      initResearch(cfg.research.dbPath, cfg.watchlist)
        .then(() => console.log('📡 Research engine started (' + cfg.research.dbPath + ')'))
        .catch((e) => console.warn('⚠️  Research engine init failed: ' + e.message));
    }
  }

  // Use requireState() — works on both first run and retry
  const state = requireState();

  // ════════════════════════════════════════════════════════════
  // STARTUP RECONCILIATION: Sync with Alpaca EVERY time
  // (Not just on first call — the retry loop skips initialization
  //  but MUST still reconcile positions & cash on each re-entry)
  // ════════════════════════════════════════════════════════════
  console.log("🔄 Syncing with Alpaca account...");
  try {
    const account = await getAccount();
    state.syncAccount(account.cash, account.settledCash);
    console.log(`   Cash: $${account.cash.toFixed(2)} | Settled: $${account.settledCash.toFixed(2)} | Equity: $${account.equity.toFixed(2)}`);

    // Backfill today's existing snapshots with Alpaca equity data
    const today = getTradingDate();
    const history = state.getPortfolioHistory();
    const todaySnaps = history.filter(s => s.timestamp.slice(0, 10) === today);
    if (todaySnaps.length > 0) {
      // Use last_equity (prior close) as the starting baseline
      const startEquity = account.lastEquity;
      const currentEquity = account.equity;
      // Linearly interpolate: early snapshots near startEquity, later ones near currentEquity
      const total = todaySnaps.length;
      for (let i = 0; i < total; i++) {
        const t = total > 1 ? i / (total - 1) : 1;
        todaySnaps[i].totalEquity = Math.round((startEquity + (currentEquity - startEquity) * t) * 100) / 100;
      }
      console.log(`   📊 Backfilled ${total} today's snapshots (${startEquity.toFixed(2)} -> ${currentEquity.toFixed(2)})`);
      state.save();
    }

    // Reconcile open positions
    const alpacaPositions = await getOpenPositions();
    const internalPositions = state.getPositions();
    const internalSymbols = new Set(internalPositions.map((p) => p.symbol));
    const alpacaSymbols = new Set(alpacaPositions.map((p) => p.symbol));

    // Positions Alpaca has but we don't know about (absorb them)
    const unknownPositions = alpacaPositions.filter((p) => !internalSymbols.has(p.symbol));
    if (unknownPositions.length > 0) {
      console.log(`⚠️  Found ${unknownPositions.length} position(s) in Alpaca not tracked internally:`);
      for (const pos of unknownPositions) {
        const holdUntil = new Date(Date.now() + cfg.signal.holdMinutes * 60000);
        state.recordEntry(
          pos.symbol,
          pos.qty,
          pos.entryPrice,
          pos.notional,
          holdUntil,
          "unknown_preexisting"
        );
        console.log(`   [${pos.symbol}] ${pos.qty.toFixed(4)} @ $${pos.entryPrice.toFixed(2)} (absorbed as pre-existing)`);
      }
    }

    // Positions we track but Alpaca doesn't have (stale, already exited)
    const stalePositions = internalPositions.filter((p) => !alpacaSymbols.has(p.symbol));
    if (stalePositions.length > 0) {
      console.log(`⚠️  Found ${stalePositions.length} stale internal position(s) already exited in Alpaca:`);
      for (const pos of stalePositions) {
        // Mark as exited with zero P&L (we don't know the actual exit price)
        state.recordExit(pos.symbol, pos.entryPrice, "stale_position_reconciled_at_startup");
        console.log(`   [${pos.symbol}] marked as reconciled`);
      }
    }

    if (unknownPositions.length === 0 && stalePositions.length === 0) {
      console.log(`   ✅ Positions aligned: ${internalPositions.length} tracked`);
    }
  } catch (e: any) {
    console.warn(`   ⚠️  Could not sync with Alpaca: ${e.message}`);
    console.warn(`      Running on internal state only.`);
  }
  console.log();

  // Verify market status
  const clock = await getClock();
  console.log(`📊 Market: ${clock.isOpen ? "OPEN" : "CLOSED"}`);
  console.log(`   Next Open: ${clock.nextOpen}`);
  console.log(`   Next Close: ${clock.nextClose}`);
  console.log();

  if (!clock.isOpen) {
    console.log(`⏰ Market is closed. Retrying in ${cfg.pollIntervalMs / 1000}s...`);

    // ── DAILY RETROSPECTIVE ────────────────────────────────────────────────
    // NOTE: The standalone retrospective process (cron job) is the primary
    // mechanism now. This is a fallback in case cron didn't run.
    if (state.getPositions().length > 0) {
      console.log("⚠️  Market closed with open positions — closing them first...");
    }
    if (await shouldRunRetrospective(state)) {
      console.log("\n📋 Market closed — running daily retrospective (in-process fallback)...");
      try {
        await runDailyRetrospective(state);
        state.recordActivity("retrospective", "Daily retrospective completed");
      } catch (e: any) {
        console.error("❌ Retrospective failed:", e.message);
      }
    }

    await new Promise(r => setTimeout(r, cfg.pollIntervalMs));
    return main(true);
  }

  console.log("✅ Market is OPEN — entering event loop.");

  // Check for pre-market briefing
  const preMarketBriefing = state.getPreMarketBriefing();

  // Clear the briefing if it exists — we don't use it anymore
  // The strategist provides strategies, the perception prompt provides live context
  if (preMarketBriefing) {
    state.clearPreMarketBriefing();
  }

  // Create the brain  console.log("🧠 Initializing pi.dev agent with OpenRouter...");
  const session = await createTradingBrain(process.env.OPENROUTER_API_KEY);
  console.log("✅ Agent ready. 21 tools registered.");
  console.log();

  if (cfg.execution.dryRun) {
    console.log("🏝️  DRY RUN MODE: No orders will be placed.");
    console.log("   The agent will reason, call tools, and log decisions with live data.");
    console.log();
  }

  state.recordActivity("system", `Agent session started — ${cfg.execution.dryRun ? "DRY RUN" : "live trading"}`, {
    metadata: { dryRun: cfg.execution.dryRun, initialCash: cfg.initialCapital, watchlist: cfg.watchlist.slice(0, 10) },
  });

  // ─── EVENT LOOP ────────────────────────────────────────────────────────────

  let loopCount = 0;
  let lastAgentOutput = "";
  let _lastRegime: string | null = null;

  session.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        lastAgentOutput += event.assistantMessageEvent.delta;
      }
    }
    if (event.type === "turn_end") {
      if (lastAgentOutput.trim()) {
        console.log("\n" + "─".repeat(50));
        console.log("🤖 AGENT OUTPUT:");
        console.log("─".repeat(50));
        console.log(lastAgentOutput.trim());
        console.log("─".repeat(50) + "\n");
      }
      lastAgentOutput = "";

      // Track token usage from the assistant message
      const msg = event.message as any;
      if (msg.usage && typeof msg.usage.input === "number") {
        state.recordTokenUsage(
          msg.usage.input,
          msg.usage.output,
          msg.usage.cost?.input ?? 0,
          msg.usage.cost?.output ?? 0,
        );
      }
    }
    if (event.type === "tool_execution_start") {
      console.log(`   [TOOL] ${event.toolName}...`);
    }
    if (event.type === "tool_execution_end") {
      const status = event.isError ? "❌ ERROR" : "✅ DONE";
      let msg = "";
      if (event.isError && event.result) {
        const err: any = event.result;
        msg = `: ${err && err.message ? err.message : typeof err === "string" ? err : JSON.stringify(err)}`.slice(0, 300);
      }
      console.log(`   [TOOL] ${event.toolName} ${status}${msg}`);
    }
  });

  try {
    // Just enter the event loop directly — no special first prompt.
    // The strategist provides strategies, the perception prompt provides context.
    // A special "first turn" adds nothing but token cost and confusion.

    // Continuous loop. Each cycle is wrapped in its own try/catch so
    // a single failed fetch (Yahoo timeout, Alpaca blip) doesn't kill the entire process.
    while (true) {
      loopCount++;

      // Reload config periodically (so user can tune without restart)
      if (loopCount % 20 === 0) {
        reloadConfig();
      }

      // Re-discover tickers periodically
      if (cfg.discovery.enabled && loopCount % cfg.discovery.refreshIntervalCycles === 0) {
        // getWatchlist() in tools.ts handles this automatically
      }

      await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));

      const now = new Date().toISOString();

      // ── RE-CHECK MARKET CLOCK ─────────────────────────────────────────
      // Verify the market is still open. If it closed since we started the
      // event loop, exit so the off-hours handler (retrospective, etc.) runs.
      // Also prevents the LLM from hallucinating "market closed" — we prove it.
      const currentClock = await getClock();
      if (!currentClock.isOpen) {
        console.log(`[${now}] ⏰ Market closed (detected by clock check) — exiting event loop.`);
        break;
      }

      // ── PROGRAMMATIC PERCEPTION ─────────────────────────────────────────
      // Build multi-source context: VIX, SPY, headlines, EDGAR, volume,
      // Reddit, gaps, and sector movers — all gathered in parallel.
      // The agent receives this as pre-digested context in its prompt,
      // then uses tools only to dive deeper on what's interesting.
      // Build context ticker list from positions + active strategies only
      // (no fixed watchlist — the trader only cares about what it holds or might enter)
      const positionSymbols = state.getPositions().map(p => p.symbol);
      const strategyStore = new StrategyStore("data/strategies.db");
      const activeStrategies = strategyStore.getTopStrategies(20)
        .filter(s => !positionSymbols.includes(s.ticker));
      const contextTickers = [...new Set([
        ...positionSymbols,
        ...activeStrategies.map(s => s.ticker),
      ])];
      const ctx = await buildMarketContext(contextTickers, state);

      const marketState: MarketState = {
        timestamp: ctx.market.timestamp,
        isMarketOpen: true,
        vix: ctx.market.vix,
        spyChangePct: ctx.market.spyChangePct,
        breadth: ctx.market.breadth as "strong" | "neutral" | "weak",
        regime: ctx.market.regime as "trending_up" | "trending_down" | "chop" | "volatile" | "unknown",
      };

      // Fetch Alpaca's official equity for accurate snapshot
      let alpacaEquity: number | null = null;
      try {
        const account = await getAccount();
        alpacaEquity = account.equity;
      } catch {
        // Fall back to internal calculation
      }

      // Record snapshot for equity curve
      state.addSnapshot(ctx.market.vix ?? null, marketState.regime, alpacaEquity);

      // ── REGIME SHIFT DETECTION ────────────────────────────────────────
      // Track regime changes and log them to the activity stream
      if (loopCount > 1 && _lastRegime && _lastRegime !== marketState.regime) {
        state.recordActivity("regime_shift", `Market regime changed from ${_lastRegime} → ${marketState.regime} (VIX ${marketState.vix?.toFixed(1) ?? "?"}, SPY ${marketState.spyChangePct?.toFixed(1) ?? "?"}%)`, {
          details: `Regime transition detected: ${_lastRegime} → ${marketState.regime}. Adjusting strategy bias accordingly.`,
          metadata: { from: _lastRegime, to: marketState.regime, vix: marketState.vix, spyChange: marketState.spyChangePct },
        });
      }
      _lastRegime = marketState.regime;

      const perceptionPrompt = await buildPerceptionPrompt(marketState, ctx, state, loopCount, cfg, currentClock);

      // Log this cycle to the activity stream
      const positionsForLog = state.getPositions();
      const regimeLabel = marketState.regime;
      state.recordActivity("cycle",
        `Cycle ${loopCount}: ${regimeLabel.toUpperCase()} market | ${positionsForLog.length} positions | VIX ${marketState.vix?.toFixed(1) ?? "?"} | daily P&L $${state.getDailyPnL().toFixed(2)}`,
        {
          details: `VIX=${marketState.vix?.toFixed(1) ?? "?"}, SPY=${marketState.spyChangePct?.toFixed(2) ?? "?"}%, breadth=${marketState.breadth}, regime=${regimeLabel}, positions=${positionsForLog.length}, cash=$${state.getCash().toFixed(2)}, dailyPnL=$${state.getDailyPnL().toFixed(2)}`,
          metadata: {
            cycle: loopCount, regime: regimeLabel, vix: marketState.vix,
            spyChange: marketState.spyChangePct, breadth: marketState.breadth,
            positionsCount: positionsForLog.length, cash: state.getCash(),
            dailyPnL: state.getDailyPnL()
          },
        }
      );

      console.log(`[${now}] 📡 Cycle ${loopCount} — perception sent...`);

      try {
        await session.prompt(perceptionPrompt);
      } catch (promptErr: any) {
        console.error(`[${now}] ⚠️  Agent cycle ${loopCount} failed (continuing loop):`, promptErr.message ?? promptErr);
        state.recordActivity("cycle_error", `Cycle ${loopCount} failed: ${promptErr.message ?? "unknown error"}`, {
          metadata: { cycle: loopCount },
        });
      }

      if (loopCount % 10 === 0) {
        console.log(`[${now}] 💓 Heartbeat | Positions: ${state.getPositions().length} | P&L: $${state.getDailyPnL().toFixed(2)} | Cash: $${state.getCash().toFixed(2)}`);
      }
    }
  } catch (err) {
    console.error("\n💥 Fatal error (event loop exited):", err);
  } finally {
    // ── MARKET CLOSE: Run daily retrospective ────────────────────────────
    // NOTE: The standalone retrospective process (cron job) is the primary
    // mechanism now. This is a fallback in case cron didn't run.
    const today = getTradingDate();
    const latestReport = state.getLatestReport();
    if (!latestReport || latestReport.date !== today) {
      console.log("\n📋 Market session ended — running daily retrospective (fallback)...");
      try {
        await runDailyRetrospective(state);
        state.recordActivity("retrospective", "Daily retrospective completed — market session ended", {
          metadata: { date: today },
        });
      } catch (e: any) {
        console.error("❌ Retrospective failed:", e.message);
      }
    } else {
      console.log(`\n📋 Report already generated for ${today} — skipping.`);
    }

    session.dispose();
  }
}

async function buildPerceptionPrompt(
  market: MarketState,
  ctx: any,
  state: PortfolioState,
  cycle: number,
  cfg: ReturnType<typeof getConfig>,
  clock?: { timestamp: string; isOpen: boolean; nextClose: string }
): Promise<string> {
  // Format current ET time from Alpaca clock for the agent
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
  const positions = state.getPositions();
  const portfolio = state.getPortfolio();
  const memory = state.getMemory();
  const lessonsFormatted = state.formatLessonsForPrompt();

  const lines: string[] = [
    `=== MARKET UPDATE (Cycle ${cycle}) ===`,
    ``,
    `Current Market State:`,
    `  Time: ${market.timestamp}`,
    `  VIX: ${market.vix?.toFixed(2) ?? "unknown"}`,
    `  SPY Change: ${market.spyChangePct?.toFixed(2) ?? "unknown"}%`,
    `  Breadth: ${market.breadth ?? "unknown"}`,
    `  Regime: ${market.regime}`,
    ``,
    `Your Portfolio:`,
    `  Cash: $${portfolio.cash.toFixed(2)}`,
    `  Settled: $${portfolio.settledCash.toFixed(2)}`,
    `  Daily P&L: $${portfolio.dailyPnL.toFixed(2)}`,
    `  Open Positions: ${positions.length} open`,
  ];

  if (positions.length > 0) {
    // Fetch strategies for position linkage
    const strategyStore = new StrategyStore("data/strategies.db");

    // Run exit condition checks AND fetch ticker context for each position in parallel
    const { getCurrentPrice } = await import("./execution/alpaca.js");

    const exitChecks = await Promise.all(
      positions.map(async (p) => {
        const currentPrice = await getCurrentPrice(p.symbol);
        if (!currentPrice) return { symbol: p.symbol, exitCheck: null, currentPrice: null };

        const exitCheck = checkExitConditions({ position: p, currentPrice });

        // Apply state updates from exit check
        if (exitCheck.newStatus || exitCheck.newTrailingStop !== undefined || exitCheck.newHighestPrice) {
          state.updatePositionState(p.symbol, currentPrice, {
            status: exitCheck.newStatus,
            trailingStopPrice: exitCheck.newTrailingStop,
            highestPrice: exitCheck.newHighestPrice,
          });
        }

        return { symbol: p.symbol, exitCheck, currentPrice };
      })
    );
    const exitMap = new Map(exitChecks.map(e => [e.symbol, e]));

    // Build ticker context for each position, enriched with linked strategy data
    const contextPromises = positions.map(p => {
      const exit = exitMap.get(p.symbol);
      // Find the linked strategy for this position
      const tickerStrategies = strategyStore.getByTicker(p.symbol, 3);
      const linkedStrategy = tickerStrategies.find((s: Strategy) => s.state === "active" || s.state === "realized");

      return buildTickerContext({
        symbol: p.symbol,
        entryPrice: p.entryPrice,
        qty: p.qty,
        unrealizedPnL: p.unrealizedPnL,
        highestPrice: p.highestPrice,
        lowestPrice: p.lowestPrice,
        trailingStopPrice: p.trailingStopPrice,
        status: p.status,
        entryTime: p.entryTime,
        entryRegime: p.entryRegime,
        entryVix: p.entryVix,
        entrySignalSource: p.entrySignalSource,
        entrySignalConfidence: p.entrySignalConfidence,
        entrySignalImpactScore: p.entrySignalImpactScore,
        strategy: p.strategy,
        currentRegime: market.regime,
        currentVix: market.vix,
      }).then(contextLines => {
        // Append linked strategy data to each position's context block
        if (linkedStrategy) {
          contextLines.push("─ LINKED STRATEGY ─");
          contextLines.push(`  type: ${linkedStrategy.strategy_type} | state: ${linkedStrategy.state} | conviction: ${linkedStrategy.conviction} | confidence: ${(linkedStrategy.confidence * 100).toFixed(0)}%`);
          contextLines.push(`  thesis: ${linkedStrategy.thesis.slice(0, 200)}`);
          if (linkedStrategy.catalyst) contextLines.push(`  catalyst: ${linkedStrategy.catalyst.slice(0, 120)}`);
          if (linkedStrategy.entry_conditions) contextLines.push(`  entry: ${linkedStrategy.entry_conditions.slice(0, 150)}`);
          if (linkedStrategy.exit_conditions) contextLines.push(`  exit if: ${linkedStrategy.exit_conditions.slice(0, 150)}`);
          if (linkedStrategy.risk_factors && linkedStrategy.risk_factors.length > 0)
            contextLines.push(`  risk factors: ${linkedStrategy.risk_factors.slice(0, 3).join(", ")}`);
          // What-If grade (if available) — shows historical setup quality
          if (linkedStrategy.what_if) {
            const wi = linkedStrategy.what_if;
            const gradeEmoji = wi.grade >= 4 ? "✅" : wi.grade <= 2 ? "❌" : "➖";
            contextLines.push(`  HISTORICAL GRADE: ${gradeEmoji} ${wi.grade}/5 | ${wi.abstraction} | ${wi.gradeRationale.slice(0, 120)}`);
          }
        }
        return contextLines;
      });
    });

    const contextBlocks = await Promise.all(contextPromises);

    for (const block of contextBlocks) {
      lines.push("");
      lines.push(...block);
    }

    lines.push("");
    lines.push("═══ DECISION ═══");
    lines.push("Above is the full multi-timeframe context for each open position. Key questions:");
    lines.push("  • If the position is nearing a stop (trailing or hard) → place_sell_order");
    lines.push("  • If thesis invalidated (regime changed, catalyst dead) but stops haven't hit → close_position to self-evaluate, then place_sell_order");
    lines.push("  • If thesis confirmed and working → let the stop ride, do nothing");
  }

  if (lessonsFormatted) {
    lines.push("");
    lines.push(lessonsFormatted);
  }

  // ─── Context notes from agent memory ───────────────────────────────
  const ctxNotes = state.formatContextNotesForPrompt();
  if (ctxNotes) {
    lines.push("");
    lines.push(ctxNotes);
  }

  // ── STRATEGIST REPORT INJECTION ──────────────────────────────────────
  // The strategist writes a markdown report after each session.
  // Inject it as a "Strategist's Briefing" section — it provides the narrative
  // context behind the candidate strategies, market summary, and strategy overview.
  //
  // Focus: the trader should check current positions first, then use this briefing
  // to decide whether to enter new positions.
  const reportPath = join(process.cwd(), "data", "strategist-report.md");
  let strategistReport = "";
  try {
    const reportContent = readFileSync(reportPath, "utf-8");
    if (reportContent.trim()) {
      strategistReport = reportContent.trim();
    }
  } catch {
    // Report doesn't exist yet (first cycle before strategist runs) — skip
  }

  // ── STRATEGY INJECTION — Top 10 candidates with full ticker context ──
  const strategyStore = new StrategyStore("data/strategies.db");
  const topStrategies = strategyStore.getTopStrategies(10);

  if (topStrategies.length > 0) {
    lines.push("");
    lines.push("═══ CANDIDATE STRATEGIES (with what-if historical grades + real-time price context) ═══");

    // Quick what-if summary at the top (scannable overview)
    const graded = topStrategies.filter(s => s.what_if !== null);
    if (graded.length > 0) {
      const highGrade = graded.filter(s => s.what_if!.grade >= 4);
      const lowGrade = graded.filter(s => s.what_if!.grade <= 2);
      const parts: string[] = [];
      if (highGrade.length > 0) parts.push(`✅ ${highGrade.length} historically high-grade (4-5)`);
      if (lowGrade.length > 0) parts.push(`❌ ${lowGrade.length} historically low-grade (1-2)`);
      const neutral = graded.length - highGrade.length - lowGrade.length;
      if (neutral > 0) parts.push(`➖ ${neutral} neutral (3)`);
      const ungraded = topStrategies.length - graded.length;
      if (ungraded > 0) parts.push(`🆕 ${ungraded} ungraded`);
      lines.push(`  📊 What-If summary: ${parts.join(" | ")}`);
    }

    for (const s of topStrategies) {
      // Fetch compact ticker context (no RISK/THESIS sections since there's no position)
      let priceLines: string[] = [];
      try {
        priceLines = await buildTickerContext({ symbol: s.ticker });
      } catch {
        priceLines = [`  (Price data unavailable for ${s.ticker})`];
      }

      // ── WHAT-IF GRADE (if available) ─────────────────────────────────
      let whatIfLine = "";
      if (s.what_if) {
        const gradeEmoji = s.what_if.grade >= 4 ? "✅" : s.what_if.grade <= 2 ? "❌" : "➖";
        const pnlStr = s.what_if.potentialGainLoss >= 0
          ? `+$${s.what_if.potentialGainLoss.toFixed(2)}`
          : `-$${Math.abs(s.what_if.potentialGainLoss).toFixed(2)}`;
        whatIfLine = `  HISTORICAL: ${gradeEmoji} Grade ${s.what_if.grade}/5 | ${pnlStr} (${s.what_if.potentialGainLossPct >= 0 ? "+" : ""}${s.what_if.potentialGainLossPct.toFixed(1)}%) | Pattern: ${s.what_if.abstraction}`;
      } else {
        whatIfLine = `  HISTORICAL: No prior grade — new/unanalyzed strategy`;
      }

      // Output: separator → strategy header → strategy metadata → what-if → remaining price context
      lines.push("");
      lines.push(priceLines[0]); // ═══ separator line
      lines.push(`CANDIDATE: [${s.ticker}] ${s.direction.toUpperCase()} ${s.strategy_type} | ${s.state} | conviction: ${s.conviction} @ ${(s.confidence * 100).toFixed(0)}%`);
      lines.push(`  thesis: ${s.thesis.slice(0, 200)}`);
      if (s.catalyst) lines.push(`  catalyst: ${s.catalyst.slice(0, 120)}`);
      if (s.timeframe) lines.push(`  timeframe: ${s.timeframe}`);
      if (s.entry_conditions) lines.push(`  entry: ${s.entry_conditions.slice(0, 200)}`);
      if (s.exit_conditions) lines.push(`  exit if: ${s.exit_conditions.slice(0, 200)}`);
      if (s.rationale) lines.push(`  rationale: ${s.rationale.slice(0, 200)}`);
      lines.push(whatIfLine);

      // ── RE-ENTRY AWARENESS ────────────────────────────────────────────
      // Check if we already traded this ticker today and warn the agent
      // about re-entering after a win. Prevents buying back near the exit
      // price after a pullback from a big gain.
      const todayTrades = state.getTradesForDay(getTradingDate());
      const priorTrades = todayTrades.filter(t => t.symbol === s.ticker);
      if (priorTrades.length > 0) {
        const totalPnl = priorTrades.reduce((sum, t) => sum + t.pnl, 0);
        const totalPnlPct = priorTrades.reduce((sum, t) => sum + t.pnlPct, 0);
        const bestExit = Math.max(...priorTrades.map(t => t.exitPrice));
        const worstEntry = Math.min(...priorTrades.map(t => t.entryPrice));
        const peakFromEntry = ((bestExit - worstEntry) / worstEntry * 100);

        lines.push(`  ⚠️  RE-ENTRY WARNING — Already traded ${s.ticker} ${priorTrades.length}x today`);
        lines.push(`     Result: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%)`);
        lines.push(`     Prior range: entry $${worstEntry.toFixed(2)} → exit $${bestExit.toFixed(2)} (${peakFromEntry >= 0 ? "+" : ""}${peakFromEntry.toFixed(1)}% move)`);
        lines.push(`     ⚠️  Re-entering means buying after the stock already ran and pulled back.`);
        lines.push(`     Only enter if the strategist confirms fresh catalysts (not stale signals).`);
        lines.push(`     Prefer a DIFFERENT candidate — let this one cool off.`);
      }

      // Append remaining price action lines (skip the original "TICKER:" header)
      lines.push(...priceLines.slice(2));
    }
  } else {
    lines.push("");
    lines.push("═══ NO CANDIDATE STRATEGIES — strategist hasn\'t identified any setups yet ═══");
  }

  // ── STRATEGIST REPORT ─────────────────────────────────────────────────────
  if (strategistReport) {
    lines.push("");
    lines.push("═══ STRATEGIST\'S BRIEFING ═══");
    lines.push("The strategist\'s latest report provides narrative context for the market and strategies.");
    lines.push("Read it for the strategist\'s reasoning and commentary, then use the structured data");
    lines.push("above (current positions + candidate strategies) to make execution decisions.");
    lines.push("");
    lines.push("```");
    lines.push(strategistReport);
    lines.push("```");
    lines.push("");
  }

  // ── PRE-DIGESTED CONTEXT ─────────────────────────────────────────────────
  lines.push("");
  lines.push("═══ PRE-DIGESTED MARKET CONTEXT ═══");
  lines.push(formatContextForPrompt(ctx));

  lines.push("");
  // Inject real Alpaca clock time so the agent stops hallucinating market hours
  if (clock && clock.isOpen) {
    lines.push("");
    lines.push("═══ REAL MARKET CLOCK (from Alpaca) ═══");
    lines.push(`  Current Eastern Time: ${etDateStr} — ${etTimeStr}`);
    lines.push(`  Market closes at: ${clock.nextClose} ET`);
    lines.push(`  ⚠️  The market IS CURRENTLY OPEN. Do NOT declare the session over.`);
  }

  lines.push("");
  lines.push("═══ AVAILABLE TOOLS ═══");
  lines.push("The strategist handles ALL research. You manage positions only.");
  lines.push("All candidate strategies are provided directly in your prompt above —");
  lines.push("there is NO tool to re-fetch or research strategies on your own.");
  lines.push("Learn more from the strategist\'s report (above) and your own memory.");
  lines.push("");
  lines.push("Your execution tools:");
  lines.push("  • check_portfolio — view cash, P&L, open positions");
  lines.push("  • monitor_positions — check all open positions' exit conditions");
  lines.push("  • place_buy_order, place_short_order — enter positions");
  lines.push("  • place_sell_order — exit a position");
  lines.push("  • close_position — evaluate if a position's thesis still holds");
  lines.push("  • update_strategy_on_exit — record outcome when you close a position");
  lines.push("  • hold_cash — explicitly choose not to trade");
  lines.push("  • consult_memory — check lessons and similar past trades BEFORE any trade");
  lines.push("  • record_decision — log your reasoning");
  lines.push("  • reflect_on_performance — end-of-session retrospective");
  lines.push("  • emergency_close_all — shut everything down (risk emergency only)");
  lines.push("");
  lines.push("⚠️  IMPORTANT: The market is CURRENTLY OPEN. Alpaca clock confirms this.");
  lines.push("    Do NOT declare 'market closed' or 'session over' — you are mid-session.");
  lines.push("");

  // ── CALIBRATION CHECKLIST ──────────────────────────────────────────────
  const calibration = state.getCalibrationTable();
  const regimeCal = calibration.filter((c: any) => c.regime === market.regime);
  if (regimeCal.length > 0) {
    lines.push("═══ REGIME CALIBRATION CHECK (current regime: " + market.regime.toUpperCase() + ") ═══");
    lines.push("Check each strategy\'s track record in this regime before placing a trade:");
    lines.push("");
    for (const c of regimeCal) {
      const winRate = c.totalTrades > 0 ? (c.wins / c.totalTrades * 100) : 0;
      let flag = "🆕 limited data";
      if (winRate === 0 && c.totalTrades >= 3) flag = "⛔ SKIP — 0% win rate";
      else if (winRate >= 60) flag = "✅ positive expectancy";
      else if (winRate >= 40) flag = "➖ mixed results";
      lines.push("  ☐ " + c.strategy + " in " + c.regime + ": " + c.wins + "/" + c.totalTrades + " wins (" + winRate.toFixed(0) + "%) — " + flag);
    }
    lines.push("");
  }

  // ── RECENT MISTAKES FLAG ──────────────────────────────────────────────
  const todaysTrades = state.getTradesForDay(getTradingDate());
  const lastThree = todaysTrades.slice(-3);
  const recentLosses = lastThree.filter((t: any) => t.pnl < -1);
  if (recentLosses.length > 0) {
    lines.push("═══ RECENT MISTAKES ═══");
    lines.push("The following trades lost money last cycle. Consider why before repeating similar setups:");
    lines.push("");
    for (const t of lastThree) {
      const icon = t.pnl > 0 ? "✅" : t.pnl < -1 ? "❌" : "➖";
      const exitPrice = t.exitPrice || t.entryPrice || 0;
      lines.push("  " + icon + " " + t.symbol + " @ $" + exitPrice.toFixed(2) + ": " + (t.pnl >= 0 ? "+" : "") + "$" + t.pnl.toFixed(2) + " — " + t.strategy);
    }
    lines.push("");
  }

  lines.push("INSTRUCTION:");
  lines.push("1. Review positions first — check if each position\'s linked strategy still holds.");
  lines.push("   The strategist already built the thesis. Your job: manage the position.");
  lines.push("2. Read the STRATEGIST\'S BRIEFING (above) — it contains:");
  lines.push("   • What changed since last cycle (lifecycle actions: promotions, kills, new creations)");
  lines.push("   • Market-level observations the strategist noticed (sector rotation, cross-currents)");
  lines.push("   • Per-strategy narrative notes about developing catalysts or risks");
  lines.push("   • Warnings or things to watch out for");
  lines.push("   The full strategy details (thesis, catalyst, entry/exit conditions) are in CANDIDATE STRATEGIES below.");
  lines.push("3. Then review the TOP CANDIDATE STRATEGIES above — these are pre-vetted by the strategist.");
  lines.push("   Cross-reference the strategist\'s reasoning with the structured data + price context provided.");
  lines.push("4. For thesis invalidation: close_position → place_sell_order → update_strategy_on_exit.");
  lines.push("5. For mechanical exits: monitor_positions → place_sell_order → update_strategy_on_exit.");
  lines.push("6. **BEFORE any trade**, call consult_memory to check lessons and similar past trades.");
  lines.push("7. Each candidate strategy includes a HISTORICAL GRADE (1-5) + hypothetical P&L from prior days.");
  lines.push("   - Grade 4-5 = setup has worked before in similar conditions. Stronger conviction.");
  lines.push("   - Grade 1-2 = setup has failed before. Approach with caution or skip.");
  lines.push("   - Grade 3 or 'No prior grade' = neutral or new. Rely on thesis + price action.");
  lines.push("   - Use the ABSTRACTION PATTERN to assess regime fit: `momentum long trending_up works catalyst:news`.");
  lines.push("8. If a candidate strategy has a strong thesis + confirming price action + good historical grade → place_buy_order or place_short_order.");
  lines.push("9. If nothing passes your bar → hold_cash (explain why).");
  lines.push("10. Remember: hard stops + trailing stops protect you. Use that freedom to take smart bets.");
  lines.push("11. Cash doesn't compound — but bad trades don't either. Be decisive, not reckless.");
  lines.push("");
  lines.push("⚠️  IMPORTANT RESTRICTIONS:");
  lines.push("    • You have NO research tools. Do NOT try to analyze tickers beyond what is provided.");
  lines.push("    • You have NO tool to fetch additional strategies. Use what is in this prompt.");
  lines.push("    • Do NOT attempt to evaluate tickers not listed in CANDIDATE STRATEGIES or POSITIONS.");
  lines.push("    • If the strategist's briefing mentions interesting tickers not in the structured list,");
  lines.push("      ignore them — they weren't ranked highly enough to be included.");
  lines.push("    • You are a portfolio manager, not a researcher. Your job is to allocate capital to the best setups the strategist provides.");

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Uncaught error:", err);
  process.exit(1);
});

// Clean shutdown on SIGINT/SIGTERM
process.on("SIGINT", () => {
  console.log("\n⚠️  Shutting down...");
  stopResearch();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\n⚠️  Received SIGTERM...");
  stopResearch();
  process.exit(0);
});