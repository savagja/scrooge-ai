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

import { getConfig, reloadConfig } from "./config.js";
import { createTradingBrain } from "./brain/agent.js";
import { setGlobalState, requireState, getWatchlist } from "./brain/tools.js";
import { PortfolioState } from "./state/portfolio.js";
import { getAccount, getOpenPositions, getClock } from "./execution/alpaca.js";
import { getVix, getSpyChange } from "./ingestion/market.js";
import { buildMarketContext, formatContextForPrompt, buildPreMarketBriefing, resetContextHistory } from "./context/builder.js";
import { runDailyRetrospective } from "./retrospective/retrospective.js";
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

    console.log(`💰 Initial Capital: $${cfg.initialCapital}`);
    console.log(`🧪 Dry Run: ${cfg.execution.dryRun ? "YES — no real trades" : "NO"}`);
    console.log(`📋 Seed Watchlist: ${cfg.watchlist.slice(0, 5).join(",")}... (${cfg.watchlist.length} tickers)`);
    console.log(`🔑 OpenRouter: ${process.env.OPENROUTER_API_KEY ? "configured" : "NOT SET"}`);
    console.log(`🔑 Alpaca: ${process.env.ALPACA_API_KEY ? "configured" : "NOT SET"}`);
    console.log(`⚙️  Config: max_pos=${(cfg.risk.maxPositionPct * 100).toFixed(0)}%, stop=${(cfg.risk.stopLossPct * 100).toFixed(0)}%, trailing=${(cfg.risk.trailingStopPct * 100).toFixed(0)}%, hold=${cfg.signal.holdMinutes}min`);
    console.log();
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
    }

    console.log(`⏰ Market is closed. Retrying in ${cfg.pollIntervalMs / 1000}s...`);
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

  // ─── EVENT LOOP ────────────────────────────────────────────────────────────

  let loopCount = 0;
  let lastAgentOutput = "";

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

      // Record snapshot for equity curve
      state.addSnapshot(ctx.market.vix ?? null, marketState.regime);

      const perceptionPrompt = buildPerceptionPrompt(marketState, ctx, state, loopCount, cfg);

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
    const today = new Date().toISOString().slice(0, 10);
    const latestReport = state.getLatestReport();
    if (!latestReport || latestReport.date !== today) {
      console.log("\n📋 Market session ended — running daily retrospective...");
      try {
        await runDailyRetrospective(state);
      } catch (e: any) {
        console.error("❌ Retrospective failed:", e.message);
      }
    } else {
      console.log(`\n📋 Report already generated for ${today} — skipping.`);
    }

    session.dispose();
  }
}

function buildPerceptionPrompt(
  market: MarketState,
  ctx: any,
  state: PortfolioState,
  cycle: number,
  cfg: ReturnType<typeof getConfig>
): string {
  const positions = state.getPositions();
  const portfolio = state.getPortfolio();
  const memory = state.getMemory();

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
    `Risk Settings (from config):`,
    `  Max Position: ${(cfg.risk.maxPositionPct * 100).toFixed(0)}%`,
    `  Stop Loss: ${(cfg.risk.stopLossPct * 100).toFixed(0)}%`,
    `  Trailing Stop: ${(cfg.risk.trailingStopPct * 100).toFixed(0)}%`,
    `  Green Threshold: ${(cfg.risk.greenThreshold * 100).toFixed(0)}%`,
    `  Time Stop: ${cfg.signal.holdMinutes} min`,
    `  Daily Loss Halt: ${(cfg.risk.maxDailyLossPct * 100).toFixed(0)}%`,
    ``,
    `Your Portfolio:`,
    `  Cash: $${portfolio.cash.toFixed(2)}`,
    `  Settled: $${portfolio.settledCash.toFixed(2)}`,
    `  Daily P&L: $${portfolio.dailyPnL.toFixed(2)}`,
    `  Open Positions: ${positions.length} / ${cfg.risk.maxOpenPositions} max`,
  ];

  if (positions.length > 0) {
    lines.push("");
    for (const p of positions) {
      const statusIcon = p.status === "initial" ? "🟡" : p.status === "green" ? "🟢" : "🔵";
      lines.push(`  ${statusIcon} [${p.symbol}] ${p.qty.toFixed(4)} @ $${p.entryPrice.toFixed(2)} (status: ${p.status}) (unrealized: $${p.unrealizedPnL.toFixed(2)})`);
    }
  }

  if (memory.lessons.length > 0) {
    lines.push("");
    lines.push("Recent Lessons:");
    memory.lessons.slice(-3).forEach((l) => lines.push(`  • ${l}`));
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
  lines.push("  • fetch_news — full headlines for a specific ticker");
  lines.push("  • fetch_all_news — ALL recent headlines (wider net)");
  lines.push("  • fetch_edgar_filings — detailed SEC 8-K filings");
  lines.push("  • scan_relative_volume — check if a move has volume confirmation");
  lines.push("  • scan_premarket_gaps — gap analysis for specific tickers");
  lines.push("  • scan_range_breaks — 20-day range analysis");
  lines.push("  • scan_reddit — Reddit sentiment details");
  lines.push("  • discover_opportunities — find NEW tickers outside current list");
  lines.push("");
  lines.push("INSTRUCTION:");
  lines.push("1. Monitor positions (monitor_positions).");
  lines.push("2. Use the pre-digested context above. If something catches your eye, use ONE tool to verify.");
  lines.push("3. Analyze 1-2 specific tickers with trade_news_momentum or trade_mean_reversion.");
  lines.push("4. If signal >= impact 4 and >= 45% confidence → place_buy_order.");
  lines.push("5. If signal is below threshold → hold_cash (explain why nothing passed).");
  lines.push("6. Remember: Cutting losers fast + trailing stops = risk management. Use it to take smart bets.");
  lines.push("");
  lines.push("You should aim to have 1-2 positions open most days. Cash doesn't compound.");

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Uncaught error:", err);
  process.exit(1);
});