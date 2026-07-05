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
import type { DailyReport, Lesson, StrategyCalibration } from "../types.js";
import { analyzeDay } from "./analyzer.js";
import { getTradingDate } from "../config.js";
import { integrateLessons } from "./lesson-integrator.js";

/**
 * Check whether the retrospective should run for today.
 * Returns true if no report exists for the current date yet.
 */
export async function shouldRunRetrospective(state: PortfolioState): Promise<boolean> {
  const today = getTradingDate();
  const latestReport = state.getLatestReport();
  return !latestReport || latestReport.date !== today;
}

/**
 * Run the full-day retrospective.
 *
 * Call this at market close (or after the last cycle of the day).
 * Returns the completed DailyReport and persists it to state.json.
 */
export async function runDailyRetrospective(state: PortfolioState): Promise<DailyReport> {
  const today = getTradingDate();
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
    state
  );

  // Have the LLM write the analysis
  const analysis = await analyzeDay(dataBundle);

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
  };

  // Persist the report
  state.saveDailyReport(report);

  // ── EVOLVE LESSONS via the lesson integrator ──────────────────────────
  // This is a SEPARATE LLM call that takes the retrospective findings
  // together with existing lessons and returns an evolved set (merge,
  // modify, overwrite, remove — NOT just additive).
  console.log(`🧠 Running lesson integrator...`);
  const calibrationSummary = calibrationTable.length > 0
    ? calibrationTable.map((c) =>
        `- ${c.strategy} in ${c.regime}: ${(c.winRate * 100).toFixed(0)}% WR (${c.totalTrades} trades)`
      ).join("\n")
    : "No calibration data yet.";

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
    calibrationSummary,
  });

  state.replaceAllLessons(evolvedLessons);

  console.log(`✅ Daily retrospective saved for ${today}`);
  console.log(`   Trades: ${trades.length} | Net P&L: $${netPnL.toFixed(2)} | Win Rate: ${winRate.toFixed(1)}%`);
  console.log(`   Lessons: ${evolvedLessons.length} total (${evolvedLessons.filter((l) => !l.deprecated).length} active)`);

  return report;
}

// ─── Data Bundle Builder ────────────────────────────────────────────────────

interface RetrospectiveDataBundle {
  date: string;
  tradeCount: number;
  trades: Array<{
    symbol: string;
    strategy: string;
    pnl: number;
    pnlPct: number;
    entryPrice: number;
    exitPrice: number;
    exitReason: string;
    holdMinutes: number;
    wasPromoted: boolean;
    signalSource: string;
    signalConfidence: number;
    signalImpactScore: number;
    agentReasoning: string;
  }>;
  wins: number;
  losses: number;
  winRate: number;
  grossPnL: number;
  startingEquity: number;
  endingEquity: number;
  totalEquityChange: number;
  tokenCost: number;
  netPnL: number;
  lessons: string[];
  calibrationTable: Array<{
    strategy: string;
    regime: string;
    winRate: number;
    totalTrades: number;
    avgWinPct: number;
    avgLossPct: number;
  }>;
  equityCurve: string;      // Compact text representation
  marketRegimes: string[];  // Regimes seen during the day
  contextNotes: string[];   // What the agent was tracking
}

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
  state: PortfolioState
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

  return {
    date,
    tradeCount: trades.length,
    trades: trades.map((t) => ({
      symbol: t.symbol,
      strategy: t.strategy,
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
    })),
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
    calibrationTable: calibrationTable.map((c) => ({
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
    `---`,
    ``,
    `*Generated by Scrooge AI at ${new Date().toISOString()}*`,
    ``,
  ].join("\n");
}
