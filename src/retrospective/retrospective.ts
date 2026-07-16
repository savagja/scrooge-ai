/**
 * Daily retrospective module — orchestrator for split trader + strategist retro.
 *
 * Now runs TWO separate retrospective analyses:
 *   1. TRADER retrospective — evaluates execution quality, produces trader lessons
 *   2. STRATEGIST retrospective — evaluates hypothesis quality, produces strategist lessons
 *
 * Both are persisted and available to their respective agents.
 */

import { PortfolioState } from "../state/portfolio.js";
import { StrategyStore } from "../state/strategies.js";
import type { DailyReport, WhatIfAnalysis } from "../types.js";
import { getTradingDate } from "../config.js";
import { analyzeTraderExecution, type TraderRetroInput } from "./trader-retrospective.js";
import { analyzeStrategistPerformance, extractPatternsFromWhatIf, type StrategistRetroInput } from "./strategist-retrospective.js";
import { runWhatIfAnalysis, formatAbstractionsForPrompt, formatWhatIfForReport } from "./what-if.js";
import { getAccount } from "../execution/alpaca.js";

/**
 * Check whether the retrospective should run for today.
 * Returns true if no report exists for the current date yet.
 */
export async function shouldRunRetrospective(state: PortfolioState, forceDate?: string): Promise<boolean> {
  const today = forceDate || getTradingDate();
  const latestReport = state.getLatestReport();
  return !latestReport || latestReport.date !== today;
}

/**
 * Run the full-day retrospective.
 *
 * Orchestrates TWO separate analyses:
 *   - Trader execution analysis -> trader lessons in state.json
 *   - Strategist hypothesis analysis -> strategist lessons in strategies.db
 *
 * Returns the combined DailyReport.
 */
export async function runDailyRetrospective(state: PortfolioState, strategyStore?: StrategyStore, forceDate?: string): Promise<DailyReport> {
  const today = forceDate || getTradingDate();
  console.log("=".repeat(60));
  console.log(`  📋 Daily Retrospective — ${today}`);
  console.log("=".repeat(60));

  // ── Gather raw data ──────────────────────────────────────────────────────
  const trades = state.getTradesForDay(today);
  const history = state.getSnapshotsForDay(today);
  const lessons = state.getMemory().lessons;
  const lessonInsights = lessons.filter((l) => !l.deprecated).map((l) => l.insight);
  const calibrationTable = state.getCalibrationTable();
  const tokenCost = state.getDailyTokenCost(today);

  // ── Daily P&L from Alpaca (the single source of truth) ────────────────
  // Alpaca's /v2/account returns `equity` (current) and `last_equity` (previous close).
  // The daily change is simply equity - lastEquity. No calculation needed.
  const account = await getAccount();
  const alpacaDailyChange = account.equity - account.lastEquity;
  const totalEquityChange = Math.round(alpacaDailyChange * 100) / 100;
  const startingEquity = account.lastEquity;
  const endingEquity = account.equity;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const grossPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const netPnL = grossPnL - (tokenCost?.totalCost ?? 0);

  // ── Run What-If analysis on strategies ──────────────────────────────────
  let whatIfData: WhatIfAnalysis | null = null;
  let store: StrategyStore;
  if (strategyStore || process.env.STRATEGIES_DB_PATH) {
    store = strategyStore ?? new StrategyStore(process.env.STRATEGIES_DB_PATH);
    try {
      whatIfData = await runWhatIfAnalysis(today, store, state);
    } catch (e: any) {
      console.warn(`  ⚠️  What-If analysis failed: ${e.message}`);
    }
  } else {
    store = new StrategyStore("data/strategies.db");
  }

  const whatIfSummary = whatIfData ? formatAbstractionsForPrompt(whatIfData) : "";
  const whatIfReportSection = whatIfData ? formatWhatIfForReport(whatIfData) : "";

  // Build shared data structures
  const topStrategies = whatIfData
    ? whatIfData.strategies.filter((s) => s.grade >= 4).map((s) => ({
        ticker: s.ticker, type: s.strategy_type, direction: s.direction,
        grade: s.grade, pnl: `$${s.potentialGainLoss.toFixed(2)}`,
      }))
    : [];
  const bottomStrategies = whatIfData
    ? whatIfData.strategies.filter((s) => s.grade <= 2).map((s) => ({
        ticker: s.ticker, type: s.strategy_type, direction: s.direction,
        grade: s.grade, pnl: `$${s.potentialGainLoss.toFixed(2)}`,
      }))
    : [];
  const strategyStateCounts = store.getStateCounts();
  const executedStrategies = store.getExecuted(50).map((s: any) => ({
    ticker: s.ticker, type: s.strategy_type, direction: s.direction,
    state: s.state, confidence: s.confidence, catalyst: s.catalyst ?? "",
    pnl: s.pnl, pnlPct: s.pnl_pct, exit_reason: s.exit_reason,
  }));

  const tradesWithDir = trades.map((t: any) => ({
    symbol: t.symbol, strategy: t.strategy, direction: t.direction ?? "long",
    pnl: t.pnl, pnlPct: t.pnlPct, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
    exitReason: t.exitReason, holdMinutes: t.holdMinutesActual,
    wasPromoted: t.wasPromoted, signalSource: t.signalSource,
    signalConfidence: t.signalConfidence, signalImpactScore: t.signalImpactScore,
    agentReasoning: t.agentReasoning,
  }));

  const marketRegimes = [...new Set(history.map((s: any) => s.regime).filter(Boolean))];

  // ═══════════════════════════════════════════════════════════════════════
  // TRADER RETROSPECTIVE
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n🛒 Running TRADER retrospective...`);

  const traderInput: TraderRetroInput = {
    date: today,
    trades: tradesWithDir,
    tradeCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    grossPnL,
    netPnL,
    startingEquity,
    endingEquity,
    totalEquityChange,
    marketRegimes,
    topStrategies,
    bottomStrategies,
    executedStrategies,
    whatIfSummary,
    existingLessons: state.getMemory().lessons,
    performanceSnapshot: {
      totalTrades: trades.length,
      winRate,
      netPnL,
      equityChange: totalEquityChange,
      consecutiveLosses: trades.slice(-5).filter((t) => t.pnl <= 0).length,
    },
    calibrationTable: calibrationTable.map((c: any) => ({
      strategy: c.strategy, regime: c.regime, winRate: c.winRate,
      totalTrades: c.totalTrades, avgWinPct: c.avgWinPct, avgLossPct: c.avgLossPct,
    })),
  };

  const traderResult = await analyzeTraderExecution(traderInput);

  // Persist trader lessons back to state.json (for trader's consult_memory)
  state.replaceAllLessons(traderResult.evolvedLessons);
  console.log(`  ✅ Trader retro complete: ${traderResult.evolvedLessons.filter((l) => !l.deprecated).length} active lessons`);

  // ═══════════════════════════════════════════════════════════════════════
  // STRATEGIST RETROSPECTIVE
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n🧪 Running STRATEGIST retrospective...`);

  const patterns = whatIfData ? extractPatternsFromWhatIf(whatIfData) : [];
  const existingStrategistLessons = store.getStrategistLessons(true);
  const dominantRegime = marketRegimes.length > 0
    ? marketRegimes.reduce((a, b) =>
        marketRegimes.filter((r) => r === a).length >= marketRegimes.filter((r) => r === b).length ? a : b
      )
    : "unknown";

  const strategistInput: StrategistRetroInput = {
    date: today,
    whatIfAnalysis: whatIfData,
    totalStrategiesCreated: store.getTotalCount(),
    strategyStateCounts,
    patterns,
    existingStrategistLessons,
    marketRegime: dominantRegime,
  };

  const strategistResult = await analyzeStrategistPerformance(strategistInput);

  // Persist strategist lessons to strategies.db (for strategist's tool)
  store.replaceStrategistLessons(strategistResult.evolvedLessons);
  console.log(`  ✅ Strategist retro complete: ${strategistResult.evolvedLessons.filter((l) => !l.deprecated).length} active lessons`);

  // ═══════════════════════════════════════════════════════════════════════
  // BUILD COMBINED REPORT
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n📝 Building combined report...`);

  const markdown = buildCombinedReport({
    date: today,
    tradeCount: trades.length,
    totalEquityChange,
    startingEquity,
    endingEquity,
    cashAtEnd: state.getCash(),
    settledCashAtEnd: state.getSettledCash(),
    winCount: wins.length,
    lossCount: losses.length,
    winRate,
    grossPnL,
    tokenCost: tokenCost?.totalCost ?? 0,
    netPnL,
    positionsHeldAtClose: state.getPositions().length,
    traderWhatWorked: traderResult.analysis.whatWorked,
    traderWhatDidnt: traderResult.analysis.whatDidnt,
    traderWhatToChange: traderResult.analysis.whatToChange,
    strategistOverview: strategistResult.analysis.overview,
    strategistSignalSources: strategistResult.analysis.signalSourceQuality,
    strategistRegimeFit: strategistResult.analysis.strategyRegimeFit,
    strategistLifecycle: strategistResult.analysis.lifecycleManagement,
    strategistCatalysts: strategistResult.analysis.catalystAssessment,
    whatIfSection: whatIfReportSection,
  });

  const report: DailyReport = {
    date: today,
    timestamp: new Date().toISOString(),
    tradeCount: trades.length,
    totalEquityChange,
    startingEquity,
    endingEquity,
    cashAtEnd: state.getCash(),
    settledCashAtEnd: state.getSettledCash(),
    winCount: wins.length,
    lossCount: losses.length,
    winRate,
    grossPnL,
    tokenCost: tokenCost?.totalCost ?? 0,
    netPnL,
    positionsHeldAtClose: state.getPositions().length,
    whatWorked: traderResult.analysis.whatWorked,
    whatDidnt: traderResult.analysis.whatDidnt,
    whatToChange: traderResult.analysis.whatToChange,
    markdown,
    whatIfAnalysis: whatIfData ?? undefined,
  };

  // Persist the report
  state.saveDailyReport(report);

  console.log(`\n✅ Retrospective complete for ${today}`);
  console.log(`   Trades: ${trades.length} | Net P&L: $${netPnL.toFixed(2)} | Win Rate: ${winRate.toFixed(1)}%`);
  if (whatIfData) {
    console.log(`   What-If: ${whatIfData.totalStrategiesAnalyzed} strategies graded, $${whatIfData.totalHypotheticalPnL.toFixed(2)} hypo P&L`);
  }
  console.log(`   Trader lessons: ${traderResult.evolvedLessons.filter((l) => !l.deprecated).length} active`);
  console.log(`   Strategist lessons: ${strategistResult.evolvedLessons.filter((l) => !l.deprecated).length} active`);

  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMBINED REPORT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

function buildCombinedReport(rpt: {
  date: string;
  tradeCount: number;
  totalEquityChange: number;
  startingEquity: number;
  endingEquity: number;
  cashAtEnd: number;
  settledCashAtEnd: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  grossPnL: number;
  tokenCost: number;
  netPnL: number;
  positionsHeldAtClose: number;
  traderWhatWorked: string;
  traderWhatDidnt: string;
  traderWhatToChange: string;
  strategistOverview: string;
  strategistSignalSources: string;
  strategistRegimeFit: string;
  strategistLifecycle: string;
  strategistCatalysts: string;
  whatIfSection?: string;
}): string {
  const changeEmoji = rpt.netPnL >= 0 ? "🟢" : "🔴";
  const winRateEmoji = rpt.winRate >= 50 ? "✅" : "⚠️";

  return [
    `# Scrooge Daily Report — ${rpt.date}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Trades** | ${rpt.tradeCount} |`,
    `| **Starting Equity** | $${rpt.startingEquity.toFixed(2)} |`,
    `| **Ending Equity** | $${rpt.endingEquity.toFixed(2)} |`,
    `| **Total Equity Change** | ${changeEmoji} $${rpt.totalEquityChange.toFixed(2)} |`,
    `| **Wins** | ${rpt.winCount} ✅ |`,
    `| **Losses** | ${rpt.lossCount} ❌ |`,
    `| **Win Rate** | ${winRateEmoji} ${rpt.winRate.toFixed(1)}% |`,
    `| **Gross P&L** | $${rpt.grossPnL.toFixed(2)} |`,
    `| **Token Cost** | $${rpt.tokenCost.toFixed(5)} |`,
    `| **Net P&L (after costs)** | ${changeEmoji} **$${rpt.netPnL.toFixed(2)}** |`,
    `| **Cash at EOD** | $${rpt.cashAtEnd.toFixed(2)} |`,
    `| **Positions Held at Close** | ${rpt.positionsHeldAtClose} |`,
    ``,
    `## Trader Analysis`,
    ``,
    `### What Worked (Execution)`,
    ``,
    rpt.traderWhatWorked,
    ``,
    `### What Didn't Work (Execution)`,
    ``,
    rpt.traderWhatDidnt,
    ``,
    `### What to Change (Execution)`,
    ``,
    rpt.traderWhatToChange,
    ``,
    `## Strategist Analysis`,
    ``,
    `### Overview`,
    ``,
    rpt.strategistOverview,
    ``,
    `### Signal Source Quality`,
    ``,
    rpt.strategistSignalSources,
    ``,
    `### Strategy × Regime Fit`,
    ``,
    rpt.strategistRegimeFit,
    ``,
    `### Lifecycle Management`,
    ``,
    rpt.strategistLifecycle,
    ``,
    `### Catalyst Assessment`,
    ``,
    rpt.strategistCatalysts,
    ``,
    rpt.whatIfSection || "",
    ``,
    `---`,
    ``,
    `*Generated by Scrooge AI at ${new Date().toISOString()}*`,
    ``,
  ].join("\n");
}