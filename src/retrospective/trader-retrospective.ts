/**
 * Trader Retrospective — evaluates the trader's execution quality.
 *
 * Focused on:
 *   - Trade execution decisions (entry timing, strategy selection)
 *   - Position management (exit discipline, stop adherence)
 *   - Strategy-to-trade conversion rate (did the trader act on good strategies?)
 *   - Missed opportunities (high-grade strategies the trader skipped)
 *
 * Produces trader-targeted lessons about execution, timing, exit discipline.
 * These lessons go into state.json and are shown to the trader via consult_memory.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

import type { Lesson } from "../types.js";
import { extractJson } from "./analyzer.js";

export interface TraderRetroInput {
  date: string;
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
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnL: number;
  netPnL: number;
  startingEquity: number;
  endingEquity: number;
  totalEquityChange: number;
  marketRegimes: string[];

  // Strategy awareness
  topStrategies: Array<{ ticker: string; type: string; direction: string; grade: number; pnl: string }>;
  bottomStrategies: Array<{ ticker: string; type: string; direction: string; grade: number; pnl: string }>;
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
  whatIfSummary: string;

  // Existing trader lessons
  existingLessons: Lesson[];

  // Performance snapshot
  performanceSnapshot: {
    totalTrades: number;
    winRate: number;
    netPnL: number;
    equityChange: number;
    consecutiveLosses: number;
  };

  calibrationTable: Array<{
    strategy: string;
    regime: string;
    winRate: number;
    totalTrades: number;
    avgWinPct: number;
    avgLossPct: number;
  }>;
}

interface TraderAnalysis {
  whatWorked: string;
  whatDidnt: string;
  whatToChange: string;
}

/**
 * Parse what the trader did, evaluate decision quality, produce trader-targeted analysis.
 * Does NOT evaluate the strategist — that's for the strategist retrospective.
 */
export async function analyzeTraderExecution(input: TraderRetroInput): Promise<{
  analysis: TraderAnalysis;
  evolvedLessons: Lesson[];
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[TRADER-RETRO] No OPENROUTER_API_KEY — using fallback analysis");
    return {
      analysis: fallbackTraderAnalysis(input),
      evolvedLessons: input.existingLessons,
    };
  }

  const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";

  const systemPrompt = `You are the TRADER performance analyst for Scrooge, an autonomous AI trading bot.

You evaluate ONLY the TRADER's execution quality. You do NOT evaluate the strategist's research or hypothesis formation.

## Trader Evaluation Framework

### 1. Execution Quality
- Did the trader enter at good prices relative to the strategy thesis?
- Did the trader exit at appropriate times? (stop hit, thesis invalidated, profit taken)
- Was the hold time appropriate for the strategy type? (momentum should be fast, swing can be longer)
- Did the trader overstay (held too long after thesis invalidated) or bail too early (exited before catalyst played out)?

### 2. Strategy Selection
- Did the trader pick the right strategies from the strategist's slate?
- Grade 4-5 strategies in the what-if analysis -> SHOULD have been taken. If missed, that's an opportunity cost.
- Grade 1-2 strategies -> SHOULD have been avoided. If entered, that's poor selection.
- Look at the executed strategies: did their actual P&L match the what-if grade?

### 3. Position Management
- Were positions promoted to trailing stop when they hit green (+1%)?
- Were timely cuts made for positions where the thesis was invalidated (vs. waiting for the stop to hit)?
- Did the trader avoid holding into obvious reversals?
- Was the exit reason appropriate? ("stop hit" is fine, "panic" is not)

### 4. Signal-to-Execution Conversion
- Did the trader act on appropriate signal confidence?
- Were trades taken without clear reasoning?
- Pattern: did the trader enter on weak signals and miss strong ones?

### 5. Capital Allocation
- Was the trader sizing appropriately for the setup quality?
- Were too many positions opened at once (diluting attention)?
- Was cash preserved when conditions were unfavorable?

### 6. Recurring Execution Patterns
- Same mistakes repeated across multiple trades?
- Specific exit timing issues? (always early? always late?)
- Specific entry timing issues? (always chasing? always waiting too long?)

## Output Format — Trader-Focused ONLY
Be direct and critical. Focus on EXECUTION, not research.

Respond ONLY with valid JSON:
{
  "whatWorked": "Markdown prose (2-3 paragraphs) about what the trader did well: good entries, timely exits, appropriate strategy selection, capital preservation",
  "whatDidnt": "Markdown prose (2-3 paragraphs) about what the trader did poorly: bad entries, late exits, wrong strategy picks, missed opportunities, sizing errors",
  "whatToChange": "Markdown prose with 2-4 specific improvements to EXECUTION BEHAVIOR. Focus on: how to evaluate entry timing better, which exit signals to trust, how to spot thesis invalidation sooner, how to size positions based on conviction, how to avoid FOMO entries. Do NOT suggest research or strategy formation changes — that's the strategist's domain."
}`;

  const userPrompt = buildTraderPrompt(input);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://scrooge-trading-bot.local",
        "X-Title": "Scrooge Trader Retrospective",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[TRADER-RETRO] OpenRouter error: ${res.status} ${text.slice(0, 200)}`);
      return {
        analysis: fallbackTraderAnalysis(input),
        evolvedLessons: input.existingLessons,
      };
    }

    const raw = await res.json();
    const content: string = raw.choices?.[0]?.message?.content || "";

    const parsed = extractJson<TraderAnalysis>(content);

    const analysis: TraderAnalysis = {
      whatWorked: parsed?.whatWorked || fallbackWhatWorked(input),
      whatDidnt: parsed?.whatDidnt || fallbackWhatDidnt(input),
      whatToChange: parsed?.whatToChange || fallbackWhatToChange(input),
    };

    // Now evolve trader-specific lessons
    const evolvedLessons = await evolveTraderLessons(input, analysis);

    return { analysis, evolvedLessons };
  } catch (e: any) {
    console.warn(`[TRADER-RETRO] LLM analysis failed: ${e.message}`);
    return {
      analysis: fallbackTraderAnalysis(input),
      evolvedLessons: input.existingLessons,
    };
  }
}

// ============================================================================
// TRADER LESSON EVOLUTION
// ============================================================================

async function evolveTraderLessons(
  input: TraderRetroInput,
  analysis: TraderAnalysis
): Promise<Lesson[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return input.existingLessons;

  const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";

  const systemPrompt = `You evolve the TRADER's execution lessons. These lessons ONLY cover execution behavior — not research or strategy formation.

## Allowed lesson categories for the trader:
- "execution_timing" — when to enter, when to wait, when to chase
- "exit_discipline" — when to cut, when to hold, stop adherence
- "position_sizing" — how much capital to deploy per setup
- "strategy_selection" — which strategy types to prioritize from the strategist's slate
- "capital_preservation" — when to hold cash, when to be aggressive
- "general" — trader-wide patterns

## What lessons are NOT for the trader:
- Signal source quality (EDGAR vs Reddit) — that's strategist territory
- Strategy x regime fit analysis — that's strategist territory
- Catalyst assessment patterns — that's strategist territory
- Conviction scoring methodology — that's strategist territory

## Evolution rules:
- MERGE similar lessons (increase weight, update insight)
- OVERWRITE lessons that were contradicted
- REMOVE lessons that are no longer relevant (set deprecated=true)
- CREATE new lessons from novel insights about execution
- Return ONLY the evolved active set (2-6 lessons). Drop deprecated lessons entirely.

Output ONLY valid JSON:
{
  "lessons": [
    {
      "id": "string",
      "category": "execution_timing|exit_discipline|position_sizing|strategy_selection|capital_preservation|general",
      "insight": "string — pattern about HOW to execute better, NOT a trading rule",
      "weight": 0.0-1.0,
      "reinforcementCount": number,
      "createdAt": "ISO timestamp",
      "lastReinforcedAt": "ISO timestamp (today)",
      "deprecated": false,
      "context": "string | null",
      "featureVector": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    }
  ]
}`;

  const userPrompt = buildTraderLessonPrompt(input, analysis);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://scrooge-trading-bot.local",
        "X-Title": "Scrooge Trader Lesson Evolution",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[TRADER-RETRO] Lesson evolution error: ${res.status} ${text.slice(0, 200)}`);
      return input.existingLessons;
    }

    const raw = await res.json();
    const content: string = raw.choices?.[0]?.message?.content || "";
    const parsed = extractJson<{ lessons: Lesson[] }>(content);

    if (!parsed || !Array.isArray(parsed.lessons) || parsed.lessons.length === 0) {
      console.warn("[TRADER-RETRO] LLM returned invalid lesson set — keeping existing");
      return input.existingLessons;
    }

    console.log(`[TRADER-RETRO] Evolved ${parsed.lessons.length} trader lessons`);
    return parsed.lessons;
  } catch (e: any) {
    console.warn(`[TRADER-RETRO] Lesson evolution failed: ${e.message}`);
    return input.existingLessons;
  }
}

// ============================================================================
// PROMPT BUILDERS
// ============================================================================

function buildTraderPrompt(input: TraderRetroInput): string {
  const lines: string[] = [
    `## Trader Retrospective -- ${input.date}`,
    ``,
    `### Performance Summary`,
    `- Trades: ${input.tradeCount} | Wins: ${input.wins} | Losses: ${input.losses}`,
    `- Win Rate: ${input.winRate.toFixed(1)}%`,
    `- Gross P&L: $${input.grossPnL.toFixed(2)} | Net P&L: $${input.netPnL.toFixed(2)}`,
    `- Equity: $${input.startingEquity.toFixed(2)} -> $${input.endingEquity.toFixed(2)} (${input.totalEquityChange > 0 ? "+" : ""}$${input.totalEquityChange.toFixed(2)})`,
    `- Regimes: ${input.marketRegimes.join(", ") || "unknown"}`,
    ``,
  ];

  if (input.tradeCount > 0) {
    lines.push(`### Trades Executed`);
    for (const t of input.trades) {
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

  if (input.executedStrategies.length > 0) {
    lines.push(`### Executed Strategies (via strategy store)`);
    for (const s of input.executedStrategies) {
      const pnlStr = s.pnl !== null ? `$${s.pnl.toFixed(2)} (${(s.pnlPct ?? 0).toFixed(2)}%)` : "-";
      lines.push(
        `- [${s.ticker}] ${s.type} ${s.direction} | State: ${s.state} | Conf: ${(s.confidence * 100).toFixed(0)}% | ` +
        `P&L: ${pnlStr} | Exit: ${s.exit_reason ?? "open"}`
      );
    }
    lines.push(``);
  }

  if (input.topStrategies.length > 0) {
    lines.push(`### HIGH-GRADE STRATEGIES (G4-5) -- Opportunities the Trader Missed`);
    for (const s of input.topStrategies) {
      lines.push(`- [${s.ticker}] ${s.type} ${s.direction} | G${s.grade}/5 | Hypo P&L: ${s.pnl}`);
    }
    lines.push(``);
  }

  if (input.bottomStrategies.length > 0 && input.tradeCount > 0) {
    const badEntries = input.executedStrategies.filter((es) =>
      input.bottomStrategies.some((bs) => bs.ticker === es.ticker && bs.type === es.type)
    );
    if (badEntries.length > 0) {
      lines.push(`### LOW-GRADE STRATEGIES (G1-2) -- Entries the Trader Should Have Avoided`);
      for (const s of badEntries) {
        lines.push(`- [${s.ticker}] ${s.type} ${s.direction} | Actual P&L: ${s.pnl !== null ? `$${s.pnl.toFixed(2)}` : "unknown"}`);
      }
      lines.push(``);
    }
  }

  if (input.calibrationTable.length > 0) {
    lines.push(`### Strategy x Regime Calibration`);
    for (const c of input.calibrationTable) {
      lines.push(
        `- ${c.strategy} in ${c.regime}: ${(c.winRate * 100).toFixed(0)}% WR (${c.totalTrades} trades, ` +
        `avg win ${(c.avgWinPct * 100).toFixed(1)}%, avg loss ${(c.avgLossPct * 100).toFixed(1)}%)`
      );
    }
    lines.push(``);
  }

  if (input.existingLessons.length > 0) {
    const active = input.existingLessons.filter((l) => !l.deprecated);
    if (active.length > 0) {
      lines.push(`### Existing Trader Lessons`);
      for (const l of active) {
        lines.push(`- [${l.category}] (w: ${l.weight.toFixed(2)}, reinforced: ${l.reinforcementCount}x) "${l.insight}"`);
      }
      lines.push(``);
    }
  }

  lines.push(
    `---`,
    ``,
    `Evaluate the TRADER's execution quality only. Focus on:`,
    `1. Entry timing -- did the trader enter at good prices?`,
    `2. Exit discipline -- did the trader cut losses, let winners run?`,
    `3. Strategy selection -- did the trader pick the right strategies to execute?`,
    `4. Missed high-grade and taken low-grade strategies`,
    `5. Recurring execution patterns (good or bad)`,
    ``,
    `Be direct and critical. Use specific examples.`
  );

  return lines.join("\n");
}

function buildTraderLessonPrompt(input: TraderRetroInput, analysis: TraderAnalysis): string {
  const lines: string[] = [
    `## Trader Lesson Evolution -- ${input.date}`,
    ``,
    `### Today's Performance`,
    `- Trades: ${input.performanceSnapshot.totalTrades}`,
    `- Win Rate: ${input.performanceSnapshot.winRate.toFixed(1)}%`,
    `- Net P&L: $${input.performanceSnapshot.netPnL.toFixed(2)}`,
    `- Equity Change: $${input.performanceSnapshot.equityChange.toFixed(2)}`,
    `- Consecutive Losses: ${input.performanceSnapshot.consecutiveLosses}`,
    ``,
    `### Today's Trader Analysis`,
    ``,
    `**What Worked:**`,
    analysis.whatWorked,
    ``,
    `**What Didn't Work:**`,
    analysis.whatDidnt,
    ``,
    `**What to Change:**`,
    analysis.whatToChange,
    ``,
    `### Existing Trader Lessons (${input.existingLessons.length} total, ${input.existingLessons.filter((l) => !l.deprecated).length} active)`,
    ``,
  ];

  for (const l of input.existingLessons) {
    const status = l.deprecated ? "DEPRECATED" : `active (weight: ${l.weight.toFixed(2)}, reinforced: ${l.reinforcementCount}x)`;
    lines.push(`- [${l.id}] [${l.category}] ${status}`);
    lines.push(`  "${l.insight}"`);
    lines.push(`  Created: ${l.createdAt.slice(0, 10)} | Last reinforced: ${l.lastReinforcedAt.slice(0, 10)}`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`Now evolve the TRADER lesson set based on today's retrospective. Return ONLY the evolved active set (2-6 lessons). DO NOT include deprecated lessons.`);

  return lines.join("\n");
}

// ============================================================================
// FALLBACK ANALYSIS (no LLM available)
// ============================================================================

function fallbackTraderAnalysis(input: TraderRetroInput): TraderAnalysis {
  return {
    whatWorked: fallbackWhatWorked(input),
    whatDidnt: fallbackWhatDidnt(input),
    whatToChange: fallbackWhatToChange(input),
  };
}

function fallbackWhatWorked(input: TraderRetroInput): string {
  const parts: string[] = [];

  if (input.winRate > 60 && input.tradeCount >= 3) {
    parts.push(`**Win rate was strong at ${input.winRate.toFixed(0)}%** — the trader showed good discretion on which strategies to execute.`);
  }

  if (input.grossPnL > 0) {
    parts.push(`**The day finished positive with a gross P&L of $${input.grossPnL.toFixed(2)}** — the trader's directional bets aligned with strategy theses.`);
  }

  if (input.topStrategies.length > 0) {
    parts.push(`**${input.topStrategies.length} strategies graded G4-5** were identified by the what-if analysis. These represent setups with solid thesis, clear catalysts, and good regime fit.`);
  }

  if (input.tradeCount === 0) {
    parts.push(`**No trades were executed today.** The trader held cash, which is valid if the strategist's top strategies didn't align with market conditions.`);
  }

  if (parts.length === 0) {
    parts.push(`No standout execution positives from the raw data. The LLM analysis would provide deeper insight.`);
  }

  return parts.join("\n\n");
}

function fallbackWhatDidnt(input: TraderRetroInput): string {
  const parts: string[] = [];

  if (input.bottomStrategies.length > 0 && input.tradeCount > 0) {
    const badEntries = input.executedStrategies.filter((es) =>
      input.bottomStrategies.some((bs) => bs.ticker === es.ticker && bs.type === es.type)
    );
    if (badEntries.length > 0) {
      parts.push(`**${badEntries.length} executed strategies received poor what-if grades (G1-2).** The trader entered strategies that the retrospective analysis rated as poor setups.`);
    }
  }

  if (input.topStrategies.length > 0 && input.tradeCount > 0) {
    const missed = input.topStrategies.filter((t) =>
      !input.executedStrategies.some((e) => e.ticker === t.ticker && e.type === t.type)
    );
    if (missed.length > 0) {
      parts.push(`**${missed.length} high-grade strategies existed** that the trader DID NOT execute. These represent missed opportunities.`);
    }
  }

  if (input.tradeCount === 0) {
    parts.push(`**Zero trades executed today.** The trader needs to find more opportunities by reviewing the strategist's hypotheses more carefully.`);
  }

  if (input.winRate < 50 && input.tradeCount >= 3) {
    parts.push(`**Win rate was ${input.winRate.toFixed(0)}%** — the trader lost more trades than won. This suggests poor strategy selection, wrong regime fit, or bad timing.`);
  }

  if (input.netPnL < 0) {
    parts.push(`**Net P&L was negative at $${input.netPnL.toFixed(2)}** — the combination of trade losses and token costs resulted in account drawdown.`);
  }

  if (parts.length === 0) {
    parts.push(`No major execution issues identified from the raw data. The LLM analysis would provide deeper insight.`);
  }

  return parts.join("\n\n");
}

function fallbackWhatToChange(input: TraderRetroInput): string {
  const recommendations: string[] = [];

  if (input.tradeCount === 0) {
    recommendations.push("**Execute more.** The strategist generated hypotheses but the trader didn't act. Review why the top strategies weren't actionable.");
  }

  if (input.bottomStrategies.length > 0 && input.tradeCount > 0) {
    const overlaps = input.executedStrategies.filter((es) =>
      input.bottomStrategies.some((bs) => bs.ticker === es.ticker && bs.type === es.type)
    );
    if (overlaps.length > 0) {
      recommendations.push("**Avoid low-grade strategies.** The trader entered strategies that the what-if analysis graded poorly. Use the what-if grades from past retrospectives to filter out G1-2 strategies before entry.");
    }
  }

  if (input.topStrategies.length > 0 && input.tradeCount > 0) {
    const missed = input.topStrategies.filter((t) =>
      !input.executedStrategies.some((e) => e.ticker === t.ticker && e.type === t.type)
    );
    if (missed.length > 0) {
      recommendations.push("**Take more high-grade opportunities.** The trader ignored G4-5 strategies. Lower the bar for entry when the what-if pattern is proven (same strategy type + regime that has historically graded well).");
    }
  }

  if (input.winRate < 50 && input.tradeCount >= 3) {
    recommendations.push("**Improve signal selection.** A win rate below 50% means poor strategy-regime fit. Check if the strategies being executed match the current regime.");
  }

  const strategies = new Set(input.trades.map((t) => t.strategy));
  if (strategies.size <= 1 && input.tradeCount >= 3) {
    recommendations.push("**Diversify strategy types.** All trades used one approach. Different regimes reward different strategies.");
  }

  if (recommendations.length === 0) {
    recommendations.push("**Continue with current approach** — monitor for regime changes.");
  }

  return recommendations.map((r) => `- ${r}`).join("\n");
}
