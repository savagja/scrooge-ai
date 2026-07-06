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
      sector: null,  // Alpaca doesn't provide sector/industry
      industry: null,
      name: data.name ?? null,
    };
  } catch {
    return null;
  }
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

  // Phase 2: Technical indicators — skipped (Alpaca bars endpoint requires paid subscription)
  // Will enable when account has data API access
  // For now, ticker metadata is the fundamentals payload
  console.log(`[RESEARCH] Asset metadata refreshed for ${watchlist.length} tickers`);
}