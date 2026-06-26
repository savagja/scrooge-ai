/**
 * Market scanner using Alpaca free data.
 * - Relative volume: compare current volume to 20-day average
 * - Pre-market gaps: compare 4 AM price to prior close
 * - Volatility expansion: detect which names are breaking ranges
 */

import { getCurrentPrice } from "../execution/alpaca.js";

const ALPACA_DATA_URL = "https://data.alpaca.markets";

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
 * Fetch 20-day average volume for a symbol using Alpaca historical bars.
 */
async function getAverageVolume(symbol: string, days: number = 20): Promise<number | null> {
  try {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - (days + 5) * 86400000).toISOString();

    const url = new URL(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("limit", (days + 5).toString());

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) return null;

    const data = await res.json();
    const bars = data.bars || [];
    if (bars.length < 5) return null;

    // Skip the last bar (today, potentially incomplete)
    const completeBars = bars.slice(0, -1);
    const volumes = completeBars.map((b: any) => b.v).filter((v: number) => v > 0);
    if (volumes.length === 0) return null;

    const avg = volumes.reduce((a: number, b: number) => a + b, 0) / volumes.length;
    return Math.round(avg);
  } catch {
    return null;
  }
}

/**
 * Get today's volume so far (intraday bars).
 */
async function getTodayVolume(symbol: string): Promise<number | null> {
  try {
    const now = new Date();
    const marketOpen = new Date(now);
    marketOpen.setHours(9, 30, 0, 0);

    const start = marketOpen.toISOString();
    const end = now.toISOString();

    const url = new URL(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "1Hour");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) return null;

    const data = await res.json();
    const bars = data.bars || [];
    return bars.reduce((sum: number, b: any) => sum + (b.v || 0), 0);
  } catch {
    return null;
  }
}

/**
 * Get prior close (last complete trading day's close).
 */
async function getPriorClose(symbol: string): Promise<number | null> {
  try {
    const url = new URL(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("limit", "2");

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) return null;

    const data = await res.json();
    const bars = data.bars || [];
    if (bars.length < 2) return null;

    // Second-to-last bar = prior close
    return bars[bars.length - 2].c;
  } catch {
    return null;
  }
}

/**
 * Scan watchlist for relative volume and price action.
 */
export async function scanRelativeVolume(
  watchlist: string[]
): Promise<VolumeScan[]> {
  const results: VolumeScan[] = [];

  for (const symbol of watchlist) {
    const [price, avgVol, todayVol] = await Promise.all([
      getCurrentPrice(symbol),
      getAverageVolume(symbol, 20),
      getTodayVolume(symbol),
    ]);

    if (!price || !avgVol || !todayVol) continue;

    const relativeVolume = avgVol > 0 ? todayVol / avgVol : 0;
    const priorClose = await getPriorClose(symbol);
    const changePct = priorClose ? ((price - priorClose) / priorClose) * 100 : 0;

    let regime: VolumeScan["regime"] = "quiet";
    if (relativeVolume >= 5) regime = "blowout";
    else if (relativeVolume >= 3) regime = "surge";
    else if (relativeVolume >= 1.5) regime = "active";

    results.push({
      symbol,
      currentPrice: price,
      changePct: Math.round(changePct * 100) / 100,
      avgVolume20d: Math.round(avgVol),
      todayVolume: Math.round(todayVol),
      relativeVolume: Math.round(relativeVolume * 100) / 100,
      regime,
    });
  }

  // Sort by relative volume descending
  return results.sort((a, b) => b.relativeVolume - a.relativeVolume);
}

/**
 * Scan for pre-market gaps (4 AM–9:30 AM ET).
 * Compares current price to prior close.
 */
export async function scanPreMarketGaps(
  watchlist: string[]
): Promise<GapScan[]> {
  const results: GapScan[] = [];

  for (const symbol of watchlist) {
    const [price, priorClose] = await Promise.all([
      getCurrentPrice(symbol),
      getPriorClose(symbol),
    ]);

    if (!price || !priorClose) continue;

    const gapPct = ((price - priorClose) / priorClose) * 100;

    // Only report significant gaps
    if (Math.abs(gapPct) < 1.5) continue;

    results.push({
      symbol,
      priorClose: Math.round(priorClose * 100) / 100,
      preMarketPrice: Math.round(price * 100) / 100,
      gapPct: Math.round(gapPct * 100) / 100,
      hasNews: false, // will be populated by caller
    });
  }

  // Sort by gap magnitude descending
  return results.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
}

/**
 * Find tickers that are breaking out of their 20-day range.
 */
export async function scanRangeBreaks(
  watchlist: string[]
): Promise<Array<{ symbol: string; price: number; high20d: number; low20d: number; positionInRange: number }>> {
  const results: { symbol: string; price: number; high20d: number; low20d: number; positionInRange: number }[] = [];

  for (const symbol of watchlist) {
    try {
      const url = new URL(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars`);
      url.searchParams.set("timeframe", "1Day");
      url.searchParams.set("limit", "22");

      const res = await fetch(url.toString(), { headers: getHeaders() });
      if (!res.ok) continue;

      const data = await res.json();
      const bars = data.bars || [];
      if (bars.length < 10) continue;

      const completeBars = bars.slice(0, -1); // exclude today
      const prices = completeBars.flatMap((b: any) => [b.h, b.l]);
      const high20d = Math.max(...prices);
      const low20d = Math.min(...prices);

      const price = await getCurrentPrice(symbol);
      if (!price) continue;

      const range = high20d - low20d;
      const positionInRange = range > 0 ? ((price - low20d) / range) : 0.5;

      // Only flag extremes (near top or bottom of range)
      if (positionInRange > 0.9 || positionInRange < 0.1) {
        results.push({
          symbol,
          price: Math.round(price * 100) / 100,
          high20d: Math.round(high20d * 100) / 100,
          low20d: Math.round(low20d * 100) / 100,
          positionInRange: Math.round(positionInRange * 100) / 100,
        });
      }
    } catch {
      continue;
    }
  }

  return results.sort((a, b) => Math.abs(0.5 - b.positionInRange) - Math.abs(0.5 - a.positionInRange));
}
