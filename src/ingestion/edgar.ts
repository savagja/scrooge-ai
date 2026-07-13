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
 *
 * ARCHITECTURE NOTE:
 * SEC RSS does NOT include tickers. It provides CIK (Central Index Key) numbers.
 * We resolve CIK -> ticker via the SEC Company Submissions API:
 *   https://data.sec.gov/submissions/CIK{0000XXXXXX}.json
 * This is the official SEC endpoint, returns ticker, name, exchange, etc.
 * Results are cached in-memory to avoid hammering the API.
 */

import { XMLParser } from "fast-xml-parser";

const EDGAR_RSS = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom";
const SEC_HEADERS = { "User-Agent": "ScroogeBot/1.0 (contact@example.com)" };

// ═══════════════════════════════════════════════════════════════════════════
// CIK -> TICKER CACHE
// ═══════════════════════════════════════════════════════════════════════════

const _cikCache = new Map<string, string | null>();

/**
 * Resolve a CIK to its ticker symbol using the SEC Company Submissions API.
 * Results cached in-memory (no TTL — CIKs don't change).
 */
async function cikToTicker(cik: string): Promise<string | null> {
  if (_cikCache.has(cik)) return _cikCache.get(cik) ?? null;

  try {
    // Strip leading zeros for lookup
    const paddedCik = cik.startsWith("000") ? cik : cik.padStart(10, "0");
    const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ScroogeBot/1.0 (contact@example.com)",
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      _cikCache.set(cik, null);
      return null;
    }

    const data = await res.json();
    // SEC API returns tickers array on submission object or on the main object
    const tickers = data.tickers || [];
    let ticker: string | null = null;
    if (tickers.length > 0) {
      ticker = typeof tickers[0] === "string" ? tickers[0] : (tickers[0].ticker || null);
    }

    _cikCache.set(cik, ticker);
    return ticker;
  } catch {
    _cikCache.set(cik, null);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

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
 * The high-impact 8-K items we care about.
 * SEC defines these exactly; any filing mentioning these is worth flagging.
 */
const HIGH_IMPACT_ITEMS = ["1.01", "2.02", "5.02", "7.01", "8.01", "2.01"];

/**
 * Fetch the latest 8-K filings from EDGAR RSS.
 * Returns filings with high-impact items, with tickers resolved from CIK.
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

    const rawEntries = parsed.feed?.entry || [];
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];

    // Phase 1: Extract CIK and items from RSS (fast, no API calls)
    const parsedEntries: Array<{
      id: string;
      title: string;
      cik: string;
      companyName: string;
      filingDate: string;
      items: string[];
      link: string;
    }> = [];

    for (const entry of entries) {
      const title = String(entry.title || "");
      const filingId = String(entry.id || "");

      // Dedup
      if (seenFilings.has(filingId)) continue;
      seenFilings.add(filingId);
      if (seenFilings.size > 200) {
        const arr = Array.from(seenFilings);
        seenFilings.clear();
        arr.slice(-100).forEach((h) => seenFilings.add(h));
      }

      // Extract CIK from title: "8-K - COMPANY NAME (0000123456) (Filer)"
      const cikMatch = title.match(/\((\d+)\)/);
      const cik = cikMatch ? cikMatch[1] : "";

      // Extract company name: remove "8-K - " prefix and " (CIK) (Filer)" suffix
      const companyName = title
        .replace(/^8-K\s*-\s*/i, "")
        .replace(/\s*\(\d+\)\s*\(Filer\)\s*$/i, "")
        .trim();

      // Extract items from <summary> (SEC uses <summary>, not <content>)
      let summaryText = "";
      if (entry.summary) {
        if (typeof entry.summary === "string") {
          summaryText = entry.summary;
        } else if (entry.summary["#text"]) {
          summaryText = entry.summary["#text"];
        }
        summaryText = summaryText.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      }

      const itemMatches = summaryText.match(/Item\s+([\d.]+)/g);
      const items = itemMatches
        ? itemMatches.map((m: string) => m.replace(/Item\s+/, ""))
        : [];

      // Filing date from <updated>
      const filingDate = String(entry.updated || entry.filed || new Date().toISOString());

      // Link
      let link = "";
      if (typeof entry.link === "string") {
        link = entry.link;
      } else if (entry.link?.["@_href"]) {
        link = entry.link["@_href"];
      }

      parsedEntries.push({
        id: filingId,
        title,
        cik,
        companyName: companyName || title,
        filingDate,
        items,
        link,
      });
    }

    // Phase 2: Filter to high-impact items only and resolve tickers
    const filings: EdgarEntry[] = [];

    for (const pe of parsedEntries) {
      const hasHighImpact = pe.items.some((i: string) =>
        HIGH_IMPACT_ITEMS.some((hi) => i.includes(hi))
      );

      if (!hasHighImpact && !pe.cik) continue;

      // Resolve CIK to ticker (only for entries we're keeping — saves API calls)
      let ticker = "";
      if (pe.cik) {
        const resolved = await cikToTicker(pe.cik);
        if (resolved) ticker = resolved.toUpperCase();
      }

      // Check watchlist relevance (now with real ticker)
      const isRelevantTicker = watchlist.some(
        (w) => ticker.toUpperCase() === w.toUpperCase()
      );

      if (!isRelevantTicker && !hasHighImpact) continue;

      filings.push({
        id: pe.id,
        cik: pe.cik,
        ticker,
        companyName: pe.companyName,
        filingDate: pe.filingDate,
        items: pe.items,
        title: pe.title,
        link: pe.link,
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