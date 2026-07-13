/**
 * Ingestion pipeline — wires all data sources to the Research DB.
 *
 * Every data source calls SignalStore.recordSignal() after fetching its data.
 * Deterministic, fire-and-forget, decoupled from the agent and trading hours.
 *
 * This module also manages the independent research timer that runs 24/7.
 */

import { SignalStore } from "./db.js";
import { getConfig } from "../config.js";
import { scanYahooMarketMovers } from "../ingestion/discovery.js";
import { fetchAllNews } from "../ingestion/expanded-news.js";
import { fetchEdgarFilings, scoreFiling } from "../ingestion/edgar.js";
import { scanRedditMentions } from "../ingestion/social.js";
import { scanRelativeVolume, scanPreMarketGaps, scanRangeBreaks, clearPriceCache } from "../ingestion/scanner.js";
import { getDailyBars } from "../execution/alpaca.js";
import { computeIndicators, generateTechnicalSignals } from "../analysis/technicals.js";
import { getActiveWatchlist } from "../ingestion/discovery.js";
import { refreshFundamentals } from "./fundamentals.js";
import { ingestMacroAndSector } from "./macro.js";

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

let _store: SignalStore | null = null;
let _timerId: ReturnType<typeof setInterval> | null = null;
let _cycleCount = 0;

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC TICKER SET — no static watchlist
//
// Each research tick, we derive which tickers to scan from the research DB
// itself. Broad-market screeners (Yahoo movers, Alpaca news, EDGAR with
// high-impact items) discover tickers unconditionally. Those tickers then
// get picked up by per-ticker scans (volume, gaps, range breaks, Reddit)
// on subsequent cycles.
//
// This creates a self-reinforcing loop:
//   Broad discovery → tickers in DB → per-ticker analysis → more signals
//
// Core seed tickers provide baseline coverage so we never go "blind".
// ═══════════════════════════════════════════════════════════════════════════

const MAX_SCAN_TICKERS = 40; // Keep under Alpaca free tier rate limits (~200 req/min)

/**
 * Build the dynamic ticker set for per-ticker scans.
 * Sources:
 *   1. Core seed tickers (always included for baseline)
 *   2. Tickers with signals in the last 7 days (self-reinforcing discovery)
 */
function getScanTickers(): string[] {
  const tickers = new Set<string>();

  // Core seed tickers — broad market coverage baseline
  const CORE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "TSLA"];
  for (const t of CORE) tickers.add(t);

  // Recent tickers from research DB — self-reinforcing discovery loop
  try {
    const store = getSignalStore();
    const recent = store._execSql(
      `SELECT DISTINCT ticker FROM signals WHERE timestamp >= datetime('now', '-7 days') ORDER BY timestamp DESC LIMIT ?`,
      [MAX_SCAN_TICKERS]
    );
    for (const row of recent) {
      if (row.ticker && typeof row.ticker === 'string' && String(row.ticker) !== 'UNKNOWN') {
        tickers.add(String(row.ticker));
      }
    }
  } catch {}

  return Array.from(tickers).slice(0, MAX_SCAN_TICKERS);
}

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH MONITORING — Track which sources succeed/fail
// ═══════════════════════════════════════════════════════════════════════════

interface SourceHealth {
  name: string;
  successes: number;
  failures: number;
  lastSuccess: number | null;
  lastFailure: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  enabled: boolean;
}

const _sourceHealth: Record<string, SourceHealth> = {
  yahoo_mover: { name: "Yahoo Market Movers", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  alpaca_news: { name: "Alpaca News", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  edgar: { name: "SEC EDGAR", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  reddit: { name: "Reddit Mentions", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  volume_spike: { name: "Volume Scanner", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  gap: { name: "Pre-Market Gaps", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  range_break: { name: "Range Breaks", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  macro_sector: { name: "Macro/Sector", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  fundamentals: { name: "Fundamentals", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
  technicals: { name: "Technical Scans", successes: 0, failures: 0, lastSuccess: null, lastFailure: null, lastError: null, consecutiveFailures: 0, enabled: true },
};

function recordSourceSuccess(source: string): void {
  const h = _sourceHealth[source];
  if (!h) return;
  h.successes++;
  h.lastSuccess = Date.now();
  h.consecutiveFailures = 0;
}

function recordSourceFailure(source: string, error: string): void {
  const h = _sourceHealth[source];
  if (!h) return;
  h.failures++;
  h.lastFailure = Date.now();
  h.lastError = error.slice(0, 200);
  h.consecutiveFailures++;

  // Alert on consecutive failures
  if (h.consecutiveFailures === 5) {
    console.warn(`[HEALTH] ⚠️  ${h.name} has failed ${h.consecutiveFailures} times consecutively. Last: ${error.slice(0, 100)}`);
  }
  if (h.consecutiveFailures === 20) {
    console.warn(`[HEALTH] 🔴 ${h.name} has failed ${h.consecutiveFailures} times. Disabling temporarily.`);
    h.enabled = false;
  }
}

export function getSignalStore(): SignalStore {
  if (!_store) throw new Error("SignalStore not initialized. Call initResearch() first.");
  return _store;
}

// ═══════════════════════════════════════════════════════════════════════════
// NORMALIZATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify news headline direction based on sentiment keywords.
 * Simple heuristic — agent can override via reasoning.
 */
function classifyNewsDirection(headline: string, summary: string): number {
  const text = `${headline} ${summary}`.toLowerCase();
  const positives = ["beat", "surge", "upgrade", "buy", "positive", "growth", "record", "profit",
    "partnership", "acquisition", "approve", "launch", "exceed", "raised guidance"];
  const negatives = ["miss", "drop", "downgrade", "sell", "negative", "loss", "decline", "cut",
    "layoff", "lawsuit", "investigation", "recall", "delay", "suspend", "warning"];

  let score = 0;
  for (const w of positives) { if (text.includes(w)) score++; }
  for (const w of negatives) { if (text.includes(w)) score--; }
  return Math.max(-1, Math.min(1, score / 3));
}

/**
 * Classify EDGAR filing type as bullish, bearish, or neutral.
 */
function classifyEdgarDirection(items: string[]): number {
  let direction = 0;
  if (items.some((i) => i.includes("1.01"))) direction += 0.5;   // Material agreement (usually positive)
  if (items.some((i) => i.includes("2.01"))) direction += 0.5;   // Acquisition (neutral to positive)
  if (items.some((i) => i.includes("2.02"))) direction += 0.3;   // Financial results (neutral)
  if (items.some((i) => i.includes("5.02"))) direction -= 0.5;   // Officer departure (usually negative)
  return Math.max(-1, Math.min(1, direction));
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA SOURCE WIRES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wire Yahoo market movers (gainers/losers/trending).
 */
async function ingestYahooMovers(store: SignalStore): Promise<void> {
  try {
    const movers = await scanYahooMarketMovers(50);
    const signals: Array<Parameters<typeof store.recordSignals>[0][number]> = [];

    for (const g of movers.gainers) {
      signals.push({
        ticker: g.symbol,
        source: "yahoo_mover",
        score: Math.min(1.0, Math.abs(g.changePct) / 50),
        direction: g.changePct > 0 ? 1 : -1,
        payload: { type: "gainer", changePct: g.changePct, price: g.price },
      });
    }

    for (const l of movers.losers) {
      signals.push({
        ticker: l.symbol,
        source: "yahoo_mover",
        score: Math.min(1.0, Math.abs(l.changePct) / 50),
        direction: -1,
        payload: { type: "loser", changePct: l.changePct, price: l.price },
      });
    }

    for (const t of movers.trending) {
      if (!signals.some((s) => s.ticker === t.symbol)) {
        signals.push({
          ticker: t.symbol,
          source: "yahoo_mover",
          score: 0.4,
          direction: 0,
          payload: { type: "trending" },
        });
      }
    }

    if (signals.length > 0) {
      store.recordSignals(signals);
    }
  } catch (e: any) {
    console.warn("[RESEARCH] Yahoo movers ingest failed:", e.message);
  }
}

/**
 * Wire Alpaca news headlines.
 */
async function ingestAlpacaNews(store: SignalStore): Promise<void> {
  try {
    const news = await fetchAllNews(20);
    const signals: Array<Parameters<typeof store.recordSignals>[0][number]> = [];

    for (const item of news) {
      if (item.symbols.length === 0) continue;
      const direction = classifyNewsDirection(item.headline, item.summary);
      const score = 0.5 + Math.abs(direction) * 0.3; // 0.5-0.8 depending on sentiment strength

      for (const sym of item.symbols) {
        signals.push({
          ticker: sym,
          source: "alpaca_news",
          score: Math.min(1.0, score),
          direction,
          payload: { headline: item.headline.slice(0, 200), summary: item.summary.slice(0, 300), source: item.source },
        });
      }
    }

    if (signals.length > 0) {
      store.recordSignals(signals);
    }
  } catch (e: any) {
    console.warn("[RESEARCH] Alpaca news ingest failed:", e.message);
  }
}

/**
 * Wire EDGAR 8-K filings.
 */
async function ingestEdgarFilings(store: SignalStore): Promise<void> {
  try {
    const tickers = getScanTickers();
    const filings = await fetchEdgarFilings(tickers);
    const signals: Array<Parameters<typeof store.recordSignals>[0][number]> = [];

    for (const f of filings) {
      const { score } = scoreFiling(f);
      const direction = classifyEdgarDirection(f.items);
      const ticker = f.ticker || "UNKNOWN";

      signals.push({
        ticker,
        source: "edgar",
        score: score / 10,
        direction,
        payload: {
          companyName: f.companyName,
          items: f.items,
          filingDate: f.filingDate,
          cik: f.cik,
        },
      });

      // Also record as corporate event
      store.recordCorporateEvent({
        ticker,
        eventDate: f.filingDate,
        eventType: "sec_filing",
        impact: score / 10,
        details: { items: f.items, companyName: f.companyName },
        sourceUrl: f.link,
      });
    }

    if (signals.length > 0) {
      store.recordSignals(signals);
    }
  } catch (e: any) {
    console.warn("[RESEARCH] EDGAR ingest failed:", e.message);
  }
}

/**
 * Wire Reddit mention velocity.
 */
async function ingestRedditMentions(store: SignalStore): Promise<void> {
  try {
    const scans = await scanRedditMentions(getScanTickers());
    const signals: Array<Parameters<typeof store.recordSignals>[0][number]> = [];

    for (const s of scans) {
      signals.push({
        ticker: s.symbol,
        source: "reddit",
        score: Math.min(1.0, s.velocity / 5),
        direction: 0,
        payload: { velocity: s.velocity, mentionsLastHour: s.mentionsLastHour, totalMentions: s.totalMentions },
      });
    }

    if (signals.length > 0) {
      store.recordSignals(signals);
    }
  } catch (e: any) {
    console.warn("[RESEARCH] Reddit ingest failed:", e.message);
  }
}

/**
 * Wire volume standouts.
 */
async function ingestVolumeScans(store: SignalStore): Promise<void> {
  try {
    const scans = await scanRelativeVolume(getScanTickers());
    const signals: Array<Parameters<typeof store.recordSignals>[0][number]> = [];

    for (const s of scans) {
      signals.push({
        ticker: s.symbol,
        source: "volume_spike",
        score: Math.min(1.0, s.relativeVolume / 10),
        direction: s.changePct > 0 ? 1 : -1,
        payload: { relativeVolume: s.relativeVolume, changePct: s.changePct, price: s.currentPrice, regime: s.regime },
      });
    }

    if (signals.length > 0) {
      store.recordSignals(signals);
    }
  } catch (e: any) {
    console.warn("[RESEARCH] Volume scan ingest failed:", e.message);
  }
}

/**
 * Wire pre-market gaps.
 */
async function ingestPreMarketGaps(store: SignalStore): Promise<void> {
  try {
    const gaps = await scanPreMarketGaps(getScanTickers());
    const signals: Array<Parameters<typeof store.recordSignals>[0][number]> = [];

    for (const g of gaps) {
      signals.push({
        ticker: g.symbol,
        source: "gap",
        score: Math.min(1.0, Math.abs(g.gapPct) / 10),
        direction: g.gapPct > 0 ? 1 : -1,
        payload: { gapPct: g.gapPct, priorClose: g.priorClose, price: g.preMarketPrice },
      });
    }

    if (signals.length > 0) {
      store.recordSignals(signals);
    }
  } catch (e: any) {
    console.warn("[RESEARCH] Pre-market gap ingest failed:", e.message);
  }
}

/**
 * Wire range break scans.
 */
async function ingestRangeBreaks(store: SignalStore): Promise<void> {
  try {
    const breaks = await scanRangeBreaks(getScanTickers());
    const signals: Array<Parameters<typeof store.recordSignals>[0][number]> = [];

    for (const b of breaks) {
      const nearTop = b.positionInRange > 0.9;
      signals.push({
        ticker: b.symbol,
        source: "range_break",
        score: Math.min(1.0, Math.abs(b.positionInRange - 0.5) * 3),
        direction: nearTop ? 1 : -1,
        payload: { positionInRange: b.positionInRange, price: b.price, high20d: b.high20d, low20d: b.low20d },
      });
    }

    if (signals.length > 0) {
      store.recordSignals(signals);
    }
  } catch (e: any) {
    console.warn("[RESEARCH] Range break ingest failed:", e.message);
  }
}

/**
 * Wire technical indicator scans.
 * Fetches daily bars for the scan tickers, computes indicators (RSI, EMA, etc.),
 * stores them in the technical_indicators table, and records signals for
 * interesting setups (oversold/overbought, crossovers, streaks).
 */
async function ingestTechnicalScans(store: SignalStore): Promise<void> {
  try {
    const tickers = getScanTickers();
    const signals: Array<Parameters<typeof store.recordSignals>[0][number]> = [];

    // Process in small batches to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (symbol) => {
          const bars = await getDailyBars(symbol, 60);
          if (bars.length < 10) return; // Need enough data

          const indicators = computeIndicators(symbol, bars);

          // Store indicators in the research DB
          store.upsertTechnicalIndicators(symbol, indicators as unknown as Record<string, unknown>);

          // Generate signals from the indicators
          const techSignals = generateTechnicalSignals(indicators);
          for (const sig of techSignals) {
            signals.push({
              ticker: sig.ticker,
              source: "technicals",
              score: sig.score,
              direction: sig.direction,
              payload: { signalType: sig.signalType, ...sig.payload },
            });
          }
        })
      );
      // Small delay between batches
      if (i + batchSize < tickers.length) await new Promise(r => setTimeout(r, 200));
    }

    if (signals.length > 0) {
      store.recordSignals(signals);
    }
  } catch (e: any) {
    console.warn("[RESEARCH] Technical scan ingest failed:", e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH TIMER — Runs on its own schedule, independent of trading hours/agent
// ═══════════════════════════════════════════════════════════════════════════

const PRUNE_INTERVAL_CYCLES = 60;   // Every 60 ticks (~30 min at 30s poll)
const FUNDAMENTALS_INTERVAL_MS = 24 * 60 * 60_000; // Daily

let _lastFundamentalsTime = 0;

/**
 * One tick of the research loop — fires every `pollIntervalMs`.
 * Fetches ALL data sources and writes to the signal store.
 */
/**
 * Wrap a data source ingest function with health tracking.
 * Records success/failure, auto-disables after 20 consecutive failures.
 */
function trackedIngest(source: string, fn: (store: SignalStore) => Promise<void>): (store: SignalStore) => Promise<void> {
  return async (store: SignalStore) => {
    const h = _sourceHealth[source];
    if (h && !h.enabled) {
      // Attempt re-enable after 100 cycles (auto-recovery)
      if (_cycleCount % 100 === 0) {
        h.enabled = true;
        console.log(`[HEALTH] 🔄 Re-enabling ${h.name} after ${h.consecutiveFailures} failures`);
      } else {
        return; // Skip disabled sources
      }
    }

    try {
      await fn(store);
      recordSourceSuccess(source);
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      recordSourceFailure(source, msg);
      console.warn(`[RESEARCH] ${source} ingest failed: ${msg.slice(0, 150)}`);
    }
  };
}

async function researchTick(): Promise<void> {
  const store = getSignalStore();
  _cycleCount++;

  // Clear shared price cache so scanners get fresh data
  clearPriceCache();

  // Run broad-market scanners first (no ticker list needed)
  await Promise.allSettled([
    trackedIngest("yahoo_mover", ingestYahooMovers)(store),
    trackedIngest("alpaca_news", ingestAlpacaNews)(store),
    trackedIngest("edgar", ingestEdgarFilings)(store),
    trackedIngest("macro_sector", ingestMacroAndSector)(store),
  ]);

  // Run per-ticker scanners sequentially to share the price cache
  await trackedIngest("reddit", ingestRedditMentions)(store);
  await trackedIngest("volume_spike", ingestVolumeScans)(store);
  await trackedIngest("gap", ingestPreMarketGaps)(store);
  await trackedIngest("range_break", ingestRangeBreaks)(store);

  // Technical indicator scans use daily bars (not cached price), run after price scanners
  await trackedIngest("technicals", ingestTechnicalScans)(store);

  // Log health summary every 10 cycles
  if (_cycleCount % 10 === 0) {
    const health = getResearchHealth();
    const failing = Object.entries(health).filter(([, h]: [string, any]) => !h.ok).map(([k]) => k);
    if (failing.length > 0) {
      console.log(`[HEALTH] 📊 Sources failing: ${failing.join(", ")}`);
    }
  }

  // Prune old data every N cycles
  if (_cycleCount % PRUNE_INTERVAL_CYCLES === 0) {
    const { rawDeleted, hourlyDeleted, dailyDeleted } = store.prune();
    if (rawDeleted + hourlyDeleted + dailyDeleted > 0) {
      console.log(`[RESEARCH] Pruned: ${rawDeleted} raw, ${hourlyDeleted} hourly, ${dailyDeleted} daily`);
    }
  }

  // Refresh fundamentals daily
  const now = Date.now();
  if (now - _lastFundamentalsTime > FUNDAMENTALS_INTERVAL_MS) {
    _lastFundamentalsTime = now;
    try {
      await refreshFundamentals(store, getScanTickers());
      recordSourceSuccess("fundamentals");
      console.log("[RESEARCH] Fundamentals refreshed");
    } catch (e: any) {
      recordSourceFailure("fundamentals", e.message);
      console.warn("[RESEARCH] Fundamentals refresh failed:", e.message);
    }
  }
}

/**
 * Get health report for all research data sources.
 * Useful for debugging or dashboard display.
 */
export function getResearchHealth(): Record<string, { successes: number; failures: number; consecutiveFailures: number; lastError: string | null; enabled: boolean; ok: boolean }> {
  const report: Record<string, any> = {};
  for (const [key, h] of Object.entries(_sourceHealth)) {
    report[key] = {
      successes: h.successes,
      failures: h.failures,
      consecutiveFailures: h.consecutiveFailures,
      lastError: h.lastError,
      enabled: h.enabled,
      ok: h.failures === 0 || (h.successes > 0 && h.consecutiveFailures < 5),
    };
  }
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the research engine.
 * Creates/finds the SQLite DB, starts the independent research timer.
 * Returns the SignalStore instance.
 */
export async function initResearch(dbPath: string, _watchlist?: string[]): Promise<SignalStore> {
  if (_store) {
    console.warn("[RESEARCH] Already initialized. Returning existing store.");
    return _store;
  }

  const store = new SignalStore(dbPath);
  await store.init();
  _store = store;

  const cfg = getConfig();
  const interval = cfg.pollIntervalMs;

  console.log(`[RESEARCH] Database at ${dbPath} — ${store.getTableInfo().length} tables ready`);
  console.log(`[RESEARCH] Timer: every ${(interval / 1000).toFixed(0)}s, prune every ${PRUNE_INTERVAL_CYCLES} ticks`);

  // Start the independent research timer
  _timerId = setInterval(researchTick, interval);

  // Fire immediate first tick
  researchTick().catch((e) => console.warn("[RESEARCH] Initial tick failed:", e.message));

  return store;
}

/**
 * Stop the research timer. Call on shutdown.
 */
export function stopResearch(): void {
  if (_timerId) {
    clearInterval(_timerId);
    _timerId = null;
  }
  if (_store) {
    _store.flush();
  }
}

/**
 * Force a single research tick (useful for testing or manual trigger).
 */
export async function triggerResearchTick(): Promise<void> {
  await researchTick();
}