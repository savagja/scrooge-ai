/**
 * X (Twitter) + StockTwits social sentiment tracker.
 *
 * Two free data sources:
 *   1. StockTwits public API (no auth) — trending symbols + per-ticker sentiment
 *   2. Nitter RSS — user timeline feeds for curated finfluencer accounts
 *
 * StockTwits: https://api.stocktwits.com/api/2/trending/symbols.json
 * Nitter RSS: https://nitter.net/{username}/rss
 *
 * Nitter is a privacy-respecting X frontend. User timeline RSS feeds work
 * reliably (proven). Search RSS is broken due to X's anti-scraping, so we
 * use curated account lists instead of open search.
 *
 * Both sources gracefully degrade to empty results if blocked.
 */

import crypto from "crypto";
import https from "https";

// ═══════════════════════════════════════════════════════════════════════════
// STOCKTWITS — free public API, no auth needed
// ═══════════════════════════════════════════════════════════════════════════

const ST_API = "https://api.stocktwits.com/api/2";

export interface StockTwitsTrendingSymbol {
  symbol: string;
  title: string;
  watchlist_count: number;
  trending_score: number;
  trend_summary: string | null;
  sector: string | null;
}

export interface StockTwitsMessage {
  id: string;
  symbol: string;
  body: string;
  username: string;
  created_at: string;
  sentiment: "Bullish" | "Bearish" | "Neutral" | null;
  likes: number;
}

/**
 * Fetch trending symbols from StockTwits.
 * Returns the top N trending symbols with scores and watchlist counts.
 * Free, no API key required.
 */
export async function fetchStockTwitsTrending(limit: number = 30): Promise<StockTwitsTrendingSymbol[]> {
  try {
    const res = await fetch(`${ST_API}/trending/symbols.json`, {
      headers: { "User-Agent": "ScroogeBot/1.0" },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[X-SOCIAL] StockTwits trending returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const symbols = data.symbols || [];

    return symbols
      .filter((s: any) => {
        // Filter to US equities only (exclude crypto, DRs, etc.)
        const cls = s.instrument_class || "";
        const sym = s.symbol || "";
        if (sym.includes(".")) return false; // Crypto format
        if (cls === "CRYPTO") return false;
        return true;
      })
      .slice(0, limit)
      .map((s: any) => ({
        symbol: s.symbol?.replace(/\.X$/, ""), // Strip .X suffix for crypto leftovers
        title: s.title || "",
        watchlist_count: s.watchlist_count || 0,
        trending_score: s.trending_score || 0,
        trend_summary: s.trends?.summary || null,
        sector: s.sector || s.fundamentals?.SectorName || null,
      }));
  } catch (e: any) {
    if (e.name !== "AbortError") {
      console.warn(`[X-SOCIAL] StockTwits trending error: ${e.message}`);
    }
    return [];
  }
}

/**
 * Fetch recent messages for a specific ticker on StockTwits.
 * Returns sentiment-labelled chat messages from traders.
 */
export async function fetchStockTwitsMessages(
  symbol: string,
  limit: number = 20
): Promise<StockTwitsMessage[]> {
  try {
    const res = await fetch(
      `${ST_API}/streams/symbol/${symbol.toUpperCase()}.json?limit=${limit}`,
      {
        headers: { "User-Agent": "ScroogeBot/1.0" },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!res.ok) {
      if (res.status !== 404) {
        console.warn(`[X-SOCIAL] StockTwits messages for ${symbol}: ${res.status}`);
      }
      return [];
    }

    const data = await res.json();
    const messages = data.messages || [];

    return messages.map((m: any) => ({
      id: String(m.id || ""),
      symbol: symbol.toUpperCase(),
      body: m.body || "",
      username: m.user?.username || "anonymous",
      created_at: m.created_at || "",
      sentiment: m.entities?.sentiment?.basic || null,
      likes: m.likes?.total || 0,
    }));
  } catch (e: any) {
    if (e.name !== "AbortError") {
      console.warn(`[X-SOCIAL] StockTwits messages ${symbol} error: ${e.message}`);
    }
    return [];
  }
}

/**
 * Get sentiment summary for a ticker from StockTwits.
 * Returns bullish/bearish ratio and total message count.
 */
export async function getStockTwitsSentiment(
  symbol: string
): Promise<{
  bullish: number;
  bearish: number;
  neutral: number;
  total: number;
  ratio: number; // bullish / (bullish + bearish)
} | null> {
  try {
    const messages = await fetchStockTwitsMessages(symbol, 30);
    if (messages.length === 0) return null;

    let bullish = 0;
    let bearish = 0;
    let neutral = 0;

    for (const m of messages) {
      if (m.sentiment === "Bullish") bullish++;
      else if (m.sentiment === "Bearish") bearish++;
      else neutral++;
    }

    const total = bullish + bearish + neutral;

    return {
      bullish,
      bearish,
      neutral,
      total,
      ratio: total > 0 ? bullish / Math.max(1, bullish + bearish) : 0.5,
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NITTER RSS — curated X/Twitter finfluencer account timelines
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Curated list of finfluencer accounts to track via Nitter RSS.
 * These are accounts that regularly tweet about stock picks, market moves,
 * and breaking news that affects tickers.
 *
 * Updated as accounts change or new ones emerge.
 */
const FINFLUENCER_ACCOUNTS: Record<string, string> = {
  // Stock pickers / analysts
  CitronResearch: "Citron Research (Andrew Left) — stock picks and shorts",
  TheStalwart: "Joe Weisenthal — markets commentary",
  unusual_whales: "Unusual Whales — options flow, market data",
  // News aggregators
  MarketWatch: "MarketWatch — financial news",
  ReutersBiz: "Reuters Business — breaking business news",
  // Media / commentators
  // Add more as discovered
};

const NITTER_BASE = "https://nitter.net";
const NITTER_RATE_LIMIT_MS = 30000; // 30s between Nitter requests
const NITTER_BLACKLIST_MS = 10 * 60 * 1000; // 10 min blacklist on failure

let _lastNitterFetch = 0;
let _lastNitterBlocked = 0;

export interface NitterTweet {
  id: string;
  username: string;
  displayName: string;
  title: string;
  description: string;
  pubDate: string;
  link: string;
  tickers: string[]; // Extracted $TICKER mentions
}

/**
 * Fetch Nitter RSS using Node.js https module instead of fetch/undici.
 * undici (Node.js fetch) gets empty responses from nitter.net's Caddy server
 * due to TLS fingerprint or HTTP protocol differences. The native https module
 * works fine.
 */
function fetchNitterRss(username: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${NITTER_BASE}/${username}/rss`);
    const req = https.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        resolve("");
        return;
      }
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.on("data", (chunk: string) => body += chunk);
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/**
 * Fetch a user's timeline from Nitter RSS and extract ticker mentions.
 * Rate-limited to 1 request per 30s, blacklisted for 10min on failure.
 */
async function fetchNitterUserFeed(username: string): Promise<NitterTweet[]> {
  const now = Date.now();

  // If Nitter recently blocked us, skip
  if (now - _lastNitterBlocked < NITTER_BLACKLIST_MS) {
    return [];
  }

  // Rate limit
  const elapsed = now - _lastNitterFetch;
  if (elapsed < NITTER_RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, NITTER_RATE_LIMIT_MS - elapsed));
  }
  _lastNitterFetch = Date.now();

  try {
    const xml = await fetchNitterRss(username);
    if (!xml || xml.length < 100) {
      // Empty body — nitter may be blocking us
      _lastNitterBlocked = Date.now();
      return [];
    }

    // Check if we got HTML (error page) instead of XML
    const trimmed = xml.trim();
    if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
      _lastNitterBlocked = Date.now();
      return [];
    }

    // Parse RSS items
    const tweets: NitterTweet[] = [];
    const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<description>(.*?)<\/description>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<guid[^>]*>(.*?)<\/guid>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/gi;

    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) !== null) {
      const title = decodeHtmlEntities(match[1] || "");
      const description = decodeHtmlEntities(stripHtml(match[2] || ""));
      const pubDate = match[3] || "";
      const guid = match[4] || "";
      const link = match[5] || "";

      const combined = `${title} ${description}`;
      const tickers = extractCashtags(combined);

      // Only include tweets that mention at least one ticker
      if (tickers.length > 0) {
        tweets.push({
          id: guid,
          username,
          displayName: FINFLUENCER_ACCOUNTS[username] || username,
          title,
          description,
          pubDate,
          link,
          tickers,
        });
      }
    }

    return tweets;
  } catch (e: any) {
    if (e.name !== "AbortError") {
      console.warn(`[X-SOCIAL] Nitter ${username} error: ${e.message}`);
    }
    return [];
  }
}

/**
 * Fetch recent tweets mentioning tickers from all tracked finfluencer accounts.
 * Returns a deduplicated map of ticker → tweet references.
 */
export async function fetchFinfluencerTweets(): Promise<
  Map<string, { tweets: NitterTweet[]; accountCount: number }>
> {
  const tickerMap = new Map<string, { tweets: NitterTweet[]; accountCount: number }>();
  const accountsWithTicker = new Set<string>();

  // Fetch all accounts in parallel — nitter.net handles concurrent requests fine
  const results = await Promise.allSettled(
    Object.keys(FINFLUENCER_ACCOUNTS).map((username) => fetchNitterUserFeed(username))
  );

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const tweets = result.value;
    for (const tweet of tweets {
      for (const ticker of tweet.tickers) {
        if (!tickerMap.has(ticker)) {
          tickerMap.set(ticker, { tweets: [], accountCount: 0 });
        }
        tickerMap.get(ticker)!.tweets.push(tweet);
        accountsWithTicker.add(`${ticker}:${username}`);
      }
    }
  }

  // Count unique accounts per ticker
  for (const [ticker] of tickerMap) {
    const uniqueAccounts = new Set<string>();
    for (const [key] of accountsWithTicker) {
      if (key.startsWith(`${ticker}:`)) {
        uniqueAccounts.add(key.split(":")[1]);
      }
    }
    tickerMap.get(ticker)!.accountCount = uniqueAccounts.size;
  }

  return tickerMap;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract $TICKER cashtags from text.
 * Matches $AAPL, $TSLA, $MSFT, etc. — standard stock ticker format on X/Twitter.
 */
function extractCashtags(text: string): string[] {
  const tickers = new Set<string>();
  const regex = /\$([A-Z]{1,5})(?:\b|$)/g;
  let match;

  while ((match = regex.exec(text.toUpperCase())) !== null) {
    const ticker = match[1];
    // Filter out common false positives
    if (isValidTicker(ticker)) {
      tickers.add(ticker);
    }
  }

  return Array.from(tickers);
}

/**
 * Validate a potential ticker symbol.
 * Excludes common non-stock patterns.
 */
const KNOWN_NON_TICKERS = new Set([
  "USD", "EUR", "GBP", "JPY", "BTC", "ETH", "XRP", "ADA", "SOL", "DOT",
  "A", "I", "THE", "FOR", "AND", "NOT", "YOU", "ARE", "ALL", "CAN",
  "NEW", "NOW", "GET", "OUT", "HAS", "HAD", "BUT", "ITS", "WAS",
  "ONE", "TWO", "SIX", "BIG", "TOP", "HOT", "RED", "BEST", "FREE",
  "WILL", "JUST", "LIKE", "MORE", "THAT", "THIS", "WITH", "FROM",
  "HAVE", "BEEN", "GOOD", "DOWN", "OVER", "INTO", "ONLY", "VERY",
  "WHEN", "WHAT", "WHICH", "YOUR", "ABOUT", "THAN", "THEN",
]);

function isValidTicker(ticker: string): boolean {
  // Must be 1-5 uppercase letters
  if (!/^[A-Z]{1,5}$/.test(ticker)) return false;
  // Exclude known non-tickers
  if (KNOWN_NON_TICKERS.has(ticker)) return false;
  // Exclude single-letter tickers that are common words
  if (ticker.length === 1 && !["A", "I"].includes(ticker)) return false;
  return true;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/&lt;!\[CDATA\[/g, "").replace(/\]\]&gt;/g, "");
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSITE SCAN — combines both sources
// ═══════════════════════════════════════════════════════════════════════════

export interface XSocialScan {
  symbol: string;
  source: "stocktwits_trending" | "stocktwits_sentiment" | "nitter_finfluencer";
  score: number; // 0-1 normalized
  direction: number; // -1 bearish, 0 neutral, 1 bullish
  payload: Record<string, any>;
}

/**
 * Full X/Twitter + StockTwits scan.
 * Returns signals suitable for the research DB.
 */
export async function scanXSocial(watchlist: string[]): Promise<XSocialScan[]> {
  const signals: XSocialScan[] = [];

  // 1. StockTwits trending symbols (broad discovery)
  try {
    const trending = await fetchStockTwitsTrending(30);
    for (const t of trending) {
      const score = Math.min(1.0, t.trending_score / 10);
      signals.push({
        symbol: t.symbol,
        source: "stocktwits_trending",
        score,
        direction: 0,
        payload: {
          trending_score: t.trending_score,
          watchlist_count: t.watchlist_count,
          trend_summary: t.trend_summary,
          sector: t.sector,
        },
      });
    }
  } catch {
    // Graceful degradation
  }

  // 2. StockTwits per-ticker sentiment for watchlist
  if (watchlist.length > 0) {
    // Process in batches to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < watchlist.length; i += batchSize) {
      const batch = watchlist.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (symbol) => {
          const sentiment = await getStockTwitsSentiment(symbol);
          if (!sentiment || sentiment.total < 3) return; // Need minimum sample

          const score = Math.min(1.0, sentiment.total / 50);
          const direction = sentiment.ratio > 0.6 ? 1 : sentiment.ratio < 0.4 ? -1 : 0;

          signals.push({
            symbol,
            source: "stocktwits_sentiment",
            score,
            direction,
            payload: {
              bullish: sentiment.bullish,
              bearish: sentiment.bearish,
              neutral: sentiment.neutral,
              total: sentiment.total,
              ratio: sentiment.ratio,
            },
          });
        })
      );
      // Small delay between batches
      if (i + batchSize < watchlist.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // 3. Nitter finfluencer tweets (curated account timelines)
  try {
    const finfluencerTweets = await fetchFinfluencerTweets();
    for (const [symbol, data] of finfluencerTweets) {
      const score = Math.min(1.0, data.tweets.length / 10);
      signals.push({
        symbol,
        source: "nitter_finfluencer",
        score,
        direction: 0,
        payload: {
          tweetCount: data.tweets.length,
          accountCount: data.accountCount,
          recentTweets: data.tweets.slice(0, 3).map((t) => ({
            account: t.username,
            title: t.title.slice(0, 200),
          })),
        },
      });
    }
  } catch {
    // Graceful degradation
  }

  return signals;
}