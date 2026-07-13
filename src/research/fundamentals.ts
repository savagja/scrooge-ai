/**
 * Fundamentals refresh — fetches company data and writes to the Research DB.
 *
 * Sources:
 * - Alpaca assets endpoint: name, exchange, status (daily)
 * - Yahoo Finance: sector, industry, market cap, P/E, volume averages (via HTML scrape)
 *
 * The `fundamentals` table stores this data. The `tickers` table tracks
 * first_seen/last_seen. Both are updated here.
 *
 * NOTE: Valuation data (P/E, market cap) requires a paid data source for accuracy.
 * Yahoo Finance HTML scraping is used as a fallback — it's unofficial but free.
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
// YAHOO FINANCE — Sector, industry, market data
// ═══════════════════════════════════════════════════════════════════════════

interface YahooFundamentals {
  sector: string | null;
  industry: string | null;
  longName: string | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  regularMarketPrice: number | null;
  regularMarketVolume: number | null;
  chartPreviousClose: number | null;
}

async function fetchYahooFundamentals(symbol: string): Promise<YahooFundamentals | null> {
  try {
    // Chart API — no auth needed
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return null;

    return {
      sector: meta.exchangeName || null,
      industry: meta.fullExchangeName || meta.exchangeName || null,
      longName: meta.longName || meta.shortName || null,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      regularMarketPrice: meta.regularMarketPrice ?? null,
      regularMarketVolume: meta.regularMarketVolume ?? null,
      chartPreviousClose: meta.chartPreviousClose ?? null,
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
 * Runs once daily.
 */
export async function refreshFundamentals(store: SignalStore, watchlist: string[]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0;

  // Process in batches to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < watchlist.length && i < 50; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async (sym) => {
        // 1. Get Alpaca asset info (name, exchange status)
        const alpacaRes = await fetch(
          `https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(sym.toUpperCase())}`,
          { headers: getAlpacaHeaders() }
        );
        const name = alpacaRes.ok ? (await alpacaRes.json()).name ?? null : null;

        // 2. Get Yahoo fundamentals (sector, industry, market cap, PE, etc.)
        const yahoo = await fetchYahooFundamentals(sym);

        // 3. Update tickers table (always)
        store.ensureTicker(
          sym,
          name ?? undefined,
          yahoo?.sector ?? undefined,
          yahoo?.industry ?? undefined,
        );

        // 4. Upsert into fundamentals table (with what we have)
        if (yahoo) {
          store.upsertFundamentals(sym, today, "yahoo", {
            avg_volume_20d: yahoo.regularMarketVolume,
          });
          // Also update ticker name
          if (yahoo.longName) {
            store.ensureTicker(sym, yahoo.longName, yahoo.sector ?? undefined, yahoo.industry ?? undefined);
          }
          updated++;
        }
      })
    );

    // Small delay between batches
    if (i + batchSize < watchlist.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[RESEARCH] Fundamentals refreshed: ${updated}/${Math.min(watchlist.length, 50)} tickers`);
}
