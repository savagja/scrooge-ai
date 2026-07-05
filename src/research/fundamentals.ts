/**
 * Fundamentals refresh — fetches company financial data and technical indicators
 * on independent schedules (daily, weekly, quarterly) and writes to the Research DB.
 *
 * All computation is deterministic. The agent reads through search_signals tools.
 * No LLM involvement in data collection.
 */

import type { SignalStore } from "./db.js";
import { getCurrentPrice } from "../execution/alpaca.js";

const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const ALPACA_DATA_URL = "https://data.alpaca.markets";

function getAlpacaHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca credentials not set");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// YAHOO FINANCE QUOTE — Daily refresh: P/E, market cap, EPS, beta, sector
// ═══════════════════════════════════════════════════════════════════════════

interface YahooQuoteResult {
  marketCap: number | null;
  peRatio: number | null;
  forwardPe: number | null;
  epsTtm: number | null;
  beta: number | null;
  sector: string | null;
  industry: string | null;
  name: string | null;
}

async function fetchYahooQuote(symbol: string): Promise<YahooQuoteResult | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo`,
      { headers: YAHOO_HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;

    if (!meta) return null;

    // Yahoo chart meta doesn't include all fundamentals.
    // For full data we'd use the /v10/finance/quoteSummary endpoint.
    // Start with what's available from chart meta:
    return {
      marketCap: meta.marketCap ?? null,
      peRatio: meta.trailingPE ?? null,
      forwardPe: meta.forwardPE ?? null,
      epsTtm: null,  // Requires quoteSummary
      beta: null,
      sector: meta.sector ?? null,
      industry: meta.industry ?? null,
      name: meta.shortName ?? meta.longName ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch richer fundamental data from Yahoo's quoteSummary endpoint.
 * More details but slower — run weekly, not daily.
 */
async function fetchYahooStats(symbol: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=financialData,defaultKeyStatistics,summaryDetail`,
      { headers: YAHOO_HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const qs = data.quoteSummary?.result?.[0];
    if (!qs) return null;

    const fd = qs.financialData || {};
    const ks = qs.defaultKeyStatistics || {};
    const sd = qs.summaryDetail || {};

    return {
      marketCap: fd.marketCap?.raw ?? ks.marketCap?.raw ?? null,
      peRatio: fd.currentPE?.raw ?? ks.peRatio?.raw ?? null,
      forwardPe: fd.forwardPE?.raw ?? null,
      psRatio: fd.priceToSalesTrailing12Months?.raw ?? null,
      pbRatio: ks.priceToBook?.raw ?? null,
      evToEbitda: ks.enterpriseToEbitda?.raw ?? null,
      totalCash: ks.totalCash?.raw ?? null,
      totalDebt: ks.totalDebt?.raw ?? null,
      bookValue: ks.bookValue?.raw ?? null,
      freeCashFlow: ks.freeCashflow?.raw ?? null,
      currentRatio: ks.currentRatio?.raw ?? null,
      debtToEquity: ks.debtToEquity?.raw ?? null,
      revenueTtm: fd.totalRevenue?.raw ?? null,
      grossMargin: fd.grossMargins?.raw ?? null,
      operatingMargin: fd.operatingMargins?.raw ?? null,
      netMargin: fd.profitMargins?.raw ?? null,
      epsTtm: ks.trailingEps?.raw ?? fd.epsTrailingTwelveMonths?.raw ?? null,
      epsGrowthYoy: ks.earningsQuarterlyGrowth?.raw ?? null,
      revenueGrowthYoy: fd.revenueGrowth?.raw ?? null,
      beta: ks.beta?.raw ?? sd.beta?.raw ?? null,
      avgVolume20d: sd.averageVolume?.raw ?? null,
      avgVolume50d: sd.averageVolume10days?.raw ?? null,
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS — From Alpaca historical bars
// ═══════════════════════════════════════════════════════════════════════════

interface TechnicalIndicators {
  avgVolume20d: number | null;
  avgVolume50d: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  volatility30d: number | null;
}

async function computeTechnicalIndicators(symbol: string): Promise<TechnicalIndicators | null> {
  try {
    // Fetch 200+ daily bars for SMA calculations
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 300 * 86400000).toISOString();

    const url = new URL(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("limit", "250");

    const res = await fetch(url.toString(), { headers: getAlpacaHeaders() });
    if (!res.ok) return null;

    const data = await res.json();
    const bars = data.bars || [];
    if (bars.length < 20) return null;

    // Use complete bars only (exclude today if incomplete)
    const complete = bars.slice(0, -1);
    const closes = complete.map((b: any) => b.c);
    const volumes = complete.map((b: any) => b.v);

    // SMAs
    const sma20 = computeSMA(closes, 20);
    const sma50 = computeSMA(closes, 50);
    const sma200 = computeSMA(closes, 200);

    // RSI (14)
    const rsi14 = computeRSI(closes, 14);

    // Volatility (30-day annualized)
    const vol30d = computeVolatility(closes, 30);

    // Average volumes
    const avgVol20 = volumes.length >= 20
      ? volumes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20
      : null;
    const avgVol50 = volumes.length >= 50
      ? volumes.slice(-50).reduce((a: number, b: number) => a + b, 0) / 50
      : null;

    return {
      avgVolume20d: avgVol20 ? Math.round(avgVol20) : null,
      avgVolume50d: avgVol50 ? Math.round(avgVol50) : null,
      sma20: sma20 ? Math.round(sma20 * 100) / 100 : null,
      sma50: sma50 ? Math.round(sma50 * 100) / 100 : null,
      sma200: sma200 ? Math.round(sma200 * 100) / 100 : null,
      rsi14: rsi14 ? Math.round(rsi14 * 100) / 100 : null,
      volatility30d: vol30d ? Math.round(vol30d * 10000) / 10000 : null,
    };
  } catch {
    return null;
  }
}

function computeSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function computeRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map(Math.abs);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeVolatility(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const returns: number[] = [];
  const slice = closes.slice(-period);
  for (let i = 1; i < slice.length; i++) {
    returns.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252); // Annualized
}

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full fundamentals refresh for all watchlist + discovered tickers.
 * Runs daily after market close.
 */
export async function refreshFundamentals(store: SignalStore, watchlist: string[]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  // Helper: convert camelCase to snake_case for DB columns
  function toSnake(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data)) {
      result[key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = val;
    }
    return result;
  }

  // Phase 1: Quick daily quote data from Yahoo chart (fast, no API key)
  const quotePromises = watchlist.slice(0, 50).map(async (sym) => {
    const quote = await fetchYahooQuote(sym);
    if (!quote) return;
    const data = toSnake(quote as unknown as Record<string, unknown>);
    store.upsertFundamentals(sym, today, "yahoo_finance", data);

    // Update ticker metadata
    if (quote.sector || quote.industry || quote.name) {
      store.ensureTicker(sym, quote.name ?? undefined, quote.sector ?? undefined, quote.industry ?? undefined);
    }
  });

  await Promise.allSettled(quotePromises);

  // Phase 2: Weekly stats — only on Sundays (day 0) or first run
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 0) {
    const statsPromises = watchlist.slice(0, 30).map(async (sym) => {
      const stats = await fetchYahooStats(sym);
      if (!stats) return;
      store.upsertFundamentals(sym, today, "yahoo_finance", toSnake(stats as unknown as Record<string, unknown>));
    });
    await Promise.allSettled(statsPromises);
    console.log(`[RESEARCH] Weekly stats refreshed for ${watchlist.length} tickers`);
  }

  // Phase 3: Technical indicators from Alpaca bars (daily)
  const techPromises = watchlist.slice(0, 50).map(async (sym) => {
    const tech = await computeTechnicalIndicators(sym);
    if (!tech) return;
    const data = toSnake(tech as unknown as Record<string, unknown>);
    store.upsertFundamentals(sym, today, "alpaca_bars", data);
  });

  await Promise.allSettled(techPromises);
}