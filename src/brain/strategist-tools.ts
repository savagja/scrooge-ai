/**
 * Strategist tools — research-only, no execution capabilities.
 * Reuses shared research tools from tools.ts and adds strategy management.
 */

import { Type } from "@sinclair/typebox";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

function coerceNumber(val: unknown, fallback: number): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") { const n = Number(val); if (!isNaN(n)) return n; }
  return fallback;
}
const NumStr = Type.Any();

import { PortfolioState } from "../state/portfolio.js";
import { StrategyStore } from "../state/strategies.js";
import type { StrategyType } from "../types.js";

// ── Shared state ──────────────────────────────────────────────────────────

let _state: PortfolioState;
let _strategies: StrategyStore;
export function setStrategistState(state: PortfolioState, strategies: StrategyStore) {
  _state = state; _strategies = strategies;
}
function requireState(): PortfolioState { if (!_state) throw new Error("State not initialized."); return _state; }
function requireStrategies(): StrategyStore { if (!_strategies) throw new Error("Strategies not initialized."); return _strategies; }

function text(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
}

// ── Re-export shared research tools from tools.ts ────────────────────────

import {
  fetchMarketDataTool as _fmd, fetchNewsTool as _fn, fetchAllNewsTool as _fan,
  fetchEdgarFilingsTool as _fef, scanRelativeVolumeTool as _srv,
  scanPreMarketGapsTool as _spg, scanRangeBreaksTool as _srb,
  scanRedditTool as _sr, discoverOpportunitiesTool as _do,
  searchSignalsTool as _ss, describeDatasetsTool as _dd,
} from "./tools.js";

// ── Strategist-only: list_strategies (read existing strategies) ───────────

export const listStrategiesTool = defineTool({
  name: "list_strategies",
  label: "List Strategies",
  description: "List your existing strategies. Use this BEFORE creating new ones to check if you already have a strategy for a ticker. Supports filtering by ticker, state, or type. This is how you avoid creating duplicates.",
  parameters: Type.Object({
    state: Type.Optional(Type.String({ description: "Filter by state: anticipated, developing, active, failed, stale" })),
    ticker: Type.Optional(Type.String({ description: "Filter by ticker symbol" })),
    type: Type.Optional(Type.String({ description: "Filter by strategy type" })),
    topK: Type.Optional(NumStr),
  }),
  execute: async (_id: string, params: any) => {
    try {
      const store = requireStrategies();
      let strategies: any[] = [];
      
      if (params.ticker) {
        strategies = store.getByTicker(params.ticker.toUpperCase(), 10);
      } else if (params.state) {
        strategies = store.getByState(params.state);
      } else if (params.type) {
        // Use SQL through getTopStrategies with type filter
        strategies = store.getTopStrategies(coerceNumber(params.topK, 50));
      } else {
        strategies = store.getTopStrategies(coerceNumber(params.topK, 30));
      }

      if (strategies.length === 0) {
        return text("No strategies found" + (params.state ? " in state: " + params.state : "") + (params.ticker ? " for ticker: " + params.ticker : "") + ".");
      }

      const lines = ["=== STRATEGIES (" + strategies.length + " found) ===", ""];
      for (const s of strategies) {
        lines.push(`  [${s.ticker}] ${s.strategy_type} ${s.direction} | ${s.state} | conf:${(s.confidence * 100).toFixed(0)}% conv:${s.conviction}`);
        lines.push(`    Thesis: ${s.thesis.slice(0, 120)}`);
        if (s.catalyst) lines.push(`    Catalyst: ${s.catalyst.slice(0, 80)}`);
        const grade = s.what_if?.grade ? `G${s.what_if.grade}/5` : "not graded";
        lines.push(`    ID: ${s.id.slice(0, 16)}... | Grade: ${grade}`);
        lines.push("");
      }
      return text(lines.join("\n"));
    } catch (e: any) { return text("Error: " + e.message); }
  },
});

// ── Strategist-only: consult_strategist_lessons ──────────────────────────

export const consultStrategistLessonsTool = defineTool({
  name: "consult_strategist_lessons",
  label: "Consult Strategist Lessons",
  description: "Read the strategist\'s own lessons from past retrospectives. These lessons cover: signal source quality, strategy x regime fit, catalyst assessment, and conviction scoring. Updated daily after market close. Use this at the start of each session to orient yourself on what patterns have been working or failing.",
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const store = requireStrategies();
      const lessons = store.getStrategistLessons(true);
      if (lessons.length === 0) {
        return text("No strategist lessons yet. They accumulate after each daily retrospective.");
      }
      const lines = ["=== STRATEGIST LESSONS (from past retrospectives) ===", ""];
      for (const l of lessons) {
        lines.push(`[${l.category}] (w: ${l.weight.toFixed(2)}, reinforced: ${l.reinforcementCount}x)`);
        lines.push(`  ${l.insight}`);
        if (l.context) lines.push(`  Context: ${l.context}`);
        lines.push(`  Reinforced: ${l.lastReinforcedAt.slice(0, 10)}`);
        lines.push("");
      }
      lines.push("Use these lessons to improve your hypothesis formation and signal assessment.");
      return text(lines.join("\n"));
    } catch (e: any) { return text("Error: " + e.message); }
  },
});

// ═══════════════════════════════════════════════════════════════════════════

export const fetchMarketDataTool = _fmd;
export const fetchNewsTool = _fn;
export const fetchAllNewsTool = _fan;
export const fetchEdgarFilingsTool = _fef;
export const scanRelativeVolumeTool = _srv;
export const scanPreMarketGapsTool = _spg;
export const scanRangeBreaksTool = _srb;
export const scanRedditTool = _sr;
export const discoverOpportunitiesTool = _do;
export const searchSignalsTool = _ss;
export const describeDatasetsTool = _dd;

// ── Strategist-only: consult_memory (read-only) ───────────────────────────

export const consultMemoryTool = defineTool({
  name: "consult_memory", label: "Consult Memory",
  description: "Search accumulated trade history and lessons for similar past setups. Read-only.",
  parameters: Type.Object({
    vix: Type.Optional(NumStr), regime: Type.Optional(Type.String()),
    confidence: Type.Optional(NumStr), impactScore: Type.Optional(NumStr),
  }),
  execute: async (_id: string, params: any) => {
    const state = requireState();
    const fv = state.buildLessonFeatureVector({
      vix: params.vix !== undefined ? coerceNumber(params.vix, 18) : 18,
      regime: params.regime ?? "unknown",
      confidence: params.confidence !== undefined ? coerceNumber(params.confidence, 0.5) : 0.5,
      impactScore: params.impactScore !== undefined ? coerceNumber(params.impactScore, 0) : 0,
      notional: 50,
    });
    const similar = state.findSimilarTrades(fv, 5);
    const lessons = state.findRelevantLessons(fv, 3);
    const lines: string[] = ["=== MEMORY CONSULTATION ==="];
    if (similar.length > 0) {
      lines.push("Similar trades:");
      for (const s of similar) lines.push("  " + s.symbol + " " + (s.outcome === "win" ? "WIN" : "LOSS") + " (" + s.pnlPct.toFixed(1) + "%) sim: " + (s.similarity * 100).toFixed(0) + "%");
    } else { lines.push("No similar trades."); }
    if (lessons.length > 0) {
      lines.push("Lessons:");
      for (const l of lessons) lines.push("  [" + l.category + "] " + l.insight.slice(0, 150));
    }
    return text(lines.join("\n"));
  },
});

// ── Strategist-only: technical indicator tools ───────────────────────────

const _storeForTech = getSignalStore;

/**
 * Query technical indicators for tickers matching specific setups.
 * The strategist can filter by RSI extremes, Bollinger Band breaks,
 * EMA alignment, consecutive candle streaks, and SMA position.
 * Returns the latest indicators per symbol.
 */
export const queryTechnicalIndicatorsTool = defineTool({
  name: "query_technical_indicators",
  label: "Query Technical Indicators",
  description:
    "Query the latest technical indicators for tickers matching specific setups. " +
    "Filters: minRsi/maxRsi (oversold <30, overbought >70), " +
    "minConsecutiveUp/minConsecutiveDown (streak length), " +
    "aboveBollingerUpper/belowBollingerLower (Bollinger Band breaks), " +
    "emaBullishAlignment/emaBearishAlignment (EMA 8/21/50 alignment), " +
    "aboveSma50/belowSma50 (price vs SMA-50). " +
    "Returns: symbol, RSI, EMA 8/21/50, SMA 20/50/200, Bollinger %B, ATR, streak counts, timestamp.",
  parameters: Type.Object({
    minRsi: Type.Optional(NumStr),
    maxRsi: Type.Optional(NumStr),
    minConsecutiveUp: Type.Optional(NumStr),
    minConsecutiveDown: Type.Optional(NumStr),
    aboveBollingerUpper: Type.Optional(Type.Boolean()),
    belowBollingerLower: Type.Optional(Type.Boolean()),
    emaBullishAlignment: Type.Optional(Type.Boolean()),
    emaBearishAlignment: Type.Optional(Type.Boolean()),
    aboveSma50: Type.Optional(Type.Boolean()),
    belowSma50: Type.Optional(Type.Boolean()),
    limit: Type.Optional(NumStr),
  }),
  execute: async (_id: string, params: any) => {
    try {
      const store = _storeForTech();
      if (!store) return text("Research DB not available.");

      const results = store.queryTechnicalIndicators({
        minRsi: params.minRsi !== undefined ? coerceNumber(params.minRsi, 0) : undefined,
        maxRsi: params.maxRsi !== undefined ? coerceNumber(params.maxRsi, 100) : undefined,
        minConsecutiveUp: params.minConsecutiveUp !== undefined ? coerceNumber(params.minConsecutiveUp, 0) : undefined,
        minConsecutiveDown: params.minConsecutiveDown !== undefined ? coerceNumber(params.minConsecutiveDown, 0) : undefined,
        aboveBollingerUpper: params.aboveBollingerUpper,
        belowBollingerLower: params.belowBollingerLower,
        emaBullishAlignment: params.emaBullishAlignment,
        emaBearishAlignment: params.emaBearishAlignment,
        aboveSma50: params.aboveSma50,
        belowSma50: params.belowSma50,
        limit: params.limit !== undefined ? coerceNumber(params.limit, 50) : 50,
      });

      if (!results || results.length === 0) {
        return text("No tickers match the specified technical criteria.");
      }

      const lines = [
        `=== TECHNICAL INDICATORS (${results.length} tickers) ===`,
        "",
      ];

      for (const r of results) {
        const rsi = r.rsi_14 !== null ? Number(r.rsi_14).toFixed(1) : "N/A";
        const bb = r.bollinger_band_pct !== null ? Number(r.bollinger_band_pct).toFixed(2) : "N/A";
        const emaAlign = Number(r.ema_8_above_ema_21) && Number(r.ema_21_above_ema_50) ? "↑↑" : !Number(r.ema_8_above_ema_21) && !Number(r.ema_21_above_ema_50) ? "↓↓" : "→";
        const streak = Number(r.consecutive_up) > 0 ? `${r.consecutive_up}↑` : Number(r.consecutive_down) > 0 ? `${r.consecutive_down}↓` : "0";

        lines.push(`  ${String(r.symbol)}`);
        lines.push(`    RSI: ${rsi} | Bollinger %B: ${bb} | Streak: ${streak} | EMA: ${emaAlign}`);
        lines.push(`    SMA-50: ${r.sma_50 !== null ? Number(r.sma_50).toFixed(2) : "N/A"} ${Number(r.close_above_sma_50) ? "(above)" : "(below)"}`);
        lines.push(`    Date: ${r.timestamp}`);
        lines.push("");
      }

      return text(lines.join("\n"));
    } catch (e: any) {
      return text("Error querying technical indicators: " + e.message);
    }
  },
});

/**
 * Get the latest technical indicators for a single ticker.
 * Simpler than query_technical_indicators — just returns the latest values.
 */
export const getTickerTechnicalsTool = defineTool({
  name: "get_ticker_technicals",
  label: "Get Ticker Technicals",
  description:
    "Get the latest technical indicators for a single ticker. " +
    "Returns: RSI(14), EMA(8/21/50), SMA(20/50/200), MACD, ATR(14), " +
    "Bollinger Bands with %B, consecutive candle streak.",
  parameters: Type.Object({
    symbol: Type.String({ description: "Ticker symbol" }),
  }),
  execute: async (_id: string, params: any) => {
    try {
      const store = _storeForTech();
      if (!store) return text("Research DB not available.");

      const result = store.getLatestTechnicalIndicators(params.symbol.toUpperCase());
      if (!result) {
        return text(`No technical indicators found for ${params.symbol.toUpperCase()}. The research engine may not have computed them yet (it runs every ~2 minutes).`);
      }

      const r = result;
      const lines = [
        `=== TECHNICAL INDICATORS: ${String(r.symbol)} ===`,
        `Date: ${r.timestamp}`,
        "",
        `Momentum:`,
        `  RSI(14): ${r.rsi_14 !== null ? Number(r.rsi_14).toFixed(1) : "N/A"}`,
        `  MACD: ${r.macd_line !== null ? Number(r.macd_line).toFixed(4) : "N/A"} | Signal: ${r.macd_signal !== null ? Number(r.macd_signal).toFixed(4) : "N/A"} | Hist: ${r.macd_histogram !== null ? Number(r.macd_histogram).toFixed(4) : "N/A"}`,
        "",
        `Trend:`,
        `  EMA(8): ${r.ema_8 !== null ? Number(r.ema_8).toFixed(2) : "N/A"}`,
        `  EMA(21): ${r.ema_21 !== null ? Number(r.ema_21).toFixed(2) : "N/A"}`,
        `  EMA(50): ${r.ema_50 !== null ? Number(r.ema_50).toFixed(2) : "N/A"}`,
        `  SMA(20): ${r.sma_20 !== null ? Number(r.sma_20).toFixed(2) : "N/A"}`,
        `  SMA(50): ${r.sma_50 !== null ? Number(r.sma_50).toFixed(2) : "N/A"}`,
        `  SMA(200): ${r.sma_200 !== null ? Number(r.sma_200).toFixed(2) : "N/A"}`,
        `  EMA Alignment: ${Number(r.ema_8_above_ema_21) && Number(r.ema_21_above_ema_50) ? "Bullish (8>21>50)" : !Number(r.ema_8_above_ema_21) && !Number(r.ema_21_above_ema_50) ? "Bearish (8<21<50)" : "Mixed"}`,
        `  Price vs SMA-50: ${Number(r.close_above_sma_50) ? "Above" : "Below"}`,
        "",
        `Volatility:`,
        `  ATR(14): ${r.atr_14 !== null ? Number(r.atr_14).toFixed(4) : "N/A"}`,
        `  Bollinger %B: ${r.bollinger_band_pct !== null ? Number(r.bollinger_band_pct).toFixed(2) : "N/A"}`,
        "",
        `Structure:`,
        `  Consecutive candles: ${Number(r.consecutive_up) > 0 ? `${r.consecutive_up} green` : Number(r.consecutive_down) > 0 ? `${r.consecutive_down} red` : "0"}`,
      ];

      return text(lines.join("\n"));
    } catch (e: any) {
      return text("Error fetching technicals: " + e.message);
    }
  },
});

// ── Strategist-only: sector / macro tools ─────────────────────────────────

import { getSignalStore } from "../research/index.js";

export const searchSectorSignalsTool = defineTool({
  name: "search_sector_signals", label: "Search Sector Signals",
  description: "Query sector-level, macro-economic, and political/regulatory signals.",
  parameters: Type.Object({
    since_minutes: Type.Optional(NumStr),
    sources: Type.Optional(Type.Array(Type.String())),
  }),
  execute: async (_id: string, params: any) => {
    const store = getSignalStore();
    if (!store) return text("Research DB not available.");
    const results = store.getMacroEvents(
      params.sources?.join(",") ?? undefined,
      coerceNumber(params.since_minutes, 1440)
    );
    if (!results || results.length === 0) return text("No sector signals found.");
    const lines = ["SECTOR/MACRO SIGNALS:"];
    for (const r of results) {
      lines.push("  " + (r.event_type ?? "?"));
    }
    return text(lines.join("\n"));
  },
});

export const getMacroCalendarTool = defineTool({
  name: "get_macro_calendar", label: "Get Macro Calendar",
  description: "View upcoming macro-economic events (CPI, FOMC, NFP, PPI) with impact levels.",
  parameters: Type.Object({ days_ahead: Type.Optional(NumStr) }),
  execute: async (_id: string, params: any) => {
    const store = getSignalStore();
    if (!store) return text("Research DB not available.");
    const events = store.getMacroEvents("macro", coerceNumber(params.days_ahead, 14) * 1440);
    if (!events || events.length === 0) return text("No upcoming macro events.");
    const lines = ["UPCOMING MACRO EVENTS:"];
    for (const e of events) {
      const details = typeof e.details === "string" ? JSON.parse(e.details) : (e.details ?? {});
      const impact = (details as any).impact ?? "medium";
      lines.push("  " + (impact === "high" ? "HIGH" : impact === "medium" ? "MED" : "LOW") + " " + (e.event_type ?? "?"));
    }
    return text(lines.join("\n"));
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY MANAGEMENT TOOLS (strategist-only)
// ═══════════════════════════════════════════════════════════════════════════

export const createStrategyTool = defineTool({
  name: "create_strategy", label: "Create Strategy",
  description: "Store a new trading strategy with thesis, confidence, and lifecycle state.",
  parameters: Type.Object({
    ticker: Type.String(),
    strategy_type: Type.String(),
    direction: Type.Optional(Type.String()),
    thesis: Type.String(),
    catalyst: Type.Optional(Type.String()),
    timeframe: Type.Optional(Type.String()),
    confidence: Type.Optional(NumStr),
    rationale: Type.Optional(Type.String()),
    key_signals: Type.Optional(Type.Array(Type.String())),
    risk_factors: Type.Optional(Type.Array(Type.String())),
    conviction: Type.Optional(Type.String()),
    entry_conditions: Type.Optional(Type.String()),
    exit_conditions: Type.Optional(Type.String()),
    state: Type.Optional(Type.String()),
  }),
  execute: async (_id: string, params: any) => {
    try {
      const s = requireStrategies().create({
        ticker: params.ticker.toUpperCase(),
        strategy_type: params.strategy_type as StrategyType,
        direction: (params.direction as "long" | "short") ?? "long",
        thesis: params.thesis,
        catalyst: params.catalyst ?? null,
        timeframe: params.timeframe ?? null,
        confidence: params.confidence !== undefined ? coerceNumber(params.confidence, 0.1) : 0.1,
        rationale: params.rationale ?? "",
        key_signals: params.key_signals ?? [],
        risk_factors: params.risk_factors ?? [],
        conviction: params.conviction ?? "low",
        entry_conditions: params.entry_conditions ?? null,
        exit_conditions: params.exit_conditions ?? null,
        state: params.state ?? "anticipated",
      });
      return text("Created: " + s.id.slice(0, 16) + " (" + s.ticker + " " + s.strategy_type + " " + s.state + " @" + (s.confidence * 100).toFixed(0) + "%)");
    } catch (e: any) { return text("Error: " + e.message); }
  },
});

export const updateStrategyTool = defineTool({
  name: "update_strategy", label: "Update Strategy",
  description: "Update an existing strategy's state, confidence, thesis, or other fields.",
  parameters: Type.Object({
    strategy_id: Type.String(),
    state: Type.Optional(Type.String()),
    confidence: Type.Optional(NumStr),
    thesis: Type.Optional(Type.String()),
    catalyst: Type.Optional(Type.String()),
    timeframe: Type.Optional(Type.String()),
    rationale: Type.Optional(Type.String()),
    key_signals: Type.Optional(Type.Array(Type.String())),
    risk_factors: Type.Optional(Type.Array(Type.String())),
    conviction: Type.Optional(Type.String()),
    entry_conditions: Type.Optional(Type.String()),
    exit_conditions: Type.Optional(Type.String()),
  }),
  execute: async (_id: string, params: any) => {
    try {
      const update: any = {};
      if (params.state !== undefined) update.state = params.state;
      if (params.confidence !== undefined) update.confidence = coerceNumber(params.confidence, 0.5);
      if (params.conviction !== undefined) update.conviction = params.conviction;
      if (params.thesis !== undefined) update.thesis = params.thesis;
      if (params.catalyst !== undefined) update.catalyst = params.catalyst;
      if (params.timeframe !== undefined) update.timeframe = params.timeframe;
      if (params.rationale !== undefined) update.rationale = params.rationale;
      if (params.key_signals !== undefined) update.key_signals = params.key_signals;
      if (params.risk_factors !== undefined) update.risk_factors = params.risk_factors;
      if (params.entry_conditions !== undefined) update.entry_conditions = params.entry_conditions;
      if (params.exit_conditions !== undefined) update.exit_conditions = params.exit_conditions;
      const result = requireStrategies().update(params.strategy_id, update);
      if (!result) return text("Strategy not found: " + params.strategy_id);
      return text("Updated: " + result.ticker + " -> " + result.state + " @" + (result.confidence * 100).toFixed(0) + "%");
    } catch (e: any) { return text("Error: " + e.message); }
  },
});

export const archiveStrategyTool = defineTool({
  name: "archive_strategy", label: "Archive Strategy",
  description: "Mark a strategy as stale (no new signals) or failed (thesis invalidated).",
  parameters: Type.Object({
    strategy_id: Type.String(),
    reason: Type.String({ description: "stale or failed" }),
    note: Type.Optional(Type.String()),
  }),
  execute: async (_id: string, params: any) => {
    try {
      const result = requireStrategies().archive(params.strategy_id, params.reason, params.note);
      if (!result) return text("Strategy not found: " + params.strategy_id);
      return text("Archived: " + result.ticker + " -> " + result.state);
    } catch (e: any) { return text("Error: " + e.message); }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// ALL STRATEGIST TOOLS — export for registration
// ═══════════════════════════════════════════════════════════════════════════

export const allStrategistTools = [
  fetchMarketDataTool, fetchNewsTool, fetchAllNewsTool, fetchEdgarFilingsTool,
  scanRelativeVolumeTool, scanPreMarketGapsTool, scanRangeBreaksTool,
  scanRedditTool, discoverOpportunitiesTool, searchSignalsTool, describeDatasetsTool,
  searchSectorSignalsTool, getMacroCalendarTool, consultMemoryTool, consultStrategistLessonsTool, listStrategiesTool,
  queryTechnicalIndicatorsTool, getTickerTechnicalsTool,
  createStrategyTool, updateStrategyTool, archiveStrategyTool,
];
