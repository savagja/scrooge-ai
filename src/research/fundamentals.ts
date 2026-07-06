/**
 * Fundamentals refresh — fetches company data and technical indicators
 * on independent schedules and writes to the Research DB.
 *
 * Sources:
 * - Alpaca assets endpoint: sector, industry, name (daily)
 * - Alpaca historical bars: SMA, RSI, volume averages, volatility (daily after close)
 *
 * Valuation data (P/E, market cap) are not currently available from free Alpaca/Yahoo
 * endpoints. This is sufficient for the agent to reason about technical context.
 */

import type { SignalStore } from "./db.js";

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
// ALPACA ASSET INFO — Sector, industry, name (daily, fast)
// ═══════════════════════════════════════════════════════════════════════════

interface AlpacaAssetInfo {
  sector: string | null;
  industry: string | null;
  name: string | null;
}

async function fetchAlpacaAsset(symbol: string): Promise<AlpacaAssetInfo | null> {
  try {
    const res = await fetch(
      `https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(symbol.toUpperCase())}`,
      { headers: getAlpacaHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      sector: data.sector ?? null,
      industry: data.industry ?? null,
      name: data.name ?? null,
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

    const complete = bars.slice(0, -1);
    const closes = complete.map((b: any) => b.c);
    const volumes = complete.map((b: any) => b.v);

    const sma20 = computeSMA(closes, 20);
    const sma50 = computeSMA(closes, 50);
    const sma200 = computeSMA(closes, 200);
    const rsi14 = computeRSI(closes, 14);
    const vol30d = computeVolatility(closes, 30);

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
  return Math.sqrt(variance) * Math.sqrt(252);
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

  // Phase 1: Asset info from Alpaca (sector, industry, name) — fast, daily
  const assetPromises = watchlist.slice(0, 50).map(async (sym) => {
    const asset = await fetchAlpacaAsset(sym);
    if (!asset) return;
    store.ensureTicker(sym, asset.name ?? undefined, asset.sector ?? undefined, asset.industry ?? undefined);
  });

  await Promise.allSettled(assetPromises);

  // Phase 2: Technical indicators from Alpaca bars (daily)
  const techPromises = watchlist.slice(0, 50).map(async (sym) => {
    const tech = await computeTechnicalIndicators(sym);
    if (!tech) return;

    // Convert camelCase to snake_case for DB columns
    const data: Record<string, unknown> = {};
    if (tech.avgVolume20d !== null) data.avg_volume_20d = tech.avgVolume20d;
    if (tech.avgVolume50d !== null) data.avg_volume_50d = tech.avgVolume50d;
    if (tech.sma20 !== null) data.sma_20 = tech.sma20;
    if (tech.sma50 !== null) data.sma_50 = tech.sma50;
    if (tech.sma200 !== null) data.sma_200 = tech.sma200;
    if (tech.rsi14 !== null) data.rsi_14 = tech.rsi14;
    if (tech.volatility30d !== null) data.volatility_30d = tech.volatility30d;

    store.upsertFundamentals(sym, today, "alpaca_bars", data);
  });

  await Promise.allSettled(techPromises);
}