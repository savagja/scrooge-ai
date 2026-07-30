/**
 * Minimal risk guardrails.
 *
 * Philosophy: Scrooge is an intelligent portfolio manager. The only things we
 * enforce deterministically are the position-level safety stops (so the bot
 * doesn't blow up between cycles). Everything else — sizing, position count,
 * risk per trade, daily loss limits — is the agent's domain.
 *
 * KEPT (position-level safety):
 * - Hard stop loss (3% from entry)
 * - Trailing stop (5% below peak for longs, 5% above trough for shorts)
 * - Green threshold (+1% promotes to trailing)
 * - Short squeeze protection (cover if price jumps 5% intraday)
 *
 * REMOVED (agent's domain):
 * - Max position % of account
 * - Max open positions
 * - Max daily loss %
 * - Consecutive losses halt
 * - Min impact score / confidence thresholds
 * - Mean reversion hard block in trending_up
 * - Cooldown between trades on same ticker
 * - Short sizing reduction in uptrends
 */

import { getConfig } from "../config.js";
import type { Position } from "../types.js";

export interface RiskCheckResult {
  allowed: boolean;
  size: number;
  reason: string;
  exitPlan?: {
    exitTime: Date;
    stopPrice: number;
  };
}

export function evaluateBuySignal(params: {
  signal: {
    symbol: string;
    direction: string;
    strategy: string;
    impactScore: number;
    confidence: number;
    suggestedSizePct: number;
    suggestedHoldMinutes: number;
  };
  accountValue: number;
  cash: number;
  settledCash: number;
  dailyPnL: number;
  openPositions: Position[];
  currentRegime?: string;
  calibrationOverride?: number | null;
}): RiskCheckResult {
  const cfg = getConfig();

  // 1. Direction validation
  if (params.signal.direction !== "long" && params.signal.direction !== "short") {
    return { allowed: false, size: 0, reason: `Unsupported direction: ${params.signal.direction}. Only 'long' or 'short' allowed.` };
  }

  // 2. Already in position (same ticker regardless of direction)
  if (params.openPositions.some((p) => p.symbol === params.signal.symbol)) {
    return { allowed: false, size: 0, reason: `Already holding ${params.signal.symbol}` };
  }

  // 3. Minimum trade size (Alpaca fractional share minimum)
  if (params.settledCash < 5) {
    return { allowed: false, size: 0, reason: `Insufficient settled cash: $${params.settledCash.toFixed(2)}` };
  }

  // Agent sizes based on its own conviction. We just pass through.
  const suggestedSize = params.accountValue * params.signal.suggestedSizePct;
  const size = Math.min(suggestedSize, params.settledCash);

  return {
    allowed: true,
    size: Math.round(size * 100) / 100,
    reason: "PASS",
  };
}

/**
 * Compute exit plan metadata (stop price + nominal hold time).
 * The holdUntil timestamp is stored for reference only — no time stop is enforced.
 * The agent holds as long as the thesis is intact. Only hard stop and trailing stop are enforced.
 */
export function getExitPlan(entryPrice: number, holdMinutes: number): {
  exitTime: Date;
  stopPrice: number;
} {
  const cfg = getConfig();
  return {
    exitTime: new Date(Date.now() + holdMinutes * 60000),
    stopPrice: Math.round(entryPrice * (1 - cfg.risk.stopLossPct) * 100) / 100,
  };
}

/**
 * Check if a position should be exited.
 *
 * EXIT RULES (LONGS):
 * 1. Hard stop: Always exit if price <= entry * (1 - stopLossPct)
 * 2. Trailing stop: Once green, track highest price. Exit if price <= highest * (1 - trailingStopPct).
 * 3. Manual exit: Agent can always call place_sell_order.
 *
 * EXIT RULES (SHORTS):
 * 1. Hard stop: Always exit if price >= entry * (1 + stopLossPct)  [price rose against you]
 * 2. Squeeze stop: Exit if price rises > shortSqueezeThreshold intraday (sudden move protection)
 * 3. Trailing stop: Once green (price dropped), track lowest price. Exit if price >= lowest * (1 + trailingStopPct).
 * 4. Manual exit: Agent can always call place_sell_order.
 */
export function checkExitConditions(params: {
  position: Position;
  currentPrice: number;
}): { shouldExit: boolean; reason: string; newStatus?: Position["status"]; newTrailingStop?: number; newHighestPrice?: number; newLowestPrice?: number } {
  const pos = params.position;
  const price = params.currentPrice;
  const cfg = getConfig();
  const isShort = pos.direction === "short";

  if (isShort) {
    return checkShortExitConditions(pos, price, cfg);
  } else {
    return checkLongExitConditions(pos, price, cfg);
  }
}

function checkLongExitConditions(
  pos: Position,
  price: number,
  cfg: ReturnType<typeof getConfig>
): { shouldExit: boolean; reason: string; newStatus?: Position["status"]; newTrailingStop?: number; newHighestPrice?: number; newLowestPrice?: number } {
  // 1. Hard stop (always active)
  const hardStop = Math.round(pos.entryPrice * (1 - cfg.risk.stopLossPct) * 100) / 100;
  if (price <= hardStop) {
    return { shouldExit: true, reason: `Hard stop hit at $${price.toFixed(2)} (stop: $${hardStop.toFixed(2)})` };
  }

  // 2. Check if position has gone "green" (+greenThreshold profit)
  const profitPct = (price - pos.entryPrice) / pos.entryPrice;

  if (profitPct >= cfg.risk.greenThreshold && pos.status === "initial") {
    const initialTrailing = Math.round(price * (1 - cfg.risk.trailingStopPct) * 100) / 100;
    return {
      shouldExit: false,
      reason: `Position went GREEN (+${(profitPct * 100).toFixed(2)}%). Trailing stop activated at $${initialTrailing.toFixed(2)}. Holding indefinitely.`,
      newStatus: "green",
      newTrailingStop: initialTrailing,
      newHighestPrice: price,
    };
  }

  // 3. Update trailing stop if already green
  if (pos.status === "green" || pos.status === "trailing") {
    const highest = Math.max(pos.highestPrice || pos.entryPrice, price);
    const trailing = Math.round(highest * (1 - cfg.risk.trailingStopPct) * 100) / 100;

    if (price <= trailing) {
      return { shouldExit: true, reason: `Trailing stop hit at $${price.toFixed(2)} (peak: $${highest.toFixed(2)}, trailing: $${trailing.toFixed(2)})` };
    }

    if (price > (pos.highestPrice || pos.entryPrice)) {
      return {
        shouldExit: false,
        reason: `Trailing stop moved up to $${trailing.toFixed(2)} (new peak: $${highest.toFixed(2)})`,
        newStatus: "trailing",
        newTrailingStop: trailing,
        newHighestPrice: highest,
      };
    }

    return { shouldExit: false, reason: `Holding. Trailing stop: $${trailing.toFixed(2)}. Peak: $${highest.toFixed(2)}.` };
  }

  // 4. No time stop — the agent has full discretion over when to exit.
  // The hard stop and trailing stop provide safety. The agent can hold
  // as long as the thesis is intact.
  return {
    shouldExit: false,
    reason: `Holding. Position is in initial status. No time limit — agent has full discretion. Hard stop at $${hardStop.toFixed(2)}. Need +${(cfg.risk.greenThreshold * 100).toFixed(0)}% to activate trailing stop.`,
  };
}

function checkShortExitConditions(
  pos: Position,
  price: number,
  cfg: ReturnType<typeof getConfig>
): { shouldExit: boolean; reason: string; newStatus?: Position["status"]; newTrailingStop?: number; newHighestPrice?: number; newLowestPrice?: number } {
  // 1. Hard stop (always active) — price rose against us
  const hardStop = Math.round(pos.entryPrice * (1 + cfg.risk.stopLossPct) * 100) / 100;
  if (price >= hardStop) {
    return { shouldExit: true, reason: `Hard stop (short) hit at $${price.toFixed(2)} (stop: $${hardStop.toFixed(2)}). Cutting short.` };
  }

  // 2. Squeeze protection: rapid intraday move against short
  const squeezeStop = Math.round(pos.entryPrice * (1 + cfg.risk.shortSqueezeThreshold) * 100) / 100;
  if (price >= squeezeStop) {
    if (pos.status === "initial") {
      return { shouldExit: true, reason: `Squeeze protection triggered at $${price.toFixed(2)} (threshold: $${squeezeStop.toFixed(2)}). Covering short.` };
    }
  }

  // For shorts: profit = (entryPrice - price) / entryPrice (price dropped = profit)
  const profitPct = (pos.entryPrice - price) / pos.entryPrice;

  // 3. Check if short has gone "green" (price dropped enough)
  if (profitPct >= cfg.risk.greenThreshold && pos.status === "initial") {
    const initialTrailing = Math.round(price * (1 + cfg.risk.trailingStopPct) * 100) / 100;
    return {
      shouldExit: false,
      reason: `Short went GREEN (price dropped ${(profitPct * 100).toFixed(2)}%). Trailing stop activated at $${initialTrailing.toFixed(2)} (cover if price rises to here).`,
      newStatus: "green",
      newTrailingStop: initialTrailing,
      newLowestPrice: price,
    };
  }

  // 4. Update trailing stop if already green/trailing
  if (pos.status === "green" || pos.status === "trailing") {
    const lowest = Math.min(pos.lowestPrice || pos.entryPrice, price);
    const trailing = Math.round(lowest * (1 + cfg.risk.trailingStopPct) * 100) / 100;

    if (price >= trailing) {
      return { shouldExit: true, reason: `Trailing stop (short) hit at $${price.toFixed(2)} (trough: $${lowest.toFixed(2)}, cover trigger: $${trailing.toFixed(2)})` };
    }

    if (price < (pos.lowestPrice || pos.entryPrice)) {
      return {
        shouldExit: false,
        reason: `Short trailing stop lowered to $${trailing.toFixed(2)} (new trough: $${lowest.toFixed(2)})`,
        newStatus: "trailing",
        newTrailingStop: trailing,
        newLowestPrice: lowest,
      };
    }

    return { shouldExit: false, reason: `Holding short. Trailing stop: $${trailing.toFixed(2)}. Trough: $${lowest.toFixed(2)}.` };
  }

  // 5. No time stop — the agent has full discretion over when to exit a short.
  // The hard stop, squeeze stop, and trailing stop provide safety.
  return {
    shouldExit: false,
    reason: `Holding short position in initial status. No time limit — agent has full discretion. Hard stop at $${hardStop.toFixed(2)}. Need price drop of ${(cfg.risk.greenThreshold * 100).toFixed(0)}% to activate trailing stop.`,
  };
}
