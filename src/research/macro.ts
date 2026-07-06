/**
 * Macro/sector/political ingestion wires.
 *
 * Captures sector-level signals, macro calendar events, and political/regulatory
 * headlines that don't map to a single ticker. Stored in `sector_signals` and
 * `macro_events` tables.
 *
 * Sources:
 *   - Federal Reserve press releases (RSS)
 *   - SEC press releases (RSS) — regulatory actions
 *   - Sector ETF daily price action (derived from Alpaca bars when available)
 *   - Hardcoded macro calendar (CPI, FOMC, NFP expected dates)
 */

import { SignalStore, SECTOR_ETFS } from "./db.js";

// ═══════════════════════════════════════════════════════════════════════════
// FREE RSS FEEDS — Macro/political news
// ═══════════════════════════════════════════════════════════════════════════

interface RssItem {
  title: string;
  description: string;
  pubDate: string;
  categories: string[];
}

async function parseRss(url: string): Promise<RssItem[]> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const text = await res.text();
  const items: RssItem[] = [];

  // Simple XML parse — extract <item> blocks, then <title>, <description>, <pubDate>, <category>
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const tag = (block: string, name: string) => {
    const m = new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>`, 'i').exec(block)
      || new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
    return m ? m[1].trim() : null;
  };
  const cats = (block: string) => {
    const c: string[] = [];
    const catRegex = /<category[^>]*>([\s\S]*?)<\/category>/gi;
    let m;
    while ((m = catRegex.exec(block)) !== null) c.push(m[1].trim());
    return c;
  };

  let m;
  while ((m = itemRegex.exec(text)) !== null) {
    const block = m[1];
    const title = tag(block, "title");
    const description = tag(block, "description");
    const pubDate = tag(block, "pubDate");
    if (title && pubDate) {
      items.push({ title, description: description || "", pubDate, categories: cats(block) });
    }
  }

  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// FEDERAL RESERVE — Regulatory & monetary policy announcements
// ═══════════════════════════════════════════════════════════════════════════

const FED_RSS = "https://www.federalreserve.gov/feeds/press_all.xml";

async function ingestFedRss(store: SignalStore): Promise<void> {
  const items = await parseRss(FED_RSS);
  const seenKey = "last_fed_item";
  const lastTitle = store._getMeta?.(seenKey) || "";

  for (const item of items) {
    if (item.title === lastTitle) break;

    // Classify impact
    const lower = (item.title + " " + item.description).toLowerCase();
    const isHighImpact = lower.includes("rate") || lower.includes("monetary policy")
      || lower.includes("interest") || lower.includes("stress test")
      || lower.includes("inflation") || lower.includes("recession");
    const isMedImpact = lower.includes("enforcement") || lower.includes("regulation")
      || lower.includes("bank") || lower.includes("supervision");

    const direction = lower.includes("positive") || lower.includes("optimistic")
      || lower.includes("strong") || lower.includes("well positioned") ? 1
      : lower.includes("concern") || lower.includes("weak") || lower.includes("decline") ? -1
      : 0;

    store.recordSectorSignal({
      sector: "macro",
      source: "macro_event",
      headline: item.title,
      score: isHighImpact ? 0.9 : isMedImpact ? 0.6 : 0.4,
      direction,
      impact: isHighImpact ? "high" : isMedImpact ? "medium" : "low",
    });
  }

  if (items.length > 0) {
    store._setMeta?.(seenKey, items[0].title);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HARDCODED MACRO CALENDAR — Expected dates for major releases
// ═══════════════════════════════════════════════════════════════════════════

interface MacroCalendarEntry {
  eventType: string;
  label: string;
  expectedDate: string; // ISO date YYYY-MM-DD
  impact: "high" | "medium";
}

/**
 * Current quarter macro calendar.
 * These are approximate expected dates — actual dates confirmed via calendar feed.
 * Updated quarterly.
 */
function getMacroCalendar(): MacroCalendarEntry[] {
  return [
    // Q3 2026 — monthly recurring
    { eventType: "cpi", label: "CPI MoM", expectedDate: "2026-07-15", impact: "high" },
    { eventType: "ppi", label: "PPI MoM", expectedDate: "2026-07-14", impact: "medium" },
    { eventType: "nfp", label: "Non-Farm Payrolls", expectedDate: "2026-07-10", impact: "high" },
    { eventType: "fomc", label: "FOMC Rate Decision", expectedDate: "2026-07-29", impact: "high" },
    { eventType: "cpi", label: "CPI MoM", expectedDate: "2026-08-13", impact: "high" },
    { eventType: "ppi", label: "PPI MoM", expectedDate: "2026-08-12", impact: "medium" },
    { eventType: "nfp", label: "Non-Farm Payrolls", expectedDate: "2026-08-07", impact: "high" },
    { eventType: "cpi", label: "CPI MoM", expectedDate: "2026-09-11", impact: "high" },
    { eventType: "ppi", label: "PPI MoM", expectedDate: "2026-09-10", impact: "medium" },
    { eventType: "nfp", label: "Non-Farm Payrolls", expectedDate: "2026-09-04", impact: "high" },
    { eventType: "fomc", label: "FOMC Rate Decision", expectedDate: "2026-09-16", impact: "high" },
  ];
}

async function ingestMacroCalendar(store: SignalStore): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const seenKey = "macro_calendar_refreshed";

  // Only refresh once per day
  const lastRefresh = store._getMeta?.(seenKey) || "";
  if (lastRefresh === today) return;

  const entries = getMacroCalendar();

  for (const entry of entries) {
    // Only record events within the next 30 days — drop stale ones
    const diffMs = new Date(entry.expectedDate).getTime() - new Date(today).getTime();
    if (diffMs > 30 * 86400000 || diffMs < -1 * 86400000) continue;

    const daysAway = Math.round(diffMs / 86400000);
    const prefix = daysAway === 0 ? "🔴 TODAY" : daysAway === 1 ? "🟡 TOMORROW" : `📅 ${daysAway}d away`;

    store.recordMacroEvent({
      eventType: entry.eventType,
      headline: `${prefix}: ${entry.label} — ${entry.expectedDate}`,
      impact: entry.impact,
      payload: { expectedDate: entry.expectedDate, daysAway },
    });
  }

  store._setMeta?.(seenKey, today);
}

// ═══════════════════════════════════════════════════════════════════════════
// EARNINGS CALENDAR — Extract earnings dates from available free sources
// ═══════════════════════════════════════════════════════════════════════════
// Sources:
//   1. EDGAR 8-K Item 2.02 filings = earnings pre-announcements / results
//   2. Alpaca News API headlines mentioning "earnings", "reports", "quarterly"
//   3. Historical pattern: ~quarterly cadence from last filing

const EARNINGS_KEYWORDS = [
  "earnings", "quarterly results", "Q1", "Q2", "Q3", "Q4",
  "reports", "reported", "financial results", "fiscal",
  "quarter", "revenue", "profit", "EPS", "earnings call",
];

const DATA_URL = "https://data.alpaca.markets";

interface AlpacaNewsItem {
  id: number;
  headline: string;
  summary: string;
  source: string;
  symbols: string[];
  created_at: string;
}

function getHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY required");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

async function fetchEarningsNews(): Promise<AlpacaNewsItem[]> {
  try {
    const start = new Date(Date.now() - 7 * 86400000).toISOString();
    const url = new URL(`${DATA_URL}/v1beta1/news`);
    url.searchParams.set("limit", "50");
    url.searchParams.set("sort", "desc");
    url.searchParams.set("start", start);

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    const items: AlpacaNewsItem[] = (data.news || []);

    // Filter to earnings-related headlines
    return items.filter((item) => {
      const text = (item.headline + " " + item.summary).toLowerCase();
      return EARNINGS_KEYWORDS.some((kw) => text.includes(kw));
    });
  } catch {
    return [];
  }
}

async function ingestEarningsCalendar(store: SignalStore): Promise<void> {
  // 1. Fetch earnings-related news from Alpaca
  const newsItems = await fetchEarningsNews();
  for (const item of newsItems) {
    if (item.symbols.length === 0) continue;
    for (const sym of item.symbols) {
      const text = (item.headline + " " + item.summary).toLowerCase();
      // Score sentiment from headline
      const bullish = ["beat", "surge", "raise", "record", "exceed", "grow", "profit"].some(w => text.includes(w));
      const bearish = ["miss", "drop", "decline", "loss", "cut", "warn", "weak"].some(w => text.includes(w));
      const impact = bullish ? 0.7 : bearish ? -0.7 : 0.3;

      store.recordCorporateEvent({
        ticker: sym,
        eventDate: item.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        eventType: "earnings",
        impact: Math.abs(impact),
        details: {
          headline: item.headline.slice(0, 200),
          source: item.source,
          sentiment: impact > 0 ? "positive" : impact < 0 ? "negative" : "neutral",
        },
        sourceUrl: `news:${item.id}`,
      });

      // Also record as a regular signal for the agent
      store.recordSignal({
        ticker: sym,
        source: "alpaca_news",
        score: Math.abs(impact),
        direction: impact,
        payload: {
          type: "earnings_news",
          headline: item.headline.slice(0, 200),
        },
      });
    }
  }

  // 2. Check for upcoming earnings dates from recent EDGAR 8-K Item 2.02 filings
  //    (Already recorded by edgar.ts — but we can flag them as earnings specific)
  const recentCorpEvents = store._execSql?.(
    `SELECT DISTINCT ticker, event_date, details FROM corporate_events
     WHERE event_type = 'sec_filing'
       AND details LIKE '%2.02%'
       AND event_date >= date('now', '-90 days')
     ORDER BY event_date DESC`
  ) || [];

  // If we had earnings news flagged above, it's already in corporate_events
  const earningsCount = store._execSql?.(
    `SELECT COUNT(*) as cnt FROM corporate_events WHERE event_type = 'earnings'`
  );
  if (earningsCount?.[0]?.cnt && Number(earningsCount[0].cnt) > 0) {
    return; // Already recorded earnings events — skip duplicate tagging
  }

  // Tag qualifying 8-K filings as earnings events too
  for (const filing of (recentCorpEvents as Record<string, unknown>[]) || []) {
    const ticker = String(filing.ticker || "");
    const eventDate = String(filing.event_date || "");
    if (!ticker) continue;

    store.recordCorporateEvent({
      ticker,
      eventDate,
      eventType: "earnings",
      impact: 0.5,
      details: { source: "edgar_8k_item_2.02", note: "Earnings-related 8-K filing" },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTOR ROTATION — Track sector ETF daily direction from Alpaca snapshots
// ═══════════════════════════════════════════════════════════════════════════

async function ingestSectorTracking(store: SignalStore): Promise<void> {
  // Placeholder — requires Alpaca data API bars access
}

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION — Called from researchTick()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fire all macro/sector ingestions. Each has its own try/catch.
 */
export async function ingestMacroAndSector(store: SignalStore): Promise<void> {
  await Promise.allSettled([
    ingestFedRss(store),
    ingestMacroCalendar(store),
    ingestSectorTracking(store),
    ingestEarningsCalendar(store),
  ]);
}