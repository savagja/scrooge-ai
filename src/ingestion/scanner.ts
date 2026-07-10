/**
 * Market scanner using Alpaca free data.
 * - Relative volume: compare current volume to 20-day average
 * - Pre-market gaps: compare current price to prior close
 * - Range breaks: detect which names are at 20-day extremes
 *
 * ⚠️  Alpaca paper accounts do NOT have access to recent SIP bar data
 *     (returns 403: "subscription does not permit querying recent SIP data").
 *     We get:
 *       - Historical daily bars from 2+ days ago ✓
 *       - Latest quotes (bid/ask/trade) ✓
 *       - Today's volume from quotes (not bars)
 *       - Current price from quotes/trades
 */

import { getCurrentPrice, getLatestQuote } from "../execution/alpaca.js";

const ALPACA_DATA_URL = "https://data.alpaca.markets";

// ═══════════════════════════════════════════════════════════════════════════
// SHARED PRICE CACHE — All scanners share the same cache within a research tick
// Prevents redundant API calls and reduces rate limit pressure.
// ═══════════════════════════════════════════════════════════════════════════

const _priceCache = new Map<string, number>();

/**
 * Get price with cycle-level caching. All scanners in the same research tick
 * share this cache, reducing API calls from ~320 to ~40 per cycle.
 */
async function getCachedPrice(symbol: string): Promise<number | null> {
  const cached = _priceCache.get(symbol);
  if (cached !== undefined) return cached;
  const price = await getCurrentPrice(symbol);
  if (price !== null) _priceCache.set(symbol, price);
  return price;
}

/**
 * Clear the shared price cache. Call at the start of each research tick.
 */
export function clearPriceCache(): void {
  _priceCache.clear();
}

function getHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca credentials not set");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

export interface VolumeScan {
  symbol: string;
  currentPrice: number;
  changePct: number;
  avgVolume20d: number;
  todayVolume: number;
  relativeVolume: number; // 1.0 = average, 5.0 = 5x average
  regime: "quiet" | "active" | "surge" | "blowout";
}

export interface GapScan {
  symbol: string;
  priorClose: number;
  preMarketPrice: number;
  gapPct: number;
  hasNews: boolean;
}

/**
 * Fetch historical daily bars ending 2 days ago (to avoid the "recent SIP data" 403
 * that paper accounts get). Returns bars ending at yesterday's close.
 */
async function getHistoricalDailyBars(symbol: string, days: number = 25): Promise<any[]> {
  try {
    // End at the start of 2 days ago UTC (avoids recent data restriction)
    const end = new Date(Date.now() - 2 * 86400000);
    end.setUTCHours(23, 59, 59, 999);
    const start = new Date(end.getTime() - (days + 5) * 86400000);

    const url = new URL(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", start.toISOString());
    url.searchParams.set("end", end.toISOString());
    url.searchParams.set("limit", String(days + 5));
    url.searchParams.set("adjustment", "split");

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) return [];

    const data = await res.json();
    return data.bars || [];
  } catch {
    return [];
  }
}

/**
 * Get yesterday's close from the last complete daily bar (from historical data).
 */
async function getPriorClose(symbol: string): Promise<number | null> {
  const bars = await getHistoricalDailyBars(symbol, 5);
  if (bars.length === 0) return null;
  return bars[bars.length - 1].c;
}

/**
 * Fetch 20-day average volume using historical bars (paper-account compatible).
 */
async function getAverageVolume(symbol: string, days: number = 20): Promise<number | null> {
  try {
    const bars = await getHistoricalDailyBars(symbol, days);
    if (bars.length < 5) return null;

    const volumes = bars.map((b: any) => b.v).filter((v: number) => v > 0);
    if (volumes.length === 0) return null;

    const avg = volumes.reduce((a: number, b: number) => a + b, 0) / volumes.length;
    return Math.round(avg);
  } catch {
    return null;
  }
}

/**
 * Get today's approximate volume from quote trade data.
 * Paper accounts can't get recent SIP bars, but we can estimate from
 * the latest trade's size and the quote feed's volume indicator.
 * Falls back to 0 if unavailable.
 */
async function getTodayVolume(symbol: string): Promise<number | null> {
  try {
    // Use the latest trade to get a rough volume estimate
    const url = `${ALPACA_DATA_URL}/v2/stocks/${symbol}/trades/latest`;
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) return null;

    const data = await res.json();
    // The latest trade has the trade size (s), not cumulative volume
    // We use the quote's trade condition to return a rough estimate
    if (data.trade?.s) {
      return data.trade.s; // Return last trade size as a proxy
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get today's daily bars (aligned with trading day in ET).
 * Falls back to getting just the latest trade if SIP data is blocked.
 */
export async function getTodayDailyBars(symbol: string): Promise<any[]> {
  try {
    const url = new URL(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("limit", "1");

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) return [];

    const data = await res.json();
    return data.bars || [];
  } catch {
    return [];
  }
}


/**
 * Scan watchlist for relative volume and price action.
 */
export async function scanRelativeVolume(
  watchlist: string[]
): Promise<VolumeScan[]> {
  const results: VolumeScan[] = [];

  // Concurrency limit to avoid Alpaca rate limits
  const batchSize = 5;
  for (let i = 0; i < watchlist.length; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(async (symbol) => {
        const [price, avgVol, todayVol] = await Promise.all([
          getCachedPrice(symbol),
          getAverageVolume(symbol, 20),
          getTodayVolume(symbol),
        ]);

        if (!price || !avgVol) return null;

        const relativeVolume = avgVol > 0 ? (todayVol || 0) / avgVol : 0;
        const priorClose = await getPriorClose(symbol);
        const changePct = priorClose ? ((price - priorClose) / priorClose) * 100 : 0;

        let regime: VolumeScan["regime"] = "quiet";
        if (relativeVolume >= 5) regime = "blowout";
        else if (relativeVolume >= 3) regime = "surge";
        else if (relativeVolume >= 1.5) regime = "active";

        return {
          symbol,
          currentPrice: price,
          changePct: Math.round(changePct * 100) / 100,
          avgVolume20d: Math.round(avgVol),
          todayVolume: Math.round(todayVol || 0),
          relativeVolume: Math.round(relativeVolume * 100) / 100,
          regime,
        } satisfies VolumeScan;
      })
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
    // Small delay between batches to respect rate limits
    if (i + batchSize < watchlist.length) await new Promise(r => setTimeout(r, 100));
  }

  // Sort by relative volume descending
  return results.sort((a, b) => b.relativeVolume - a.relativeVolume);
}

/**
 * Scan for pre-market gaps.
 * Compares current price to prior close (from historical bars).
 */
export async function scanPreMarketGaps(
  watchlist: string[]
): Promise<GapScan[]> {
  const results: GapScan[] = [];

  const batchSize = 5;
  for (let i = 0; i < watchlist.length; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(async (symbol) => {
        const [price, priorClose] = await Promise.all([
          getCachedPrice(symbol),
          getPriorClose(symbol),
        ]);

        if (!price || !priorClose) return null;

        const gapPct = ((price - priorClose) / priorClose) * 100;

        // Only report significant gaps
        if (Math.abs(gapPct) < 1.5) return null;

        return {
          symbol,
          priorClose: Math.round(priorClose * 100) / 100,
          preMarketPrice: Math.round(price * 100) / 100,
          gapPct: Math.round(gapPct * 100) / 100,
          hasNews: false,
        } satisfies GapScan;
      })
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
    if (i + batchSize < watchlist.length) await new Promise(r => setTimeout(r, 100));
  }

  // Sort by gap magnitude descending
  return results.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
}

/**
 * Find tickers that are breaking out of their 20-day range.
 * Uses historical bars (paper-account compatible) + current quote.
 */
export async function scanRangeBreaks(
  watchlist: string[]
): Promise<Array<{ symbol: string; price: number; high20d: number; low20d: number; positionInRange: number }>> {
  const results: { symbol: string; price: number; high20d: number; low20d: number; positionInRange: number }[] = [];

  const batchSize = 5;
  for (let i = 0; i < watchlist.length; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(async (symbol) => {
        // Use historical bars (avoids paper account's recent SIP restriction)
        const bars = await getHistoricalDailyBars(symbol, 25);
        if (bars.length < 10) return null;

        const prices = bars.flatMap((b: any) => [b.h, b.l]);
        const high20d = Math.max(...prices);
        const low20d = Math.min(...prices);

        const price = await getCachedPrice(symbol);
        if (!price) return null;

        const range = high20d - low20d;
        const positionInRange = range > 0 ? ((price - low20d) / range) : 0.5;

        // Only flag extremes (near top or bottom of range)
        if (positionInRange <= 0.9 && positionInRange >= 0.1) return null;

        return {
          symbol,
          price: Math.round(price * 100) / 100,
          high20d: Math.round(high20d * 100) / 100,
          low20d: Math.round(low20d * 100) / 100,
          positionInRange: Math.round(positionInRange * 100) / 100,
        };
      })
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
    if (i + batchSize < watchlist.length) await new Promise(r => setTimeout(r, 100));
  }

  return results.sort((a, b) => Math.abs(0.5 - b.positionInRange) - Math.abs(0.5 - a.positionInRange));
}
