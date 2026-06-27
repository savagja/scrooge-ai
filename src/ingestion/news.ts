/**
 * Alpaca News API ingestion.
 * Fetches recent headlines for watchlist tickers.
 */

import crypto from "crypto";

const DATA_URL = "https://data.alpaca.markets";

function getHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY required");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

export interface NewsItem {
  id: string;
  symbol: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  createdAt: string;
}

const seenHashes = new Set<string>();

export async function fetchNews(watchlist: string[], limit: number = 20): Promise<NewsItem[]> {
  if (watchlist.length === 0) return [];

  const symbols = watchlist.join(",");
  const start = new Date(Date.now() - 5 * 60000).toISOString(); // last 5 minutes

  const url = new URL(`${DATA_URL}/v1beta1/news`);
  url.searchParams.set("symbols", symbols);
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sort", "desc");
  url.searchParams.set("start", start);

  const res = await fetch(url.toString(), { headers: getHeaders() });
  if (!res.ok) {
    console.warn(`[NEWS] Fetch error: ${res.status} ${await res.text()}`);
    return [];
  }

  const data = await res.json();
  const items: NewsItem[] = [];

  for (const article of data.news || []) {
    // Filter to relevant symbols
    const relevant = (article.symbols || []).filter((s: string) =>
      watchlist.includes(s.toUpperCase())
    );
    if (relevant.length === 0) continue;

    // Deduplicate
    const hash = crypto
      .createHash("sha256")
      .update(`${article.headline}-${relevant.join(",")}-${article.created_at}`)
      .digest("hex")
      .slice(0, 16);

    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    // Prune old hashes
    if (seenHashes.size > 500) {
      const arr = Array.from(seenHashes);
      seenHashes.clear();
      arr.slice(-100).forEach((h) => seenHashes.add(h));
    }

    // Skip very old items
    const age = Date.now() - new Date(article.created_at).getTime();
    if (age > 300000) continue; // older than 5 minutes

    items.push({
      id: hash,
      symbol: relevant[0],
      headline: article.headline || "",
      summary: article.summary || "",
      source: article.source || "unknown",
      url: article.url || "",
      createdAt: article.created_at,
    });
  }

  return items;
}
