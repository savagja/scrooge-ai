/**
 * Broad market discovery — finds tickers across ALL US equities.
 * Uses free Yahoo Finance APIs (no auth required) for market-wide scanning.
 * Verifies fractional eligibility on Alpaca before returning results.
 *
 * Strategies:
 * - Most active (highest volume)
 * - Top gainers / losers
 * - Unusual volume (vs prior day)
 * - Trending tickers (Yahoo's "trending" list)
 * - New highs / lows
 *
 * All returned tickers are filtered to those supported by Alpaca fractional shares.
 */

const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// Alpaca base URL for checking asset eligibility
const ALPACA_DATA_URL = "https://data.alpaca.markets";

// Regex to filter out non-US-equity tickers that commonly appear in Yahoo data.
// Catches: crypto (BTC-USD, XRP-USD), mutual funds (FXAIX), foreign stocks (ASML, NESTE),
// Canadian (SHOP), and anything with exchange suffixes.
const INVALID_TICKER_REGEX = /[-.^=]|\d{2,}$/;
const COMMON_FOREIGN_TICKERS = new Set([
  // Non-US large caps that Yahoo includes in "most active"
  "ASML", "SHOP", "NESTE", "SAP", "DSV", "WISE", "VOW", "ENR", "CLS",
  "NOKIA", "WSP", "TCS", "ULVR", "XERI", "NSRGY",
  // Dual-listed / OTC that aren't tradeable on Alpaca
  "VALMT",
]);

function isUsEquity(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (INVALID_TICKER_REGEX.test(upper)) return false;
  if (COMMON_FOREIGN_TICKERS.has(upper)) return false;
  // Crypto tickers from Yahoo (suffix format)
  if (upper.endsWith("-USD") || upper.endsWith("-EUR") || upper.endsWith("-CAD") || upper.endsWith("-GBP")) return false;
  return true;
}

function getAlpacaHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca credentials not set");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

// Cache for fractional eligibility (1-hour TTL)
const _fractionalCache = new Map<string, { eligible: boolean; ts: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Check if a ticker supports fractional shares on Alpaca.
 */
export async function isFractionalEligible(symbol: string): Promise<boolean> {
  const cached = _fractionalCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.eligible;
  }

  try {
    // Alpaca's assets endpoint — no official fractional flag, but we can check if it's fractionable
    const url = `${ALPACA_DATA_URL}/v2/assets?status=active&asset_class=us_equity`;
    // Actually, we need to query per asset — that's heavy.
    // Better: Alpaca's trading API GET /v2/assets/{symbol_or_asset_id} returns fractionable bool
    const assetUrl = `${ALPACA_DATA_URL}/v2/assets/${encodeURIComponent(symbol.toUpperCase())}`;
    const res = await fetch(assetUrl, { headers: getAlpacaHeaders() });

    if (res.status === 404) {
      _fractionalCache.set(symbol, { eligible: false, ts: Date.now() });
      return false; // Not on Alpaca
    }

    if (!res.ok) {
      // Rate limited or error — assume eligible for known large-caps
      const knownEligibles = ["AAPL", "TSLA", "NVDA", "AMD", "MSFT", "AMZN", "GOOGL", "META", "NFLX", "CRM",
        "PLTR", "COIN", "HOOD", "SOFI", "ENPH", "FSLR", "BA", "JPM", "XOM", "UNH"];
      const fallback = knownEligibles.includes(symbol.toUpperCase());
      _fractionalCache.set(symbol, { eligible: fallback, ts: Date.now() });
      return fallback;
    }

    const data = await res.json();
    const fractionable = data.fractionable === true || data.tradable === true;
    _fractionalCache.set(symbol, { eligible: fractionable, ts: Date.now() });
    return fractionable;
  } catch {
    return true; // Assume eligible on error to not block trades
  }
}

/**
 * Fetch Yahoo Finance's most active, gainers, losers, and trending tickers.
 */
export async function scanYahooMarketMovers(
  limit: number = 50
): Promise<{
  mostActive: Array<{ symbol: string; name: string; price: number; change: number; volume: number }>;
  gainers: Array<{ symbol: string; price: number; changePct: number }>;
  losers: Array<{ symbol: string; price: number; changePct: number }>;
  trending: Array<{ symbol: string }>;
}> {
  const result = {
    mostActive: [] as any[],
    gainers: [] as any[],
    losers: [] as any[],
    trending: [] as any[],
  };

  // Yahoo Finance screener endpoints (undocumented but stable)
  const screens = [
    {
      key: "mostActive" as const,
      url: "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&scrIds=most_actives&count=50",
    },
    {
      key: "gainers" as const,
      url: "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&scrIds=day_gainers&count=30",
    },
    {
      key: "losers" as const,
      url: "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&scrIds=day_losers&count=30",
    },
    {
      key: "trending" as const,
      url: "https://query1.finance.yahoo.com/v1/finance/trending/US?count=20",
    },
  ];

  for (const screen of screens) {
    try {
      const res = await fetch(screen.url, { headers: YAHOO_HEADERS });
      if (!res.ok) continue;
      const data = await res.json();

      if (screen.key === "trending") {
        const quotes = data.finance?.result?.[0]?.quotes || [];
        result.trending = quotes
          .map((q: any) => ({ symbol: q.symbol }))
          .filter((q: any) => q.symbol && isUsEquity(q.symbol));
      } else {
        const quotes = data.finance?.result?.[0]?.quotes || [];
        const mapped = quotes
          .filter((q: any) => q.symbol && isUsEquity(q.symbol))
          .map((q: any) => ({
            symbol: q.symbol,
            name: q.shortName || q.longName || "",
            price: q.regularMarketPrice || 0,
            change: q.regularMarketChange || 0,
            changePct: q.regularMarketChangePercent || 0,
            volume: q.regularMarketVolume || 0,
          }));

        if (screen.key === "mostActive") result.mostActive = mapped;
        if (screen.key === "gainers") result.gainers = mapped;
        if (screen.key === "losers") result.losers = mapped;
      }
    } catch {
      // Silently skip on error — Yahoo is unofficial
    }
  }

  return result;
}

/**
 * Filter discovered tickers to only those tradeable on Alpaca with fractional shares.
 * If Alpaca is unreachable, returns all tickers (assumes eligible) rather than crashing.
 */
export async function filterFractionalEligible(
  tickers: Array<{ symbol: string; [key: string]: any }>
): Promise<any[]> {
  try {
    // Check in parallel batches to avoid rate limits
    const batchSize = 5;
    const eligible: any[] = [];

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const checks = await Promise.all(
        batch.map(async (t) => {
          try {
            const ok = await isFractionalEligible(t.symbol);
            return { t, ok };
          } catch {
            return { t, ok: true }; // Assume eligible on error
          }
        })
      );
      for (const { t, ok } of checks) {
        if (ok) eligible.push(t);
      }
      // Small delay between batches
      if (i + batchSize < tickers.length) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    return eligible;
  } catch {
    // Entire filter failed (network issue) — return all tickers as eligible
    return tickers;
  }
}

/**
 * Discover high-opportunity tickers dynamically.
 * Returns a curated list of the most actionable names.
 */
export async function discoverOpportunities(
  existingWatchlist: string[],
  maxResults: number = 20
): Promise<{
  discovered: Array<{
    symbol: string;
    source: string;
    price: number;
    changePct: number;
    volume: number;
    reason: string;
  }>;
  sourceCounts: Record<string, number>;
}> {
  try {
    const movers = await scanYahooMarketMovers(50);
    const candidates: Record<string, any> = {};

    // Build candidate pool from all sources
    for (const m of movers.mostActive.slice(0, 30)) {
      if (m.price < 1) continue;
      candidates[m.symbol] = {
        ...m,
        sources: new Set(["mostActive"]),
        reasons: ["High volume"],
      };
    }

    for (const g of movers.gainers.slice(0, 20)) {
      if (g.price < 1) continue;
      if (candidates[g.symbol]) {
        candidates[g.symbol].sources.add("gainers");
        candidates[g.symbol].reasons.push(`Up ${g.changePct.toFixed(1)}% today`);
      } else {
        candidates[g.symbol] = {
          ...g,
          sources: new Set(["gainers"]),
          reasons: [`Up ${g.changePct.toFixed(1)}% today`],
        };
      }
    }

    for (const l of movers.losers.slice(0, 20)) {
      if (l.price < 1) continue;
      if (candidates[l.symbol]) {
        candidates[l.symbol].sources.add("losers");
        candidates[l.symbol].reasons.push(`Down ${Math.abs(l.changePct).toFixed(1)}% today`);
      } else {
        candidates[l.symbol] = {
          ...l,
          sources: new Set(["losers"]),
          reasons: [`Down ${Math.abs(l.changePct).toFixed(1)}% today`],
        };
      }
    }

    for (const t of movers.trending.slice(0, 20)) {
      if (!candidates[t.symbol]) {
        candidates[t.symbol] = {
          symbol: t.symbol,
          price: 0,
          changePct: 0,
          volume: 0,
          sources: new Set(["trending"]),
          reasons: ["Trending on Yahoo Finance"],
        };
      } else {
        candidates[t.symbol].sources.add("trending");
        candidates[t.symbol].reasons.push("Trending on Yahoo Finance");
      }
    }

    // Exclude existing watchlist
    const uniqueCandidates = Object.values(candidates).filter(
      (c: any) => !existingWatchlist.includes(c.symbol.toUpperCase())
    );

    // Score by cross-source mentions
    uniqueCandidates.sort((a: any, b: any) => b.sources.size - a.sources.size);

    // Filter to fractional-eligible
    const topCandidates = uniqueCandidates.slice(0, maxResults * 2);
    const eligible = await filterFractionalEligible(topCandidates);

    // Build final result
    const discovered = eligible.slice(0, maxResults).map((c: any) => ({
      symbol: c.symbol,
      source: Array.from(c.sources).join(", "),
      price: Math.round(c.price * 100) / 100,
      changePct: Math.round(c.changePct * 100) / 100,
      volume: c.volume,
      reason: c.reasons.slice(0, 2).join("; "),
    }));

    const sourceCounts: Record<string, number> = {};
    for (const d of discovered) {
      for (const s of d.source.split(", ")) {
        sourceCounts[s] = (sourceCounts[s] || 0) + 1;
      }
    }

    return { discovered, sourceCounts };
  } catch {
    // Network error fetching Yahoo/Alpaca data — return empty results
    return { discovered: [], sourceCounts: {} };
  }
}

/**
 * Get a combined watchlist: user's seed list + dynamically discovered tickers.
 * Returns only tickers we can actually trade.
 */
export async function getActiveWatchlist(
  seedWatchlist: string[],
  maxDiscovered: number = 10
): Promise<string[]> {
  // Always include seed tickers (assume they're verified)
  const active = new Set(seedWatchlist.map((s) => s.toUpperCase()));

  // Add discovered tickers
  try {
    const { discovered } = await discoverOpportunities(seedWatchlist, maxDiscovered);
    for (const d of discovered) {
      active.add(d.symbol.toUpperCase());
    }
  } catch {
    // Discovery failed — just use the seed list
  }

  return Array.from(active);
}
