/**
 * Daily retrospective module.
 *
 * After each trading day, Scrooge runs an LLM-driven retrospective that:
 *   - Analyzes the day's trades (decisions taken)
 *   - Analyzes non-decisions (opportunities the agent saw but passed on)
 *   - Reviews outcomes (P&L, win rate, equity curve)
 *   - Generates a markdown report with structured prose sections
 *
 * The report is persisted in state.json and served via the API so your
 * assistant can fetch it and message you with the summary.
 */

import { PortfolioState } from "../state/portfolio.js";
import { StrategyStore } from "../state/strategies.js";
import type { DailyReport, Lesson, StrategyCalibration } from "../types.js";
import { analyzeDay, RetrospectiveDataBundle } from "./analyzer.js";
import { getTradingDate } from "../config.js";
import { integrateLessons } from "./lesson-integrator.js";
import { runWhatIfAnalysis, formatAbstractionsForPrompt, formatWhatIfForLessons, formatWhatIfForReport } from "./what-if.js";

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
 * Call this at market close (or after the last cycle of the day).
 * Returns the completed DailyReport and persists it to state.json.
 */
export async function runDailyRetrospective(state: PortfolioState, strategyStore?: StrategyStore, forceDate?: string): Promise<DailyReport> {
  const today = forceDate || getTradingDate();
  console.log(`📋 Running daily retrospective for ${today}...`);

  // Gather raw data
  const trades = state.getTradesForDay(today);
  const history = state.getSnapshotsForDay(today);
  const lessons = state.getMemory().lessons;
  const lessonInsights = lessons.filter((l) => !l.deprecated).map((l) => l.insight);
  const calibrationTable = state.getCalibrationTable();
  const tokenCost = state.getDailyTokenCost(today);

  // Compute stats — never use 0 as starting equity, always fall back to the actual equity
  const allHistory = state.getSnapshotHistory();
  const startingEquity = history.length > 0
    ? history[0].totalEquity
    : allHistory.length > 0
      ? allHistory[allHistory.length - 1].totalEquity
      : state.getSettledCash();
  const endingEquity = history.length > 0
    ? history[history.length - 1].totalEquity
    : await state.getAccountEquity();
  const totalEquityChange = endingEquity - startingEquity;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const grossPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const netPnL = grossPnL - (tokenCost?.totalCost ?? 0);

  // ═══════════════════════════════════════════════════════════════════════
  // WHAT-IF STRATEGY ANALYSIS — Grade all strategies from today
  // ═══════════════════════════════════════════════════════════════════════
  let whatIfData: Awaited<ReturnType<typeof runWhatIfAnalysis>> | null = null;
  let store: StrategyStore;
  if (strategyStore || process.env.STRATEGIES_DB_PATH) {
    store = strategyStore ?? new StrategyStore(process.env.STRATEGIES_DB_PATH);
    try {
      whatIfData = await runWhatIfAnalysis(today, store, state);
    } catch (e: any) {
      console.warn(`⚠️  What-If analysis failed: ${e.message}`);
    }
  } else {
    store = new StrategyStore("data/strategies.db");
  }

  const whatIfSummary = whatIfData ? formatAbstractionsForPrompt(whatIfData) : "";
  const whatIfReportSection = whatIfData ? formatWhatIfForReport(whatIfData) : "";

  // Build comprehensive data bundle for the LLM
  const dataBundle = buildDataBundle(
    today,
    trades,
    wins,
    losses,
    startingEquity,
    endingEquity,
    totalEquityChange,
    grossPnL,
    winRate,
    tokenCost,
    lessonInsights,
    calibrationTable,
    history,
    state,
    whatIfData,
    store
  );

  // Have the LLM write the analysis
  const analysis = await analyzeDay(dataBundle);

  // Append what-if-specific analysis to the LLM-produced sections
  // (the what-if data was also included in the data bundle for LLM consumption)

  // Build the full markdown report
  const markdown = buildMarkdownReport({
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
    whatWorked: analysis.whatWorked,
    whatDidnt: analysis.whatDidnt,
    whatToChange: analysis.whatToChange,
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
    whatWorked: analysis.whatWorked,
    whatDidnt: analysis.whatDidnt,
    whatToChange: analysis.whatToChange,
    markdown,
    whatIfAnalysis: whatIfData ?? undefined,
  };

  // Persist the report
  state.saveDailyReport(report);

  // ── EVOLVE LESSONS via the lesson integrator ──────────────────────────
  // The lesson integrator now receives what-if abstractions as additional
  // structured context about which strategy patterns worked and which didn't.
  console.log(`🧠 Running lesson integrator...`);
  const calibrationSummary = calibrationTable.length > 0
    ? calibrationTable.map((c) =>
        `- ${c.strategy} in ${c.regime}: ${(c.winRate * 100).toFixed(0)}% WR (${c.totalTrades} trades)`
      ).join("\n")
    : "No calibration data yet.";

  const whatIfLessonsContext = whatIfData
    ? `\n\n### What-If Strategy Analysis (for lesson evolution)\n\n${formatWhatIfForLessons(whatIfData)}`
    : "";

  const existingLessons = state.getMemory().lessons;
  const evolvedLessons = await integrateLessons({
    date: today,
    report,
    existingLessons,
    performanceSnapshot: {
      totalTrades: trades.length,
      winRate,
      netPnL,
      equityChange: totalEquityChange,
      consecutiveLosses: trades.slice(-5).filter((t) => t.pnl <= 0).length,
    },
    calibrationSummary: calibrationSummary + whatIfLessonsContext,
  });

  state.replaceAllLessons(evolvedLessons);

  console.log(`✅ Daily retrospective saved for ${today}`);
  console.log(`   Trades: ${trades.length} | Net P&L: $${netPnL.toFixed(2)} | Win Rate: ${winRate.toFixed(1)}%`);
  if (whatIfData) {
    console.log(`   What-If: ${whatIfData.totalStrategiesAnalyzed} strategies graded, $${whatIfData.totalHypotheticalPnL.toFixed(2)} hypothetical P&L`);
  }
  console.log(`   Lessons: ${evolvedLessons.length} total (${evolvedLessons.filter((l) => !l.deprecated).length} active)`);

  return report;
}

// ─── Data Bundle Builder ────────────────────────────────────────────────────

function buildDataBundle(
  date: string,
  trades: any[],
  wins: any[],
  losses: any[],
  startingEquity: number,
  endingEquity: number,
  totalEquityChange: number,
  grossPnL: number,
  winRate: number,
  tokenCost: any,
  lessons: string[],
  calibrationTable: any[],
  history: any[],
  state: PortfolioState,
  whatIfData?: any,
  strategyStore?: StrategyStore
): RetrospectiveDataBundle {
  // Equity curve as a compact text representation
  const equityCurve = history.length > 0
    ? history
        .filter((_, i) => i % Math.max(1, Math.floor(history.length / 20)) === 0 || i === history.length - 1)
        .map((s) => {
          const time = s.timestamp.slice(11, 19);
          return `${time} $${s.totalEquity.toFixed(2)}`;
        })
        .join(" → ")
    : "No snapshots";

  // Market regimes seen
  const regimes = [...new Set(history.map((s) => s.regime).filter(Boolean))];

  // Context notes
  const ctxNotes = state.getContextNotes().map(
    (n) => `[${n.topic}]${n.ticker ? ` ${n.ticker}` : ""} — ${n.note}`
  );

  // ── Strategy-aware fields ──────────────────────────────────────────
  let whatIfSummary = "";
  let topStrategies: Array<{ ticker: string; type: string; direction: string; grade: number; pnl: string }> = [];
  let bottomStrategies: Array<{ ticker: string; type: string; direction: string; grade: number; pnl: string }> = [];
  let strategyStateCounts: Record<string, number> = { anticipated: 0, developing: 0, realized: 0, active: 0, failed: 0, stale: 0 };
  let executedStrategies: Array<{
    ticker: string;
    type: string;
    direction: string;
    state: string;
    confidence: number;
    catalyst: string;
    pnl: number | null;
    pnlPct: number | null;
    exit_reason: string | null;
  }> = [];

  if (whatIfData) {
    whatIfSummary = formatAbstractionsForPrompt(whatIfData);
    topStrategies = whatIfData.strategies
      .filter((s: any) => s.grade >= 4)
      .map((s: any) => ({
        ticker: s.ticker,
        type: s.strategy_type,
        direction: s.direction,
        grade: s.grade,
        pnl: `$${s.potentialGainLoss.toFixed(2)}`,
      }));
    bottomStrategies = whatIfData.strategies
      .filter((s: any) => s.grade <= 2)
      .map((s: any) => ({
        ticker: s.ticker,
        type: s.strategy_type,
        direction: s.direction,
        grade: s.grade,
        pnl: `$${s.potentialGainLoss.toFixed(2)}`,
      }));
  }

  if (strategyStore) {
    strategyStateCounts = strategyStore.getStateCounts();
    const executed = strategyStore.getExecuted(50);
    executedStrategies = executed.map((s: any) => ({
      ticker: s.ticker,
      type: s.strategy_type,
      direction: s.direction,
      state: s.state,
      confidence: s.confidence,
      catalyst: s.catalyst ?? "",
      pnl: s.pnl,
      pnlPct: s.pnl_pct,
      exit_reason: s.exit_reason,
    }));
  }

  const activeStrategyCount =
    (strategyStateCounts.anticipated ?? 0) +
    (strategyStateCounts.developing ?? 0) +
    (strategyStateCounts.realized ?? 0) +
    (strategyStateCounts.active ?? 0);

  // Also add direction field to trades for the new bundle
  const tradesWithDir = trades.map((t: any) => ({
    symbol: t.symbol,
    strategy: t.strategy,
    direction: t.direction ?? "long",
    pnl: t.pnl,
    pnlPct: t.pnlPct,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    exitReason: t.exitReason,
    holdMinutes: t.holdMinutesActual,
    wasPromoted: t.wasPromoted,
    signalSource: t.signalSource,
    signalConfidence: t.signalConfidence,
    signalImpactScore: t.signalImpactScore,
    agentReasoning: t.agentReasoning,
  }));

  return {
    date,
    tradeCount: trades.length,
    trades: tradesWithDir,
    wins: wins.length,
    losses: losses.length,
    winRate,
    grossPnL,
    startingEquity,
    endingEquity,
    totalEquityChange,
    tokenCost: tokenCost?.totalCost ?? 0,
    netPnL: grossPnL - (tokenCost?.totalCost ?? 0),
    lessons,
    calibrationTable: calibrationTable.map((c: any) => ({
      strategy: c.strategy,
      regime: c.regime,
      winRate: c.winRate,
      totalTrades: c.totalTrades,
      avgWinPct: c.avgWinPct,
      avgLossPct: c.avgLossPct,
    })),
    equityCurve,
    marketRegimes: regimes,
    contextNotes: ctxNotes,
    // Strategy-aware fields
    whatIfSummary,
    activeStrategyCount,
    topStrategies,
    bottomStrategies,
    strategyStateCounts,
    executedStrategies,
  };
}

// ─── Markdown Report Builder ────────────────────────────────────────────────

function buildMarkdownReport(report: {
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
  whatWorked: string;
  whatDidnt: string;
  whatToChange: string;
  whatIfSection?: string;
}): string {
  const changeEmoji = report.netPnL >= 0 ? "🟢" : "🔴";
  const winRateEmoji = report.winRate >= 50 ? "✅" : "⚠️";

  return [
    `# Scrooge Daily Report — ${report.date}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Trades** | ${report.tradeCount} |`,
    `| **Starting Equity** | $${report.startingEquity.toFixed(2)} |`,
    `| **Ending Equity** | $${report.endingEquity.toFixed(2)} |`,
    `| **Total Equity Change** | ${changeEmoji} $${report.totalEquityChange.toFixed(2)} |`,
    `| **Wins** | ${report.winCount} ✅ |`,
    `| **Losses** | ${report.lossCount} ❌ |`,
    `| **Win Rate** | ${winRateEmoji} ${report.winRate.toFixed(1)}% |`,
    `| **Gross P&L** | $${report.grossPnL.toFixed(2)} |`,
    `| **Token Cost** | $${report.tokenCost.toFixed(5)} |`,
    `| **Net P&L (after costs)** | ${changeEmoji} **$${report.netPnL.toFixed(2)}** |`,
    `| **Cash at EOD** | $${report.cashAtEnd.toFixed(2)} |`,
    `| **Positions Held at Close** | ${report.positionsHeldAtClose} |`,
    ``,
    `## What Worked Well`,
    ``,
    report.whatWorked,
    ``,
    `## What Didn't Work Well`,
    ``,
    report.whatDidnt,
    ``,
    `## What to Do Differently`,
    ``,
    report.whatToChange,
    ``,
    report.whatIfSection || "",
    ``,
    `---`,
    ``,
    `*Generated by Scrooge AI at ${new Date().toISOString()}*`,
    ``,
  ].join("\n");
}
