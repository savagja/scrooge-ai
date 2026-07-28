/**
 * Context Builder — programmatically gathers a multi-source data snapshot
 * every cycle and feeds it to the agent as pre-digested context.
 *
 * This is the "perception layer" done deterministically. The agent receives
 * this context as part of its prompt, then uses tools to dive deeper on
 * whatever it finds interesting.
 *
 * Sources gathered per cycle (two tiers):
 *
 * TIER 1 — Every cycle, fast only (10s timeout, ~3s typical):
 *   1. Market state (VIX, SPY, regime) — cached 5-10 min between cycles
 *   2. Top headlines from Alpaca news (watchlist + discovered tickers, max 5)
 *   3. Watchlist relative volume standouts (max 5 biggest volume spikes)
 *   4. Pre-market gap highlights (max 3)
 *   5. Sector-level movers (Yahoo gainers/losers) — cached 10 min
 *
 * TIER 2 — Cached between cycles (strategist-only data, not for trader):
 *   6. EDGAR filing highlights (max 3) — cached 1 hour
 *   7. Reddit velocity highlights — cached 30 min
 *
 * ROLLING CONTEXT: Each cycle's context is stored in a ring buffer. Every
 * subsequent call compares the latest context to the previous one and generates
 * a "What Changed" section highlighting shifts, trends, and repeat appearances.
 *
 * Design: All tier-1 fetches are parallel with 10s AbortController timeouts.
 * Tier-2 data is refreshed from a simple interval cache. Total time target: < 3s.
 */

import { getVix, getSpyChange } from "../ingestion/market.js";
import { fetchNews } from "../ingestion/news.js";
import { fetchEdgarFilings, scoreFiling } from "../ingestion/edgar.js";
import { scanRelativeVolume } from "../ingestion/scanner.js";
import { scanRedditMentions } from "../ingestion/social.js";
import { scanPreMarketGaps } from "../ingestion/scanner.js";
import { scanYahooMarketMovers } from "../ingestion/discovery.js";
import { PortfolioState } from "../state/portfolio.js";
import type { MarketState } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MarketContext {
  /** Market regime and broad conditions */
  market: {
    timestamp: string;
    vix: number | null;
    spyChangePct: number | null;
    regime: string;
    breadth: string;
  };
  /** Top gainers and losers today (up to 5 each, ticker + change %) */
  sectorMovers: {
    gainers: Array<{ symbol: string; changePct: number; price: number }>;
    losers: Array<{ symbol: string; changePct: number; price: number }>;
  };
  /** Watchlist headlines — condensed (max 5) */
  headlines: Array<{
    symbol: string;
    headline: string;
    source: string;
  }>;
  /** High-impact EDGAR filings (max 3) */
  edgarFilings: Array<{
    ticker: string;
    companyName: string;
    items: string[];
    impactScore: number;
    reason: string;
  }>;
  /** Tickers with unusual volume (max 5) */
  volumeStandouts: Array<{
    symbol: string;
    relativeVolume: number;
    changePct: number;
    price: number;
    regime: string;
  }>;
  /** Reddit mention acceleration (max 3) */
  redditHeat: Array<{
    symbol: string;
    velocity: number;
    mentionsLastHour: number;
  }>;
  /** Pre-market gaps (max 3) */
  preMarketGaps: Array<{
    symbol: string;
    gapPct: number;
    preMarketPrice: number;
  }>;
}

// ─── Simple Interval Cache for Tier-2 (slow/strategist-only) data ────────────

const _cache: Record<string, { value: any; ts: number }> = {};

function getCached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const cached = _cache[key];
  if (cached && Date.now() - cached.ts < ttlMs) {
    return Promise.resolve(cached.value as T);
  }
  return fetcher().then(val => {
    _cache[key] = { value: val, ts: Date.now() };
    return val;
  }).catch(err => {
    // Return stale cache on error, or empty if never cached
    if (cached) return cached.value as T;
    throw err;
  });
}

// ─── AbortController wrapper for fetch timeouts ─────────────────────────────

function fetchWithTimeout(url: string, options: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const timeout = options.timeout ?? 10000;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

// ─── Rolling Context Buffer ──────────────────────────────────────────────────

/**
 * In-memory ring buffer of recent context snapshots.
 * Used to detect shifts, trends, and repeat appearances across cycles.
 * Not persisted to disk (high I/O for no benefit).
 */
const CONTEXT_HISTORY_SIZE = 8; // Keep last 8 cycles (~4 minutes at 30s poll)
let contextHistory: MarketContext[] = [];

/**
 * Push the latest context into the rolling buffer.
 */
export function pushContext(ctx: MarketContext) {
  contextHistory.push(ctx);
  if (contextHistory.length > CONTEXT_HISTORY_SIZE) {
    contextHistory.shift();
  }
}

/**
 * Reset the rolling context buffer (e.g., on market open after overnight briefing).
 */
export function resetContextHistory() {
  contextHistory = [];
}

/**
 * Get the previous cycle's context (if any).
 */
function getPreviousContext(): MarketContext | null {
  return contextHistory.length >= 2
    ? contextHistory[contextHistory.length - 2]
    : null;
}

/**
 * Get the earliest context in the buffer (for comparisons across longer windows).
 */
function getEarliestContext(): MarketContext | null {
  return contextHistory.length > 0 ? contextHistory[0] : null;
}

/**
 * Compare current context vs previous cycle and produce a "What Changed" diff.
 */
function buildContextDiff(current: MarketContext, previous: MarketContext): string {
  const lines: string[] = [];

  // 1. Market regime shift
  if (current.market.regime !== previous.market.regime) {
    lines.push(`🔄 REGIME SHIFT: ${previous.market.regime.toUpperCase()} → ${current.market.regime.toUpperCase()}`);
  }
  if (current.market.vix !== null && previous.market.vix !== null) {
    const vixDiff = current.market.vix - previous.market.vix;
    if (Math.abs(vixDiff) > 1) {
      lines.push(`🌊 VIX moved ${vixDiff > 0 ? "+ " : ""}${vixDiff.toFixed(1)} pts (${previous.market.vix.toFixed(1)} → ${current.market.vix.toFixed(1)})`);
    }
  }

  // 2. Tickers appearing in gainers/losers across multiple cycles
  const prevGainers = new Set(previous.sectorMovers.gainers.map((g) => g.symbol));
  const prevLosers = new Set(previous.sectorMovers.losers.map((l) => l.symbol));
  const repeatGainers = current.sectorMovers.gainers.filter((g) => prevGainers.has(g.symbol));
  const repeatLosers = current.sectorMovers.losers.filter((l) => prevLosers.has(l.symbol));
  if (repeatGainers.length > 0) {
    lines.push(`📈 REPEAT GAINERS: ${repeatGainers.map((g) => `${g.symbol} (${g.changePct > 0 ? "+" : ""}${g.changePct.toFixed(1)}%)`).join(", ")}`);
  }
  if (repeatLosers.length > 0) {
    lines.push(`📉 REPEAT LOSERS: ${repeatLosers.map((l) => `${l.symbol} (${l.changePct.toFixed(1)}%)`).join(", ")}`);
  }

  // 3. New tickers appearing in gainers/losers this cycle (first appearance)
  const priorGainersTotal = new Set(
    contextHistory.slice(0, -1).flatMap((c) => c.sectorMovers.gainers.map((g) => g.symbol))
  );
  const priorLosersTotal = new Set(
    contextHistory.slice(0, -1).flatMap((c) => c.sectorMovers.losers.map((l) => l.symbol))
  );
  const newGainers = current.sectorMovers.gainers.filter((g) => !priorGainersTotal.has(g.symbol));
  const newLosers = current.sectorMovers.losers.filter((l) => !priorLosersTotal.has(l.symbol));
  if (newGainers.length > 0) {
    lines.push(`🆕 NEW GAINERS: ${newGainers.map((g) => `${g.symbol} +${g.changePct.toFixed(1)}%`).join(", ")}`);
  }
  if (newLosers.length > 0) {
    lines.push(`🆕 NEW LOSERS: ${newLosers.map((l) => `${l.symbol} ${l.changePct.toFixed(1)}%`).join(", ")}`);
  }

  // 4. Volume changes
  const prevVolMap = new Map(previous.volumeStandouts.map((v) => [v.symbol, v]));
  for (const v of current.volumeStandouts) {
    const prev = prevVolMap.get(v.symbol);
    if (prev) {
      const volDiff = v.relativeVolume - prev.relativeVolume;
      if (Math.abs(volDiff) > 0.5) {
        lines.push(`📊 VOL ${v.symbol}: ${prev.relativeVolume.toFixed(1)}x → ${v.relativeVolume.toFixed(1)}x ${volDiff > 0 ? "🔥 building" : "📉 fading"}`);
      }
    } else {
      lines.push(`📊 VOL ${v.symbol}: NEW — ${v.relativeVolume.toFixed(1)}x avg vol`);
    }
  }

  // 5. Reddit velocity changes
  const prevRedditMap = new Map(previous.redditHeat.map((r) => [r.symbol, r]));
  for (const r of current.redditHeat) {
    const prev = prevRedditMap.get(r.symbol);
    if (prev) {
      if (r.velocity > prev.velocity * 1.5) {
        lines.push(`💬 REDDIT ${r.symbol}: velocity ${prev.velocity.toFixed(1)}x → ${r.velocity.toFixed(1)}x 🚀`);
      } else if (r.velocity < prev.velocity * 0.5) {
        lines.push(`💬 REDDIT ${r.symbol}: velocity ${prev.velocity.toFixed(1)}x → ${r.velocity.toFixed(1)}x 💤`);
      }
    } else {
      if (r.velocity > 2) {
        lines.push(`💬 REDDIT ${r.symbol}: NEW — ${r.velocity.toFixed(1)}x velocity`);
      }
    }
  }

  // 6. Count how many cycles each ticker has been appearing (persistence signal)
  const appearanceCounts = new Map<string, { gainer: number; loser: number; vol: number }>();
  for (const ctx of contextHistory) {
    for (const g of ctx.sectorMovers.gainers) {
      const entry = appearanceCounts.get(g.symbol) || { gainer: 0, loser: 0, vol: 0 };
      entry.gainer++;
      appearanceCounts.set(g.symbol, entry);
    }
    for (const l of ctx.sectorMovers.losers) {
      const entry = appearanceCounts.get(l.symbol) || { gainer: 0, loser: 0, vol: 0 };
      entry.loser++;
      appearanceCounts.set(l.symbol, entry);
    }
    for (const v of ctx.volumeStandouts) {
      const entry = appearanceCounts.get(v.symbol) || { gainer: 0, loser: 0, vol: 0 };
      entry.vol++;
      appearanceCounts.set(v.symbol, entry);
    }
  }

  // Report tickers appearing 3+ times (persistent interest)
  const persistent = Array.from(appearanceCounts.entries())
    .filter(([_, counts]) => counts.gainer >= 3 || counts.loser >= 3 || counts.vol >= 3)
    .sort((a, b) => Math.max(b[1].gainer, b[1].loser, b[1].vol) - Math.max(a[1].gainer, a[1].loser, a[1].vol));

  if (persistent.length > 0) {
    lines.push(`⏱️  PERSISTENT (${contextHistory.length} cycles tracked):`);
    for (const [sym, counts] of persistent.slice(0, 5)) {
      const parts: string[] = [];
      if (counts.gainer >= 3) parts.push(`${counts.gainer}x gainer`);
      if (counts.loser >= 3) parts.push(`${counts.loser}x loser`);
      if (counts.vol >= 3) parts.push(`${counts.vol}x volume`);
      lines.push(`   ${sym} — ${parts.join(", ")}`);
    }
  }

  return lines.join("\n");
}

// ─── Builder ────────────────────────────────────────────────────────────────

export async function buildMarketContext(
  watchlist: string[],
  state: PortfolioState
): Promise<MarketContext> {
  const startTime = Date.now();

  // ── Helper: add a timeout to any promise ────────────────────────────────
  function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]).catch(() => fallback);
  }

  // ── TIER 1: Fast fetches every cycle (10s timeout) ───────────────────────
  const [vix, spyChange, news, volumeScans, gaps] = await Promise.all([
    withTimeout(getVix(), 10000, null),
    withTimeout(getSpyChange(), 10000, null),
    withTimeout(fetchNews(watchlist, 10), 10000, [] as Awaited<ReturnType<typeof fetchNews>>),
    withTimeout(scanRelativeVolume(watchlist), 10000, [] as Awaited<ReturnType<typeof scanRelativeVolume>>),
    withTimeout(scanPreMarketGaps(watchlist), 10000, [] as Awaited<ReturnType<typeof scanPreMarketGaps>>),
  ]);

  // ── TIER 2: Slow/cached sources (strategist-only data, cached between cycles) ──
  const [edgarEntries, redditScans, yahooMovers] = await Promise.all([
    getCached('edgar', 3600000, () => fetchEdgarFilings(watchlist)),        // 1 hour cache
    getCached('reddit', 1800000, () => scanRedditMentions(watchlist)),      // 30 min cache
    getCached('yahoo_movers', 600000, () => scanYahooMarketMovers(50)),     // 10 min cache
  ]);

  // ── Build each section ────────────────────────────────────────────────────

  // 1. Market state
  let regime = "unknown";
  if (vix !== null) {
    if (vix > 25) regime = "volatile";
    else if (spyChange !== null && spyChange > 0.5) regime = "trending_up";
    else if (spyChange !== null && spyChange < -0.5) regime = "trending_down";
    else if (vix < 18) regime = "chop";
    else regime = "chop";
  }
  const breadth =
    spyChange !== null && Math.abs(spyChange) > 1
      ? "strong"
      : spyChange !== null && Math.abs(spyChange) > 0.5
        ? "neutral"
        : "weak";

  // 2. Sector movers (from Yahoo, top 5 each)
  const gainers = yahooMovers.gainers.slice(0, 5).map((g) => ({
    symbol: g.symbol,
    changePct: Math.round(g.changePct * 100) / 100,
    price: Math.round(g.price * 100) / 100,
  }));
  const losers = yahooMovers.losers.slice(0, 5).map((l) => ({
    symbol: l.symbol,
    changePct: Math.round(l.changePct * 100) / 100,
    price: Math.round(l.price * 100) / 100,
  }));

  // 3. Headlines (condensed, max 5)
  const headlines = news.slice(0, 5).map((n) => ({
    symbol: n.symbol,
    headline: n.headline,
    source: n.source,
  }));

  // 4. EDGAR filings (scored, max 3)
  const scoredEdgar = edgarEntries
    .map((f) => ({ ...f, ...scoreFiling(f) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((f) => ({
      ticker: f.ticker || "unknown",
      companyName: f.companyName,
      items: f.items,
      impactScore: f.score,
      reason: f.reason,
    }));

  // 5. Volume standouts (max 5, sorted by relative volume descending)
  const volumeStandouts = volumeScans
    .filter((s) => s.regime !== "quiet")
    .sort((a, b) => b.relativeVolume - a.relativeVolume)
    .slice(0, 5)
    .map((s) => ({
      symbol: s.symbol,
      relativeVolume: Math.round(s.relativeVolume * 10) / 10,
      changePct: Math.round(s.changePct * 100) / 100,
      price: Math.round(s.currentPrice * 100) / 100,
      regime: s.regime,
    }));

  // 6. Reddit heat (max 3, sorted by velocity)
  const redditHeat = redditScans
    .filter((s) => s.velocity > 1.5 || s.mentionsLastHour >= 3)
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, 3)
    .map((s) => ({
      symbol: s.symbol,
      velocity: Math.round(s.velocity * 100) / 100,
      mentionsLastHour: s.mentionsLastHour,
    }));

  // 7. Pre-market gaps (max 3, sorted by magnitude)
  const preMarketGaps = (gaps as any[])
    .sort((a: any, b: any) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
    .slice(0, 3)
    .map((g: any) => ({
      symbol: g.symbol,
      gapPct: Math.round(g.gapPct * 100) / 100,
      preMarketPrice: Math.round(g.preMarketPrice * 100) / 100,
    }));

  const elapsed = Date.now() - startTime;
  if (elapsed > 3000) {
    console.warn(`[CONTEXT] Built in ${elapsed}ms (slow — consider reducing sources)`);
  }

  const ctx: MarketContext = {
    market: {
      timestamp: new Date().toISOString(),
      vix,
      spyChangePct: Math.round((spyChange ?? 0) * 100) / 100,
      regime,
      breadth,
    },
    sectorMovers: { gainers, losers },
    headlines,
    edgarFilings: scoredEdgar,
    volumeStandouts,
    redditHeat,
    preMarketGaps,
  };

  // Push into rolling history for diff tracking
  pushContext(ctx);

  return ctx;
}

// ─── Format for Prompt ──────────────────────────────────────────────────────

/**
 * Render the market context into a text block for the perception prompt.
 * Compact, scannable, no fluff.
 */
export function formatContextForPrompt(ctx: MarketContext): string {
  const lines: string[] = [];

  // Market summary (always present)
  const vixLine = ctx.market.vix !== null ? `${ctx.market.vix.toFixed(1)}` : "unavailable";
  const spyLine = ctx.market.spyChangePct !== null ? `${ctx.market.spyChangePct > 0 ? "+" : ""}${ctx.market.spyChangePct.toFixed(2)}%` : "unavailable";
  lines.push(`📊 MARKET: VIX ${vixLine} | SPY ${spyLine} | Regime: ${ctx.market.regime.toUpperCase()} | Breadth: ${ctx.market.breadth}`);

  // Sector movers
  if (ctx.sectorMovers.gainers.length > 0 || ctx.sectorMovers.losers.length > 0) {
    const gainStr = ctx.sectorMovers.gainers.map((g) => `${g.symbol}+${g.changePct.toFixed(1)}%`).join(" ");
    const loseStr = ctx.sectorMovers.losers.map((l) => `${l.symbol}${l.changePct.toFixed(1)}%`).join(" ");
    if (gainStr) lines.push(`📈 GAINERS: ${gainStr}`);
    if (loseStr) lines.push(`📉 LOSERS: ${loseStr}`);
  }

  // Headlines (compact)
  if (ctx.headlines.length > 0) {
    lines.push(`📰 HEADLINES:`);
    for (const h of ctx.headlines) {
      lines.push(`   [${h.symbol}] ${h.headline.slice(0, 120)}`);
    }
  }

  // EDGAR
  if (ctx.edgarFilings.length > 0) {
    lines.push(`📋 EDGAR 8-Ks:`);
    for (const f of ctx.edgarFilings) {
      lines.push(`   [${f.ticker}] ${f.companyName} | Impact: ${f.impactScore}/10 | ${f.reason}`);
    }
  }

  // Volume standouts
  if (ctx.volumeStandouts.length > 0) {
    lines.push(`🔥 VOLUME:`);
    for (const v of ctx.volumeStandouts) {
      lines.push(`   [${v.symbol}] ${v.relativeVolume}x avg vol | ${v.changePct > 0 ? "+" : ""}${v.changePct}% | $${v.price}`);
    }
  }

  // Reddit heat
  if (ctx.redditHeat.length > 0) {
    lines.push(`💬 REDDIT:`);
    for (const r of ctx.redditHeat) {
      lines.push(`   [${r.symbol}] vel: ${r.velocity.toFixed(1)}x | ${r.mentionsLastHour} mentions/hr`);
    }
  }

  // Pre-market gaps
  if (ctx.preMarketGaps.length > 0) {
    lines.push(`🕐 GAPS:`);
    for (const g of ctx.preMarketGaps) {
      lines.push(`   [${g.symbol}] ${g.gapPct > 0 ? "+" : ""}${g.gapPct}% gap @ $${g.preMarketPrice}`);
    }
  }

  return lines.join("\n");
}

// ─── PRE-MARKET BRIEFING ────────────────────────────────────────────────────

/**
 * Build a richer, denser briefing during off-hours for consumption at market open.
 * Same sources as buildMarketContext but with more data since we have more time,
 * plus overnight-specific context (larger time window on news, filings, gaps).
 */
export async function buildPreMarketBriefing(
  watchlist: string[],
  state: PortfolioState
): Promise<string> {
  const startTime = Date.now();

  // Use a wider time window for off-hours — grab more news/filings
  const [vixPromise, spyPromise, newsPromise, edgarPromise, redditPromise, yahooPromise] =
    [getVix(), getSpyChange(), fetchNews(watchlist, 20), fetchEdgarFilings(watchlist), scanRedditMentions(watchlist), scanYahooMarketMovers(50)];

  const vix = await vixPromise.catch(() => null);
  const spyChange = await spyPromise.catch(() => null);
  const news = await newsPromise.catch<Awaited<ReturnType<typeof fetchNews>>>(() => []);
  const edgarEntries = await edgarPromise.catch<Awaited<ReturnType<typeof fetchEdgarFilings>>>(() => []);
  const redditScans = await redditPromise.catch<Awaited<ReturnType<typeof scanRedditMentions>>>(() => []);
  const yahooMovers = await yahooPromise.catch<Awaited<ReturnType<typeof scanYahooMarketMovers>>>(() => ({
    mostActive: [], gainers: [], losers: [], trending: [],
  }));

  const lines: string[] = [];
  lines.push(`═══ PRE-MARKET BRIEFING (built at ${Date.now()}) ═══`);
  lines.push("");

  // Market state
  let regime = "unknown";
  if (vix !== null) {
    if (vix > 25) regime = "volatile";
    else if (spyChange !== null && spyChange > 0.5) regime = "trending_up";
    else if (spyChange !== null && spyChange < -0.5) regime = "trending_down";
    else if (vix < 18) regime = "chop";
    else regime = "chop";
  }
  const vixLine = vix !== null ? `${vix.toFixed(1)}` : "unavailable";
  const spyLine = spyChange !== null ? `${spyChange > 0 ? "+" : ""}${spyChange.toFixed(2)}%` : "unavailable";
  lines.push(`📊 OVERNIGHT MARKET: VIX ${vixLine} | SPY ${spyLine} | Regime: ${regime.toUpperCase()}`);
  lines.push("");

  // EDGAR filings (overnight filings are often pre-market catalysts)
  if (edgarEntries.length > 0) {
    const scored = edgarEntries
      .map((f) => ({ ...f, ...scoreFiling(f) }))
      .sort((a, b) => b.score - a.score);
    lines.push(`📋 OVERNIGHT EDGAR 8-Ks (${scored.length} found):`);
    for (const f of scored.slice(0, 8)) {
      lines.push(`   [${f.ticker || "?"}] ${f.companyName} | Impact: ${f.score}/10 | ${f.reason}`);
    }
    lines.push("");
  }

  // News headlines (wider capture)
  if (news.length > 0) {
    lines.push(`📰 OVERNIGHT HEADLINES:`);
    for (const n of news.slice(0, 10)) {
      lines.push(`   [${n.symbol}] ${n.headline.slice(0, 140)}`);
    }
    lines.push("");
  }

  // Yahoo gainers/losers
  const gainers = yahooMovers.gainers.slice(0, 8);
  const losers = yahooMovers.losers.slice(0, 8);
  if (gainers.length > 0) {
    lines.push(`📈 PRE-MARKET GAINERS:`);
    for (const g of gainers) {
      lines.push(`   ${g.symbol} +${g.changePct.toFixed(1)}% @ $${g.price.toFixed(2)}`);
    }
    lines.push("");
  }
  if (losers.length > 0) {
    lines.push(`📉 PRE-MARKET LOSERS:`);
    for (const l of losers) {
      lines.push(`   ${l.symbol} ${l.changePct.toFixed(1)}% @ $${l.price.toFixed(2)}`);
    }
    lines.push("");
  }

  // Yahoo most active
  const active = yahooMovers.mostActive.slice(0, 8);
  if (active.length > 0) {
    lines.push(`🔥 MOST ACTIVE:`);
    for (const a of active) {
      lines.push(`   ${a.symbol} Vol: ${(a.volume / 1e6).toFixed(1)}M | ${a.change > 0 ? "+" : ""}${a.change.toFixed(2)} @ $${a.price.toFixed(2)}`);
    }
    lines.push("");
  }

  // Reddit overnight heat
  const hotReddit = redditScans.filter((s) => s.velocity > 1.5 || s.mentionsLastHour >= 3);
  if (hotReddit.length > 0) {
    lines.push(`💬 REDDIT OVERNIGHT:`);
    for (const r of hotReddit.slice(0, 5)) {
      lines.push(`   [${r.symbol}] vel: ${r.velocity.toFixed(1)}x | ${r.mentionsLastHour} mentions/hr`);
    }
    lines.push("");
  }

  lines.push(`══════════════════════════════════════════════════════`);

  const elapsed = Date.now() - startTime;
  console.log(`[BRIEFING] Built pre-market briefing in ${elapsed}ms (${news.length} headlines, ${edgarEntries.length} filings)`);

  return lines.join("\n");
}