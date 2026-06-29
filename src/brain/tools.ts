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
import { analyzeNews } from "./analysis.js";
import {
  getAccount,
  submitOrder,
  liquidateSymbol,
  closeAllPositions,
  getCurrentPrice,
  getClock,
} from "../execution/alpaca.js";
import { PortfolioState } from "../state/portfolio.js";
import { evaluateBuySignal, getExitPlan, checkExitConditions } from "../risk/guardrails.js";

// Global state reference — set at startup
let _state: PortfolioState;
let _watchlist: string[] = [];
let _discovered: string[] = [];

export function setGlobalState(state: PortfolioState, watchlist: string[]) {
  _state = state;
  _watchlist = watchlist;
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
      `- Risk Settings: 30% max pos, 3% stop, 30-min hold, 4-loss halt`,
      "",
      regime === "trending_up" ? "Low vol uptrend. Momentum favored. Mean-reversion dangerous."
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
        details: { count: 0 },
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
        details: { count: 0 },
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
        details: { count: 0 },
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
        details: { count: 0 },
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
        details: { count: 0 },
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
        details: { count: 0 },
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
        details: { count: 0 },
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

    if (discovered.length === 0) {
      return {
        content: [{ type: "text", text: "No new opportunities discovered. Your seed watchlist may be the best set." }],
        details: { discovered: 0 },
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
        lines.push(
          `  [${p.symbol}] ${p.qty.toFixed(4)} @ $${p.entryPrice.toFixed(2)} ` +
          `(unrealized: $${p.unrealizedPnL.toFixed(2)}) | Strategy: ${p.strategy}`
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
        details: { exits: [] },
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

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { exits, positions: positions.length },
    };
  },
});

// ─── TOOL 11: trade_news_momentum (analysis only) ───────────────────────────

export const tradeNewsMomentumTool = defineTool({
  name: "trade_news_momentum",
  label: "Trade News Momentum",
  description:
    "Analyze a specific headline for short-term directional momentum. " +
    "Returns a signal with direction, impact score, confidence, and sizing guidance. " +
    "Does NOT execute — call place_buy_order after analysis.",
  parameters: Type.Object({
    headline: Type.String({ description: "The headline text" }),
    summary: Type.String({ description: "Article summary or body" }),
    ticker: Type.String({ description: "The ticker symbol" }),
  }),
  execute: async (_id, params) => {
    const price = await getPrice(params.ticker ?? "");
    const signal = await analyzeNews(params.headline ?? "", params.summary ?? "", params.ticker ?? "", price || 0);

    const lines: string[] = [
      `NEWS MOMENTUM ANALYSIS:`,
      `  Ticker: ${signal.symbol}`,
      `  Direction: ${signal.direction.toUpperCase()}`,
      `  Impact Score: ${signal.impactScore}/10`,
      `  Confidence: ${(signal.confidence * 100).toFixed(0)}%`,
      `  Reasoning: ${signal.reasoning}`,
      `  Suggested Size: ${(signal.suggestedSizePct * 100).toFixed(0)}%`,
      `  Suggested Hold: ${signal.suggestedHoldMinutes} min`,
    ];

    if (price) lines.push(`  Current Price: $${price.toFixed(2)}`);

    if (signal.direction === "neutral" || signal.confidence < 0.6) {
      lines.push("", "⚠️ Signal is weak or neutral. Consider holding cash.");
    } else {
      lines.push("", "💡 Next step: Call place_buy_order if you want to execute.");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: signal,
    };
  },
});

// ─── TOOL 12: trade_mean_reversion (analysis only) ──────────────────────────

export const tradeMeanReversionTool = defineTool({
  name: "trade_mean_reversion",
  label: "Trade Mean Reversion",
  description:
    "Evaluate a ticker for mean-reversion potential. " +
    "Best when: market is choppy, name moved >2% on no clear catalyst.",
  parameters: Type.Object({
    ticker: Type.String({ description: "The ticker symbol" }),
  }),
  execute: async (_id, params) => {
    const price = await getPrice(params.ticker ?? "");
    if (!price) {
      return {
        content: [{ type: "text", text: `Could not get price for ${params.ticker}.` }],
        details: { signal: null },
      };
    }

    const prevClose = await getPreviousClose(params.ticker ?? "");
    const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const isOverextended = Math.abs(changePct) > 2;
    const direction = changePct > 2 ? "short" : changePct < -2 ? "long" : "neutral";

    const reasoning = prevClose
      ? `${params.ticker} is ${changePct > 0 ? "up" : "down"} ${Math.abs(changePct).toFixed(2)}% from prior close. ${isOverextended ? "Potential mean-reversion candidate." : "Not significantly extended."}`
      : "Could not determine prior close.";

    const lines: string[] = [
      `MEAN REVERSION ANALYSIS:`,
      `  Ticker: ${params.ticker}`,
      `  Current: $${price.toFixed(2)}`,
      `  Prior Close: ${prevClose ? `$${prevClose.toFixed(2)}` : "unknown"}`,
      `  Change: ${changePct.toFixed(2)}%`,
      `  Signal: ${direction.toUpperCase()}`,
      `  Reasoning: ${reasoning}`,
    ];

    if (isOverextended) {
      lines.push("", "💡 Next step: Call place_buy_order (for dips) if you want to fade.");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { direction, changePct, isOverextended, reasoning },
    };
  },
});

async function getPreviousClose(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = data.chart?.result?.[0];
    if (!results) return null;
    const closes = results.indicators?.quote?.[0]?.close;
    if (!closes || closes.length < 2) return null;
    return closes[closes.length - 2];
  } catch {
    return null;
  }
}

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
        details: { executed: false, reason: "No price data" },
      };
    }

    const signal = {
      symbol: params.ticker ?? "",
      direction: "long" as const,
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
        details: { executed: false, reason: risk.reason },
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
        details: { executed: true, dryRun: true, ticker: params.ticker, price, notional, plan },
      };
    }

    try {
      const order = await submitOrder({
        symbol: params.ticker,
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

      return {
        content: [{ type: "text", text: `✅ ORDER PLACED: ${params.ticker}\nNotional: $${notional.toFixed(2)} | Price: $${price.toFixed(2)}\nStop: $${plan.stopPrice.toFixed(2)} | Hold: ${plan.exitTime.toISOString()}\nID: ${order.id}` }],
        details: { executed: true, order, ticker: params.ticker, price, notional, plan },
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `❌ ORDER FAILED: ${e.message}` }],
        details: { executed: false, error: e.message },
      };
    }
  },
});

// ─── TOOL 14: place_sell_order ──────────────────────────────────────────────

// ─── TOOL 13b: place_short_order ────────────────────────────────────────────

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
        memoryWarning = highWeightLessons.map((l) => `[${l.category}] ${l.insight.slice(0, 100)}`).join(" | ");
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
        details: { executed: false, reason: "No price data" },
      };
    }

    if (dryRun) {
      state.recordExit(params.ticker ?? "", price, params.reason ?? "");
      return {
        content: [{ type: "text", text: `[DRY RUN] Simulated sell ${params.ticker} @ $${price.toFixed(2)} | ${params.reason}` }],
        details: { executed: true, dryRun: true, ticker: params.ticker, price, reason: params.reason },
      };
    }

    try {
      const result = await liquidateSymbol(params.ticker ?? "");
      if (result.success) {
        state.recordExit(params.ticker ?? "", price, params.reason ?? "");
        return {
          content: [{ type: "text", text: `✅ SOLD ${params.ticker} @ $${price.toFixed(2)} | ${params.reason}\nID: ${result.order?.id ?? "N/A"}` }],
          details: { executed: true, ticker: params.ticker, price, reason: params.reason, order: result.order },
        };
      } else {
        return { content: [{ type: "text", text: `❌ SELL FAILED: ${result.error}` }], details: { executed: false, error: result.error } };
      }
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ SELL FAILED: ${e.message}` }], details: { executed: false, error: e.message } };
    }
  },
});

// ─── TOOL 15: close_position (analysis, no execution) ──────────────────────

export const closePositionTool = defineTool({
  name: "close_position",
  label: "Close Position",
  description:
    "Evaluate an open position for exit conditions. Returns recommendation for both LONG and SHORT positions. " +
    "Does NOT execute — call place_sell_order to actually close.",
  parameters: Type.Object({
    ticker: Type.String({ description: "Ticker to evaluate" }),
    reason: Type.String({ description: "Why considering close" }),
  }),
  execute: async (_id, params) => {
    const state = requireState();
    const pos = state.getPositions().find((p) => p.symbol === params.ticker);
    const price = await getPrice(params.ticker ?? "");

    if (!pos) {
      return {
        content: [{ type: "text", text: `No tracked position in ${params.ticker}.` }],
        details: { hasPosition: false },
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

    const lines: string[] = [
      `POSITION EXIT ANALYSIS [${directionLabel}]:`,
      `  ${pos.symbol}: Entry $${pos.entryPrice.toFixed(2)} | Current ${price ? `$${price.toFixed(2)}` : "unavailable"}`,
      `  Unrealized: ${price ? `${unrealizedPct.toFixed(2)}%` : "unknown"}`,
      `  Status: ${pos.status.toUpperCase()}${pos.status === "initial" ? ` | Time held: ${timeHeld.toFixed(1)} min` : ""}${pos.trailingStopPrice ? ` | ${pos.direction === "short" ? "Cover trigger" : "Trailing stop"}: $${pos.trailingStopPrice.toFixed(2)}` : ""}`,
      `  Evaluation: ${check.reason}`,
    ];

    if (check.shouldExit) {
      lines.push("", "🔴 RECOMMENDATION: EXIT NOW", `  Reason: ${check.reason}`, "", "💡 Call place_sell_order to execute exit.");
    } else if (pos.status === "initial") {
      const holdMsg = pos.direction === "short" ? "Need price drop" : "Need +1% profit";
      lines.push("", `🟡 INITIAL HOLD — ${holdMsg} to promote to trailing stop.`, `  Time stop in effect: auto-exit if not profitable within 30 min.`);
    } else {
      lines.push("", `🟢 GREEN — Winner running. Trailing ${pos.direction === "short" ? "cover" : "stop"} active.`, `  Let it ride. Will exit automatically if ${pos.direction === "short" ? "cover trigger" : "trailing stop"} hits.`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { pos, price, unrealizedPct, timeHeld, check },
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
        details: { trades: 0 },
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
      return { content: [{ type: "text", text: "No open positions." }], details: { closed: 0 } };
    }

    if (dryRun) {
      for (const pos of positions) {
        const price = await getPrice(pos.symbol) || pos.entryPrice;
        state.recordExit(pos.symbol, price, `EMERGENCY: ${params.reason}`);
      }
      return {
        content: [{ type: "text", text: `[DRY RUN] Emergency closed ${positions.length} positions. ${params.reason}` }],
        details: { closed: positions.length, reason: params.reason, dryRun: true },
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
        details: { closed: positions.length, reason: params.reason },
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ EMERGENCY CLOSE FAILED: ${e.message}` }], details: { closed: 0, error: e.message } };
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
        details: { similar: [] },
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
        details: { count: 0 },
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
        details: { removed: ids.length },
      };
    }

    // Auto-prune: remove notes not seen in 2+ hours
    const pruned = state.pruneStaleContextNotes(120);
    if (pruned > 0) {
      return {
        content: [{ type: "text", text: `🧹 Auto-pruned ${pruned} stale note(s) (not referenced in 2+ hours).` }],
        details: { pruned },
      };
    }

    return {
      content: [{ type: "text", text: "No stale notes to prune." }],
      details: { pruned: 0 },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// ALL TOOLS EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export const allTradingTools = [
  // Data gathering
  fetchMarketDataTool,
  fetchNewsTool,
  fetchAllNewsTool,
  fetchEdgarFilingsTool,
  scanRelativeVolumeTool,
  scanPreMarketGapsTool,
  scanRangeBreaksTool,
  scanRedditTool,
  discoverOpportunitiesTool,
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
  reflectOnPerformanceTool,
  emergencyCloseAllTool,
  findSimilarTradesTool,
  // Context notes — agent-curated persistent awareness
  noteContextTool,
  viewContextTool,
  pruneContextTool,
];
