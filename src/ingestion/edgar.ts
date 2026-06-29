/**
 * SEC EDGAR RSS feed parser.
 * Monitors 8-K filings for material events BEFORE they hit news wires.
 * Free, no API key, no rate limits (be polite, poll every 30s).
 *
 * 8-K events that move stocks:
 * - Item 1.01: Material definitive agreements (contracts, partnerships)
 * - Item 2.02: Results of operations / financial results (earnings pre-announcements)
 * - Item 7.01: Regulation FD disclosure (selective disclosure events)
 * - Item 8.01: Other events (often used for material announcements)
 * - Item 5.02: Departure of directors / principal officers
 * - Item 2.01: Completion of acquisition or disposition of assets
 */

import { XMLParser } from "fast-xml-parser";

const EDGAR_RSS = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom";
const SEC_HEADERS = { "User-Agent": "ScroogeBot/1.0 (contact@example.com)" };

export interface EdgarEntry {
  id: string;
  cik: string;
  ticker: string;
  companyName: string;
  filingDate: string;
  items: string[];
  title: string;
  link: string;
}

// Deduplication
const seenFilings = new Set<string>();

/**
 * Fetch the latest 8-K filings from EDGAR RSS.
 * Returns only filings relevant to our watchlist.
 */
export async function fetchEdgarFilings(watchlist: string[]): Promise<EdgarEntry[]> {
  try {
    const res = await fetch(EDGAR_RSS, { headers: SEC_HEADERS });
    if (!res.ok) {
      console.warn(`[EDGAR] RSS fetch failed: ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);

    const entries = parsed.feed?.entry || [];
    const filings: EdgarEntry[] = [];

    for (const entry of entries) {
      const title = String(entry.title || "");
      const content = String(entry.content?._ || entry.content || "");
      const filingId = String(entry.id || "");
      const link = String(entry.link?.["@_href"] || entry.link || "");
      const filingDate = String(entry.updated || entry.filed || new Date().toISOString());

      // Extract CIK and ticker from content
      const cikMatch = content.match(/CIK=(\d+)/);
      const cik = cikMatch ? cikMatch[1] : "";

      const tickerMatch = content.match(/(CIK=\d+).*?>([A-Z]+)</);
      const ticker = tickerMatch ? tickerMatch[2] : "";

      // Extract 8-K items
      const itemMatches = content.match(/Item\s+([\d.]+)/g);
      const items = itemMatches ? itemMatches.map((m: string) => m.replace(/Item\s+/, "")) : [];

      // Dedup
      if (seenFilings.has(filingId)) continue;
      seenFilings.add(filingId);
      if (seenFilings.size > 200) {
        const arr = Array.from(seenFilings);
        seenFilings.clear();
        arr.slice(-100).forEach((h) => seenFilings.add(h));
      }

      // Only keep filings for watchlist or filings with high-impact items
      const isRelevantTicker = watchlist.some(
        (w) => ticker.toUpperCase() === w.toUpperCase()
      );

      const highImpactItems = ["1.01", "2.02", "5.02", "7.01", "8.01", "2.01"];
      const hasHighImpact = items.some((i: string) =>
        highImpactItems.some((hi) => i.includes(hi))
      );

      if (!isRelevantTicker && !hasHighImpact) continue;

      // Parse company name from title
      const companyName = title
        .replace(/\s*-\s*8-K\s*$/i, "")
        .replace(/\s*-\s*Current report\s*$/i, "")
        .trim();

      filings.push({
        id: filingId,
        cik,
        ticker: ticker.toUpperCase(),
        companyName,
        filingDate,
        items,
        title,
        link,
      });
    }

    return filings.reverse(); // oldest first
  } catch (e: any) {
    console.warn("[EDGAR] Parse error:", e.message);
    return [];
  }
}

/**
 * Score an 8-K filing for market impact potential.
 * Returns a simple heuristic score the agent can use.
 */
export function scoreFiling(filing: EdgarEntry): { score: number; reason: string } {
  const items = filing.items;
  let score = 0;
  const reasons: string[] = [];

  // Item 1.01: Material agreements (partnerships, major contracts)
  if (items.some((i) => i.includes("1.01"))) {
    score += 6;
    reasons.push("Material definitive agreement");
  }

  // Item 2.02: Financial results (often earnings-related)
  if (items.some((i) => i.includes("2.02"))) {
    score += 7;
    reasons.push("Financial results disclosed");
  }

  // Item 2.01: Acquisition/divestiture completion
  if (items.some((i) => i.includes("2.01"))) {
    score += 8;
    reasons.push("Acquisition/divestiture completed");
  }

  // Item 5.02: Officer departure (often negative)
  if (items.some((i) => i.includes("5.02"))) {
    score += 5;
    reasons.push("Director/officer departure");
  }

  // Item 7.01: Regulation FD (selective disclosure, can be market-moving)
  if (items.some((i) => i.includes("7.01"))) {
    score += 4;
    reasons.push("Regulation FD disclosure");
  }

  // Item 8.01: Other events (catch-all, vague but frequent)
  if (items.some((i) => i.includes("8.01"))) {
    score += 3;
    reasons.push("Other material event");
  }

  // Bonus: If we have a ticker match in our watchlist
  if (filing.ticker) {
    score += 2;
    reasons.push("Known ticker");
  }

  return {
    score: Math.min(10, score),
    reason: reasons.join("; ") || "General 8-K filing",
  };
}

/**
 * Map CIK to ticker (simplified lookup for common names).
 * SEC doesn't include tickers in the RSS, so we try to infer.
 */
export function resolveTickerFromName(companyName: string): string | null {
  // Common company name mappings for quick lookup
  const knownMappings: Record<string, string> = {
    "APPLE": "AAPL",
    "TESLA": "TSLA",
    "NVIDIA": "NVDA",
    "MICROSOFT": "MSFT",
    "AMAZON": "AMZN",
    "ALPHABET": "GOOGL",
    "META": "META",
    "NETFLIX": "NFLX",
    "SALESFORCE": "CRM",
    "ADVANCED MICRO DEVICES": "AMD",
    "PALANTIR": "PLTR",
    "COINBASE": "COIN",
    "ROBINHOOD": "HOOD",
  };

  const upper = companyName.toUpperCase();
  for (const [name, ticker] of Object.entries(knownMappings)) {
    if (upper.includes(name)) return ticker;
  }
  return null;
}
