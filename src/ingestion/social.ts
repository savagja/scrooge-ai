/**
 * Social sentiment tracker.
 * - Reddit: PRAW for r/wallstreetbets, r/stocks mention velocity
 * - Currently limited to Reddit (Twitter/X is $100+/mo, dead to us)
 *
 * Tracks mention VELOCITY (mentions/hour), not just counts.
 * The LLM can read top comments for sentiment quality.
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
 * Uses Reddit's JSON API (no auth required for public subs, but rate limited).
 * Returns mention velocity (mentions in last hour vs previous hour).
 */
export interface RedditScan {
  symbol: string;
  totalMentions: number;
  mentionsLastHour: number;
  velocity: number; // ratio: last hour / previous hour
  topPosts: Array<{ title: string; subreddit: string; score: number; url: string }>;
}

export async function scanRedditMentions(
  watchlist: string[]
): Promise<RedditScan[]> {
  const results: RedditScan[] = [];

  // Reddit JSON API for r/wallstreetbets + r/stocks
  const subreddits = ["wallstreetbets", "stocks", "wallstreetbetselite", "investing"];

  for (const sub of subreddits) {
    try {
      const res = await fetch(
        `https://www.reddit.com/r/${sub}/new.json?limit=100`,
        { headers: { "User-Agent": "ScroogeBot/1.0" } }
      );
      if (!res.ok) continue;

      const data = await res.json();
      const posts = data.data?.children || [];
      const now = Date.now();
      const oneHour = 3600000;

      for (const post of posts) {
        const p = post.data;
        const title = String(p.title || "");
        const selftext = String(p.selftext || "");
        const combined = `${title} ${selftext}`.toUpperCase();
        const created = (p.created_utc || 0) * 1000;

        for (const symbol of watchlist) {
          const tickerPattern = new RegExp(`\\b${symbol}\\b`, "i");
          if (!tickerPattern.test(combined)) continue;

          // Record mention
          if (!mentionState[symbol]) {
            mentionState[symbol] = { symbol, count: 0, lastSeen: 0 };
          }
          mentionState[symbol].count++;
          mentionState[symbol].lastSeen = now;

          // Find existing result or create new
          let result = results.find((r) => r.symbol === symbol);
          if (!result) {
            result = {
              symbol,
              totalMentions: 0,
              mentionsLastHour: 0,
              velocity: 0,
              topPosts: [],
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

  // Calculate velocity (last hour vs previous hour)
  // Since we don't store hourly history, we estimate from mention density
  for (const result of results) {
    const entry = mentionState[result.symbol];
    if (entry) {
      const hoursSinceLast = (Date.now() - entry.lastSeen) / 3600000;
      // If mentions are accelerating (many recent mentions), high velocity
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
