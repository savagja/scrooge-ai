/**
 * Alpaca REST API wrapper for TypeScript.
 * No SDK dependency — raw fetch for full control.
 */

import type { Position } from "../types.js";

const BASE_URL = "https://paper-api.alpaca.markets";
const DATA_URL = "https://data.alpaca.markets";

// ─── Quote cache ──────────────────────────────────────────────────────────
// Prevents hammering the Alpaca Data API with duplicate quote requests.
// Only the SymbolNotionalBalance endpoint has generous limits;
// the data API quotes endpoint is rate-limited to ~200 req/min.
// Cache TTL: 30 seconds per ticker.
const quoteCache = new Map<string, { price: number; timestamp: number }>();
const QUOTE_CACHE_TTL_MS = 30_000;

function getCachedQuote(symbol: string): number | null {
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < QUOTE_CACHE_TTL_MS) {
    return cached.price;
  }
  return null;
}

function setCachedQuote(symbol: string, price: number): void {
  quoteCache.set(symbol, { price, timestamp: Date.now() });
}

function getHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY required");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
    "Content-Type": "application/json",
  };
}

function tradingUrl(path: string) {
  const base = process.env.ALPACA_PAPER === "false" ? "https://api.alpaca.markets" : BASE_URL;
  return `${base}/v2${path}`;
}

function dataUrl(path: string) {
  return `${DATA_URL}/v2${path}`;
}

export interface AccountSummary {
  cash: number;
  settledCash: number;
  equity: number;
  lastEquity: number;  // Previous close equity — useful for daily baseline
  buyingPower: number;
  status: string;
  daytradeCount: number;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  notional?: string;
  qty?: string;
  status: string;
  side: string;
  submittedAt: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  marketValue: string;
  avgEntryPrice: string;
  unrealizedPl: string;
}

export interface LatestQuote {
  askPrice: number;
  bidPrice: number;
}

export interface AlpacaClock {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
  timestamp: string;
}

// ─── Account ─────────────────────────────────────────────────────────────────

export async function getAccount(): Promise<AccountSummary> {
  const res = await fetch(tradingUrl("/account"), { headers: getHeaders() });
  if (!res.ok) throw new Error(`Alpaca account error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    cash: parseFloat(data.cash),
    settledCash: parseFloat(data.settled_cash ?? data.cash),  // fallback: cash = settled on off-hours
    equity: parseFloat(data.equity),
    lastEquity: parseFloat(data.last_equity ?? data.equity),  // fallback to current equity if missing
    buyingPower: parseFloat(data.buying_power),
    status: data.status,
    daytradeCount: data.daytrade_count || 0,
  };
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export async function submitOrder(params: {
  symbol: string;
  notional?: number;
  qty?: number;
  side: "buy" | "sell" | "sell_short";
  timeInForce?: "day" | "ioc" | "fok";
}): Promise<AlpacaOrder> {
  const body: Record<string, unknown> = {
    symbol: params.symbol,
    side: params.side,
    type: "market",
    time_in_force: params.timeInForce || "day",
  };

  if (params.notional !== undefined) {
    body.notional = params.notional.toFixed(2);
  } else if (params.qty !== undefined) {
    body.qty = params.qty.toString();
  } else {
    throw new Error("Must provide notional or qty");
  }

  const res = await fetch(tradingUrl("/orders"), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca order error: ${res.status} ${text}`);
  }

  const data = await res.json();
  return {
    id: data.id,
    symbol: data.symbol,
    notional: data.notional,
    qty: data.qty,
    status: data.status,
    side: data.side,
    submittedAt: data.submitted_at,
  };
}

export async function liquidateSymbol(symbol: string): Promise<{ success: boolean; order?: AlpacaOrder; error?: string }> {
  try {
    // Alpaca DELETE /v2/positions/{symbol} closes the position
    const res = await fetch(tradingUrl(`/positions/${symbol}`), {
      method: "DELETE",
      headers: getHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: text };
    }
    const data = await res.json();
    return {
      success: true,
      order: {
        id: data.id,
        symbol: data.symbol,
        qty: data.qty,
        status: data.status,
        side: data.side,
        submittedAt: data.submitted_at,
      },
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Buy to cover a short position — buys back the borrowed shares.
 * Alpaca requires side="buy" with a notional/qty that covers the short.
 */
export async function coverShort(symbol: string): Promise<{ success: boolean; order?: AlpacaOrder; error?: string }> {
  try {
    // Use DELETE /v2/positions/{symbol} which Alpaca handles as buy-to-cover
    const res = await fetch(tradingUrl(`/positions/${symbol}`), {
      method: "DELETE",
      headers: getHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: text };
    }
    const data = await res.json();
    return {
      success: true,
      order: {
        id: data.id,
        symbol: data.symbol,
        qty: data.qty,
        status: data.status,
        side: data.side,
        submittedAt: data.submitted_at,
      },
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function closeAllPositions(): Promise<void> {
  const res = await fetch(tradingUrl("/positions"), {
    method: "DELETE",
    headers: getHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Close all positions failed: ${text}`);
  }
}

// ─── Positions ───────────────────────────────────────────────────────────────

export async function getOpenPositions(): Promise<Position[]> {
  const res = await fetch(tradingUrl("/positions"), { headers: getHeaders() });
  if (!res.ok) throw new Error(`Positions error: ${res.status}`);
  const data = await res.json();
  return data.map((p: any) => ({
    symbol: p.symbol,
    qty: parseFloat(p.qty),
    entryPrice: parseFloat(p.avg_entry_price),
    entryTime: new Date().toISOString(), // Alpaca doesn't expose entry time directly
    holdUntil: new Date(Date.now() + 15 * 60000).toISOString(), // placeholder
    notional: parseFloat(p.market_value),
    unrealizedPnL: parseFloat(p.unrealized_pl),
    strategy: "unknown", // tracked internally
  }));
}

// ─── Quotes ────────────────────────────────────────────────────────────────────

export async function getLatestQuote(symbol: string): Promise<LatestQuote | null> {
  // Check cache first
  const cached = getCachedQuote(symbol);
  if (cached !== null) {
    return { askPrice: cached, bidPrice: cached };
  }

  const res = await fetch(dataUrl(`/stocks/${symbol}/quotes/latest`), { headers: getHeaders() });
  if (!res.ok) {
    console.warn(`[ALPACA] Quote error for ${symbol}: ${res.status}`);
    return null;
  }
  const data = await res.json();
  const quote = data.quote;
  const bidPrice = parseFloat(quote.bp);
  const askPrice = parseFloat(quote.ap);
  const midPrice = (bidPrice + askPrice) / 2;
  // Cache the mid price
  setCachedQuote(symbol, midPrice);
  return {
    askPrice,
    bidPrice,
  };
}

export async function getCurrentPrice(symbol: string): Promise<number | null> {
  // Check cache first
  const cached = getCachedQuote(symbol);
  if (cached !== null) {
    return cached;
  }

  // Use Alpaca's positions endpoint for the official mark price (`current_price`).
  // This is more reliable than the quote feed, especially in after-hours when
  // bid-ask spreads are wide and the last quote may be stale.
  try {
    const res = await fetch(tradingUrl(`/positions/${symbol}`), { headers: getHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data.current_price) {
        const price = parseFloat(data.current_price);
        setCachedQuote(symbol, price);
        return price;
      }
    }
  } catch {
    // fall through to quote
  }

  // Fallback to quote API for symbols without a position
  const quote = await getLatestQuote(symbol);
  if (quote) {
    const price = quote.bidPrice;
    setCachedQuote(symbol, price);
    return price;
  }
  return null;
}

// ─── Clock ───────────────────────────────────────────────────────────────────

export async function getClock(): Promise<AlpacaClock> {
  const res = await fetch(tradingUrl("/clock"), { headers: getHeaders() });
  if (!res.ok) throw new Error(`Clock error: ${res.status}`);
  const data = await res.json();
  return {
    isOpen: data.is_open,
    nextOpen: data.next_open,
    nextClose: data.next_close,
    timestamp: data.timestamp,
  };
}

export async function isMarketOpen(): Promise<boolean> {
  const clock = await getClock();
  return clock.isOpen;
}

// ─── Bars / Candles ────────────────────────────────────────────────────────────

export interface IntradayBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch today's intraday candlesticks for a symbol.
 * Returns 15-min bars from market open to now.
 * Used to give the agent a sense of position trajectory (direction, volatility, range).
 */
export async function getTodayBars(symbol: string): Promise<IntradayBar[]> {
  try {
    const now = new Date();
    // Market open today (9:30 AM ET = 13:30 UTC)
    const marketOpen = new Date(now);
    marketOpen.setUTCHours(13, 30, 0, 0);

    const start = marketOpen.toISOString();

    const url = new URL(`${DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "15Min");
    url.searchParams.set("start", start);
    url.searchParams.set("limit", "78"); // 15-min bars × 6.5 hours = ~26 bars max

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) return [];

    const data = await res.json();
    const bars = data.bars || [];
    return bars.map((b: any) => ({
      timestamp: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  } catch {
    return [];
  }
}

/**
 * Build a ticker summary context block — same format as the Position Context Spec.
 * Used both for open positions (perception prompt) and new ticker analysis (tool output).
 * Returns formatted text lines. For positions, pass entry info to enable RISK and THESIS sections.
 */
export async function buildTickerContext(params: {
  symbol: string;
  entryPrice?: number;       // If set, enables RISK + THESIS TRACKING sections
  qty?: number;
  unrealizedPnL?: number;
  highestPrice?: number;
  lowestPrice?: number;
  trailingStopPrice?: number | null;
  status?: string;
  holdUntil?: string;
  entryTime?: string;
  entryRegime?: string;
  entryVix?: number | null;
  entrySignalSource?: string;
  entrySignalConfidence?: number;
  entrySignalImpactScore?: number;
  strategy?: string;
  currentRegime?: string;
  currentVix?: number | null;
}): Promise<string[]> {
  const symbol = params.symbol.toUpperCase();
  const lines: string[] = [];
  const hasEntry = params.entryPrice !== undefined;

  // ── Header ──────────────────────────────────────────────
  const headerLen = 78;
  lines.push("═".repeat(headerLen));
  if (hasEntry) {
    const dirLabel = "long"; // direction from the position
    const qtyStr = params.qty ? params.qty.toFixed(4) : "";
    const entryStr = params.entryPrice ? `$${params.entryPrice.toFixed(2)}` : "";
    lines.push(`POSITION: [${symbol}] LONG ${qtyStr} @ ${entryStr}`);
    lines.push(`THESIS: ${params.entrySignalSource || "N/A"} | duration: ${params.entryTime ? Math.round((Date.now() - new Date(params.entryTime).getTime()) / 86400000) + "d" : "?"} | strategy: ${params.strategy || "?"} | source: ${params.entrySignalSource || "?"} | entry: ${params.entryTime ? params.entryTime.slice(0, 16).replace("T", " ") : "?"}`);
  } else {
    lines.push(`TICKER: [${symbol}]`);
  }
  lines.push("═".repeat(headerLen));

  // ── Fetch data in parallel ──────────────────────────────
  const [dailyBars, intradayBars] = await Promise.all([
    getDailyBars(symbol, 30),
    getTodayBars(symbol),
  ]);

  const currentPrice = dailyBars.length > 0 ? dailyBars[dailyBars.length - 1].close : (intradayBars.length > 0 ? intradayBars[intradayBars.length - 1].close : null);
  if (!currentPrice) {
    lines.push(`  (No price data available for ${symbol})`);
    return lines;
  }

  // ── PRICE ACTION ────────────────────────────────────────
  lines.push("");
  lines.push("─ PRICE ACTION ─");

  if (dailyBars && dailyBars.length >= 2) {
    const high30d = Math.max(...dailyBars.map(b => b.high));
    const low30d = Math.min(...dailyBars.map(b => b.low));
    const open30d = dailyBars[0].open;
    const net30d = ((currentPrice - open30d) / open30d * 100);
    const pctOfRange = high30d !== low30d ? ((currentPrice - low30d) / (high30d - low30d) * 100) : 50;
    const closes = dailyBars.slice(-5).map(b => `$${b.close.toFixed(2)}`).join(" → ");
    const avgVol = Math.round(dailyBars.reduce((s, b) => s + b.volume, 0) / dailyBars.length);

    lines.push(`  30d: $${low30d.toFixed(2)}–$${high30d.toFixed(2)} | current: ${pctOfRange.toFixed(0)}% of 30d range | net: ${net30d >= 0 ? "+" : ""}${net30d.toFixed(1)}% | avg vol: ${(avgVol / 1e6).toFixed(1)}M`);
    lines.push(`  5d closes: ${closes}`);
  }

  if (intradayBars && intradayBars.length > 0) {
    const hi = Math.max(...intradayBars.map(b => b.high));
    const lo = Math.min(...intradayBars.map(b => b.low));
    const open = intradayBars[0].open;
    const netToday = ((currentPrice - open) / open * 100);
    const pctOfDay = hi !== lo ? ((currentPrice - lo) / (hi - lo) * 100) : 50;
    const totalVol = intradayBars.reduce((s, b) => s + b.volume, 0);

    lines.push(`  1d: $${lo.toFixed(2)}–$${hi.toFixed(2)} | current: ${pctOfDay.toFixed(0)}% of 1d range | net: ${netToday >= 0 ? "+" : ""}${netToday.toFixed(2)}% | vol: ${(totalVol / 1e3).toFixed(0)}K`);

    // Last 8-ish bars (compact)
    const recentBars = intradayBars.slice(-8);
    const barStrings = recentBars.map(b => {
      const change = ((b.close - b.open) / b.open * 100);
      return `${b.timestamp.slice(11, 16)} C$${b.close.toFixed(2)} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    }).join(" | ");
    lines.push(`  1d bars (15m): ${barStrings}`);
  }

  // ── RELATIVE ────────────────────────────────────────────
  // Fetch SPY for comparison
  const spyDaily = await getDailyBars("SPY", 30);
  const spyIntraday = await getTodayBars("SPY");

  lines.push("");
  lines.push("─ RELATIVE ─");

  if (spyDaily && spyDaily.length >= 2 && dailyBars && dailyBars.length >= 2) {
    const spyOpen30d = spyDaily[0].open;
    const spyClose30d = spyDaily[spyDaily.length - 1].close;
    const spyNet30d = ((spyClose30d - spyOpen30d) / spyOpen30d * 100);
    const symOpen30d = dailyBars[0].open;
    const symNet30d = ((currentPrice - symOpen30d) / symOpen30d * 100);
    lines.push(`  vs SPY 30d: ${symNet30d >= 0 ? "+" : ""}${symNet30d.toFixed(1)}% vs ${spyNet30d >= 0 ? "+" : ""}${spyNet30d.toFixed(1)}%`);
  }

  if (spyIntraday && spyIntraday.length > 0 && intradayBars && intradayBars.length > 0) {
    const spyOpen = spyIntraday[0].open;
    const spyClose = spyIntraday[spyIntraday.length - 1].close;
    const spyNetToday = ((spyClose - spyOpen) / spyOpen * 100);
    const symOpen = intradayBars[0].open;
    const symNetToday = ((currentPrice - symOpen) / symOpen * 100);
    lines.push(`  vs SPY today: ${symNetToday >= 0 ? "+" : ""}${symNetToday.toFixed(2)}% vs ${spyNetToday >= 0 ? "+" : ""}${spyNetToday.toFixed(2)}%`);
  }

  if (dailyBars && dailyBars.length >= 2) {
    const avgVol = Math.round(dailyBars.reduce((s, b) => s + b.volume, 0) / dailyBars.length);
    const todayVol = intradayBars ? intradayBars.reduce((s, b) => s + b.volume, 0) : 0;
    const relVol = avgVol > 0 ? (todayVol / avgVol) : 0;
    lines.push(`  vol: ${(todayVol / 1e6).toFixed(1)}M today vs ${(avgVol / 1e6).toFixed(1)}M avg (${relVol.toFixed(1)}x avg)`);
  }

  // ── RISK (only for positions) ────────────────────────────
  if (hasEntry && params.entryPrice) {
    const entry = params.entryPrice;
    const pnl = params.unrealizedPnL || 0;
    const pnlPct = ((currentPrice - entry) / entry * 100);
    const peak = params.highestPrice || entry;
    const pctFromPeak = ((currentPrice / peak - 1) * 100);
    const trailingStop = params.trailingStopPrice;
    const hardStop = entry * (1 - 0.03); // 3% hard stop from config

    lines.push("");
    lines.push("─ RISK ─");
    lines.push(`  entry: $${entry.toFixed(2)} | current: $${currentPrice.toFixed(2)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`);
    lines.push(`  peak: $${peak.toFixed(2)} | change from peak: ${pctFromPeak >= 0 ? "+" : ""}${pctFromPeak.toFixed(1)}%`);
    if (trailingStop) {
      const dist = ((currentPrice - trailingStop) / trailingStop * 100);
      lines.push(`  trailing stop: $${trailingStop.toFixed(2)} (5% below $${peak.toFixed(2)} peak) | distance from current: ${dist >= 0 ? "+" : ""}${dist.toFixed(1)}%`);
    }
    lines.push(`  hard stop: $${hardStop.toFixed(2)} (3% from entry) | distance from current: ${((currentPrice / hardStop - 1) * 100).toFixed(1)}%`);
  }

  // ── THESIS TRACKING (only for positions) ──────────────────
  if (hasEntry) {
    lines.push("");
    lines.push("─ THESIS TRACKING ─");
    lines.push(`  entry catalyst: ${params.entrySignalSource || "N/A"} | current status: ${params.status || "active"}`);
    lines.push(`  entry regime: ${(params.entryRegime || "?").toUpperCase()} | current regime: ${(params.currentRegime || "?").toUpperCase()}`);
    lines.push(`  entry VIX: ${params.entryVix?.toFixed(1) ?? "?"} | current VIX: ${params.currentVix?.toFixed(1) ?? "?"}`);
    lines.push(`  entry confidence: ${((params.entrySignalConfidence || 0) * 100).toFixed(0)}% | entry impact score: ${(params.entrySignalImpactScore || 0)}/10`);
  }

  return lines;
}

/**
 * Fetch multi-day daily bars for a symbol.
 * Returns 1-day bars going back `days` trading days.
 * Useful for showing the broader trend context.
 */
export async function getDailyBars(symbol: string, days: number = 10): Promise<IntradayBar[]> {
  try {
    const start = new Date(Date.now() - (days + 5) * 86400000).toISOString();

    const url = new URL(`${DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", start);
    url.searchParams.set("limit", String(days + 5));

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) return [];

    const data = await res.json();
    const bars = data.bars || [];
    return bars.map((b: any) => ({
      timestamp: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  } catch {
    return [];
  }
}
