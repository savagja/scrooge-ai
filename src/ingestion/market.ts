/**
 * Market data ingestion: VIX, SPY, individual prices.
 * VIX via Yahoo Finance (unofficial endpoint).
 * SPY and individual quotes via Alpaca.
 */

import { getCurrentPrice } from "../execution/alpaca.js";

export async function getVix(): Promise<number | null> {
  try {
    // Yahoo Finance quote for ^VIX
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/^VIX?interval=1d&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice) {
      return parseFloat(meta.regularMarketPrice);
    }
    return null;
  } catch (e) {
    console.warn("[MARKET] VIX fetch failed:", e);
    return null;
  }
}

export async function getSpyChange(): Promise<number | null> {
  try {
    const price = await getCurrentPrice("SPY");
    if (!price) return null;

    // Get previous close from Yahoo Finance for SPY
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=2d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = data.chart?.result?.[0];
    if (!results) return null;

    const closes = results.indicators?.quote?.[0]?.close;
    if (!closes || closes.length < 2) return null;

    const prevClose = closes[closes.length - 2];
    if (!prevClose) return null;

    return ((price - prevClose) / prevClose) * 100;
  } catch (e) {
    console.warn("[MARKET] SPY change fetch failed:", e);
    return null;
  }
}

export async function getPrice(symbol: string): Promise<number | null> {
  return getCurrentPrice(symbol);
}
