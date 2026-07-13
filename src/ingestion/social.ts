/**
 * Social sentiment tracker.
 * - Reddit: RSS feed parsing with rate limiting (Reddit blocks unauthenticated JSON)
 * - Tracks mention VELOCITY (mentions/hour), not just counts.
 *
 * NOTE: Reddit now blocks all unauthenticated API access (403 for JSON, 429/403 for RSS).
 * This module tries RSS with respectful rate limiting. If Reddit blocks us entirely,
 * we return empty results gracefully — the system runs fine without social data.
 *
 * A future upgrade could use a free proxy or a $5/mo data provider like Quiver Quantitative.
 * research DB's signal store to detect recent Reddit-related signals.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

interface MentionEntry {
  symbol: string;
  count: number;
  lastSeen: number; // timestamp
}

const DATA_DIR = join(process.cwd(), "data");
const MENTION_FILE = join(DATA_DIR, "social_mentions.json");

let mentionState: Record<string, MentionEntry> = {};

function loadMentions() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(MENTION_FILE)) {
    try {
      mentionState = JSON.parse(readFileSync(MENTION_FILE, "utf-8"));
    } catch {
      mentionState = {};
    }
  }
}

function saveMentions() {
  writeFileSync(MENTION_FILE, JSON.stringify(mentionState, null, 2));
}

loadMentions();

const REDDIT_RATE_LIMIT_MS = 60000; // Max 1 request per minute to Reddit
const REDDIT_BLACKLIST_MS = 5 * 60 * 1000; // If Reddit blocks us, don't retry for 5 min
let _lastRedditFetch = 0;
let _lastRedditBlocked = 0; // When we last got a 4xx from Reddit

/**
 * Fetch from Reddit with built-in rate limiting.
 * If Reddit returns a 4xx, we blacklist it for 5 minutes to avoid wasting cycles.
 * Returns null if we can't fetch (rate limited, blocked, or error).
 */
async function fetchRedditWithRateLimit(url: string, headers: Record<string, string>): Promise<Response | null> {
  const now = Date.now();
  
  // If Reddit recently blocked us, skip entirely
  if (now - _lastRedditBlocked < REDDIT_BLACKLIST_MS) {
    return null;
  }
  
  // Rate limit: max 1 request per 60s
  const elapsed = now - _lastRedditFetch;
  if (elapsed < REDDIT_RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, REDDIT_RATE_LIMIT_MS - elapsed));
  }
  _lastRedditFetch = Date.now();
  
  try {
    const res = await fetch(url, { headers });
    
    // If blocked, set blacklist
    if (res.status === 403 || res.status === 429) {
      _lastRedditBlocked = Date.now();
      return null;
    }
    
    return res;
  } catch {
    return null;
  }
}

/**
 * Scan Reddit for mentions of watchlist tickers.
 * Uses Reddit RSS with respectful rate limiting (1 req/min).
 * If RSS fails, tries old.reddit.com JSON as fallback.
 * Returns mention velocity (mentions in last hour vs previous hour).
 */
export interface RedditScan {
  symbol: string;
  totalMentions: number;
  mentionsLastHour: number;
  velocity: number; // ratio: last hour / previous hour
  topPosts: Array<{ title: string; subreddit: string; score: number; url: string }>;
  source: string; // which approach succeeded
}

/**
 * Try to parse ticker mentions from HTML/RSS content.
 * Looks for $TICKER, $ticker patterns and standalone uppercase 3-5 letter symbols.
 */
function extractTickers(text: string, symbols: string[]): string[] {
  const found: string[] = [];
  for (const sym of symbols) {
    // Match $TICKER, $ticker, or standalone SYMBOL (word boundary)
    const pattern = new RegExp(`(?:\\$|(?<![A-Z]))${sym}(?![A-Z])`, "i");
    if (pattern.test(text)) found.push(sym);
  }
  return found;
}

/**
 * Approach 1: old.reddit.com JSON API (still works sometimes for bots).
 */
async function scanOldRedditJson(subreddits: string[], watchlist: string[], oneHour: number): Promise<RedditScan[]> {
  const results: RedditScan[] = [];

  for (const sub of subreddits) {
    try {
      const res = await fetch(
        `https://old.reddit.com/r/${sub}/new.json?limit=100`,
        { headers: { "User-Agent": "ScroogeBot/1.0 (contact@example.com)" } }
      );
      if (!res.ok) continue;

      const data = await res.json();
      const posts = data.data?.children || [];
      const now = Date.now();

      for (const post of posts) {
        const p = post.data;
        const title = String(p.title || "");
        const selftext = String(p.selftext || "");
        const combined = `${title} ${selftext}`;
        const created = (p.created_utc || 0) * 1000;

        const foundTickers = extractTickers(combined, watchlist);
        if (foundTickers.length === 0) continue;

        for (const symbol of foundTickers) {
          if (!mentionState[symbol]) {
            mentionState[symbol] = { symbol, count: 0, lastSeen: 0 };
          }
          mentionState[symbol].count++;
          mentionState[symbol].lastSeen = now;

          let result = results.find((r) => r.symbol === symbol);
          if (!result) {
            result = {
              symbol,
              totalMentions: 0,
              mentionsLastHour: 0,
              velocity: 0,
              topPosts: [],
              source: "old.reddit.com JSON",
            };
            results.push(result);
          }

          result.totalMentions++;
          if (now - created < oneHour) {
            result.mentionsLastHour++;
          }

          if (result.topPosts.length < 3) {
            result.topPosts.push({
              title: p.title,
              subreddit: sub,
              score: p.score || 0,
              url: `https://reddit.com${p.permalink}`,
            });
          }
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}

export async function scanRedditMentions(
  watchlist: string[]
): Promise<RedditScan[]> {
  const subreddits = ["wallstreetbets", "stocks", "wallstreetbetselite"];
  const oneHour = 3600000;
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ScroogeBot/1.0";

  // Try RSS first (most reliable with proper rate limiting)
  let results: RedditScan[] = [];
  for (const sub of subreddits) {
    const res = await fetchRedditWithRateLimit(
      `https://www.reddit.com/r/${sub}/.rss`,
      { "User-Agent": ua }
    );

    if (!res || !res.ok) continue;

    try {
      const xml = await res.text();
      const now = Date.now();

      // Parse entries
      const entryRegex = /<entry>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<content[^>]*>(.*?)<\/content>[\s\S]*?<\/entry>/gi;
      let match;

      while ((match = entryRegex.exec(xml)) !== null) {
        const title = match[1] || "";
        const decodedTitle = title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'");
        const foundTickers = extractTickers(decodedTitle, watchlist);
        if (foundTickers.length === 0) continue;

        for (const symbol of foundTickers) {
          if (!mentionState[symbol]) {
            mentionState[symbol] = { symbol, count: 0, lastSeen: 0 };
          }
          mentionState[symbol].count++;
          mentionState[symbol].lastSeen = now;

          let result = results.find((r) => r.symbol === symbol);
          if (!result) {
            result = {
              symbol,
              totalMentions: 0,
              mentionsLastHour: 0,
              velocity: 0,
              topPosts: [],
              source: "reddit RSS",
            };
            results.push(result);
          }

          result.totalMentions++;
          result.mentionsLastHour++;

          if (result.topPosts.length < 3) {
            result.topPosts.push({
              title: decodedTitle.slice(0, 200),
              subreddit: sub,
              score: 0,
              url: `https://reddit.com/r/${sub}`,
            });
          }
        }
      }
    } catch {
      continue;
    }

    // If we got results from this subreddit, don't hit more
    if (results.length > 0) break;
  }

  // If RSS got nothing, try old.reddit.com JSON (usually blocked but worth trying)
  if (results.length === 0) {
    results = await scanOldRedditJson(subreddits, watchlist, oneHour);
  }

  // Calculate velocity
  for (const result of results) {
    const entry = mentionState[result.symbol];
    if (entry) {
      const density = result.mentionsLastHour / Math.max(1, result.totalMentions);
      result.velocity = Math.round(density * 100) / 100;
    }
  }

  saveMentions();
  return results.sort((a, b) => b.velocity - a.velocity);
}

/**
 * Get the "hottest" tickers on Reddit right now.
 */
export async function getRedditHot(watchlist: string[]): Promise<string[]> {
  const scans = await scanRedditMentions(watchlist);
  return scans.filter((s) => s.velocity > 0.3 || s.mentionsLastHour >= 3).map((s) => s.symbol);
}
