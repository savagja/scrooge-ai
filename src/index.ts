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

import { getConfig, reloadConfig, getTradingDate } from "./config.js";
import { createTradingBrain } from "./brain/agent.js";
import { setGlobalState, requireState, getWatchlist } from "./brain/tools.js";
import { PortfolioState } from "./state/portfolio.js";
import { getAccount, getOpenPositions, getClock, buildTickerContext } from "./execution/alpaca.js";
import { getVix, getSpyChange } from "./ingestion/market.js";
import { buildMarketContext, formatContextForPrompt, buildPreMarketBriefing, resetContextHistory } from "./context/builder.js";
import { runDailyRetrospective, shouldRunRetrospective } from "./retrospective/retrospective.js";
import { checkExitConditions } from "./risk/guardrails.js";
import { initResearch, stopResearch } from "./research/index.js";
import type { MarketState } from "./types.js";

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
    setGlobalState(state, cfg.watchlist);

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
  // STARTUP RECONCILIATION: Sync with Alpaca (skip on retries)
  // ════════════════════════════════════════════════════════════
  if (!isRetry) {
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
  }

  // Verify market status
  const clock = await getClock();
  console.log(`📊 Market: ${clock.isOpen ? "OPEN" : "CLOSED"}`);
  console.log(`   Next Open: ${clock.nextOpen}`);
  console.log(`   Next Close: ${clock.nextClose}`);
  console.log();

  if (!clock.isOpen) {
    // ── OFF-HOURS: Build/refresh pre-market briefing ──
    const watchlist = await getWatchlist();
    const existing = state.getPreMarketBriefing();

    // Store last build timestamp in a variable (we embed it in the briefing text)
    const lastBriefingLine = existing
      ? existing.match(/built at (\d+)/)?.[1]
      : null;
    const lastBriefingTs = lastBriefingLine ? parseInt(lastBriefingLine, 10) : 0;
    const briefingAge = lastBriefingTs ? (Date.now() - lastBriefingTs) / 60000 : Infinity;

    // Refresh every 30 minutes
    if (!existing || briefingAge > 30) {
      console.log(`📡 Building pre-market briefing...`);
      const briefing = await buildPreMarketBriefing(watchlist, state);
      state.setPreMarketBriefing(briefing);
      console.log(`✅ Pre-market briefing saved (${briefing.split("\n").length} lines)`);
      console.log();

      state.recordActivity("briefing", "Pre-market briefing built", {
        details: briefing.slice(0, 300),
        metadata: { lineCount: briefing.split("\n").length, scheduled: true },
      });
    }

    console.log(`⏰ Market is closed. Retrying in ${cfg.pollIntervalMs / 1000}s...`);

    // ── DAILY RETROSPECTIVE ────────────────────────────────────────────────
    // The first time the bot detects the market is closed on a new day,
    // run the retrospective to analyze the previous trading session.
    // We do this here (before the retry loop) because the `finally` block
    // only runs if the event loop exits, which doesn't happen in off-hours.
    if (state.getPositions().length > 0) {
      console.log("⚠️  Market closed with open positions — closing them first...");
    }
    if (await shouldRunRetrospective(state)) {
      console.log("\n📋 Market closed — running daily retrospective...");
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

  // Create the brain
  console.log("🧠 Initializing pi.dev agent with OpenRouter...");
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
    // ── FIRST PROMPT: Inject pre-market briefing if available ──
    const firstPrompt = preMarketBriefing
      ? `You are now managing a $${cfg.initialCapital} cash account on Alpaca. ` +
        `Your seed watchlist: ${cfg.watchlist.join(", ")}. ` +
        `The market is now OPEN. ` +
        `\n\nHere is the overnight briefing that was gathered while the market was closed:\n\n` +
        preMarketBriefing +
        `\n\nINITIAL TASK:\n` +
        `1. Monitor open positions for exits (monitor_positions).\n` +
        `2. Use the overnight briefing above to identify the most promising setups.\n` +
        `3. Analyze 1-2 specific tickers (trade_news_momentum or trade_mean_reversion).\n` +
        `4. If signal >= impact 4 and >= 45% confidence → PLACE A TRADE.\n` +
        `5. Otherwise, hold_cash. Be decisive. Cash doesn't compound.`
      : `You are now managing a $${cfg.initialCapital} cash account on Alpaca. ` +
        `Your seed watchlist: ${cfg.watchlist.join(", ")}. ` +
        `The market is currently OPEN. ` +
        `\n\nFIRST TASK: ` +
        `1. Monitor open positions for exits (monitor_positions). ` +
        `2. Fetch market data (fetch_market_data). ` +
        `3. Use 1-2 data sources to find opportunities — pick the most relevant for today's regime. ` +
        `4. Analyze 2-3 specific tickers (trade_news_momentum or trade_mean_reversion). ` +
        `5. If any analysis passes your thresholds (impact >= 4, confidence >= 45%), PLACE A TRADE. ` +
        `6. Otherwise, hold_cash — but explain exactly why nothing passed. ` +
        `Be decisive. Cash doesn't compound.`;

    await session.prompt(firstPrompt);

    // Clear the briefing so subsequent cycles use live context
    if (preMarketBriefing) {
      state.clearPreMarketBriefing();
    }

    // Continuous loop
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
      const watchlist = await getWatchlist();
      const ctx = await buildMarketContext(watchlist, state);

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

      const perceptionPrompt = await buildPerceptionPrompt(marketState, ctx, state, loopCount, cfg);

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

      await session.prompt(perceptionPrompt);

      if (loopCount % 10 === 0) {
        console.log(`[${now}] 💓 Heartbeat | Positions: ${state.getPositions().length} | P&L: $${state.getDailyPnL().toFixed(2)} | Cash: $${state.getCash().toFixed(2)}`);
      }
    }
  } catch (err) {
    console.error("\n💥 Fatal error:", err);
  } finally {
    // ── MARKET CLOSE: Run daily retrospective ────────────────────────────
    // We reach here if the event loop exits (market closed, error, or process signal).
    // Check if we've already generated today's report to avoid double-run.
    const today = getTradingDate();
    const latestReport = state.getLatestReport();
    if (!latestReport || latestReport.date !== today) {
      console.log("\n📋 Market session ended — running daily retrospective...");
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
  cfg: ReturnType<typeof getConfig>
): Promise<string> {
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

    // Build ticker context for each position
    const contextPromises = positions.map(p => {
      const exit = exitMap.get(p.symbol);
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
      });
    });

    const contextBlocks = await Promise.all(contextPromises);

    for (const block of contextBlocks) {
      lines.push("");
      lines.push(...block);
    }

    lines.push("");
    lines.push("═══ DECISION ═══");
    lines.push("Above is the full mult-timeframe context for each open position. Key questions:");
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

  // ── PRE-DIGESTED CONTEXT ─────────────────────────────────────────────────
  lines.push("");
  lines.push("═══ PRE-DIGESTED MARKET CONTEXT ═══");
  lines.push(formatContextForPrompt(ctx));

  lines.push("");
  lines.push("═══ DEEPER DIVE TOOLS ═══");
  lines.push("The context above is a snapshot. Use these tools to dive deeper on anything interesting:");
  lines.push("  • search_signals — query the RESEARCH DB for signal history across sources (recommended first step)");
  lines.push("  • describe_datasets — see what data is in the research DB (schemas, row counts, date ranges)");
  lines.push("  • fetch_news — full headlines for a specific ticker");
  lines.push("  • fetch_all_news — ALL recent headlines (wider net)");
  lines.push("  • fetch_edgar_filings — detailed SEC 8-K filings");
  lines.push("  • scan_relative_volume — check if a move has volume confirmation");
  lines.push("  • scan_premarket_gaps — gap analysis for specific tickers");
  lines.push("  • scan_range_breaks — 20-day range analysis");
  lines.push("  • scan_reddit — Reddit sentiment details");
  lines.push("  • discover_opportunities — find NEW tickers outside current list");
  lines.push("  • consult_memory — check accumulated lessons and similar past trades before deciding");
  lines.push("");
  lines.push("💡 TIP: search_signals is faster than calling individual data sources. The research DB already has Yahoo movers, Reddit, EDGAR filings, volume spikes, gaps, and range breaks — all accumulated 24/7.");
  lines.push("⚠️  IMPORTANT: The market is CURRENTLY OPEN. Alpaca clock confirms this.");
  lines.push("    Do NOT declare 'market closed' or 'session over' — you are mid-session.");
  lines.push("    If you see a timestamp that looks late, ignore it — the event loop handles clock checks.");
  lines.push("    Your job is to trade, not to decide when the market closes.");
  lines.push("");
  lines.push("");
  lines.push("INSTRUCTION:");
  lines.push("1. Review positions first — check if each original thesis still holds given current market conditions.");
  lines.push("2. For thesis invalidation: use close_position to evaluate, then place_sell_order.");
  lines.push("3. For mechanical exits: use monitor_positions to check stops, then place_sell_order.");
  lines.push("4. Use the pre-digested context above. If something catches your eye, use ONE tool to verify.");
  lines.push("5. Analyze tickers with trade_news_momentum or trade_mean_reversion if you see a setup.");
  lines.push("6. **BEFORE any trade**, call consult_memory to check if past lessons and similar trades apply.");
  lines.push("7. If you have a thesis → place_buy_order (long) or place_short_order (short).");
  lines.push("8. If nothing passes your bar → hold_cash (explain why).");
  lines.push("9. Remember: hard stops + trailing stops protect you. Use that freedom to take smart bets.");
  lines.push("10. Cash doesn't compound — but bad trades don't either. Be decisive, not reckless.");

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