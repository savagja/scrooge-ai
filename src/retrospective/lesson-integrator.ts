/**
 * Lesson Integrator — intelligent, non-additive lesson evolution.
 *
 * After the daily retrospective report is built, this module makes a separate
 * LLM call to take the report's findings (whatWorked, whatDidnt, whatToChange)
 * together with the EXISTING lesson set, and returns an EVOLVED lesson set.
 *
 * The LLM decides to:
 *   - MERGE similar lessons (increase weight, update insight)
 *   - MODIFY lessons with new information (update insight, adjust context)
 *   - OVERWRITE lessons that contradicted (increase weight of the correct one, deprecate the wrong one)
 *   - REMOVE lessons that are no longer relevant (set deprecated=true)
 *   - CREATE new lessons from novel insights
 *
 * This is NOT additive. The LLM returns the COMPLETE new lesson set.
 * The integrator is stateless — it receives all context and returns the new set.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

import type { Lesson, DailyReport } from "../types.js";
import { extractJson } from "./analyzer.js";

export interface IntegratorInput {
  /** Today's date */
  date: string;
  /** The report that was just generated */
  report: DailyReport;
  /** All existing lessons (active + deprecated) */
  existingLessons: Lesson[];
  /** Summary of recent performance metrics */
  performanceSnapshot: {
    totalTrades: number;
    winRate: number;
    netPnL: number;
    equityChange: number;
    consecutiveLosses: number;
  };
  /** Calibration table summary for context */
  calibrationSummary: string;
}

export interface IntegratorOutput {
  /** Complete new lesson set — replaces all previous lessons */
  lessons: Lesson[];
}

/**
 * Evolve the lesson set based on today's retrospective report.
 */
export async function integrateLessons(input: IntegratorInput): Promise<Lesson[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[LESSON-INTEGRATOR] No OPENROUTER_API_KEY — keeping existing lessons unchanged");
    return input.existingLessons;
  }

  const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";

  const systemPrompt = `You are the memory consolidation system for Scrooge, an autonomous AI trading bot.

Your job: Evolve the bot's assessment patterns for evaluating strategies based on new daily evidence. This is NOT about creating trading rules.

## How lessons work
Each lesson has:
- id: Stable identifier (keep it if the lesson is an evolution of an existing one; create new if truly novel)
- category: One of "signal_quality", "strategy_regime_fit", "catalyst_assessment", "conviction_scoring", "risk_calibration", "timing_evaluation", "general"
- insight: The lesson text — a pattern about HOW to evaluate strategies and score their quality. NEVER a trading rule. E.g. "EDGAR 8-K revenue guidance filings produce more resilient strategies than cost-cutting announcements when VIX < 20" NOT "force a $30 trade if no catalyst"
- weight: 0.0-1.0 — how well-established this assessment pattern is
- reinforcementCount: incremented when the lesson is confirmed again
- context: Optional regime/strategy scoping (e.g. "regime:volatile", "signal:edgar")
- featureVector: 7 floats [vix/50, confidence, impact/10, notional/100, trending_up_flag, chop_flag, volatile_flag]
- deprecated: whether this lesson should be hidden

## What lessons are NOT
Lessons are NOT trading rules. The bot's system prompt, tool logic, and config.yaml handle all trading rules (position sizing, stop losses, minimum trades, execution thresholds). Do NOT create lessons about:
- "Force a trade" or "minimum trades"
- Position sizing amounts
- Stop loss levels or trailing stop percentages
- How many cycles to wait before acting
- Whether to be aggressive or conservative

Lessons are ONLY about:
- How to assess a strategy's quality before executing
- Which signal sources (EDGAR, news, volume, Reddit) produce resilient strategies and in which market conditions
- How to score conviction more accurately given market context and signal convergence
- Which strategy types (momentum, mean_reversion, event_driven) fit which regimes and how to detect that fit
- What patterns in catalyst assessment lead to better outcomes
- How to distinguish a real signal from noise when evaluating a specific strategy
- What contextual factors should increase or decrease a strategy's confidence score

## Decision rules
1. If a new insight from today is SIMILAR to an existing lesson -> MERGE by updating the existing lesson's insight to the best synthesis, and increment its reinforcementCount. Keep the same id. Increase weight (cap at 1.0).

2. If a new insight CONTRADICTS an existing lesson -> keep the one with more evidence. If the new evidence is stronger, deprecate the old lesson and create a new one. If the old evidence is stronger, skip the new insight.

3. If a new insight is NOVEL (no similar existing lesson) -> create a new lesson with id "L_" + random 8 chars, weight 0.3, reinforcementCount 1.

4. If an existing lesson has not been reinforced in many cycles and current evidence suggests it's no longer relevant -> set deprecated=true with a note in the insight. A deprecated lesson is kept for reference but won't be shown to the agent.

5. If an existing lesson's insight is still valid but needs refinement based on today's data -> modify the insight text, adjust weight, increment reinforcementCount.

6. Lessons with weight > 0.8 should be concise and definitive statements about assessment patterns, NOT trading rules. A weight > 0.8 means "this assessment pattern is well-established and should be used when scoring strategies."

## Feature vector guidance
For each lesson, generate a featureVector (7 floats) representing the market conditions where this lesson applies. If the lesson is regime-agnostic, use [0.4, 0.5, 0, 0.5, 0, 0, 0]. If regime-specific, set the appropriate regime flag.

## Output format
Respond with ONLY valid JSON:
{
  "lessons": [
    {
      "id": "string",
      "category": "signal_quality|strategy_regime_fit|catalyst_assessment|conviction_scoring|risk_calibration|timing_evaluation|general",
      "insight": "string",
      "weight": 0.0-1.0,
      "reinforcementCount": number,
      "createdAt": "ISO timestamp (preserve original if merging, new one if creating)",
      "lastReinforcedAt": "ISO timestamp (today)",
      "deprecated": false,
      "context": "string | null",
      "featureVector": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    }
  ]
}

IMPORTANT: Only output lessons that should remain active. Deprecated lessons are DROPPED from the output entirely. Return only the evolved active set (aim for 2-6 lessons). Focus on strategy assessment patterns, not trading rules. If all existing lessons are rule-based trading rules, deprecate them all and create 2-4 fresh assessment lessons from today's evidence instead.`;

  const userPrompt = buildIntegratorPrompt(input);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://scrooge-trading-bot.local",
        "X-Title": "Scrooge Lesson Integrator",
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
      console.warn(`[LESSON-INTEGRATOR] OpenRouter error: ${res.status} ${text.slice(0, 200)}`);
      return input.existingLessons;
    }

    const raw = await res.json();
    const content: string = raw.choices?.[0]?.message?.content || "";

    const parsed = extractJson<IntegratorOutput>(content);

    if (!parsed || !Array.isArray(parsed.lessons) || parsed.lessons.length === 0) {
      console.warn("[LESSON-INTEGRATOR] LLM returned invalid or empty lesson set — keeping existing");
      return input.existingLessons;
    }

    console.log(`[LESSON-INTEGRATOR] Evolved lesson set: ${parsed.lessons.length} lessons ` +
      `(${parsed.lessons.filter((l) => !l.deprecated).length} active, ` +
      `${parsed.lessons.filter((l) => l.deprecated).length} deprecated)`);

    return parsed.lessons;
  } catch (e: any) {
    console.warn(`[LESSON-INTEGRATOR] Failed: ${e.message}`);
    return input.existingLessons;
  }
}

function buildIntegratorPrompt(input: IntegratorInput): string {
  const lines: string[] = [
    `## Lesson Integration — ${input.date}`,
    ``,
    `### Today's Performance`,
    `- Trades: ${input.performanceSnapshot.totalTrades}`,
    `- Win Rate: ${input.performanceSnapshot.winRate.toFixed(1)}%`,
    `- Net P&L: $${input.performanceSnapshot.netPnL.toFixed(2)}`,
    `- Equity Change: $${input.performanceSnapshot.equityChange.toFixed(2)}`,
    `- Consecutive Losses: ${input.performanceSnapshot.consecutiveLosses}`,
    ``,
    `### Today's Retrospective Findings`,
    ``,
    `**What Worked:**`,
    input.report.whatWorked,
    ``,
    `**What Didn't Work:**`,
    input.report.whatDidnt,
    ``,
    `**What to Change:**`,
    input.report.whatToChange,
    ``,
    `### Strategy × Regime Calibration`,
    input.calibrationSummary || "No calibration data yet.",
    ``,
    `### Existing Lessons (${input.existingLessons.length} total, ${input.existingLessons.filter((l) => !l.deprecated).length} active)`,
    ``,
  ];

  for (const l of input.existingLessons) {
    const status = l.deprecated ? "DEPRECATED" : `active (weight: ${l.weight.toFixed(2)}, reinforced: ${l.reinforcementCount}x)`;
    const ctx = l.context ? ` [${l.context}]` : "";
    lines.push(`- [${l.id}] [${l.category}]${ctx} ${status}`);
    lines.push(`  "${l.insight}"`);
    lines.push(`  featureVector: [${l.featureVector.map((v) => v.toFixed(2)).join(", ")}]`);
    lines.push(`  Created: ${l.createdAt.slice(0, 10)} | Last reinforced: ${l.lastReinforcedAt.slice(0, 10)}`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`Now evolve this lesson set based on today's retrospective. Consider what was learned today, what was contradicted, what should be merged, what is obsolete. Return ONLY the evolved active set (2-6 lessons). DO NOT include deprecated lessons.`);

  return lines.join("\n");
}