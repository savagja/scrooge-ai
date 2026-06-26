/**
 * Expanded news scanner — scans ALL headlines, not just watchlist.
 * Let the LLM filter for relevance to any ticker or sector.
 */

const DATA_URL = "https://data.alpaca.markets";

function getHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca credentials not set");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

export interface ExpandedNewsItem {
  id: string;
  symbols: string[];
  headline: string;
  summary: string;
  source: string;
  createdAt: string;
}

/**
 * Fetch ALL recent news (not filtered by watchlist).
 * Returns top headlines across all tickers Alpaca covers.
 * The LLM decides which are relevant.
 */
export async function fetchAllNews(limit: number = 20): Promise<ExpandedNewsItem[]> {
  try {
    const start = new Date(Date.now() - 5 * 60000).toISOString();
    const url = new URL(`${DATA_URL}/v1beta1/news`);
    url.searchParams.set("limit", limit.toString());
    url.searchParams.set("sort", "desc");
    url.searchParams.set("start", start);

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) {
      console.warn(`[NEWS] Expanded fetch failed: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const items: ExpandedNewsItem[] = [];

    for (const article of data.news || []) {
      const symbols = (article.symbols || []).map((s: string) => s.toUpperCase());

      items.push({
        id: article.id || String(Date.now()),
        symbols,
        headline: article.headline || "",
        summary: article.summary || "",
        source: article.source || "unknown",
        createdAt: article.created_at,
      });
    }

    return items;
  } catch (e: any) {
    console.warn("[NEWS] Expanded parse error:", e.message);
    return [];
  }
}
