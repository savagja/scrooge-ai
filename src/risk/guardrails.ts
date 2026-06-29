/**
 * Deterministic risk guardrails.
 * The agent proposes; the guardrails dispose.
 *
 * EXIT PHILOSOPHY:
 * - LOSERS: Cut quickly. Time stop (30 min) if not profitable. Hard stop (3%) always active.
 * - WINNERS: Let them run. Once +1% profit, activate trailing stop (5% below peak).
 *   Hold for days/weeks until trailing stop hits or manual exit.
 *
 * ALL VALUES are read from config.yaml (or env overrides).
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

  // 1. Direction — now supports both "long" and "short"
  if (params.signal.direction !== "long" && params.signal.direction !== "short") {
    return { allowed: false, size: 0, reason: `Unsupported direction: ${params.signal.direction}. Only 'long' or 'short' allowed.` };
  }

  const isShort = params.signal.direction === "short";

  // 2. Impact & confidence
  // Phase 2: Calibration override — if we have 5+ trades in this (strategy, regime), use actual win rate
  const effectiveConfidence = params.calibrationOverride ?? params.signal.confidence;
  if (params.calibrationOverride !== null && params.calibrationOverride !== undefined) {
    console.log(`[CALIBRATION] ${params.signal.symbol}: LLM confidence ${params.signal.confidence.toFixed(2)} overridden by historical win rate ${params.calibrationOverride.toFixed(2)} in ${params.currentRegime ?? "unknown"} regime`);
  }

  if (Math.abs(params.signal.impactScore) < cfg.signal.minImpactScore) {
    return {
      allowed: false,
      size: 0,
      reason: `Impact ${params.signal.impactScore} below threshold ${cfg.signal.minImpactScore}`,
    };
  }

  if (effectiveConfidence < cfg.signal.minConfidence) {
    return {
      allowed: false,
      size: 0,
      reason: `Confidence ${effectiveConfidence.toFixed(2)} below threshold ${cfg.signal.minConfidence}${params.calibrationOverride !== null ? " (calibrated)" : ""}`,
    };
  }

  // 3. Already in position (same ticker regardless of direction)
  if (params.openPositions.some((p) => p.symbol === params.signal.symbol)) {
    return { allowed: false, size: 0, reason: `Already holding ${params.signal.symbol}` };
  }

  // 4. Position limit
  if (params.openPositions.length >= cfg.risk.maxOpenPositions) {
    return { allowed: false, size: 0, reason: `Max ${cfg.risk.maxOpenPositions} open positions reached` };
  }

  // 5. Daily loss halt
  const dailyLossLimit = -(params.accountValue * cfg.risk.maxDailyLossPct);
  if (params.dailyPnL <= dailyLossLimit) {
    return { allowed: false, size: 0, reason: `Daily loss limit reached: $${params.dailyPnL.toFixed(2)}` };
  }

  // 6. Sizing — shorts use same max position % but may be reduced in volatile/trending_up regimes
  let maxDollar = params.accountValue * cfg.risk.maxPositionPct;
  if (isShort && params.currentRegime === "trending_up") {
    // Reduce short size in uptrends (higher squeeze risk)
    maxDollar = maxDollar * 0.5;
  }
  const suggestedDollar = params.accountValue * params.signal.suggestedSizePct;
  const available = Math.min(maxDollar, suggestedDollar, params.settledCash);

  if (available < 5) {
    return { allowed: false, size: 0, reason: `Insufficient settled cash: $${available.toFixed(2)}` };
  }

  return {
    allowed: true,
    size: Math.round(available * 100) / 100,
    reason: isShort ? `PASS (short, sized ${(available / params.accountValue * 100).toFixed(0)}%)` : "PASS",
  };
}

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
 * 2. Time stop: Only for "initial" status. If holdMinutes passes and not green, exit.
 * 3. Trailing stop: Once green, track highest price. Exit if price <= highest * (1 - trailingStopPct).
 * 4. Manual exit: Agent can always call place_sell_order.
 *
 * EXIT RULES (SHORTS):
 * 1. Hard stop: Always exit if price >= entry * (1 + stopLossPct)  [price rose against you]
 * 2. Squeeze stop: Exit if price rises > shortSqueezeThreshold intraday (sudden move protection)
 * 3. Time stop: Only for "initial" status. If holdMinutes passes and not green, exit.
 * 4. Trailing stop: Once green (price dropped), track lowest price. Exit if price >= lowest * (1 + trailingStopPct).
 * 5. Manual exit: Agent can always call place_sell_order.
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
      reason: `Position went GREEN (+${(profitPct * 100).toFixed(2)}%). Trailing stop activated at $${initialTrailing.toFixed(2)}. Time stop CANCELLED. Holding indefinitely.`,
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

  // 4. Time stop (only for "initial" status)
  const holdUntil = new Date(pos.holdUntil);
  if (Date.now() >= holdUntil.getTime()) {
    return { shouldExit: true, reason: `Time stop reached (${cfg.signal.holdMinutes} min). Position never went green. Cutting.` };
  }

  return {
    shouldExit: false,
    reason: `Initial hold. Time stop in ${Math.max(0, Math.round((holdUntil.getTime() - Date.now()) / 60000))} min. Need +${(cfg.risk.greenThreshold * 100).toFixed(0)}% to promote to trailing.`,
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
    // Only trigger if status is still initial (no profit yet)
    if (pos.status === "initial") {
      return { shouldExit: true, reason: `Squeeze protection triggered at $${price.toFixed(2)} (threshold: $${squeezeStop.toFixed(2)}). Covering short.` };
    }
  }

  // For shorts: profit = (entryPrice - price) / entryPrice (price dropped = profit)
  const profitPct = (pos.entryPrice - price) / pos.entryPrice;

  // 3. Check if short has gone "green" (price dropped enough)
  if (profitPct >= cfg.risk.greenThreshold && pos.status === "initial") {
    // Promote — time stop cancelled, set trailing stop (on the LOW side for shorts)
    // For shorts: trailing stop is triggered when price rises back up from the low
    const initialTrailing = Math.round(price * (1 + cfg.risk.trailingStopPct) * 100) / 100;
    return {
      shouldExit: false,
      reason: `Short went GREEN (price dropped ${(profitPct * 100).toFixed(2)}%). Trailing stop activated at $${initialTrailing.toFixed(2)} (cover if price rises to here). Time stop CANCELLED.`,
      newStatus: "green",
      newTrailingStop: initialTrailing,
      newLowestPrice: price,
    };
  }

  // 4. Update trailing stop if already green/trailing
  if (pos.status === "green" || pos.status === "trailing") {
    const lowest = Math.min(pos.lowestPrice || pos.entryPrice, price);
    // Trailing stop for shorts: if price rises back up from the low
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

  // 5. Time stop (only for "initial" status)
  const holdUntil = new Date(pos.holdUntil);
  if (Date.now() >= holdUntil.getTime()) {
    return { shouldExit: true, reason: `Time stop (short) reached (${cfg.signal.holdMinutes} min). Position never went green. Covering.` };
  }

  return {
    shouldExit: false,
    reason: `Initial hold (short). Time stop in ${Math.max(0, Math.round((holdUntil.getTime() - Date.now()) / 60000))} min. Need price drop of ${(cfg.risk.greenThreshold * 100).toFixed(0)}% to promote to trailing.`,
  };
}
