/**
 * Custom tools registered with the pi.dev agent.
 * Each tool represents a capability the agent can invoke.
 *
 * These directly call real Alpaca, OpenRouter, EDGAR, and Reddit APIs. No mocks.
 * Execution tools include embedded risk guardrails.
 */

import { Type } from "@sinclair/typebox";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helper: accept number or string from LLM, coerce to number internally
// Gemini and other models sometimes pass numeric params as quoted strings.
// ---------------------------------------------------------------------------
function coerceNumber(val: unknown, fallback: number): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = Number(val);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

// TypeBox schema for parameters that accept number-or-string
// Use Any() to bypass strict TypeBox validation — coerceNumber handles types at runtime
const NumStr = Type.Any();

import { getSignalStore } from "../research/index.js";

import { fetchNews } from "../ingestion/news.js";
import { fetchAllNews } from "../ingestion/expanded-news.js";
import { getVix, getSpyChange, getPrice } from "../ingestion/market.js";
import {
  fetchEdgarFilings,
  scoreFiling,
  resolveTickerFromName,
} from "../ingestion/edgar.js";
import {
  scanRelativeVolume,
  scanPreMarketGaps,
  scanRangeBreaks,
} from "../ingestion/scanner.js";
import { scanRedditMentions, getRedditHot } from "../ingestion/social.js";
import { discoverOpportunities, getActiveWatchlist } from "../ingestion/discovery.js";
import {
  getAccount,
  submitOrder,
  liquidateSymbol,
  closeAllPositions,
  getCurrentPrice,
  getClock,
  buildTickerContext,
} from "../execution/alpaca.js";
import { PortfolioState } from "../state/portfolio.js";
import { StrategyStore } from "../state/strategies.js";
import { evaluateBuySignal, getExitPlan, checkExitConditions } from "../risk/guardrails.js";

// Global state reference — set at startup
let _state: PortfolioState;
let _strategies: StrategyStore | null = null;
let _watchlist: string[] = [];
let _discovered: string[] = [];

export function setGlobalState(state: PortfolioState, watchlist: string[]) {
  _state = state;
  _watchlist = watchlist;
}

export function setStrategyStore(store: StrategyStore | null) {
  _strategies = store;
}

function requireStrategies(): StrategyStore | null {
  return _strategies;
}

export async function getWatchlist(): Promise<string[]> {
  // Refresh discovered tickers every call
  try {
    const active = await getActiveWatchlist(_watchlist, 10);
    _discovered = active.filter((s) => !_watchlist.includes(s));
    return active;
  } catch {
    return [..._watchlist, ..._discovered];
  }
}

export function requireState(): PortfolioState {
  if (!_state) throw new Error("Portfolio state not initialized. Call setGlobalState() first.");
  return _state;
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA GATHERING TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// ─── TOOL 1: fetch_market_data ───────────────────────────────────────────────

export const fetchMarketDataTool = defineTool({
  name: "fetch_market_data",
  label: "Fetch Market Data",
  description:
    "Get current market regime data: VIX, SPY change, market breadth, and regime classification. " +
    "Use this before making any trading decision to understand the current environment.",
  parameters: Type.Object({}),
  execute: async () => {
    const [vix, spyChange, clock] = await Promise.all([
      getVix(),
      getSpyChange(),
      getClock(),
    ]);

    const state = requireState();
    const portfolio = state.getPortfolio();

    let regime = "unknown";
    if (vix !== null) {
      if (vix > 25) regime = "volatile";
      else if (spyChange !== null && spyChange > 0.5) regime = "trending_up";
      else if (spyChange !== null && spyChange < -0.5) regime = "trending_down";
      else if (vix < 18) regime = "chop";
      else regime = "chop";
    }

    const breadth = spyChange !== null && Math.abs(spyChange) > 1
      ? "strong"
      : spyChange !== null && Math.abs(spyChange) > 0.5
        ? "neutral"
        : "weak";

    const text = [
      `MARKET STATE (as of ${new Date().toISOString()}):`,
      `- Market: ${clock.isOpen ? "OPEN" : "CLOSED"}`,
      `- Next Close: ${clock.nextClose}`,
      `- VIX: ${vix?.toFixed(2) ?? "unavailable"}`,
      `- SPY Change: ${spyChange !== null ? `${spyChange.toFixed(2)}%` : "unavailable"}`,
      `- Active Watchlist: ${_watchlist.length} seed + ${_discovered.length} discovered`,
      `- Breadth: ${breadth}`,
      `- Regime: ${regime}`,
      `- Risk Settings: 3% hard stop, 5% trailing stop, 30-min time stop, squeeze protection at 5%`,
      "",
      regime === "trending_up" ? "Uptrend. Consider momentum plays or shorts on overextended names with catalysts."
        : regime === "trending_down" ? "Downtrend. Cash is king. Only high-conviction setups."
          : regime === "volatile" ? "High volatility. Size down or hold cash."
            : "Choppy, range-bound. Mean-reversion favored. Breakouts often fake.",
    ].join("\n");

    return {
      content: [{ type: "text", text }],
      details: { vix, spyChange, regime, breadth, isOpen: clock.isOpen },
    };
  },
});

// ─── TOOL 2: fetch_news (watchlist-filtered) ────────────────────────────────

export const fetchNewsTool = defineTool({
  name: "fetch_news",
  label: "Fetch News (Watchlist)",
  description:
    "Scan recent news headlines for your watchlist tickers. " +
    "Use this for targeted news on names you already track.",
  parameters: Type.Object({
    limit: NumStr,
  }),
  execute: async (_id, params) => {
    const watchlist = await getWatchlist();
    const news = await fetchNews(watchlist, coerceNumber(params.limit, 10));

    if (news.length === 0) {
      return {
        content: [{ type: "text", text: "No fresh headlines for watchlist in last 5 minutes." }],
        details: { count: 0, items: [] },
      };
    }

    const text = news
      .map((n) => `[${n.symbol}] ${n.headline}\n  Source: ${n.source} | ${n.createdAt}\n  Summary: ${n.summary.slice(0, 120)}...`)
      .join("\n\n");

    return {
      content: [{ type: "text", text: `WATCHLIST HEADLINES:\n\n${text}` }],
      details: { count: news.length, items: news },
    };
  },
});

// ─── TOOL 3: fetch_all_news (unfiltered, LLM decides relevance) ────────────────

export const fetchAllNewsTool = defineTool({
  name: "fetch_all_news",
  label: "Fetch All News",
  description:
    "Scan ALL recent headlines across Alpaca's entire coverage (not just your watchlist). " +
    "The LLM will filter for tickers, sectors, or themes that are relevant to you. " +
    "Use this to catch second-order effects, supplier news, or sector-wide events.",
  parameters: Type.Object({
    limit: NumStr,
  }),
  execute: async (_id, params) => {
    const news = await fetchAllNews(coerceNumber(params.limit, 20));

    if (news.length === 0) {
      return {
        content: [{ type: "text", text: "No fresh headlines in last 5 minutes." }],
        details: { count: 0, items: [] },
      };
    }

    const text = news
      .map(
        (n) =>
          `${n.headline}\n  Tickers: ${n.symbols.join(", ") || "none"}\n  Source: ${n.source}\n  Summary: ${n.summary.slice(0, 100)}...`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: `ALL HEADLINES (LLM should filter for relevance):\n\n${text}` }],
      details: { count: news.length, items: news },
    };
  },
});

// ─── TOOL 4: fetch_edgar_filings ────────────────────────────────────────────

export const fetchEdgarFilingsTool = defineTool({
  name: "fetch_edgar_filings",
  label: "Fetch EDGAR Filings",
  description:
    "Fetch recent SEC 8-K filings from EDGAR RSS. These often drop BEFORE news wires. " +
    "High-value items: Item 1.01 (material agreements), 2.02 (financial results), 2.01 (acquisitions), 5.02 (officer departure). " +
    "Returns filings sorted by impact potential.",
  parameters: Type.Object({}),
  execute: async () => {
    const watchlist = await getWatchlist();
    const filings = await fetchEdgarFilings(watchlist);

    if (filings.length === 0) {
      return {
        content: [{ type: "text", text: "No new 8-K filings in the last poll." }],
        details: { count: 0, filings: [] },
      };
    }

    const lines: string[] = [`EDGAR 8-K FILINGS (${filings.length} new):`, ""];

    for (const f of filings) {
      const score = scoreFiling(f);
      const ticker = f.ticker || resolveTickerFromName(f.companyName) || "unknown";

      lines.push(
        `[${ticker}] ${f.companyName}`,
        `  Items: ${f.items.join(", ")}`,
        `  Impact Score: ${score.score}/10`,
        `  Why: ${score.reason}`,
        `  Filed: ${f.filingDate}`,
        `  Link: ${f.link}`,
        ""
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: filings.length, filings },
    };
  },
});

// ─── TOOL 5: scan_relative_volume ──────────────────────────────────────────

export const scanRelativeVolumeTool = defineTool({
  name: "scan_relative_volume",
  label: "Scan Relative Volume",
  description:
    "Scan your watchlist for tickers trading on unusual volume compared to their 20-day average. " +
    "High relative volume + price move = genuine interest. Low volume + move = likely fakeout. " +
    "Returns ranked list by relative volume.",
  parameters: Type.Object({}),
  execute: async () => {
    const watchlist = await getWatchlist();
    const scans = await scanRelativeVolume(watchlist);

    if (scans.length === 0) {
      return {
        content: [{ type: "text", text: "No volume data available for watchlist." }],
        details: { count: 0, scans: [] },
      };
    }

    const lines: string[] = [
      "RELATIVE VOLUME SCAN (sorted by unusualness):",
      "",
    ];

    // Only show active+ names
    const active = scans.filter((s) => s.regime !== "quiet");

    if (active.length === 0) {
      lines.push("Nothing unusual. All tickers trading at or below average volume.");
    } else {
      for (const s of active) {
        lines.push(
          `[${s.symbol}] $${s.currentPrice.toFixed(2)} | ${s.changePct.toFixed(2)}%`,
          `  Vol: ${s.todayVolume.toLocaleString()} / ${s.avgVolume20d.toLocaleString()} avg = ${s.relativeVolume.toFixed(1)}x`,
          `  Regime: ${s.regime.toUpperCase()}`,
          ""
        );
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: active.length, scans: active },
    };
  },
});

// ─── TOOL 6: scan_premarket_gaps ──────────────────────────────────────────

export const scanPreMarketGapsTool = defineTool({
  name: "scan_premarket_gaps",
  label: "Scan Pre-Market Gaps",
  description:
    "Scan your watchlist for tickers with significant gaps vs prior close. " +
    "Gap + news = momentum play. Gap - news = potential fade. " +
    "Most effective during pre-market (4 AM–9:30 AM ET).",
  parameters: Type.Object({}),
  execute: async () => {
    const watchlist = await getWatchlist();
    const gaps = await scanPreMarketGaps(watchlist);

    if (gaps.length === 0) {
      return {
        content: [{ type: "text", text: "No significant gaps (>1.5%) on watchlist." }],
        details: { count: 0, gaps: [] },
      };
    }

    const lines: string[] = [
      "PRE-MARKET GAP SCAN (sorted by magnitude):",
      "",
    ];

    for (const g of gaps) {
      lines.push(
        `[${g.symbol}] $${g.preMarketPrice.toFixed(2)} (was $${g.priorClose.toFixed(2)})`,
        `  Gap: ${g.gapPct > 0 ? "+" : ""}${g.gapPct.toFixed(2)}%`,
        `  Direction: ${g.gapPct > 0 ? "UP" : "DOWN"}`,
        g.gapPct > 0
          ? `  Play: Gap-and-go (bullish) or gap-fill fade (bearish)`
          : `  Play: Oversold bounce (bullish) or breakdown continuation (bearish)`,
        ""
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: gaps.length, gaps },
    };
  },
});

// ─── TOOL 7: scan_range_breaks ──────────────────────────────────────────────

export const scanRangeBreaksTool = defineTool({
  name: "scan_range_breaks",
  label: "Scan Range Breaks",
  description:
    "Find watchlist tickers breaking out of their 20-day trading range. " +
    "Near top of range = potential breakout. Near bottom = potential breakdown. " +
    "Use with volume confirmation (scan_relative_volume).",
  parameters: Type.Object({}),
  execute: async () => {
    const watchlist = await getWatchlist();
    const breaks = await scanRangeBreaks(watchlist);

    if (breaks.length === 0) {
      return {
        content: [{ type: "text", text: "No tickers near 20-day range extremes." }],
        details: { count: 0, breaks: [] },
      };
    }

    const lines: string[] = ["20-DAY RANGE BREAK SCAN:", ""];

    for (const b of breaks) {
      const near = b.positionInRange > 0.9 ? "TOP" : "BOTTOM";
      lines.push(
        `[${b.symbol}] $${b.price.toFixed(2)}`,
        `  20D Range: $${b.low20d.toFixed(2)} – $${b.high20d.toFixed(2)}`,
        `  Position: ${(b.positionInRange * 100).toFixed(0)}% of range`,
        `  Near: ${near} of range`,
        near === "TOP"
          ? `  Play: Breakout long if volume confirms, or fade if overextended`
          : `  Play: Oversold bounce if support holds, or breakdown short if broken`,
        ""
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: breaks.length, breaks },
    };
  },
});

// ─── TOOL 8: scan_reddit ───────────────────────────────────────────────────

export const scanRedditTool = defineTool({
  name: "scan_reddit",
  label: "Scan Reddit Sentiment",
  description:
    "Scan Reddit for mention velocity of your watchlist tickers. " +
    "Tracks how fast mentions are accelerating (not just raw counts). " +
    "Use with caution: retail sentiment is noisy, but can predict meme/momentum moves.",
  parameters: Type.Object({}),
  execute: async () => {
    const watchlist = await getWatchlist();
    const scans = await scanRedditMentions(watchlist);

    if (scans.length === 0) {
      return {
        content: [{ type: "text", text: "No significant Reddit mentions for watchlist." }],
        details: { count: 0, scans: [] },
      };
    }

    const lines: string[] = [
      "REDDIT SENTIMENT SCAN:",
      "",
    ];

    for (const s of scans) {
      lines.push(
        `[${s.symbol}]`,
        `  Total mentions: ${s.totalMentions}`,
        `  Last hour: ${s.mentionsLastHour}`,
        `  Velocity: ${s.velocity.toFixed(2)} (1.0 = steady, >2.0 = accelerating)`,
        s.topPosts.length > 0 ? `  Top post: "${s.topPosts[0].title}" (${s.topPosts[0].subreddit}, score: ${s.topPosts[0].score})` : "",
        ""
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: scans.length, scans },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVERY TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// ─── TOOL: discover_opportunities ──────────────────────────────────────────

export const discoverOpportunitiesTool = defineTool({
  name: "discover_opportunities",
  label: "Discover Opportunities",
  description:
    "Scan the ENTIRE US equity market for high-activity tickers beyond your seed watchlist. " +
    "Uses Yahoo Finance to find: most active, top gainers/losers, and trending names. " +
    "Returns only tickers that support fractional shares on Alpaca. " +
    "Use this when: your watchlist has no action, you want fresh candidates, or market is moving outside your list.",
  parameters: Type.Object({
    maxResults: NumStr,
  }),
  execute: async (_id, params) => {
    const seed = _watchlist;
    const { discovered, sourceCounts } = await discoverOpportunities(seed, coerceNumber(params.maxResults, 15));
    const state = requireState();

    if (discovered.length === 0) {
      return {
        content: [{ type: "text", text: "No new opportunities discovered. Your seed watchlist may be the best set." }],
        details: { discovered: [] as any[], sourceCounts: {} as Record<string, number> },
      };
    }

    const lines: string[] = [
      `MARKET DISCOVERY (${discovered.length} new candidates found):`,
      ``,
      `Sources: ${Object.entries(sourceCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      ``,
    ];

    for (const d of discovered) {
      lines.push(
        `[${d.symbol}] $${d.price.toFixed(2)} | ${d.changePct > 0 ? "+" : ""}${d.changePct.toFixed(2)}%`,
        `  Vol: ${d.volume.toLocaleString()} | Source: ${d.source}`,
        `  Why: ${d.reason}`,
        ""
      );
    }

    lines.push(
      "💡 Next step: Run scan_relative_volume, trade_news_momentum, or trade_mean_reversion on any of these."
    );

    state.recordActivity("discovery", `Discovered ${discovered.length} new ticker(s): ${discovered.slice(0, 5).map(d => d.symbol).join(", ")}${discovered.length > 5 ? ` +${discovered.length - 5} more` : ""}`, {
      details: `Sources: ${Object.entries(sourceCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      metadata: { count: discovered.length, tickers: discovered.map(d => d.symbol), sources: sourceCounts },
    });

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { discovered, sourceCounts },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// PORTFOLIO & EXECUTION TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// ─── TOOL 9: check_portfolio ─────────────────────────────────────────────────

export const checkPortfolioTool = defineTool({
  name: "check_portfolio",
  label: "Check Portfolio",
  description:
    "View current open positions, cash, settled cash, and daily P&L from Alpaca. " +
    "Use this before entering any new trade to understand your current exposure.",
  parameters: Type.Object({}),
  execute: async () => {
    const state = requireState();
    const portfolio = state.getPortfolio();
    const alpacaAccount = await getAccount();
    state.syncAccount(alpacaAccount.cash, alpacaAccount.settledCash);

    const lines: string[] = [
      `PORTFOLIO (from Alpaca):`,
      `- Cash: $${portfolio.cash.toFixed(2)}`,
      `- Settled Cash: $${portfolio.settledCash.toFixed(2)}`,
      `- Daily P&L: $${portfolio.dailyPnL.toFixed(2)}`,
      `- Open Positions: ${portfolio.positions.length}`,
    ];

    if (portfolio.positions.length > 0) {
      lines.push("");
      for (const p of portfolio.positions) {
        const dirLabel = p.direction === "short" ? "SHORT" : "LONG";
        const thesisNote = `[${p.strategy}] via ${p.entrySignalSource} (${p.entryRegime} regime, ${(p.entrySignalConfidence * 100).toFixed(0)}% conf)`;
        lines.push(
          `  [${p.symbol}] ${dirLabel} ${p.qty.toFixed(4)} @ $${p.entryPrice.toFixed(2)} ` +
          `(unrealized: $${p.unrealizedPnL.toFixed(2)}) | ${thesisNote}`
        );
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: portfolio,
    };
  },
});

// ─── TOOL 10: monitor_positions ────────────────────────────────────────────

export const monitorPositionsTool = defineTool({
  name: "monitor_positions",
  label: "Monitor Positions",
  description:
    "Check all open positions for exit conditions. " +
    "EXIT LOGIC: Losers get cut by time stop (30 min if not +1%) or hard stop (-3%). " +
    "Winners (status 'green' or 'trailing') ride with a trailing stop (5% below peak). " +
    "Hold winners for days/weeks until trailing stop hits. " +
    "Returns which positions should be closed and why. Does NOT execute exits — call place_sell_order for each.",
  parameters: Type.Object({}),
  execute: async () => {
    const state = requireState();
    const positions = state.getPositions();

    if (positions.length === 0) {
      return {
        content: [{ type: "text", text: "No open positions to monitor." }],
        details: { exits: [] as any[], positions: 0 },
      };
    }

    const exits: Array<{ symbol: string; reason: string; price: number }> = [];
    const lines: string[] = ["POSITION MONITORING:"];

    for (const pos of positions) {
      const price = await getPrice(pos.symbol);
      if (!price) continue;

      state.updatePositionPnL(pos.symbol, price);

      const check = checkExitConditions({ position: pos, currentPrice: price });

      // Apply status updates if check returned them
      if (check.newStatus || check.newTrailingStop !== undefined || check.newHighestPrice) {
        state.updatePositionState(pos.symbol, price, {
          status: check.newStatus,
          trailingStopPrice: check.newTrailingStop,
          highestPrice: check.newHighestPrice,
        });
      }

      if (check.shouldExit) {
        exits.push({ symbol: pos.symbol, reason: check.reason, price });
        lines.push(`  🔴 ${pos.symbol}: EXIT — ${check.reason} (price: $${price.toFixed(2)})`);
      } else {
        lines.push(`  🟢 ${pos.symbol}: ${check.reason} (unrealized: ${((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%)`);
      }
    }

    if (exits.length > 0) {
      lines.push("");
      lines.push("💡 Next step: Call place_sell_order for each position that needs to exit.");
    }

    // Log to activity stream
    if (exits.length > 0) {
      state.recordActivity("signal", `monitor_positions flagged ${exits.length} exit(s): ${exits.map(e => `${e.symbol} (${e.reason.slice(0, 50)})`).join(", ")}`, {
        details: `Exits needed: ${exits.map(e => `${e.symbol} @ $${e.price.toFixed(2)} — ${e.reason}`).join(" | ")}`,
        metadata: { exits: exits.length, exitSymbols: exits.map(e => e.symbol), positionsChecked: positions.length },
      });
    } else {
      state.recordActivity("signal", `monitor_positions checked ${positions.length} position(s) — all within parameters`, {
        metadata: { positionsChecked: positions.length, exits: 0 },
      });
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { exits, positions: positions.length },
    };
  },
});

// ─── TOOL 11: trade_news_momentum (data only — agent reasons) ────────────────

export const tradeNewsMomentumTool = defineTool({
  name: "trade_news_momentum",
  label: "Trade News Momentum",
  description:
    "Get price context and the full text of a news headline for a ticker. " +
    "Returns multi-timeframe price action bars so you can evaluate the setup. " +
    "Does NOT execute.",
  parameters: Type.Object({
    headline: Type.String({ description: "The headline text" }),
    summary: Type.String({ description: "Article summary or body" }),
    ticker: Type.String({ description: "The ticker symbol" }),
  }),
  execute: async (_id, params) => {
    const ctx = await buildTickerContext({ symbol: params.ticker ?? "" });

    const lines: string[] = [
      ...ctx,
      "",
      "─ NEWS ─",
      `  Headline: ${params.headline}`,
      `  Summary: ${params.summary}`,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { ticker: params.ticker, headline: params.headline },
    };
  },
});

// ─── TOOL 12: trade_mean_reversion (data only — agent reasons) ───────────────

export const tradeMeanReversionTool = defineTool({
  name: "trade_mean_reversion",
  label: "Trade Mean Reversion",
  description:
    "Get multi-timeframe price context for a ticker to evaluate mean-reversion potential. " +
    "Returns 30d and 1d price bars, relative strength vs SPY, and volume context. " +
    "Best when: market is choppy, name moved >2% on no clear catalyst. " +
    "Does NOT execute.",
  parameters: Type.Object({
    ticker: Type.String({ description: "The ticker symbol" }),
  }),
  execute: async (_id, params) => {
    const ctx = await buildTickerContext({ symbol: params.ticker ?? "" });

    return {
      content: [{ type: "text", text: ctx.join("\n") }],
      details: { ticker: params.ticker },
    };
  },
});

// ─── TOOL 13: place_buy_order ──────────────────────────────────────────────

export const placeBuyOrderTool = defineTool({
  name: "place_buy_order",
  label: "Place Buy Order",
  description:
    "Execute a BUY order (long position). Applies risk guardrails automatically. " +
    "Only executes if trade passes: position limits, cash checks, daily loss halt. " +
    "Use for LONG positions only. For short positions, use place_short_order. " +
    "Use AFTER analyzing a signal with trade_news_momentum or trade_mean_reversion.",
  parameters: Type.Object({
    ticker: Type.String({ description: "Ticker symbol to buy" }),
    notional: Type.Number({ description: "Dollar amount to invest (e.g. 25). If omitted, uses risk-based sizing." }),
    strategy: Type.String({ description: "Strategy name (news_momentum, mean_reversion, edgar_filings, etc.)" }),
    holdMinutes: Type.Number({ default: 30, description: "Initial hold duration (30 min). Winners can extend indefinitely via trailing stop." }),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const dryRun = process.env.DRY_RUN === "true";

    const price = await getPrice(params.ticker ?? "");
    if (!price) {
      return {
        content: [{ type: "text", text: `❌ No price data for ${params.ticker}.` }],
        details: { executed: false, reason: "No price data", dryRun: false, ticker: null as any, price: 0, notional: 0, plan: null as any, order: null as any, error: null as any },
      };
    }

    const signal = {
      symbol: params.ticker ?? "",
      direction: "long" as const,
      strategy: params.strategy ?? "unknown",
      impactScore: 7,
      confidence: 0.7,
      suggestedSizePct: params.notional ? params.notional / 100 : 0.20,
      suggestedHoldMinutes: params.holdMinutes ?? 30,
    };

    const portfolio = state.getPortfolio();
    const account = await getAccount();
    state.syncAccount(account.cash, account.settledCash);

    // Phase 2: Look up calibration for (strategy, current regime)
    const [vix, spyChange] = await Promise.all([
      getVix(), getSpyChange()
    ]);
    const regime = vix !== null && vix > 25 ? "volatile"
      : spyChange !== null && spyChange > 0.5 ? "trending_up"
        : spyChange !== null && spyChange < -0.5 ? "trending_down"
          : "chop";

    const calibration = state.getCalibratedConfidence(params.strategy ?? "unknown", regime);
    if (calibration.override !== null) {
      console.log(`[CALIBRATION] ${params.ticker}: historical win rate ${calibration.override.toFixed(2)} (${calibration.sampleSize} samples) in ${regime}`);
    }

    const risk = evaluateBuySignal({
      signal,
      accountValue: account.equity,
      cash: portfolio.cash,
      settledCash: portfolio.settledCash,
      dailyPnL: portfolio.dailyPnL,
      openPositions: portfolio.positions,
      currentRegime: regime,
      calibrationOverride: calibration.override,
    });

    if (!risk.allowed) {
      return {
        content: [{ type: "text", text: `⛔ RISK BLOCKED: ${risk.reason}\nNo order placed.` }],
        details: { executed: false, reason: risk.reason, dryRun: false, ticker: null as any, price: 0, notional: 0, plan: null as any, order: null as any, error: null as any },
      };
    }

    const plan = getExitPlan(price, params.holdMinutes ?? 30);
    const notional = params.notional || risk.size;

    if (dryRun) {
      const qty = notional / price;
      state.recordEntry(
        params.ticker ?? "",
        qty,
        price,
        notional,
        plan.exitTime,
        params.strategy ?? "",
        { vix, spyChange, regime },           // market context for learning
        { source: params.strategy ?? "", confidence: 0.7, impactScore: 7 } // signal meta
      );
      return {
        content: [{ type: "text", text: `[DRY RUN] Simulated buy $${notional.toFixed(2)} of ${params.ticker} @ $${price.toFixed(2)}\nStop: $${plan.stopPrice.toFixed(2)} | Hold until: ${plan.exitTime.toISOString()}` }],
        details: { executed: true, dryRun: true, ticker: params.ticker, price, notional, plan, reason: "", order: null as any, error: null as any },
      };
    }

    try {
      const order = await submitOrder({
        symbol: params.ticker!,
        notional,
        side: "buy",
        timeInForce: "day",
      });

      await new Promise((r) => setTimeout(r, 2000));
      const qty = notional / price;
      state.recordEntry(
        params.ticker ?? "",
        qty,
        price,
        notional,
        plan.exitTime,
        params.strategy ?? "",
        { vix, spyChange, regime },
        { source: params.strategy ?? "", confidence: 0.7, impactScore: 7 }
      );

      state.recordActivity("trade_opened", `Opened long ${qty.toFixed(2)} shares of ${params.ticker} @ $${price.toFixed(2)} (${params.strategy}, confidence ${(0.7 * 100).toFixed(0)}%)`, {
        metadata: { symbol: params.ticker, price, qty, notional, side: "long", strategy: params.strategy, regime },
      });

      return {
        content: [{ type: "text", text: `✅ ORDER PLACED: ${params.ticker}\nNotional: $${notional.toFixed(2)} | Price: $${price.toFixed(2)}\nStop: $${plan.stopPrice.toFixed(2)} | Hold: ${plan.exitTime.toISOString()}\nID: ${order.id}` }],
        details: { executed: true, order, ticker: params.ticker, price, notional, plan, reason: "", dryRun: false, error: null as any },
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `❌ ORDER FAILED: ${e.message}` }],
        details: { executed: false, error: e.message, reason: "", dryRun: false, ticker: null as any, price: 0, notional: 0, plan: null as any, order: null as any },
      };
    }
  },
});

export const placeShortOrderTool = defineTool({
  name: "place_short_order",
  label: "Place Short Order",
  description:
    "Execute a SHORT SALE (short position, requires Alpaca margin account). " +
    "Applies risk guardrails automatically including squeeze protection. " +
    "Only executes if trade passes: position limits, cash checks, daily loss halt. " +
    "Use AFTER analyzing a bearish signal with trade_news_momentum or trade_mean_reversion. " +
    "To close a short position, call place_sell_order.",
  parameters: Type.Object({
    ticker: Type.String({ description: "Ticker symbol to short sell" }),
    notional: Type.Number({ description: "Dollar notional value of the short (e.g. 25). If omitted, uses risk-based sizing." }),
    strategy: Type.String({ description: "Strategy name (news_momentum, mean_reversion, edgar_filings, etc.)" }),
    holdMinutes: Type.Number({ default: 30, description: "Initial hold duration (30 min). Winners can extend via trailing stop." }),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const dryRun = process.env.DRY_RUN === "true";

    const price = await getPrice(params.ticker ?? "");
    if (!price) {
      return {
        content: [{ type: "text", text: `❌ No price data for ${params.ticker}.` }],
        details: { executed: false, reason: "No price data" as string | null, memoryWarning: null } as any,
      };
    }

    const signal = {
      symbol: params.ticker ?? "",
      direction: "short" as const,
      strategy: params.strategy ?? "unknown",
      impactScore: 7,
      confidence: 0.7,
      suggestedSizePct: params.notional ? params.notional / 100 : 0.20,
      suggestedHoldMinutes: params.holdMinutes ?? 30,
    };

    const portfolio = state.getPortfolio();
    const account = await getAccount();
    state.syncAccount(account.cash, account.settledCash);

    // Phase 2: Look up calibration for (strategy, current regime)
    const [vix, spyChange] = await Promise.all([
      getVix().catch(() => null),
      getSpyChange().catch(() => null),
    ]);
    const regime = vix !== null && vix > 25 ? "volatile"
      : spyChange !== null && spyChange > 0.5 ? "trending_up"
        : spyChange !== null && spyChange < -0.5 ? "trending_down"
          : "chop";

    // ── MEMORY CONSULTATION ──────────────────────────────────────────
    const memoryFeatureVector = state.buildLessonFeatureVector({
      vix,
      regime,
      confidence: signal.confidence,
      impactScore: signal.impactScore,
      notional: params.notional || 25,
    });
    const relevantLessons = state.findRelevantLessons(memoryFeatureVector, 3);
    const similarTrades = state.findSimilarTrades(memoryFeatureVector, 3);
    let memoryWarning: string | null = null;
    if (relevantLessons.length > 0) {
      const highWeightLessons = relevantLessons.filter((l) => l.weight >= 0.7);
      if (highWeightLessons.length > 0) {
        memoryWarning = highWeightLessons.map((l) => `[${l.category}] ${(l.insight || '').slice(0, 100)}`).join(" | ");
      }
    }
    if (similarTrades.length > 0) {
      const winRate = similarTrades.filter((t) => t.outcome === "win").length / similarTrades.length;
      if (winRate < 0.34) {
        memoryWarning = (memoryWarning ? memoryWarning + " | " : "") +
          `WARNING: Only ${(winRate * 100).toFixed(0)}% of similar past short trades won.`;
      }
    }
    if (memoryWarning) {
      console.log(`[MEMORY] ${params.ticker} (short): ${memoryWarning}`);
    }

    const calibration = state.getCalibratedConfidence(params.strategy ?? "unknown", regime);
    if (calibration.override !== null) {
      console.log(`[CALIBRATION] ${params.ticker} (short): historical win rate ${calibration.override.toFixed(2)} (${calibration.sampleSize} samples) in ${regime}`);
    }

    const risk = evaluateBuySignal({
      signal,
      accountValue: account.equity,
      cash: portfolio.cash,
      settledCash: portfolio.settledCash,
      dailyPnL: portfolio.dailyPnL,
      openPositions: portfolio.positions,
      currentRegime: regime,
      calibrationOverride: calibration.override,
    });

    if (!risk.allowed) {
      const memoryPrefix = memoryWarning ? `🧠 MEMORY: ${memoryWarning}\n\n` : "";
      return {
        content: [{ type: "text", text: `${memoryPrefix}⛔ RISK BLOCKED (short): ${risk.reason}\nNo order placed.` }],
        details: { executed: false, reason: risk.reason, memoryWarning },
      };
    }

    const plan = getExitPlan(price, params.holdMinutes ?? 30);
    const notional = params.notional || risk.size;

    if (dryRun) {
      const qty = notional / price;
      state.recordEntry(
        params.ticker ?? "",
        qty,
        price,
        notional,
        plan.exitTime,
        params.strategy ?? "",
        { vix, spyChange, regime },
        { source: params.strategy ?? "", confidence: 0.7, impactScore: 7 },
        "short"
      );
      const memoryPrefix = memoryWarning ? `🧠 MEMORY: ${memoryWarning}\n\n` : "";
      return {
        content: [{ type: "text", text: `${memoryPrefix}[DRY RUN] Simulated short $${notional.toFixed(2)} of ${params.ticker} @ $${price.toFixed(2)}\nCover trigger: $${plan.stopPrice.toFixed(2)} | Hold until: ${plan.exitTime.toISOString()}` }],
        details: { executed: true, dryRun: true, ticker: params.ticker, price, notional, plan, memoryWarning, reason: null as string | null },
      };
    }

    try {
      const order = await submitOrder({
        symbol: params.ticker!,
        notional,
        side: "sell_short",
        timeInForce: "day",
      });

      await new Promise((r) => setTimeout(r, 2000));
      const qty = notional / price;
      state.recordEntry(
        params.ticker ?? "",
        qty,
        price,
        notional,
        plan.exitTime,
        params.strategy ?? "",
        { vix, spyChange, regime },
        { source: params.strategy ?? "", confidence: 0.7, impactScore: 7 },
        "short"
      );

      state.recordActivity("trade_opened", `Opened short ${qty.toFixed(2)} shares of ${params.ticker} @ $${price.toFixed(2)} (${params.strategy}, confidence ${(0.7 * 100).toFixed(0)}%)`, {
        metadata: { symbol: params.ticker, price, qty, notional, side: "short", strategy: params.strategy, regime },
      });

      const memoryPrefix = memoryWarning ? `🧠 MEMORY: ${memoryWarning}\n\n` : "";
      return {
        content: [{ type: "text", text: `${memoryPrefix}✅ SHORT ORDER PLACED: ${params.ticker}\nNotional: $${notional.toFixed(2)} | Price: $${price.toFixed(2)}\nCover trigger: $${plan.stopPrice.toFixed(2)} | Hold: ${plan.exitTime.toISOString()}\nID: ${order.id}` }],
        details: { executed: true, order, ticker: params.ticker, price, notional, plan, memoryWarning, reason: null as string | null },
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `❌ SHORT ORDER FAILED: ${e.message}` }],
        details: { executed: false, reason: e.message as string | null, memoryWarning: null },
      };
    }
  },
});

export const placeSellOrderTool = defineTool({
  name: "place_sell_order",
  label: "Place Sell Order",
  description:
    "Execute a sell order to close an open position. No risk checks — exits are always allowed. " +
    "For LONG positions: sells shares. For SHORT positions: buys to cover (closes the short). " +
    "Use when: stop hit, time stop reached, profit target met, or thesis invalidated.",
  parameters: Type.Object({
    ticker: Type.String({ description: "Ticker to sell" }),
    reason: Type.String({ description: "Why you are closing" }),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const dryRun = process.env.DRY_RUN === "true";
    const price = await getPrice(params.ticker ?? "");

    if (!price) {
      return {
        content: [{ type: "text", text: `⚠️ No price for ${params.ticker}. Recording estimated exit.` }],
        details: { executed: false, reason: "No price data", dryRun: false, ticker: params.ticker, price: 0, order: undefined },
      };
    }

    if (dryRun) {
      state.recordExit(params.ticker ?? "", price, params.reason ?? "");
      state.recordActivity("trade_closed", `Closed ${params.ticker} @ $${price.toFixed(2)} — ${params.reason}`, {
        metadata: { symbol: params.ticker, price, reason: params.reason, dryRun: true },
      });
      return {
        content: [{ type: "text", text: `[DRY RUN] Simulated sell ${params.ticker} @ $${price.toFixed(2)} | ${params.reason}` }],
        details: { executed: true, dryRun: true, ticker: params.ticker, price, reason: params.reason!, order: undefined },
      };
    }

    try {
      const result = await liquidateSymbol(params.ticker ?? "");
      if (result.success) {
        state.recordExit(params.ticker ?? "", price, params.reason ?? "");
        state.recordActivity("trade_closed", `Closed ${params.ticker} @ $${price.toFixed(2)} — ${params.reason}`, {
          metadata: { symbol: params.ticker, price, reason: params.reason, orderId: result.order?.id },
        });
        return {
          content: [{ type: "text", text: `✅ SOLD ${params.ticker} @ $${price.toFixed(2)} | ${params.reason}\nID: ${result.order?.id ?? "N/A"}` }],
          details: { executed: true, dryRun: false, ticker: params.ticker, price, reason: params.reason!, order: result.order },
        };
      } else {
        return { content: [{ type: "text", text: `❌ SELL FAILED: ${result.error}` }], details: { executed: false, reason: result.error, dryRun: false, ticker: params.ticker, price: 0, order: undefined } };
      }
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ SELL FAILED: ${e.message}` }], details: { executed: false, reason: e.message, dryRun: false, ticker: params.ticker, price: 0, order: undefined } };
    }
  },
});

// ─── TOOL 15: close_position (analysis, no execution) ──────────────────────

export const closePositionTool = defineTool({
  name: "close_position",
  label: "Close Position",
  description:
    "Evaluate an open position for exit conditions by comparing the original thesis against current conditions. " +
    "Returns recommendation for both LONG and SHORT positions with thesis analysis. " +
    "Does NOT execute — call place_sell_order to actually close.",
  parameters: Type.Object({
    ticker: Type.String({ description: "Ticker to evaluate" }),
    reason: Type.String({ description: "Why considering close" }),
    thesisNote: Type.Optional(Type.String({ description: "Your assessment: does the original thesis still hold? This gets logged for later analysis." })),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const pos = state.getPositions().find((p) => p.symbol === params.ticker);
    const price = await getPrice(params.ticker ?? "");

    if (!pos) {
      return {
        content: [{ type: "text", text: `No tracked position in ${params.ticker}.` }],
        details: { hasPosition: false, pos: null as any, price: null as any, unrealizedPct: 0, timeHeld: 0, check: null as any },
      };
    }

    const check = checkExitConditions({ position: pos, currentPrice: price || pos.entryPrice });

    // Apply status updates
    if (check.newStatus || check.newTrailingStop !== undefined || check.newHighestPrice || check.newLowestPrice) {
      state.updatePositionState(pos.symbol, price || pos.entryPrice, {
        status: check.newStatus,
        trailingStopPrice: check.newTrailingStop,
        highestPrice: check.newHighestPrice,
        lowestPrice: check.newLowestPrice,
      });
    }

    const unrealizedPct = price ? ((price - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    const timeHeld = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;

    const directionLabel = pos.direction === "short" ? "SHORT" : "LONG";
    const regimeChanged = pos.entryRegime !== "unknown" ? `(entry: ${pos.entryRegime.toUpperCase()} → current: check fetch_market_data)` : "";

    const lines: string[] = [
      `POSITION EXIT ANALYSIS [${directionLabel}]:`,
      `  ${pos.symbol}: Entry $${pos.entryPrice.toFixed(2)} | Current ${price ? `$${price.toFixed(2)}` : "unavailable"}`,
      `  Unrealized: ${price ? `${unrealizedPct.toFixed(2)}%` : "unknown"}`,
      `  Status: ${pos.status.toUpperCase()}${pos.status === "initial" ? ` | Time held: ${timeHeld.toFixed(1)} min` : ""}${pos.trailingStopPrice ? ` | ${pos.direction === "short" ? "Cover trigger" : "Trailing stop"}: $${pos.trailingStopPrice.toFixed(2)}` : ""}`,
      ``,
      `  ORIGINAL THESIS:`,
      `    Strategy: ${pos.strategy} | Source: ${pos.entrySignalSource}`,
      `    Entry regime: ${pos.entryRegime.toUpperCase()} | Entry VIX: ${pos.entryVix?.toFixed(1) ?? "?"}`,
      `    Confidence: ${(pos.entrySignalConfidence * 100).toFixed(0)}% | Impact: ${pos.entrySignalImpactScore}/10`,
      `  Evaluation: ${check.reason}`,
    ];

    if (check.shouldExit) {
      lines.push("", "🔴 RECOMMENDATION: EXIT NOW", `  Reason: ${check.reason}`, "", "💡 Call place_sell_order to execute exit.");
    } else if (pos.status === "initial") {
      lines.push("", `🟡 INITIAL HOLD — Thesis still in play. Time stop protects downside.`);
    } else {
      lines.push("", `🟢 GREEN — Thesis confirmed, winner running. Let trailing stop handle exit.`);
    }

    // Log thesis assessment to activity stream
    const thesisAssessment = params.thesisNote
      ? `Agent assessment: ${params.thesisNote}`
      : `Agent evaluating whether thesis holds (${pos.strategy} via ${pos.entrySignalSource}, entered ${pos.entryRegime} regime)`;

    state.recordActivity("thesis_check", `Evaluated ${pos.symbol} ${directionLabel}: ${check.shouldExit ? "🔴 RECOMMEND EXIT" : check.newStatus === "green" || pos.status === "green" ? "🟢 HOLD (green)" : "🟡 HOLD (initial)"} | ${thesisAssessment.slice(0, 120)}`, {
      details: thesisAssessment,
      metadata: {
        symbol: pos.symbol, direction: pos.direction, strategy: pos.strategy,
        entryRegime: pos.entryRegime, entryVix: pos.entryVix,
        unrealizedPct, timeHeld, status: pos.status,
        shouldExit: check.shouldExit, agentNote: params.thesisNote,
      },
    });

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { pos, price, unrealizedPct, timeHeld, check, hasPosition: true },
    };
  },
});

// ─── TOOL: record_decision ───────────────────────────────────────────────

/**
 * Record the agent's reasoning about what it decided this cycle and why.
 * This is the primary way the agent's thought process gets persisted for
 * dashboard visibility and post-hoc analysis.
 *
 * Call this at the end of each cycle before the agent finishes its turn.
 */
export const recordDecisionTool = defineTool({
  name: "record_decision",
  label: "Record Decision",
  description:
    "Log your reasoning for this cycle to the activity stream. Call this at the end of every cycle " +
    "to document what you decided and why. This helps with post-hoc analysis and the retrospective. " +
    "Be specific: which positions you reviewed, what you decided about each, and any trades you took or skipped.",
  parameters: Type.Object({
    summary: Type.String({ description: "One-line summary of what you did this cycle (e.g. 'Held AAPL, took no new trades')" }),
    details: Type.String({ description: "Detailed reasoning: what you checked, what you found, and why you decided what you did" }),
    positionsReviewed: Type.Optional(Type.String({ description: "Comma-separated list of symbols you reviewed" })),
    tradesTaken: Type.Optional(Type.String({ description: "Comma-separated list of symbols you traded (or 'none')" })),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const portfolio = state.getPortfolio();

    state.recordActivity("decision", `${params.summary}`, {
      details: params.details,
      metadata: {
        positionsReviewed: params.positionsReviewed?.split(",").map((s: string) => s.trim()) || [],
        tradesTaken: params.tradesTaken?.split(",").map((s: string) => s.trim()) || [],
        cash: portfolio.cash,
        dailyPnL: portfolio.dailyPnL,
        openPositions: portfolio.positions.length,
      },
    });

    return {
      content: [{ type: "text", text: `✅ Decision recorded: ${params.summary}` }],
      details: { recorded: true },
    };
  },
});

// ─── TOOL 16: hold_cash ────────────────────────────────────────────────────

export const holdCashTool = defineTool({
  name: "hold_cash",
  label: "Hold Cash",
  description:
    "Explicitly choose to do nothing. VALID and OFTEN CORRECT. " +
    "Use when: no clear edge, poor regime, already exposed, or mental clarity needed.",
  parameters: Type.Object({
    reason: Type.String({ description: "Why holding cash" }),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const portfolio = state.getPortfolio();

    state.recordActivity("decision", `Held cash — ${params.reason}`, {
      metadata: { cash: portfolio.cash, settledCash: portfolio.settledCash },
    });

    return {
      content: [{ type: "text", text: `HOLDING CASH\n  Reason: ${params.reason}\n  Cash: $${portfolio.cash.toFixed(2)} | Settled: $${portfolio.settledCash.toFixed(2)}\n  Daily P&L: $${portfolio.dailyPnL.toFixed(2)}\n\n✓ Cash is a position.` }],
      details: { cash: portfolio.cash, settledCash: portfolio.settledCash },
    };
  },
});

// ─── TOOL 17: reflect_on_performance ─────────────────────────────────────────

export const reflectOnPerformanceTool = defineTool({
  name: "reflect_on_performance",
  label: "Reflect on Performance",
  description:
    "Review recent trades, extract lessons. Use after: string of losses, end of day, or edge decay.",
  parameters: Type.Object({
    lookbackTrades: Type.Number({ default: 10, description: "How many recent trades to review" }),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const history = state.getTradeHistory();
    const recent = history.slice(-(params.lookbackTrades ?? 10));

    if (recent.length === 0) {
      return {
        content: [{ type: "text", text: "No trade history yet." }],
        details: { recent: [] as any[], summary: null as any },
      };
    }

    const wins = recent.filter((t) => t.pnl > 0);
    const losses = recent.filter((t) => t.pnl <= 0);
    const winRate = (wins.length / recent.length) * 100;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const totalPnL = recent.reduce((s, t) => s + t.pnl, 0);

    const byStrategy: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const t of recent) {
      if (!byStrategy[t.strategy]) byStrategy[t.strategy] = { wins: 0, losses: 0, pnl: 0 };
      byStrategy[t.strategy].pnl += t.pnl;
      if (t.pnl > 0) byStrategy[t.strategy].wins++;
      else byStrategy[t.strategy].losses++;
    }

    const lines: string[] = [
      `PERFORMANCE (last ${recent.length} trades):`,
      `  Win Rate: ${winRate.toFixed(1)}% (${wins.length}W / ${losses.length}L)`,
      `  Total P&L: $${totalPnL.toFixed(2)}`,
      `  Avg Win: $${avgWin.toFixed(2)}`,
      `  Avg Loss: $${avgLoss.toFixed(2)}`,
      `  R:R: ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "N/A"}`,
      "",
      "BY STRATEGY:",
    ];

    for (const [strat, stats] of Object.entries(byStrategy)) {
      const sWinRate = stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0;
      lines.push(`  ${strat}: ${stats.wins}W/${stats.losses}L (${sWinRate.toFixed(0)}% WR) | P&L: $${stats.pnl.toFixed(2)}`);
    }

    const lessons: string[] = [];
    if (winRate < 40) lessons.push("Win rate below 40%. Reduce size or hold more cash.");
    if (avgWin < Math.abs(avgLoss) * 1.5) lessons.push("R:R below 1.5:1. Tighten stops or wait for higher-conviction setups.");
    if (Object.keys(byStrategy).length === 1) lessons.push("Only one strategy used. Diversify or verify regime fit.");

    if (lessons.length > 0) {
      lines.push("", "LESSONS:", ...lessons.map((l) => `  • ${l}`));
    }

    lessons.forEach((l) => state.addLesson(l));

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { recent, summary: { winRate, totalPnL, avgWin, avgLoss, byStrategy, lessons } },
    };
  },
});

// ─── TOOL 18: emergency_close_all ──────────────────────────────────────────

export const emergencyCloseAllTool = defineTool({
  name: "emergency_close_all",
  label: "Emergency Close All",
  description:
    "Immediately close ALL open positions. Use ONLY in emergencies: severe crash, bug, account preservation.",
  parameters: Type.Object({
    reason: Type.String({ description: "Why emergency close is needed" }),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const dryRun = process.env.DRY_RUN === "true";
    const positions = state.getPositions();

    if (positions.length === 0) {
      return { content: [{ type: "text", text: "No open positions." }], details: { closed: 0, reason: null as any, dryRun: false, error: undefined } };
    }

    if (dryRun) {
      for (const pos of positions) {
        const price = await getPrice(pos.symbol) || pos.entryPrice;
        state.recordExit(pos.symbol, price, `EMERGENCY: ${params.reason}`);
      }
      return {
        content: [{ type: "text", text: `[DRY RUN] Emergency closed ${positions.length} positions. ${params.reason}` }],
        details: { closed: positions.length, reason: params.reason, dryRun: true, error: undefined },
      };
    }

    try {
      await closeAllPositions();
      for (const pos of positions) {
        const price = await getPrice(pos.symbol) || pos.entryPrice;
        state.recordExit(pos.symbol, price, `EMERGENCY: ${params.reason}`);
      }
      return {
        content: [{ type: "text", text: `🚨 EMERGENCY CLOSED ${positions.length} positions. ${params.reason}` }],
        details: { closed: positions.length, reason: params.reason, dryRun: false, error: undefined },
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ EMERGENCY CLOSE FAILED: ${e.message}` }], details: { closed: 0, reason: e.message, dryRun: false, error: e.message } };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR MEMORY TOOLS — Phase 3: Similarity search
// ═══════════════════════════════════════════════════════════════════════════

// ─── TOOL: find_similar_trades ─────────────────────────────────────────────

export const findSimilarTradesTool = defineTool({
  name: "find_similar_trades",
  label: "Find Similar Trades",
  description:
    "Query the vector memory for past trades with similar market conditions to a prospective setup. " +
    "Returns the N most similar historical trades with their outcomes (win/loss, P&L%). " +
    "Use BEFORE entering a trade to sanity-check: has this exact situation worked before?",
  parameters: Type.Object({
    ticker: Type.String({ description: "Ticker you're evaluating" }),
    vix: NumStr,
    regime: Type.String({ description: "Current market regime" }),
    confidence: NumStr,
    impactScore: NumStr,
    notional: NumStr,
    topK: NumStr,
  }),
  execute: async (_id, params) => {
    const state = requireState();

    // Build feature vector from current conditions
    const vixNorm = coerceNumber(params.vix, 18);
    const conf = coerceNumber(params.confidence, 0.5);
    const impact = coerceNumber(params.impactScore, 0);
    const notionalVal = coerceNumber(params.notional, 50);
    const topK = coerceNumber(params.topK, 5);
    const featureVector = [
      Math.min(vixNorm / 50, 1.0),
      Math.min(Math.max(conf, 0), 1),
      Math.min(Math.max(impact / 10, -1), 1),
      Math.min(notionalVal / 100, 1.0),
      params.regime === "trending_up" ? 1 : 0,
      params.regime === "chop" ? 1 : 0,
      params.regime === "volatile" ? 1 : 0,
    ];

    const similar = state.findSimilarTrades(featureVector, topK);

    if (similar.length === 0) {
      return {
        content: [{ type: "text", text: "No similar trades in memory yet. Need more history to compare." }],
        details: { similar: [], winRate: 0, avgPnlPct: 0 },
      };
    }

    const wins = similar.filter((s) => s.outcome === "win");
    const winRate = (wins.length / similar.length) * 100;
    const avgPnlPct = similar.reduce((s, t) => s + t.pnlPct, 0) / similar.length;

    const lines: string[] = [
      `SIMILARITY SEARCH (${similar.length} most similar past trades):`,
      `  Query: ${params.ticker} | VIX ${params.vix} | ${params.regime} | conf ${params.confidence} | impact ${params.impactScore}`,
      ` `,
      `  HISTORICAL OUTCOMES OF SIMILAR SETUPS:`,
      `    Win rate: ${winRate.toFixed(1)}% (${wins.length}W / ${similar.length - wins.length}L)`,
      `    Avg P&L: ${avgPnlPct > 0 ? "+" : ""}${avgPnlPct.toFixed(2)}%`,
      `  `,
    ];

    for (const s of similar) {
      lines.push(
        `  [${s.symbol}] ${s.outcome.toUpperCase()} @ ${s.pnlPct > 0 ? "+" : ""}${s.pnlPct.toFixed(2)}% | similarity: ${(s.similarity * 100).toFixed(1)}% | ${s.timestamp.slice(0, 10)}`
      );
    }

    lines.push("");
    if (winRate >= 60) {
      lines.push("🟢 Historical edge detected. Similar setups have performed well.");
    } else if (winRate <= 40) {
      lines.push("🔴 Historical warning. Similar setups have underperformed.");
    } else {
      lines.push("🟡 No clear historical edge. Proceed with caution.");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { similar, winRate, avgPnlPct },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT NOTE TOOLS — Agent-curated persistent awareness
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a short id for a context note.
 */
function noteId(): string {
  return `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─── TOOL: note_context ──────────────────────────────────────────────────

export const noteContextTool = defineTool({
  name: "note_context",
  label: "Note Context",
  description:
    "Write a note about something you're tracking. This note persists across cycles " +
    "so you can recognize shifts and trends. Use this to flag:\n" +
    "  • A ticker that appeared in multiple sources (e.g., 'TSLA in gainers + volume + Reddit')\n" +
    "  • A catalyst that hasn't played out yet (e.g., 'EDGAR filing from ACME, watching for volume')\n" +
    "  • A sector or theme you're monitoring (e.g., 'semis weak across the board')\n" +
    "  • A pattern you're seeing repeat (e.g., '3rd cycle NVDA in top gainers')\n" +
    "Use view_context to see ALL your active notes. Notes you stop mentioning will be pruned.",
  parameters: Type.Object({
    ticker: Type.Optional(Type.String({ description: "Ticker this note is about (optional)" })),
    topic: Type.String({ description: "Short topic label (e.g. 'watching', 'catalyst', 'volume_alert', 'sector_trend')" }),
    note: Type.String({ description: "What you're tracking and why" }),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const note = {
      id: noteId(),
      ticker: params.ticker || undefined,
      topic: params.topic ?? "general",
      note: params.note ?? "",
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      cycleCount: 1,
    };
    state.addContextNote(note);

    return {
      content: [{ type: "text", text: `📝 Context note saved: [${note.topic}]${note.ticker ? ` ${note.ticker} —` : " —"} ${note.note}` }],
      details: { note },
    };
  },
});

// ─── TOOL: view_context ──────────────────────────────────────────────────

export const viewContextTool = defineTool({
  name: "view_context",
  label: "View Context",
  description:
    "View all your active context notes — things you're tracking across cycles. " +
    "Review this to spot trends, check if catalysts have played out, and decide what to keep or drop. " +
    "Notes are returned sorted by last seen (most recent first).",
  parameters: Type.Object({}),
  execute: async () => {
    const state = requireState();
    const notes = state.getContextNotes();

    if (notes.length === 0) {
      return {
        content: [{ type: "text", text: "📋 No active context notes. Use note_context to start tracking something." }],
        details: { count: 0, notes: [] },
      };
    }

    const lines: string[] = [
      `📋 ACTIVE CONTEXT NOTES (${notes.length}):`,
      "",
    ];

    for (const n of notes) {
      const age = Math.round((Date.now() - new Date(n.createdAt).getTime()) / 60000);
      const sinceLast = Math.round((Date.now() - new Date(n.lastSeen).getTime()) / 60000);
      lines.push(
        `  [${n.topic}]${n.ticker ? ` ${n.ticker}` : ""}`,
        `  ${n.note}`,
        `  Created ${age}min ago | Last active ${sinceLast}min ago | Seen ${n.cycleCount} cycles`,
        ""
      );
    }

    lines.push("💡 Use note_context to update or add new observations. Stale notes will be pruned automatically.");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: notes.length, notes },
    };
  },
});

// ─── TOOL: prune_context ────────────────────────────────────────────────

export const pruneContextTool = defineTool({
  name: "prune_context",
  label: "Prune Context",
  description:
    "Remove stale context notes. Use this when a catalyst has played out, a ticker is no longer interesting, " +
    "or a sector trend reversed. Pass a list of note IDs to remove, or omit IDs to auto-prune notes " +
    "that haven't been referenced in 2+ hours.",
  parameters: Type.Object({
    noteIds: Type.Optional(Type.Array(Type.String(), { description: "Specific note IDs to remove (optional — omit to auto-prune)" })),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const ids = params.noteIds;

    if (ids && ids.length > 0) {
      state.removeContextNotes(ids as string[]);
      return {
        content: [{ type: "text", text: `🗑️ Removed ${ids.length} context note(s).` }],
        details: { removed: ids.length, pruned: 0 },
      };
    }

    // Auto-prune: remove notes not seen in 2+ hours
    const pruned = state.pruneStaleContextNotes(120);
    if (pruned > 0) {
      return {
        content: [{ type: "text", text: `🧹 Auto-pruned ${pruned} stale note(s) (not referenced in 2+ hours).` }],
        details: { pruned, removed: 0 },
      };
    }

    return {
      content: [{ type: "text", text: "No stale notes to prune." }],
      details: { pruned: 0, removed: 0 },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH ENGINE TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// ─── TOOL: search_signals ───────────────────────────────────────────────

export const searchSignalsTool = defineTool({
  name: "search_signals",
  label: "Search Research Signals",
  description:
    "Query the research database for signal history across all data sources. " +
    "Signals are gathered 24/7 from: Yahoo movers (gainers/losers/trending), Alpaca news, EDGAR 8-K filings, " +
    "Reddit mention velocity, relative volume spikes, pre-market gaps, and range breaks. " +
    "Each signal has a score (0-1), direction (-1 bearish to +1 bullish), and source-specific payload. " +
    "Optionally include fundamental data (P/E, market cap, SMA, RSI, etc.) in results. " +
    "Cross-source clusters (same ticker in 2+ sources) are the strongest signal. " +
    "Use this instead of fetch_edgar_filings, scan_reddit, scan_relative_volume for historical queries.",
  parameters: Type.Object({
    ticker: Type.Optional(Type.String({ description: "Filter to one ticker (omit for market-wide)" })),
    sources: Type.Optional(Type.Array(Type.String(), { description: "Filter to specific sources: yahoo_mover, alpaca_news, edgar, reddit, volume_spike, gap, range_break" })),
    minScore: Type.Optional(NumStr),
    sinceMinutes: Type.Optional(NumStr),
    granularity: Type.Optional(Type.String({ description: "'raw' (per-event, up to 14d), 'hourly' (up to 90d), 'daily' (up to 365d), or 'auto' (default)" })),
    sortBy: Type.Optional(Type.String({ description: "'time' or 'score' (default: score)" })),
    maxResults: Type.Optional(NumStr),
    includeFundamentals: Type.Optional(Type.Boolean({ description: "Include latest fundamentals snapshot for each result" })),
  }),
  execute: async (_id, params) => {
    const store = getSignalStore();
    const query = {
      ticker: params.ticker,
      sources: params.sources as any,
      minScore: coerceNumber(params.minScore, undefined as any),
      sinceMinutes: coerceNumber(params.sinceMinutes, 1440),
      granularity: params.granularity as any,
      sortBy: params.sortBy as any,
      maxResults: coerceNumber(params.maxResults, 50),
    };

    const results = store.searchSignals(query);
    const clusters = store.findClusters(2, query.sinceMinutes);
    const relevantClusters = query.ticker
      ? clusters.filter((c) => String(c.ticker) === query.ticker!.toUpperCase())
      : clusters;

    const lines: string[] = [
      `🔍 SIGNAL SEARCH: ${results.length} results (${query.granularity || "raw"}, last ${query.sinceMinutes}min)`,
      "",
    ];

    // Show clusters first if any
    if (relevantClusters.length > 0) {
      lines.push("CROSS-SOURCE CLUSTERS (multi-source convergence):");
      for (const c of relevantClusters.slice(0, 5)) {
        lines.push(`  🔥 [${c.ticker}] ${c.source_count} sources | avg score: ${Number(c.avg_score).toFixed(2)} | bullish: ${c.bullish_total}, bearish: ${c.bearish_total}`);
      }
      lines.push("");
    }

    // Show individual signals
    lines.push("SIGNALS:");
    for (const r of results.slice(0, 30)) {
      const dir = Number(r.direction) > 0.3 ? "🟢" : Number(r.direction) < -0.3 ? "🔴" : "⚪";
      const ts = String(r.timestamp || r.bucket_hour || r.bucket_date || "").slice(0, 19);
      const src = String(r.source || "");
      lines.push(`  ${dir} [${r.ticker}] ${src} | score: ${Number(r.score || r.avg_score || 0).toFixed(2)} | ${ts}`);
    }

    if (results.length > 30) {
      lines.push(`  ... and ${results.length - 30} more (use filter to narrow)`);
    }

    // Optionally attach fundamentals
    if (params.includeFundamentals && query.ticker) {
      const funds = store.getFundamentals(query.ticker);
      if (funds) {
        const pe = funds.pe_ratio ? `P/E: ${Number(funds.pe_ratio).toFixed(1)}` : "";
        const cap = funds.market_cap ? `Cap: $${(Number(funds.market_cap) / 1e9).toFixed(1)}B` : "";
        const rsi = funds.rsi_14 ? `RSI: ${Number(funds.rsi_14).toFixed(0)}` : "";
        const sma = funds.sma_20 ? `SMA20: $${Number(funds.sma_20).toFixed(2)}` : "";
        lines.push("", `📊 FUNDAMENTALS (${funds.as_of_date || "latest"}):`);
        if (pe || cap) lines.push(`  ${pe}${pe && cap ? " | " : ""}${cap}`);
        if (rsi || sma) lines.push(`  ${rsi}${rsi && sma ? " | " : ""}${sma}`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: results.length, results, clusters: relevantClusters.slice(0, 10) },
    };
  },
});

// ─── TOOL: describe_datasets ─────────────────────────────────────────────

export const describeDatasetsTool = defineTool({
  name: "describe_datasets",
  label: "Describe Research Datasets",
  description:
    "View the schema and current state of the research database: tables, columns, row counts, date ranges, " +
    "and per-source signal breakdowns. Call this at startup or anytime you need to understand what data " +
    "is available in the research engine. Useful before calling search_signals to know what's queryable.",
  parameters: Type.Object({}),
  execute: async () => {
    const store = getSignalStore();
    const tables = store.getTableInfo();
    const dateRanges = store.getDateRange();
    const sourceBreakdown = store.getSourceBreakdown();

    const lines: string[] = [
      "📚 RESEARCH DATABASE SCHEMA:",
      "",
    ];

    for (const t of tables) {
      const range = dateRanges[t.name];
      const dateStr = range?.min
        ? `${range.min.slice(0, 10)} to ${range.max?.slice(0, 10) || "now"}`
        : "(empty)";
      lines.push(`  TABLE: ${t.name} (${t.rowCount} rows)`);
      lines.push(`  Date range: ${dateStr}`);
      lines.push(`  Columns: ${t.columns.map((c) => `${c.name}:${c.type}`).join(", ")}`);
      lines.push("");
    }

    if (Object.keys(sourceBreakdown).length > 0) {
      lines.push("SOURCE BREAKDOWN (signals table):");
      for (const [src, count] of Object.entries(sourceBreakdown).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${src}: ${count} signals`);
      }
    }

    // Also show sector/macro counts
    const sectorCount = tables.find((t) => t.name === "sector_signals")?.rowCount ?? 0;
    const macroCount = tables.find((t) => t.name === "macro_events")?.rowCount ?? 0;
    if (sectorCount > 0 || macroCount > 0) {
      lines.push("");
      lines.push("SECTOR & MACRO DATA:");
      if (sectorCount > 0) lines.push(`  sector_signals: ${sectorCount} events (Fed, sector rotation, political news)`);
      if (macroCount > 0) lines.push(`  macro_events: ${macroCount} events (CPI, FOMC, NFP calendar)`);
      lines.push("");
      lines.push("  Use search_sector_signals and get_macro_calendar tools to query these.");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { tables, dateRanges, sourceBreakdown },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════

// ─── TOOL: search_sector_signals ─────────────────────────────────────────

export const searchSectorSignalsTool = defineTool({
  name: "search_sector_signals",
  label: "Search Sector & Macro Signals",
  description:
    "Query the research database for sector-level and macro-political signals. " +
    "These are NOT ticker-specific — they cover sectors (XLF, XLK, XLE, etc.), " +
    "macro events (Fed rate decisions, CPI, NFP), and political/regulatory news. " +
    "Useful for understanding sector rotation, macro headwinds/tailwinds, and " +
    "regulatory environment. Also use get_macro_calendar for upcoming events.",
  parameters: Type.Object({
    sector: Type.Optional(Type.String({ description: "Filter to one sector (e.g., 'Technology', 'Financials', 'macro', 'political'). Omit for all." })),
    sinceMinutes: Type.Optional(NumStr),
    impact: Type.Optional(Type.String({ description: "Filter by impact level: 'high', 'medium', 'low'" })),
  }),
  execute: async (_id, params) => {
    const store = getSignalStore();
    const results = store.getSectorSignals(params.sector,
      params.sinceMinutes ? Number(params.sinceMinutes) : 1440,
      params.impact);

    const lines: string[] = ["🏢 SECTOR & MACRO SIGNALS:", ""];
    if (results.length === 0) {
      lines.push("No sector/macro signals found.");
    } else {
      for (const r of results.slice(0, 50)) {
        const ts = String(r.timestamp || "").slice(0, 19);
        const impact = String(r.impact || "").toUpperCase();
        const dir = Number(r.direction) > 0 ? "🟢" : Number(r.direction) < 0 ? "🔴" : "⚪";
        lines.push(`  ${dir} [${r.sector}] ${r.headline?.toString().slice(0, 100)}`);
        lines.push(`     ${r.source} | impact: ${impact} | score: ${Number(r.score).toFixed(2)} | ${ts}`);
      }
    }

    // Also show sector rotation summary if querying all
    if (!params.sector) {
      const rotation = store.getSectorRotation(params.sinceMinutes ? Number(params.sinceMinutes) : 1440);
      if (rotation.length > 0) {
        lines.push("", "SECTOR ROTATION (activity in last 24h):");
        for (const r of rotation.slice(0, 10)) {
          lines.push(`  ${r.sector}: ${r.signal_count} signals | bullish: ${r.bullish} bearish: ${r.bearish} | avg score: ${Number(r.avg_score).toFixed(2)}`);
        }
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: results.length, results, rotation: !params.sector ? store.getSectorRotation() : undefined },
    };
  },
});

// ─── TOOL: get_macro_calendar ────────────────────────────────────────────

export const getMacroCalendarTool = defineTool({
  name: "get_macro_calendar",
  label: "Get Macro Economic Calendar",
  description:
    "View upcoming macro economic events from the research database: " +
    "CPI releases, FOMC rate decisions, NFP (jobs) reports, PPI, etc. " +
    "Events are pre-loaded from a quarterly schedule. " +
    "Use this to understand upcoming macro risk before making trading decisions.",
  parameters: Type.Object({
    eventType: Type.Optional(Type.String({ description: "Filter by type: 'cpi', 'fomc', 'nfp', 'ppi', 'tariff', 'regulation'" })),
    sinceMinutes: Type.Optional(NumStr),
  }),
  execute: async (_id, params) => {
    const store = getSignalStore();
    const results = store.getMacroEvents(params.eventType,
      params.sinceMinutes ? Number(params.sinceMinutes) : 7 * 24 * 60);  // Default: 7 days

    const lines: string[] = ["📅 MACRO ECONOMIC CALENDAR:", ""];
    if (results.length === 0) {
      lines.push("No upcoming macro events found.");
    } else {
      for (const r of results.slice(0, 30)) {
        const ts = String(r.timestamp || "").slice(0, 19);
        const impact = String(r.impact || "").toUpperCase();
        lines.push(`  ${impact === "HIGH" ? "🔴" : impact === "MEDIUM" ? "🟡" : "⚪"} [${r.event_type?.toString().toUpperCase()}] ${r.headline?.toString().slice(0, 120)}`);
        lines.push(`     impact: ${impact} | ${ts}`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: results.length, results },
    };
  },
});
// ALL TOOLS EXPORT
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY-AWARE TOOLS (trader can read from strategist's output)
// ═══════════════════════════════════════════════════════════════════════════

export const getActiveStrategiesTool = defineTool({
  name: "get_active_strategies",
  label: "Get Active Strategies",
  description: "Get the top 10 candidate strategies from the strategist AND any strategies linked to open positions. Read-only.",
  parameters: Type.Object({}),
  execute: async () => {
    if (!_strategies) return { content: [{ type: "text", text: "Strategy store not available." }], details: {} };
    const state = requireState();
    const positions = state.getPositions();
    const top = _strategies.getTopStrategies(10);
    const lines = ["=== ACTIVE STRATEGIES ==="];
    for (const pos of positions) {
      const tickerStrategies = _strategies.getByTicker(pos.symbol, 3);
      const linked = tickerStrategies.find((s: any) => s.state === "active" || s.state === "realized");
      if (linked) {
        lines.push("POSITION: " + pos.symbol + " -> " + linked.strategy_type + " " + linked.state + " | conviction: " + linked.conviction + " @" + (linked.confidence * 100).toFixed(0) + "%");
        lines.push("  Thesis: " + linked.thesis);
        if (linked.catalyst) lines.push("  Catalyst: " + linked.catalyst);
        if (linked.entry_conditions) lines.push("  Entry: " + linked.entry_conditions);
        if (linked.exit_conditions) lines.push("  Exit if: " + linked.exit_conditions);
      }
    }
    if (top.length > 0) {
      lines.push("TOP CANDIDATES:");
      for (const s of top) {
        lines.push("  " + s.ticker + " [" + s.strategy_type + "] " + s.direction + " " + s.state + " | conviction: " + s.conviction + " @" + (s.confidence * 100).toFixed(0) + "%");
        lines.push("    " + s.thesis.slice(0, 200));
        if (s.catalyst) lines.push("    Catalyst: " + s.catalyst.slice(0, 100));
        if (s.entry_conditions) lines.push("    Entry: " + s.entry_conditions.slice(0, 150));
        if (s.exit_conditions) lines.push("    Exit if: " + s.exit_conditions.slice(0, 150));
      }
    } else {
      lines.push("No candidate strategies from the strategist.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
  },
});

export const updateStrategyOnExitTool = defineTool({
  name: "update_strategy_on_exit",
  label: "Update Strategy on Exit",
  description: "After closing a position, call this to record the outcome on the linked strategy. Feeds back to the strategist's learning loop.",
  parameters: Type.Object({
    ticker: Type.String({ description: "Ticker symbol" }),
    exit_price: Type.Optional(NumStr),
    exit_reason: Type.Optional(Type.String()),
    strategy_outcome: Type.Optional(Type.String({ description: "success or failure" })),
  }),
  execute: async (_id: string, params: any) => {
    if (!_strategies) return { content: [{ type: "text", text: "Strategy store not available." }], details: {} };
    const ticker = params.ticker.toUpperCase();
    const tickerStrategies = _strategies.getByTicker(ticker, 5);
    const active = tickerStrategies.find((s: any) => s.state === "active" || s.state === "realized");
    if (!active) return { content: [{ type: "text", text: "No active strategy found for " + ticker + "." }], details: {} };
    const outcome = (params.strategy_outcome as string) ?? "unknown";
    const update: any = { state: outcome === "success" ? "active" : "failed", exit_reason: (params.exit_reason as string) ?? "closed" };
    if (params.exit_price !== undefined) update.exit_price = coerceNumber(params.exit_price, 0);
    _strategies.update(active.id, update);
    return { content: [{ type: "text", text: "Strategy " + active.id.slice(0, 16) + " for " + ticker + ": " + outcome }], details: {} };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// ALL TRADING TOOLS — execution + strategy, no pure-research tools
// ═══════════════════════════════════════════════════════════════════════════

export const allTradingTools = [
  // Market context (keep minimal)
  fetchMarketDataTool,
  fetchNewsTool,
  // Portfolio & execution
  checkPortfolioTool,
  monitorPositionsTool,
  tradeNewsMomentumTool,
  tradeMeanReversionTool,
  placeBuyOrderTool,
  placeShortOrderTool,
  placeSellOrderTool,
  closePositionTool,
  holdCashTool,
  recordDecisionTool,
  reflectOnPerformanceTool,
  emergencyCloseAllTool,
  findSimilarTradesTool,
  // Context notes
  noteContextTool,
  viewContextTool,
  pruneContextTool,
  // Research engine (keep for quick checks)
  searchSignalsTool,
  describeDatasetsTool,
  // Strategy-aware tools
  getActiveStrategiesTool,
  updateStrategyOnExitTool,
];
