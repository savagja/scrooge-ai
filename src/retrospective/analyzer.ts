/**
 * LLM-powered analysis for the daily retrospective.
 *
 * Strategy-aware: Evaluates the TRADER's execution against the STRATEGIST's
 * hypotheses, not just raw P&L. The what-if data and strategy lifecycle
 * states are central to the analysis.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

interface RetrospectiveAnalysis {
  whatWorked: string;
  whatDidnt: string;
  whatToChange: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

export async function analyzeDay(
  data: RetrospectiveDataBundle
): Promise<RetrospectiveAnalysis> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[RETRO] No OPENROUTER_API_KEY — falling back to template report");
    return fallbackAnalysis(data);
  }

  const model = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite";

  const systemPrompt = `You are the performance analyst for Scrooge, an autonomous AI trading bot with a two-agent architecture:

  - **Strategist**: Forms hypotheses (strategies with lifecycle states). Does NOT trade.
  - **Trader**: Executes strategies. Reads top 10 non-position strategies and decides entry/exit.

Your job is to evaluate the TRADER's performance against the STRATEGIST's hypotheses.

## Core Evaluation Framework

### 1. Strategy-Trade Alignment
For each trade, was there a strategy behind it? If a trade happened without a linked strategy, that's a RED FLAG — the trader acted without research backing.

### 2. What-If Opportunity Cost
The what-if analysis grades every active strategy on a 1-5 scale with hypothetical P&L. 
- Did the trader take G4-5 (good/excellent) strategies? Great.
- Did the trader ignore G4-5 while taking G1-2? Bad.
- Did the trader enter G1-2 strategies? That means poor strategy selection.

### 3. Regime x Strategy Fit
- momentum in trending_up: fits | momentum in chop: misfit
- mean_reversion in chop: fits | mean_reversion in trending_up: misfit
- event_driven in volatile: fits | event_driven in trending_up: neutral
- swing in trending_up: fits | swing in volatile: misfit

### 4. Strategy Lifecycle
- Did the trader enter at the right lifecycle stage (developing or realized)?
- Were strategies archived correctly (failed/stale)?

### 5. Recurring Patterns
What patterns emerge from the what-if analysis? Look for repeated abstractions that worked or failed.

## Output Format
Be direct. Use specific examples. No corporate speak.

Respond ONLY with valid JSON:
{
  "whatWorked": "Markdown prose (2-4 paragraphs) about strategy-trade alignment, good selections, what-if successes",
  "whatDidnt": "Markdown prose (2-4 paragraphs) about misalignment, ignored strategies, regime misfit, what-if failures",
  "whatToChange": "Markdown prose with 2-4 specific improvements to HOW strategies are assessed. Focus on: how to evaluate strategy quality better, which signal patterns should increase/decrease conviction scores, how to detect regime-strategy fit earlier, what contextual factors are being missed when scoring strategies. Also analyze the what-if results: were there high-grade strategies (G4-5) the trader missed? What made those strategies good in hindsight but the trader didn't see it? Were there low-grade strategies (G1-2) the trader wasted time on? What signal should have flagged those as poor earlier? Use these patterns to improve strategy assessment. Do NOT suggest trading rules (position sizing, stop levels, min trades, forced execution)."
}`;

  const userPrompt = buildAnalysisPrompt(data);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://scrooge-trading-bot.local",
        "X-Title": "Scrooge Daily Retrospective",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[RETRO] OpenRouter error: ${res.status} ${text.slice(0, 200)}`);
      return fallbackAnalysis(data);
    }

    const raw = await res.json();
    const content: string = raw.choices?.[0]?.message?.content || "";

    let cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) cleaned = match[0];

    const parsed = JSON.parse(cleaned) as RetrospectiveAnalysis;

    return {
      whatWorked: parsed.whatWorked || fallbackWhatWorked(data),
      whatDidnt: parsed.whatDidnt || fallbackWhatDidnt(data),
      whatToChange: parsed.whatToChange || fallbackWhatToChange(data),
    };
  } catch (e: any) {
    console.warn(`[RETRO] LLM analysis failed: ${e.message}`);
    return fallbackAnalysis(data);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA BUNDLE
// ═══════════════════════════════════════════════════════════════════════════

export interface RetrospectiveDataBundle {
  date: string;
  tradeCount: number;
  trades: Array<{
    symbol: string;
    strategy: string;
    direction: string;
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
  equityCurve: string;
  marketRegimes: string[];
  contextNotes: string[];
  // Strategy-aware fields
  whatIfSummary: string;
  activeStrategyCount: number;
  topStrategies: Array<{ ticker: string; type: string; direction: string; grade: number; pnl: string }>;
  bottomStrategies: Array<{ ticker: string; type: string; direction: string; grade: number; pnl: string }>;
  strategyStateCounts: Record<string, number>;
  executedStrategies: Array<{
    ticker: string;
    type: string;
    direction: string;
    state: string;
    confidence: number;
    catalyst: string;
    pnl: number | null;
    pnlPct: number | null;
    exit_reason: string | null;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

function buildAnalysisPrompt(data: RetrospectiveDataBundle): string {
  const lines: string[] = [
    `## Daily Retrospective Data - ${data.date}`,
    ``,
    `### Overview`,
    `- Trades executed: ${data.tradeCount}`,
    `- Wins: ${data.wins} | Losses: ${data.losses}`,
    `- Win Rate: ${data.winRate.toFixed(1)}%`,
    `- Gross P&L: $${data.grossPnL.toFixed(2)}`,
    `- Token Cost: $${data.tokenCost.toFixed(5)}`,
    `- Net P&L: $${data.netPnL.toFixed(2)}`,
    `- Starting Equity: $${data.startingEquity.toFixed(2)}`,
    `- Ending Equity: $${data.endingEquity.toFixed(2)}`,
    `- Total Equity Change: $${data.totalEquityChange.toFixed(2)}`,
    `- Market Regimes Seen: ${data.marketRegimes.join(", ") || "unknown"}`,
    `- Active Strategies Today: ${data.activeStrategyCount}`,
    `- Strategy Lifecycle: A:${data.strategyStateCounts.anticipated ?? 0} D:${data.strategyStateCounts.developing ?? 0} R:${data.strategyStateCounts.realized ?? 0} F:${data.strategyStateCounts.failed ?? 0} S:${data.strategyStateCounts.stale ?? 0}`,
    ``,
    `### Equity Curve (sampled)`,
    data.equityCurve || "No snapshots available",
    ``,
  ];

  // Executed Strategies
  if (data.executedStrategies.length > 0) {
    lines.push(`### Executed Strategies (Linked to Positions)`);
    for (const s of data.executedStrategies) {
      const pnlStr = s.pnl !== null ? `$${s.pnl.toFixed(2)} (${(s.pnlPct ?? 0).toFixed(2)}%)` : "-";
      lines.push(
        `- [${s.ticker}] ${s.type} ${s.direction} | State: ${s.state} | Conf: ${(s.confidence * 100).toFixed(0)}% | ` +
        `Catalyst: ${s.catalyst ?? "none"} | P&L: ${pnlStr} | Exit: ${s.exit_reason ?? "open"}`
      );
    }
    lines.push(``);
  }

  // Trades
  if (data.trades.length > 0) {
    lines.push(`### Trades Executed`);
    for (const t of data.trades) {
      const emoji = t.pnl >= 0 ? "+" : "-";
      lines.push(
        `${emoji} [${t.symbol}] ${t.strategy} (${t.direction}) | P&L: $${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(2)}%) | ` +
        `Entry: $${t.entryPrice.toFixed(2)} -> Exit: $${t.exitPrice.toFixed(2)} | ` +
        `Held: ${t.holdMinutes}min | Exit: ${t.exitReason} | ` +
        `Signal: ${t.signalSource} (conf: ${(t.signalConfidence * 100).toFixed(0)}%, impact: ${t.signalImpactScore}/10)`
      );
      if (t.agentReasoning) {
        lines.push(`  Reasoning: ${t.agentReasoning.slice(0, 200)}`);
      }
    }
    lines.push(``);
  }

  // What-If Analysis
  if (data.whatIfSummary) {
    lines.push(`### What-If Strategy Analysis (Graded Strategies)`);
    lines.push(data.whatIfSummary);
    lines.push(``);
  }

  // Top Strategies
  if (data.topStrategies.length > 0) {
    lines.push(`### Top-Grade Strategies (G4-5) - Trader Should Have Considered`);
    for (const s of data.topStrategies) {
      lines.push(`- [${s.ticker}] ${s.type} ${s.direction} | G${s.grade}/5 | Hypo P&L: ${s.pnl}`);
    }
    lines.push(``);
  }

  // Bottom Strategies
  if (data.bottomStrategies.length > 0) {
    lines.push(`### Low-Grade Strategies (G1-2) - Trader Should Have Avoided`);
    for (const s of data.bottomStrategies) {
      lines.push(`- [${s.ticker}] ${s.type} ${s.direction} | G${s.grade}/5 | Hypo P&L: ${s.pnl}`);
    }
    lines.push(``);
  }

  // Context Notes
  if (data.contextNotes.length > 0) {
    lines.push(`### Context Notes (What the Agent Was Tracking)`);
    for (const n of data.contextNotes) {
      lines.push(`- ${n}`);
    }
    lines.push(``);
  }

  // Lessons
  if (data.lessons.length > 0) {
    lines.push(`### Previously Stored Lessons`);
    for (const l of data.lessons.slice(-10)) {
      lines.push(`- ${l}`);
    }
    lines.push(``);
  }

  // Calibration
  if (data.calibrationTable.length > 0) {
    lines.push(`### Strategy x Regime Calibration (Historical)`);
    for (const c of data.calibrationTable) {
      lines.push(
        `- ${c.strategy} in ${c.regime}: ${(c.winRate * 100).toFixed(0)}% WR (${c.totalTrades} trades, ` +
        `avg win ${(c.avgWinPct * 100).toFixed(1)}%, avg loss ${(c.avgLossPct * 100).toFixed(1)}%)`
      );
    }
    lines.push(``);
  }

  lines.push(
    `---`,
    ``,
    `Now analyze with a STRATEGY-AWARE lens:`,
    `1. Did the trader execute the right strategies from the strategist's slate?`,
    `2. Were there highly-graded strategies (G4-5) the trader ignored?`,
    `3. Did the trader enter low-graded strategies (G1-2) that should have been avoided?`,
    `4. Was the strategy lifecycle managed correctly?`,
    `5. What patterns in the what-if analysis suggest systematic biases?`,
    `6. Was the strategy type appropriate for market regime?`,
    `7. Did trader entry/exit align with strategy thesis?`,
    ``,
    `Be direct and critical. Use specific examples.`,
  );

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// FALLBACK ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

function fallbackAnalysis(data: RetrospectiveDataBundle): RetrospectiveAnalysis {
  return {
    whatWorked: fallbackWhatWorked(data),
    whatDidnt: fallbackWhatDidnt(data),
    whatToChange: fallbackWhatToChange(data),
  };
}

function fallbackWhatWorked(data: RetrospectiveDataBundle): string {
  const parts: string[] = [];

  if (data.executedStrategies.length > 0) {
    const winners = data.executedStrategies.filter((s) => s.pnl !== null && s.pnl > 0);
    if (winners.length > 0) {
      parts.push(
        `**${winners.length} executed strategies were profitable.** ` +
        winners.map((s) => `${s.ticker} (${s.type} ${s.direction}, +${(s.pnlPct ?? 0).toFixed(1)}%)`).join(", ") +
        `. These represent strategy-trade alignment that worked.`
      );
    }
  }

  if (data.topStrategies.length > 0) {
    parts.push(
      `**${data.topStrategies.length} strategies graded G4-5** (good/excellent) were identified by the what-if analysis. ` +
      `These represent setups with solid thesis, clear catalysts, and good regime fit. ` +
      `Patterns: ${data.topStrategies.map((s) => `${s.ticker} (${s.type} ${s.direction})`).join(", ")}.`
    );
  }

  if (data.activeStrategyCount > 0) {
    parts.push(
      `**${data.activeStrategyCount} strategies were active** during the day across lifecycle states. ` +
      `The strategist generated hypotheses for the trader to evaluate.`
    );
  }

  if (data.winRate > 60 && data.tradeCount >= 3) {
    parts.push(
      `**Win rate was strong at ${data.winRate.toFixed(0)}%** - the trader showed good discretion ` +
      `on which strategies to execute.`
    );
  }

  if (data.grossPnL > 0) {
    parts.push(
      `**The day finished positive with a gross P&L of $${data.grossPnL.toFixed(2)}** - ` +
      `the trader's directional bets aligned with strategy theses.`
    );
  }

  if (parts.length === 0) {
    parts.push(
      `No trades were executed today. The trader held cash, which is valid if the strategist's ` +
      `top strategies didn't align with market conditions. However, ` +
      (data.activeStrategyCount > 0
        ? `${data.activeStrategyCount} strategies existed - the trader should explain why none were actionable.`
        : `no strategies were active - the strategist needs to generate more hypotheses.`)
    );
  }

  return parts.join("\n\n");
}

function fallbackWhatDidnt(data: RetrospectiveDataBundle): string {
  const parts: string[] = [];

  if (data.bottomStrategies.length > 0 && data.executedStrategies.length > 0) {
    const badEntries = data.executedStrategies.filter((s) =>
      data.bottomStrategies.some((b) => b.ticker === s.ticker && b.type === s.type)
    );
    if (badEntries.length > 0) {
      parts.push(
        `**${badEntries.length} executed strategies received poor what-if grades (G1-2).** ` +
        `The trader entered strategies that the retrospective analysis rated as poor setups. ` +
        `These include: ${badEntries.map((s) => `${s.ticker} (${s.type} ${s.direction})`).join(", ")}.`
      );
    }
  }

  if (data.topStrategies.length > 0 && data.tradeCount > 0) {
    parts.push(
      `**${data.topStrategies.length} high-grade strategies existed** that the trader DID NOT execute. ` +
      `These represent missed opportunities: ${data.topStrategies.map((s) => `${s.ticker} (G${s.grade})`).join(", ")}. ` +
      `The trader should explain why these were skipped.`
    );
  }

  if (data.tradeCount === 0) {
    parts.push(`**Zero trades executed today.** The trader needs to find more opportunities by reviewing the strategist's hypotheses more carefully.`);
  }

  if (data.winRate < 50 && data.tradeCount >= 3) {
    parts.push(`**Win rate was ${data.winRate.toFixed(0)}%** - the trader lost more trades than won. This suggests poor strategy selection, wrong regime fit, or bad timing.`);
  }

  if (data.netPnL < 0) {
    parts.push(`**Net P&L was negative at $${data.netPnL.toFixed(2)}** - the combination of trade losses and token costs resulted in account drawdown.`);
  }

  if (parts.length === 0) {
    parts.push(`No major issues identified from the raw data. The LLM analysis would provide deeper insight into strategy-trade alignment and what-if opportunity costs.`);
  }

  return parts.join("\n\n");
}

function fallbackWhatToChange(data: RetrospectiveDataBundle): string {
  const recommendations: string[] = [];

  if (data.tradeCount === 0 && data.activeStrategyCount > 0) {
    recommendations.push("**Execute more.** The strategist generated hypotheses but the trader didn't act. Review why the top strategies weren't actionable.");
  } else if (data.tradeCount === 0) {
    recommendations.push("**Strategist needs more output.** No strategies were active. The strategist should cast a wider net.");
  }

  if (data.bottomStrategies.length > 0 && data.executedStrategies.length > 0) {
    const overlaps = data.executedStrategies.filter(s =>
      data.bottomStrategies.some(b => b.ticker === s.ticker && b.type === s.type)
    );
    if (overlaps.length > 0) {
      recommendations.push("**Avoid low-grade strategies.** The trader entered strategies that the what-if analysis graded poorly. Use the what-if grades from past retrospectives to filter out G1-2 strategies before entry.");
    }
  }

  if (data.topStrategies.length > 0 && data.executedStrategies.length > 0) {
    const missedOpportunities = data.topStrategies.filter(t =>
      !data.executedStrategies.some(e => e.ticker === t.ticker && e.type === t.type)
    );
    if (missedOpportunities.length > 0) {
      recommendations.push("**Take more high-grade opportunities.** The trader ignored G4-5 strategies. Lower the bar for entry when the what-if pattern is proven (same strategy type + regime that has historically graded well).");
    }
  }

  if (data.winRate < 50 && data.tradeCount >= 3) {
    recommendations.push("**Improve signal selection.** A win rate below 50% means poor strategy-regime fit. Check if the strategies being executed match the current regime. Use the calibration table as a filter.");
  }

  const strategies = new Set(data.trades.map((t) => t.strategy));
  if (strategies.size <= 1 && data.tradeCount >= 3) {
    recommendations.push("**Diversify strategy types.** All trades used one approach. Different regimes reward different strategies.");
  }

  if (recommendations.length === 0) {
    recommendations.push("**Continue with current approach** - monitor for regime changes.");
    recommendations.push("**Increase position sizing** if win rate stays above 60%.");
  }

  return recommendations.map((r) => `- ${r}`).join("\n");
}