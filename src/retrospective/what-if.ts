/**
 * What-If Strategy Analyzer.
 *
 * After each trading day, this module analyzes ALL strategies that were active,
 * developed, or created during the day and grades them on a 1-5 scale:
 *
 *   1 = terrible setup (wrong direction, wrong thesis, bad timing)
 *   2 = poor (some promise but fundamentally flawed)
 *   3 = neutral (could go either way, no clear edge or flaw)
 *   4 = good (solid thesis, reasonable timing, would take again)
 *   5 = excellent (perfect setup, clear catalyst, well-timed)
 *
 * For each strategy, it computes a "what if" hypothetical P&L: what would have
 * happened if the trader had entered the position? This uses the day's price
 * action to simulate entry/exit at reasonable prices.
 *
 * The graded strategies feed back into:
 *   - Trader prompt: which setups have worked historically
 *   - Lesson integrator: abstracted patterns (e.g. "EDGAR 8-K momentum works
 *     in low-VIX chop" or "short squeeze plays bust in trending_up regimes")
 *   - Strategist calibration: conviction scoring improvement
 */

import { StrategyStore } from "../state/strategies.js";
import { PortfolioState } from "../state/portfolio.js";
import { getCurrentPrice } from "../execution/alpaca.js";
import type {
  Strategy,
  WhatIfEntry,
  WhatIfGrade,
  WhatIfAnalysis,
  PortfolioSnapshot,
} from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run What-If analysis for a given trading day.
 *
 * Analyzes all strategies that were touched during the day and produces
 * a graded report with hypothetical P&Ls. Persists grades back to each
 * strategy in the database.
 */
export async function runWhatIfAnalysis(
  date: string,
  strategies: StrategyStore,
  state: PortfolioState
): Promise<WhatIfAnalysis> {
  console.log(`\n🔍 Running What-If strategy analysis for ${date}...`);

  // Get all strategies touched on this day
  const dayStrategies = strategies.getStrategiesForDay(date);

  // Also include strategies that the strategist was developing/had active
  // We widen the net: strategies with no explicit update on this day but that
  // were in 'anticipated' or 'developing' state and active within reasonable bounds
  const allActive = strategies.getByState("anticipated")
    .concat(strategies.getByState("developing"))
    .concat(strategies.getByState("realized"))
    .concat(strategies.getByState("active"));

  // Deduplicate by ID
  const seen = new Set<string>();
  const allStrategies: Strategy[] = [];
  for (const s of [...dayStrategies, ...allActive]) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      allStrategies.push(s);
    }
  }

  if (allStrategies.length === 0) {
    console.log("  No strategies to analyze.");
    return buildEmptyAnalysis(date);
  }

  // Get the day's snapshots for price context
  const snapshots = state.getSnapshotsForDay(date);
  const regime = snapshots.length > 0
    ? getDominantRegime(snapshots)
    : "unknown";
  const avgVix = snapshots.length > 0
    ? averageVix(snapshots)
    : null;

  // Analyze each strategy
  const analyzed: Array<{
    ticker: string;
    strategy_type: string;
    direction: string;
    state: string;
    grade: WhatIfGrade;
    potentialGainLoss: number;
    potentialGainLossPct: number;
    abstraction: string;
    gradeRationale: string;
  }> = [];

  let totalHypotheticalPnL = 0;
  let bestStrategy: WhatIfAnalysis["bestStrategy"] = null;
  let worstStrategy: WhatIfAnalysis["worstStrategy"] = null;

  for (const s of allStrategies) {
    const result = await analyzeSingleStrategy(s, date, snapshots, regime, avgVix);
    if (!result) continue; // skip if no price data

    // Persist the what-if entry back to the strategy
    strategies.updateWhatIf(s.id, {
      grade: result.grade,
      gradeRationale: result.gradeRationale,
      potentialGainLoss: result.potentialGainLoss,
      potentialGainLossPct: result.potentialGainLossPct,
      hypotheticalEntryPrice: result.hypotheticalEntryPrice,
      hypotheticalExitPrice: result.hypotheticalExitPrice,
      abstraction: result.abstraction,
      regime,
      vix: avgVix,
      analyzedAt: new Date().toISOString(),
    });

    analyzed.push({
      ticker: s.ticker,
      strategy_type: s.strategy_type,
      direction: s.direction,
      state: s.state,
      grade: result.grade,
      potentialGainLoss: result.potentialGainLoss,
      potentialGainLossPct: result.potentialGainLossPct,
      abstraction: result.abstraction,
      gradeRationale: result.gradeRationale,
    });

    totalHypotheticalPnL += result.potentialGainLoss;

    if (!bestStrategy || result.potentialGainLoss > bestStrategy.potentialGainLoss) {
      bestStrategy = {
        ticker: s.ticker,
        grade: result.grade,
        potentialGainLoss: result.potentialGainLoss,
        abstraction: result.abstraction,
      };
    }
    if (!worstStrategy || result.potentialGainLoss < worstStrategy.potentialGainLoss) {
      worstStrategy = {
        ticker: s.ticker,
        grade: result.grade,
        potentialGainLoss: result.potentialGainLoss,
        abstraction: result.abstraction,
      };
    }
  }

  // Grade distribution
  const gradeDistribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const a of analyzed) {
    gradeDistribution[String(a.grade)] = (gradeDistribution[String(a.grade)] || 0) + 1;
  }

  const analysis: WhatIfAnalysis = {
    date,
    totalStrategiesAnalyzed: analyzed.length,
    gradeDistribution,
    totalHypotheticalPnL: Math.round(totalHypotheticalPnL * 100) / 100,
    bestStrategy,
    worstStrategy,
    strategies: analyzed,
  };

  console.log(`  ✅ What-If complete: ${analyzed.length} strategies graded, hypothetical P&L: $${analysis.totalHypotheticalPnL.toFixed(2)}`);
  console.log(`     Distribution: ${Object.entries(gradeDistribution).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  return analysis;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS: Snapshot analysis
// ═══════════════════════════════════════════════════════════════════════════

function getDominantRegime(snapshots: PortfolioSnapshot[]): string {
  const counts: Record<string, number> = {};
  for (const s of snapshots) {
    if (s.regime) {
      counts[s.regime] = (counts[s.regime] || 0) + 1;
    }
  }
  let maxCount = 0;
  let dominant = "unknown";
  for (const [regime, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      dominant = regime;
    }
  }
  return dominant;
}

function averageVix(snapshots: PortfolioSnapshot[]): number | null {
  const vixValues = snapshots.map((s) => s.vix).filter((v): v is number => v !== null);
  if (vixValues.length === 0) return null;
  return Math.round((vixValues.reduce((a, b) => a + b, 0) / vixValues.length) * 10) / 10;
}

function buildEmptyAnalysis(date: string): WhatIfAnalysis {
  return {
    date,
    totalStrategiesAnalyzed: 0,
    gradeDistribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    totalHypotheticalPnL: 0,
    bestStrategy: null,
    worstStrategy: null,
    strategies: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL: Single strategy analysis
// ═══════════════════════════════════════════════════════════════════════════

interface SingleStrategyResult {
  grade: WhatIfGrade;
  gradeRationale: string;
  potentialGainLoss: number;
  potentialGainLossPct: number;
  hypotheticalEntryPrice: number;
  hypotheticalExitPrice: number;
  abstraction: string;
}

async function analyzeSingleStrategy(
  s: Strategy,
  date: string,
  snapshots: PortfolioSnapshot[],
  regime: string,
  avgVix: number | null
): Promise<SingleStrategyResult | null> {
  try {
    // Get current price — we use this as a proxy for the day's closing/current price
    const currentPrice = await getCurrentPrice(s.ticker);
    if (!currentPrice || currentPrice <= 0) return null;

    // Determine hypothetical entry price:
    // - If the strategy had a position: use the actual entry price
    // - If position exists (realized/active): use entry_price
    // - Otherwise: use the current price as hypothetical entry
    let hypotheticalEntry = s.entry_price;
    if (!hypotheticalEntry || hypotheticalEntry <= 0) {
      hypotheticalEntry = currentPrice;
    }

    // For realized/active strategies that had trades, use the actual entry price
    if ((s.state === "realized" || s.state === "active") && s.pnl !== null && s.entry_price) {
      hypotheticalEntry = s.entry_price;
    }

    // Determine hypothetical exit price
    let hypotheticalExit: number;
    if (s.exit_price && s.exit_price > 0) {
      hypotheticalExit = s.exit_price;
    } else {
      // Simulate: assume we'd have captured ~60% of the day's range in the direction
      const intradayMove = currentPrice - hypotheticalEntry;
      const direction = s.direction === "short" ? -1 : 1;

      if (intradayMove * direction > 0) {
        // Price moved in our direction — assume we capture most of it
        hypotheticalExit = hypotheticalEntry + (intradayMove * 0.6 * direction);
      } else {
        // Price moved against us — assume a small loss
        hypotheticalExit = hypotheticalEntry + (intradayMove * -0.3 * direction);
      }

      // Cap the exit within reasonable bounds
      const maxFavorable = hypotheticalEntry * (1 + (direction * 0.05)); // 5% max favorable
      const maxAdverse = hypotheticalEntry * (1 - (direction * 0.03));  // 3% max adverse
      if (direction > 0) {
        hypotheticalExit = Math.min(Math.max(hypotheticalExit, maxAdverse), maxFavorable);
      } else {
        hypotheticalExit = Math.max(Math.min(hypotheticalExit, maxAdverse), maxFavorable);
      }
    }

    // Calculate hypothetical P&L
    const isShort = s.direction === "short";
    const pnlPct = isShort
      ? (hypotheticalEntry - hypotheticalExit) / hypotheticalEntry
      : (hypotheticalExit - hypotheticalEntry) / hypotheticalEntry;

    // Use standard position sizing ($25 notional for hypothetical)
    const hypotheticalNotional = 25;
    const pnl = hypotheticalNotional * pnlPct;

    // ── GRADE ASSIGNMENT ──────────────────────────────────────────────
    const grade = computeGrade(s, pnlPct, regime, avgVix);

    // ── ABSTRACTION ───────────────────────────────────────────────────
    const abstraction = buildAbstraction(s, grade, regime, pnlPct);

    // ── GRADE RATIONALE ───────────────────────────────────────────────
    const gradeRationale = buildGradeRationale(s, grade, pnlPct, regime, hypotheticalEntry, hypotheticalExit);

    return {
      grade,
      gradeRationale,
      potentialGainLoss: Math.round(pnl * 100) / 100,
      potentialGainLossPct: Math.round(pnlPct * 10000) / 100,
      hypotheticalEntryPrice: Math.round(hypotheticalEntry * 100) / 100,
      hypotheticalExitPrice: Math.round(hypotheticalExit * 100) / 100,
      abstraction,
    };
  } catch {
    // Price data unavailable for this ticker
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GRADE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════

function computeGrade(
  s: Strategy,
  pnlPct: number,
  regime: string,
  avgVix: number | null
): WhatIfGrade {
  // Base score starts at 3 (neutral)
  let score = 3;

  // Factor 1: Outcome (what-if P&L)
  if (pnlPct > 1.5) score += 1.5;
  else if (pnlPct > 0.5) score += 0.5;
  else if (pnlPct < -1.5) score -= 1.5;
  else if (pnlPct < -0.5) score -= 0.5;

  // Factor 2: Confidence/conviction alignment
  if (s.confidence >= 0.6) {
    if (pnlPct > 0) score += 0.5;   // Right with confidence
    else score -= 0.5;               // Wrong with confidence = worse
  } else if (s.confidence >= 0.4) {
    if (pnlPct > 0) score += 0.25;
    else score -= 0.25;
  }

  // Factor 3: Regime fit
  const regimeGood = (
    (s.direction === "long" && regime === "trending_up") ||
    (s.direction === "short" && (regime === "trending_down" || regime === "volatile"))
  );
  const regimeBad = (
    (s.direction === "long" && regime === "trending_down") ||
    (s.direction === "short" && regime === "trending_up")
  );
  if (regimeGood && pnlPct > 0) score += 0.5;
  else if (regimeGood && pnlPct < 0) score -= 1.0; // Wrong despite favorable regime
  else if (regimeBad && pnlPct > 0) score += 1.0;  // Right despite bad regime
  else if (regimeBad && pnlPct < 0) score -= 0.5;

  // Factor 4: Strategy state quality
  if (s.state === "developing" && pnlPct > 0) score += 0.5;
  if (s.state === "anticipated" && pnlPct > 0) score -= 0.25; // Luck factor
  if ((s.state === "realized" || s.state === "active") && pnlPct > 0 && s.confidence >= 0.5) score += 0.3;

  // Factor 5: Catalyst quality
  if (s.catalyst && s.catalyst.length > 5) {
    if (pnlPct > 0) score += 0.5;
    else score -= 0.25;
  }
  if (!s.catalyst && pnlPct > 0) score -= 0.25;
  if (!s.catalyst && pnlPct < 0) score -= 0.5;

  // Factor 6: Strategy type fit with regime
  const typeRegimeBonus = checkTypeRegimeFit(s.strategy_type, regime, pnlPct);
  score += typeRegimeBonus;

  // Clamp to 1-5 and round
  const clamped = Math.max(1, Math.min(5, Math.round(score))) as WhatIfGrade;
  return clamped;
}

function checkTypeRegimeFit(
  strategyType: string,
  regime: string,
  pnlPct: number
): number {
  const fitMap: Record<string, string[]> = {
    momentum: ["trending_up", "trending_down"],
    swing: ["trending_up", "chop"],
    day_trade: ["chop", "volatile"],
    value: ["chop", "trending_up"],
    event_driven: ["volatile", "trending_up", "trending_down"],
    mean_reversion: ["chop", "volatile"],
  };

  const goodRegimes = fitMap[strategyType] || ["chop"];
  const isGoodFit = goodRegimes.includes(regime);

  if (isGoodFit && pnlPct > 0) return 0.5;
  if (isGoodFit && pnlPct < 0) return -0.5;
  if (!isGoodFit && pnlPct > 0) return 0.75;
  if (!isGoodFit && pnlPct < 0) return -0.25;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// ABSTRACTION BUILDER
// ═══════════════════════════════════════════════════════════════════════════

function buildAbstraction(
  s: Strategy,
  grade: WhatIfGrade,
  regime: string,
  pnlPct: number
): string {
  const parts: string[] = [];

  // Strategy type
  parts.push(s.strategy_type.replace(/_/g, " "));
  // Direction
  parts.push(s.direction);
  // Regime
  parts.push(regime);
  // Outcome
  const outcome = grade >= 4 ? "works" : grade <= 2 ? "fails" : "mixed";
  parts.push(outcome);

  // Catalyst type inference
  if (s.catalyst) {
    const cat = s.catalyst.toLowerCase();
    if (cat.includes("edgar") || cat.includes("8-k") || cat.includes("sec")) parts.push("catalyst:edgar");
    else if (cat.includes("earnings") || cat.includes("revenue") || cat.includes("quarterly")) parts.push("catalyst:earnings");
    else if (cat.includes("news") || cat.includes("headline") || cat.includes("press")) parts.push("catalyst:news");
    else if (cat.includes("volume") || cat.includes("gap") || cat.includes("break")) parts.push("catalyst:technical");
    else if (cat.includes("reddit") || cat.includes("wsb")) parts.push("catalyst:retail");
    else parts.push("catalyst:misc");
  } else {
    parts.push("catalyst:none");
  }

  // Signal sources
  if (s.key_signals && s.key_signals.length > 0) {
    const sources = new Set(s.key_signals.map((k) => k.split(":")[0] || k));
    for (const src of sources) parts.push(`signal:${src}`);
  }

  // Grade tag
  if (grade === 5) parts.push("excellent");
  else if (grade === 4) parts.push("good");
  else if (grade === 3) parts.push("neutral");
  else if (grade === 2) parts.push("poor");
  else parts.push("terrible");

  // P&L magnitude
  if (pnlPct > 2) parts.push("big_win");
  else if (pnlPct > 0.5) parts.push("small_win");
  else if (pnlPct < -2) parts.push("big_loss");
  else if (pnlPct < -0.5) parts.push("small_loss");
  else parts.push("flat");

  return parts.join(" | ");
}

// ═══════════════════════════════════════════════════════════════════════════
// GRADE RATIONALE BUILDER
// ═══════════════════════════════════════════════════════════════════════════

function buildGradeRationale(
  s: Strategy,
  grade: WhatIfGrade,
  pnlPct: number,
  regime: string,
  hypotheticalEntry: number,
  hypotheticalExit: number
): string {
  const gradeLabels: Record<number, string> = { 1: "Terrible setup", 2: "Poor setup", 3: "Neutral setup", 4: "Good setup", 5: "Excellent setup" };
  const pnlDir = pnlPct >= 0 ? "profitable" : "unprofitable";
  const catNote = s.catalyst && s.catalyst.length > 5
    ? `Has catalyst: "${s.catalyst.slice(0, 80)}". `
    : "No specific catalyst. ";

  let regNote = "";
  const regGood = (s.direction === "long" && regime === "trending_up") || (s.direction === "short" && (regime === "trending_down" || regime === "volatile"));
  const regBad = (s.direction === "long" && regime === "trending_down") || (s.direction === "short" && regime === "trending_up");
  if (regGood) regNote = `Aligned with ${regime}. `;
  else if (regBad) regNote = `Against ${regime}. `;
  else regNote = `Regime-neutral (${regime}). `;

  const confNote = s.confidence >= 0.6 ? `High conf (${(s.confidence*100).toFixed(0)}%). ` : s.confidence >= 0.4 ? `Moderate conf (${(s.confidence*100).toFixed(0)}%). ` : `Low conf (${(s.confidence*100).toFixed(0)}%). `;

  return `${gradeLabels[grade]}. ${s.strategy_type.replace(/_/g, " ")} ${s.direction} in ${regime}: ${pnlDir} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%). ${catNote}${regNote}${confNote}Entry $${hypotheticalEntry.toFixed(2)} -> Exit $${hypotheticalExit.toFixed(2)}. State: ${s.state}.${s.rationale ? ` Thesis: ${s.rationale.slice(0, 120)}` : ""}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// WHAT-IF FORMATTING — Exported
// ═══════════════════════════════════════════════════════════════════════════

export function formatWhatIfForLessons(analysis: WhatIfAnalysis): string {
  if (analysis.totalStrategiesAnalyzed === 0) return "No strategies were analyzed.";
  const lines: string[] = [
    `### What-If Analysis (${analysis.totalStrategiesAnalyzed} strategies)`,
    `Hypothetical P&L (@ $25/strat): $${analysis.totalHypotheticalPnL.toFixed(2)}`,
    `Grades: ${Object.entries(analysis.gradeDistribution).map(([k, v]) => `${k}=${v}`).join(" | ")}`,
  ];
  if (analysis.bestStrategy) lines.push(`Best: ${analysis.bestStrategy.ticker} (G${analysis.bestStrategy.grade}, $${analysis.bestStrategy.potentialGainLoss.toFixed(2)})`);
  if (analysis.worstStrategy) lines.push(`Worst: ${analysis.worstStrategy.ticker} (G${analysis.worstStrategy.grade}, $${analysis.worstStrategy.potentialGainLoss.toFixed(2)})`);
  for (const s of analysis.strategies) {
    const e = s.grade >= 4 ? "+" : s.grade <= 2 ? "-" : "~";
    lines.push(`  ${e}[${s.ticker}] G${s.grade} ${s.direction[0].toUpperCase()}${s.strategy_type.slice(0, 6)} $${s.potentialGainLoss.toFixed(2)} ${s.abstraction}`);
  }
  return lines.join("\n");
}

export function formatAbstractionsForPrompt(analysis: WhatIfAnalysis): string {
  if (analysis.totalStrategiesAnalyzed === 0) return "No strategies created today.";
  const byG: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const s of analysis.strategies) {
    if (!byG[s.grade]) byG[s.grade] = [];
    byG[s.grade].push(`${s.ticker}: ${s.abstraction}`);
  }
  const lines: string[] = [];
  if (byG[5].length) lines.push(`Excellent(5): ${byG[5].join(" | ")}`);
  if (byG[4].length) lines.push(`Good(4): ${byG[4].join(" | ")}`);
  if (byG[3].length) lines.push(`Neutral(3): ${byG[3].join(" | ")}`);
  if (byG[2].length) lines.push(`Poor(2): ${byG[2].join(" | ")}`);
  if (byG[1].length) lines.push(`Terrible(1): ${byG[1].join(" | ")}`);

  // Recurring patterns
  const freq = new Map<string, { c: number; gs: number[] }>();
  for (const s of analysis.strategies) {
    const key = s.abstraction.split(" | ").slice(0, 4).join(" | ");
    if (!freq.has(key)) freq.set(key, { c: 0, gs: [] });
    const e = freq.get(key)!;
    e.c++; e.gs.push(s.grade);
  }
  const recurring = Array.from(freq.entries()).filter(([_, v]) => v.c >= 2).sort((a, b) => b[1].c - a[1].c);
  if (recurring.length > 0) {
    lines.push("Recurring:");
    for (const [p, v] of recurring) {
      const avg = (v.gs.reduce((a, b) => a + b, 0) / v.gs.length).toFixed(1);
      lines.push(`  [x${v.c}] ${p} (avg: ${avg})`);
    }
  }
  return lines.join("\n");
}

export function formatWhatIfForReport(analysis: WhatIfAnalysis): string {
  if (analysis.totalStrategiesAnalyzed === 0) return "## What-If Strategy Analysis\n\nNo strategies were created or updated today.";
  const lines: string[] = [
    `## What-If Strategy Analysis`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Strategies Analyzed | ${analysis.totalStrategiesAnalyzed} |`,
    `| Hypothetical P&L | $${analysis.totalHypotheticalPnL.toFixed(2)} |`,
    `| Grade 1 (Terrible) | ${analysis.gradeDistribution["1"] || 0} |`,
    `| Grade 2 (Poor) | ${analysis.gradeDistribution["2"] || 0} |`,
    `| Grade 3 (Neutral) | ${analysis.gradeDistribution["3"] || 0} |`,
    `| Grade 4 (Good) | ${analysis.gradeDistribution["4"] || 0} |`,
    `| Grade 5 (Excellent) | ${analysis.gradeDistribution["5"] || 0} |`,
  ];
  if (analysis.bestStrategy) {
    lines.push(`**Best:** ${analysis.bestStrategy.ticker} (G${analysis.bestStrategy.grade}/5, +$${analysis.bestStrategy.potentialGainLoss.toFixed(2)})`);
    lines.push(`- Pattern: ${analysis.bestStrategy.abstraction}`);
  }
  if (analysis.worstStrategy) {
    lines.push(`**Worst:** ${analysis.worstStrategy.ticker} (G${analysis.worstStrategy.grade}/5, $${analysis.worstStrategy.potentialGainLoss.toFixed(2)})`);
    lines.push(`- Pattern: ${analysis.worstStrategy.abstraction}`);
  }
  lines.push("");
  lines.push("### Graded Strategies");
  for (const s of [...analysis.strategies].sort((a, b) => b.grade - a.grade)) {
    const e = s.grade >= 4 ? "+" : s.grade <= 2 ? "-" : "~";
    lines.push(`**${e} ${s.ticker}** ${s.direction[0].toUpperCase()} ${s.strategy_type} -- G${s.grade}/5 -- $${s.potentialGainLoss.toFixed(2)}`);
    lines.push(`- Pattern: ${s.abstraction}`);
    lines.push(`- ${s.gradeRationale}`);
  }
  return lines.join("\n");
}