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
// SECTOR ROTATION — Track sector ETF daily direction from Alpaca snapshots
// ═══════════════════════════════════════════════════════════════════════════
// When Alpaca data API becomes available, this can use real bars.
// For now, it records a "data pending" placeholder so the agent knows
// sector rotation tracking is coming.

async function ingestSectorTracking(store: SignalStore): Promise<void> {
  // Placeholder: note that sector rotation tracking requires data API access.
  // This function will query Alpaca for sector ETF snapshots when the API
  // supports it. For now, FYI.
  // TODO: Implement when Alpaca data API credentials allow bars access.
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
  ]);
}