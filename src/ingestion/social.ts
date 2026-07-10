/**
 * Social sentiment tracker.
 * - Reddit: PRAW for r/wallstreetbets, r/stocks mention velocity
 * - Currently limited to Reddit (Twitter/X is $100+/mo, dead to us)
 *
 * Tracks mention VELOCITY (mentions/hour), not just counts.
 * The LLM can read top comments for sentiment quality.
 */

/**
 * Social sentiment tracker.
 * - Reddit: old.reddit.com RSS/JSON fallback (undocumented JSON API now blocked)
 * - Tracks mention VELOCITY (mentions/hour), not just counts.
 *
 * Reddit JSON API now requires OAuth even for public subs (returns 403 with HTML).
 * We use two fallback approaches:
 *   1. old.reddit.com (sometimes still serves JSON to bots)
 *   2. Reddit RSS feed (always works, no auth, but only titles)
 *
 * If both fail, we return empty results. The LLM can still use the
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

/**
 * Scan Reddit for mentions of watchlist tickers.
 * Uses multiple fallback approaches since Reddit blocks the JSON API.
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

/**
 * Approach 2: Reddit RSS feed (always works, no auth).
 * Only has titles, no selftext, but enough to detect ticker mentions.
 */
async function scanRedditRss(subreddits: string[], watchlist: string[], oneHour: number): Promise<RedditScan[]> {
  const results: RedditScan[] = [];

  for (const sub of subreddits) {
    try {
      const res = await fetch(
        `https://www.reddit.com/r/${sub}/.rss`,
        { headers: { "User-Agent": "ScroogeBot/1.0 (contact@example.com)" } }
      );
      if (!res.ok) continue;

      const xml = await res.text();
      const now = Date.now();

      // Simple XML title extraction — parse <entry><title>...</title>
      const titleRegex = /<entry>[\s\S]*?<title>(.*?)<\/title>/gi;
      let match;
      while ((match = titleRegex.exec(xml)) !== null) {
        const title = match[1] || "";
        const foundTickers = extractTickers(title, watchlist);
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
          result.mentionsLastHour++; // RSS is always current

          if (result.topPosts.length < 3) {
            result.topPosts.push({
              title,
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
  }

  return results;
}

export async function scanRedditMentions(
  watchlist: string[]
): Promise<RedditScan[]> {
  const subreddits = ["wallstreetbets", "stocks", "wallstreetbetselite"];
  const oneHour = 3600000;

  // Try JSON approach first (fallback to old.reddit.com)
  let results = await scanOldRedditJson(subreddits, watchlist, oneHour);

  // If JSON returned nothing (blocked), try RSS
  if (results.length === 0) {
    results = await scanRedditRss(subreddits, watchlist, oneHour);
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
