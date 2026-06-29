/**
 * Alpaca REST API wrapper for TypeScript.
 * No SDK dependency — raw fetch for full control.
 */

import type { Position } from "../types.js";

const BASE_URL = "https://paper-api.alpaca.markets";
const DATA_URL = "https://data.alpaca.markets";

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
  const res = await fetch(dataUrl(`/stocks/${symbol}/quotes/latest`), { headers: getHeaders() });
  if (!res.ok) {
    console.warn(`[ALPACA] Quote error for ${symbol}: ${res.status}`);
    return null;
  }
  const data = await res.json();
  const quote = data.quote;
  return {
    askPrice: parseFloat(quote.ap),
    bidPrice: parseFloat(quote.bp),
  };
}

export async function getCurrentPrice(symbol: string): Promise<number | null> {
  // Use Alpaca's positions endpoint for the official mark price (`current_price`).
  // This is more reliable than the quote feed, especially in after-hours when
  // bid-ask spreads are wide and the last quote may be stale.
  try {
    const res = await fetch(tradingUrl(`/positions/${symbol}`), { headers: getHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data.current_price) {
        return parseFloat(data.current_price);
      }
    }
  } catch {
    // fall through to quote
  }

  // Fallback to quote API for symbols without a position
  const quote = await getLatestQuote(symbol);
  return quote ? quote.bidPrice : null;
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
