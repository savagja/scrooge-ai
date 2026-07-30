/**
 * Fundamentals refresh — fetches company data and writes to the Research DB.
 *
 * Sources:
 * - Yahoo Finance: sector, industry, market cap, P/E, dividend yield, etc. (via quote-summary endpoint)
 * - Alpaca assets endpoint: name, exchange, status (daily)
 *
 * The `fundamentals` table stores this data. The `tickers` table tracks
 * first_seen/last_seen. Both are updated here.
 *
 * Yahoo Finance HTML scraping is used as a fallback — it's unofficial but free.
 * The quote-summary endpoint provides: market cap, PE ratio, dividend yield, EPS,
 * book value, free cash flow, revenue, margins, and more.
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
// YAHOO FINANCE — Full fundamentals via quote-summary endpoint
// ═══════════════════════════════════════════════════════════════════════════

interface YahooFundamentals {
  // Identity
  longName: string | null;
  sector: string | null;
  industry: string | null;
  // Valuation
  marketCap: number | null;
  enterpriseValue: number | null;
  peRatio: number | null;
  forwardPe: number | null;
  psRatio: number | null;
  pbRatio: number | null;
  evToEbitda: number | null;
  // Dividends
  dividendYield: number | null;
  dividendRate: number | null;
  payoutRatio: number | null;
  fiveYearAvgDividendYield: number | null;
  // Financials
  totalCash: number | null;
  totalDebt: number | null;
  bookValue: number | null;
  freeCashFlow: number | null;
  operatingCashFlow: number | null;
  revenueTtm: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  // Per-share
  epsTtm: number | null;
  epsForward: number | null;
  epsGrowthYoY: number | null;
  revenueGrowthYoY: number | null;
  // Technical / price
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyDayAverage: number | null;
  twoHundredDayAverage: number | null;
  beta: number | null;
  // Volume
  avgVolume10d: number | null;
  avgVolume30d: number | null;
  regularMarketPrice: number | null;
  regularMarketVolume: number | null;
}

async function fetchYahooFundamentals(symbol: string): Promise<YahooFundamentals | null> {
  // Use the fundamentals proxy server instead of the broken Yahoo Finance v10 endpoint
  // (which now requires crumb auth). The proxy runs a Python yfinance wrapper.
  const proxyUrl = process.env.FUNDAMENTALS_PROXY_URL || "http://localhost:5001";
  try {
    const res = await fetch(`${proxyUrl}/fundamentals/${encodeURIComponent(symbol)}`, {
      headers: { "User-Agent": "scrooge/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[FUNDAMENTALS] Proxy returned ${res.status} for ${symbol}, falling back to chart API`);
      return fetchYahooChartFallback(symbol);
    }
    const data = await res.json();
    if (data.error) {
      console.warn(`[FUNDAMENTALS] Proxy error for ${symbol}: ${data.error}`);
      return fetchYahooChartFallback(symbol);
    }

    return {
      longName: data.longName ?? null,
      sector: data.sector ?? null,
      industry: data.industry ?? null,
      marketCap: data.marketCap ?? null,
      enterpriseValue: data.enterpriseValue ?? null,
      peRatio: data.peRatio ?? null,
      forwardPe: data.forwardPe ?? null,
      psRatio: data.psRatio ?? null,
      pbRatio: data.pbRatio ?? null,
      evToEbitda: data.evToEbitda ?? null,
      dividendYield: data.dividendYield ?? null,
      dividendRate: data.dividendRate ?? null,
      payoutRatio: data.payoutRatio ?? null,
      fiveYearAvgDividendYield: data.fiveYearAvgDividendYield ?? null,
      totalCash: data.totalCash ?? null,
      totalDebt: data.totalDebt ?? null,
      bookValue: data.bookValue ?? null,
      freeCashFlow: data.freeCashFlow ?? null,
      operatingCashFlow: data.operatingCashFlow ?? null,
      revenueTtm: data.revenueTtm ?? null,
      grossMargin: data.grossMargin ?? null,
      operatingMargin: data.operatingMargin ?? null,
      netMargin: data.netMargin ?? null,
      epsTtm: data.epsTtm ?? null,
      epsForward: data.epsForward ?? null,
      epsGrowthYoY: data.epsGrowthYoY ?? null,
      revenueGrowthYoY: data.revenueGrowthYoY ?? null,
      fiftyTwoWeekHigh: data.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: data.fiftyTwoWeekLow ?? null,
      fiftyDayAverage: data.fiftyDayAverage ?? null,
      twoHundredDayAverage: data.twoHundredDayAverage ?? null,
      beta: data.beta ?? null,
      avgVolume10d: data.avgVolume10d ?? null,
      avgVolume30d: data.avgVolume30d ?? null,
      regularMarketPrice: data.regularMarketPrice ?? null,
      regularMarketVolume: data.regularMarketVolume ?? null,
    };
  } catch (e: any) {
    console.warn(`[FUNDAMENTALS] Proxy fetch failed for ${symbol}: ${e?.message ?? e}, falling back to chart API`);
    return fetchYahooChartFallback(symbol);
  }
}

/**
 * Fallback: use Yahoo Chart API (v8) for basic metadata when quote-summary fails.
 * Returns much less data — just price, volume, and name.
 */
async function fetchYahooChartFallback(symbol: string): Promise<YahooFundamentals | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return null;

    return {
      longName: meta.longName || meta.shortName || null,
      sector: null,
      industry: null,
      marketCap: null,
      enterpriseValue: null,
      peRatio: null,
      forwardPe: null,
      psRatio: null,
      pbRatio: null,
      evToEbitda: null,
      dividendYield: null,
      dividendRate: null,
      payoutRatio: null,
      fiveYearAvgDividendYield: null,
      totalCash: null,
      totalDebt: null,
      bookValue: null,
      freeCashFlow: null,
      operatingCashFlow: null,
      revenueTtm: null,
      grossMargin: null,
      operatingMargin: null,
      netMargin: null,
      epsTtm: null,
      epsForward: null,
      epsGrowthYoY: null,
      revenueGrowthYoY: null,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      fiftyDayAverage: null,
      twoHundredDayAverage: null,
      beta: null,
      avgVolume10d: null,
      avgVolume30d: null,
      regularMarketPrice: meta.regularMarketPrice ?? null,
      regularMarketVolume: meta.regularMarketVolume ?? null,
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VALUE STOCK SCREENERS — Used by the strategist's screen_by_fundamentals tool
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Known value/defensive tickers to seed the fundamentals database.
 * These are widely held blue-chip companies across sectors that the
 * research engine might not discover through short-term signal scanning.
 */
const VALUE_SEED_TICKERS = [
  // Consumer Staples
  "KO", "PEP", "PG", "CL", "KMB", "COST", "WMT", "SYY", "GIS", "K", "CPB", "SJM", "CAG", "HRL", "MKC",
  // Healthcare
  "JNJ", "PFE", "MRK", "ABBV", "BMY", "LLY", "UNH", "CVS", "CI", "AMGN", "GILD", "TMO", "DHR", "ISRG", "SYK",
  // Utilities
  "NEE", "DUK", "SO", "D", "AEP", "XEL", "EXC", "PEG", "ED", "ES", "WEC", "DTE", "EIX", "AWK", "CMS",
  // Financials (dividend aristocrats)
  "JPM", "BAC", "WFC", "C", "GS", "MS", "V", "MA", "BLK", "SCHW", "AXP", "USB", "PNC", "TFC", "BK",
  // Industrials / Defense
  "CAT", "DE", "MMM", "HON", "BA", "LMT", "RTX", "NOC", "GD", "GE", "UPS", "FDX", "CSX", "UNP", "ETN",
  // Energy (integrated, dividend payers)
  "XOM", "CVX", "COP", "EOG", "PSX", "VLO", "MPC", "OXY", "HES", "BP",
  // Technology (established, cash-rich)
  "AAPL", "MSFT", "GOOGL", "META", "NVDA", "ORCL", "IBM", "CSCO", "INTC", "QCOM", "TXN", "AVGO", "ADBE", "CRM", "ACN",
  // Telecom / Infrastructure
  "T", "VZ", "TMUS", "CMCSA", "CHTR",
  // Real Estate (REITs)
  "PLD", "AMT", "CCI", "EQIX", "SPG", "O", "PSA", "WELL", "DLR", "AVB",
  // Consumer Discretionary (established)
  "HD", "LOW", "MCD", "SBUX", "NKE", "DIS", "AMZN", "TSLA", "LULU", "TJX",
  // Materials
  "LIN", "APD", "SHW", "ECL", "NEM", "FCX", "DOW", "DD", "PPG",
];

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full fundamentals refresh for all watchlist + discovered tickers.
 * Runs once daily.
 * Also seeds the fundamentals database with known value/defensive tickers
 * so the strategist can screen for value plays even without signal activity.
 */
export async function refreshFundamentals(store: SignalStore, watchlist: string[]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0;

  // Build a combined ticker list: watchlist + value seeds + recently active tickers
  const tickerSet = new Set<string>();

  // Add watchlist tickers
  for (const t of watchlist) tickerSet.add(t.toUpperCase());

  // Add value seed tickers
  for (const t of VALUE_SEED_TICKERS) tickerSet.add(t);

  // Add recently active tickers from the research DB
  try {
    const recent = store._execSql(
      `SELECT DISTINCT ticker FROM signals WHERE timestamp >= datetime('now', '-7 days') ORDER BY timestamp DESC LIMIT 100`,
      []
    );
    for (const row of recent) {
      if (row.ticker && typeof row.ticker === 'string' && String(row.ticker) !== 'UNKNOWN') {
        tickerSet.add(String(row.ticker));
      }
    }
  } catch { /* ignore */ }

  const allTickers = Array.from(tickerSet).slice(0, 100); // Process up to 100 per day

  // Process in batches to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < allTickers.length; i += batchSize) {
    const batch = allTickers.slice(i, i + batchSize);

    await Promise.allSettled(
      batch.map(async (sym) => {
        try {
          // 1. Get Alpaca asset info (name, exchange status)
          let name: string | null = null;
          try {
            const alpacaRes = await fetch(
              `https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(sym.toUpperCase())}`,
              { headers: getAlpacaHeaders() }
            );
            if (alpacaRes.ok) {
              const asset = await alpacaRes.json();
              name = asset.name ?? null;
            }
          } catch { /* Alpaca asset fetch is non-critical */ }

          // 2. Get Yahoo fundamentals (full suite: P/E, market cap, dividend, etc.)
          const yahoo = await fetchYahooFundamentals(sym);

          // 3. Update tickers table (always)
          store.ensureTicker(
            sym,
            yahoo?.longName || name || undefined,
            yahoo?.sector ?? undefined,
            yahoo?.industry ?? undefined,
          );

          // 4. Upsert into fundamentals table with ALL available data
          if (yahoo) {
            const fundData: Record<string, unknown> = {};

            // Only set non-null values to avoid overwriting with nulls
            if (yahoo.marketCap !== null) fundData.market_cap = yahoo.marketCap;
            if (yahoo.enterpriseValue !== null) fundData.enterprise_value = yahoo.enterpriseValue;
            if (yahoo.peRatio !== null) fundData.pe_ratio = yahoo.peRatio;
            if (yahoo.forwardPe !== null) fundData.forward_pe = yahoo.forwardPe;
            if (yahoo.psRatio !== null) fundData.ps_ratio = yahoo.psRatio;
            if (yahoo.pbRatio !== null) fundData.pb_ratio = yahoo.pbRatio;
            if (yahoo.evToEbitda !== null) fundData.ev_to_ebitda = yahoo.evToEbitda;
            if (yahoo.dividendYield !== null) fundData.dividend_yield = yahoo.dividendYield;
            if (yahoo.dividendRate !== null) fundData.dividend_rate = yahoo.dividendRate;
            if (yahoo.payoutRatio !== null) fundData.payout_ratio = yahoo.payoutRatio;
            if (yahoo.totalCash !== null) fundData.total_cash = yahoo.totalCash;
            if (yahoo.totalDebt !== null) fundData.total_debt = yahoo.totalDebt;
            if (yahoo.bookValue !== null) fundData.book_value = yahoo.bookValue;
            if (yahoo.freeCashFlow !== null) fundData.free_cash_flow = yahoo.freeCashFlow;
            if (yahoo.operatingCashFlow !== null) fundData.operating_cash_flow = yahoo.operatingCashFlow;
            if (yahoo.revenueTtm !== null) fundData.revenue_ttm = yahoo.revenueTtm;
            if (yahoo.grossMargin !== null) fundData.gross_margin = yahoo.grossMargin;
            if (yahoo.operatingMargin !== null) fundData.operating_margin = yahoo.operatingMargin;
            if (yahoo.netMargin !== null) fundData.net_margin = yahoo.netMargin;
            if (yahoo.epsTtm !== null) fundData.eps_ttm = yahoo.epsTtm;
            if (yahoo.epsForward !== null) fundData.eps_forward = yahoo.epsForward;
            if (yahoo.epsGrowthYoY !== null) fundData.eps_growth_yoy = yahoo.epsGrowthYoY;
            if (yahoo.revenueGrowthYoY !== null) fundData.revenue_growth_yoy = yahoo.revenueGrowthYoY;
            if (yahoo.avgVolume10d !== null) fundData.avg_volume_10d = yahoo.avgVolume10d;
            if (yahoo.avgVolume30d !== null) fundData.avg_volume_30d = yahoo.avgVolume30d;
            if (yahoo.beta !== null) fundData.beta = yahoo.beta;
            if (yahoo.fiftyTwoWeekHigh !== null) fundData.fifty_two_week_high = yahoo.fiftyTwoWeekHigh;
            if (yahoo.fiftyTwoWeekLow !== null) fundData.fifty_two_week_low = yahoo.fiftyTwoWeekLow;
            if (yahoo.fiftyDayAverage !== null) fundData.fifty_day_average = yahoo.fiftyDayAverage;
            if (yahoo.twoHundredDayAverage !== null) fundData.two_hundred_day_average = yahoo.twoHundredDayAverage;

            store.upsertFundamentals(sym, today, "yahoo", fundData);

            // Update ticker name from Yahoo (more reliable)
            if (yahoo.longName) {
              store.ensureTicker(sym, yahoo.longName, yahoo.sector ?? undefined, yahoo.industry ?? undefined);
            }
            updated++;
          }
        } catch {
          // Individual ticker failure is non-fatal
        }
      })
    );

    // Small delay between batches
    if (i + batchSize < allTickers.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[RESEARCH] Fundamentals refreshed: ${updated}/${allTickers.length} tickers (including ${VALUE_SEED_TICKERS.length} value seeds)`);
}

/**
 * Get the list of value seed tickers for the strategist's screening tool.
 */
export function getValueSeedTickers(): string[] {
  return [...VALUE_SEED_TICKERS];
}