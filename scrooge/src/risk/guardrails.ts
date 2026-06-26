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

  // 1. Direction
  if (params.signal.direction !== "long") {
    return { allowed: false, size: 0, reason: "Only long positions allowed on cash account" };
  }

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

  // 3. Already in position?
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

  // 6. Sizing
  const maxDollar = params.accountValue * cfg.risk.maxPositionPct;
  const suggestedDollar = params.accountValue * params.signal.suggestedSizePct;
  const available = Math.min(maxDollar, suggestedDollar, params.settledCash);

  if (available < 5) {
    return { allowed: false, size: 0, reason: `Insufficient settled cash: $${available.toFixed(2)}` };
  }

  return {
    allowed: true,
    size: Math.round(available * 100) / 100,
    reason: "PASS",
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
 * EXIT RULES:
 * 1. Hard stop: Always exit if price <= entry * (1 - stopLossPct)
 * 2. Time stop: Only for "initial" status. If holdMinutes passes and not green, exit.
 * 3. Trailing stop: Once green, track highest price. Exit if price <= highest * (1 - trailingStopPct).
 * 4. Manual exit: Agent can always call place_sell_order.
 */
export function checkExitConditions(params: {
  position: Position;
  currentPrice: number;
}): { shouldExit: boolean; reason: string; newStatus?: Position["status"]; newTrailingStop?: number; newHighestPrice?: number } {
  const pos = params.position;
  const price = params.currentPrice;
  const cfg = getConfig();

  // 1. Hard stop (always active)
  const hardStop = Math.round(pos.entryPrice * (1 - cfg.risk.stopLossPct) * 100) / 100;
  if (price <= hardStop) {
    return { shouldExit: true, reason: `Hard stop hit at $${price.toFixed(2)} (stop: $${hardStop.toFixed(2)})` };
  }

  // 2. Check if position has gone "green" (+greenThreshold profit)
  const profitPct = (price - pos.entryPrice) / pos.entryPrice;

  if (profitPct >= cfg.risk.greenThreshold && pos.status === "initial") {
    // Promote to "green" — time stop is now irrelevant
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

    // Update trailing stop if price made new high
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

  // 4. Time stop (only for "initial" status — not yet profitable)
  const holdUntil = new Date(pos.holdUntil);
  if (Date.now() >= holdUntil.getTime()) {
    return { shouldExit: true, reason: `Time stop reached (${cfg.signal.holdMinutes} min). Position never went green. Cutting.` };
  }

  return {
    shouldExit: false,
    reason: `Initial hold. Time stop in ${Math.max(0, Math.round((holdUntil.getTime() - Date.now()) / 60000))} min. Need +${(cfg.risk.greenThreshold * 100).toFixed(0)}% to promote to trailing.`,
  };
}
