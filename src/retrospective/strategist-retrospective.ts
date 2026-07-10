/**
 * Strategist Retrospective — evaluates the strategist's hypothesis quality.
 *
 * Focused on:
 *   - Strategy quality (what-if grades assigned to each strategy)
 *   - Signal source analysis (which sources produce G4-5 vs G1-2 strategies)
 *   - Strategy x regime fit (which strategy types work in which regimes)
 *   - Lifecycle management (did the strategist move strategies through states correctly?)
 *   - Catalyst assessment (which types of catalysts produce good strategies)
 *
 * Produces strategist-targeted lessons about signal assessment, strategy x regime
 * fit, catalyst evaluation, and conviction scoring. These lessons are stored in
 * strategies.db and shown to the strategist via a dedicated tool.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

import type { WhatIfAnalysis, Lesson } from "../types.js";
import { extractJson } from "./analyzer.js";

export interface StrategistRetroInput {
  date: string;
  whatIfAnalysis: WhatIfAnalysis | null;
  totalStrategiesCreated: number;
  strategyStateCounts: Record<string, number>;
  patterns: Array<{
    pattern: string;
    count: number;
    avgGrade: number;
    direction: "good" | "bad" | "mixed";
  }>;
  existingStrategistLessons: Lesson[];
  marketRegime: string;
}

interface StrategistAnalysis {
  signalSourceQuality: string;
  strategyRegimeFit: string;
  lifecycleManagement: string;
  catalystAssessment: string;
  overview: string;
}

/**
 * Analyze the strategist's performance based on what-if grades and strategy
 * lifecycle data. Produces strategist-targeted lessons about how to improve
 * hypothesis formation, signal assessment, and conviction scoring.
 */
export async function analyzeStrategistPerformance(
  input: StrategistRetroInput
): Promise<{
  analysis: StrategistAnalysis;
  evolvedLessons: Lesson[];
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[STRAT-RETRO] No OPENROUTER_API_KEY — using fallback analysis");
    return {
      analysis: fallbackStrategistAnalysis(input),
      evolvedLessons: input.existingStrategistLessons,
    };
  }

  const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";

  const systemPrompt = `You are the STRATEGIST performance analyst for Scrooge, an autonomous AI trading bot.

You evaluate ONLY the STRATEGIST's hypothesis formation quality. You do NOT evaluate the trader's execution.

## Strategist Evaluation Framework

### 1. Signal Source Quality
Look at the what-if grades for each strategy and their signal sources (EDGAR, news, volume, Reddit, etc.):
- Which sources consistently produce G4-5 (good/excellent) strategies?
- Which sources produce G1-2 (poor/terrible) strategies?
- Are there signal sources that look interesting but consistently underperform?

### 2. Strategy x Regime Fit
Look at strategies graded against the market regime:
- Which strategy types (momentum, swing, mean_reversion, event_driven, value) work in which regimes?
- Pattern: "momentum in trending_up consistently grades well" vs "mean_reversion in volatile fails"
- This is about the STRATEGIST correctly assessing which strategy types to deploy in which conditions.

### 3. Lifecycle Management
- Were strategies moved through lifecycle states correctly?
- Did anticipated strategies develop into developing/realized appropriately?
- Were strategies that didn't pan out marked as failed/stale promptly?
- Did the strategist over-promote (too many developing strategies that never materialized)?
- Did the strategist under-promote (too many anticipated strategies that should have been developed)?

### 4. Catalyst Assessment
- Which catalyst types (EDGAR 8-K, earnings, news, technical, retail) produce the best strategies?
- Are there catalysts that LOOK meaningful but consistently produce poor strategies?
- Which catalysts (if any) are being missed?

### 5. Conviction Scoring
- Did the strategist's confidence scores align with what-if outcomes?
- High confidence + low grade = poor conviction calibration
- Low confidence + high grade = missed opportunity (under-confidence)
- Look for patterns: "strategist is always overconfident on EDGAR filings" or "strategist underrates volume breakouts"

### 6. Recurring Patterns
- What abstractions repeated across the day? (e.g. "momentum long trending_up works" appearing 3 times)
- Which repeating patterns had high grades? Which had low grades?
- These are the most valuable insights for the strategist.

## Output Format — Strategist-Focused ONLY
Be direct and critical. Focus on RESEARCH QUALITY, not execution.

Respond ONLY with valid JSON:
{
  "overview": "One-paragraph summary of the strategist's performance today — overall grade quality, signal source performance, and key patterns",
  "signalSourceQuality": "Markdown prose (2-3 paragraphs) analyzing which signal sources produced good vs poor strategies, with specific examples",
  "strategyRegimeFit": "Markdown prose (2-3 paragraphs) analyzing which strategy types fit which regimes, with specific examples from the what-if data",
  "lifecycleManagement": "Markdown prose (1-2 paragraphs) analyzing whether the strategist managed strategy lifecycle states correctly",
  "catalystAssessment": "Markdown prose (2-3 paragraphs) analyzing which catalyst types produced good strategies, which were noise"
}`;

  const userPrompt = buildStrategistPrompt(input);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://scrooge-trading-bot.local",
        "X-Title": "Scrooge Strategist Retrospective",
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
      console.warn(`[STRAT-RETRO] OpenRouter error: ${res.status} ${text.slice(0, 200)}`);
      return {
        analysis: fallbackStrategistAnalysis(input),
        evolvedLessons: input.existingStrategistLessons,
      };
    }

    const raw = await res.json();
    const content: string = raw.choices?.[0]?.message?.content || "";
    const parsed = extractJson<StrategistAnalysis>(content);

    const analysis: StrategistAnalysis = {
      overview: parsed?.overview || fallbackOverview(input),
      signalSourceQuality: parsed?.signalSourceQuality || "No LLM analysis available.",
      strategyRegimeFit: parsed?.strategyRegimeFit || "No LLM analysis available.",
      lifecycleManagement: parsed?.lifecycleManagement || "No LLM analysis available.",
      catalystAssessment: parsed?.catalystAssessment || "No LLM analysis available.",
    };

    const evolvedLessons = await evolveStrategistLessons(input, analysis);

    return { analysis, evolvedLessons };
  } catch (e: any) {
    console.warn(`[STRAT-RETRO] LLM analysis failed: ${e.message}`);
    return {
      analysis: fallbackStrategistAnalysis(input),
      evolvedLessons: input.existingStrategistLessons,
    };
  }
}

// ============================================================================
// STRATEGIST LESSON EVOLUTION
// ============================================================================

async function evolveStrategistLessons(
  input: StrategistRetroInput,
  analysis: StrategistAnalysis
): Promise<Lesson[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return input.existingStrategistLessons;

  const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";

  const systemPrompt = `You evolve the STRATEGIST's research lessons. These lessons ONLY cover hypothesis formation and signal quality assessment — not execution.

## Allowed lesson categories for the strategist:
- "signal_quality" — which signal sources produce resilient strategies and in which conditions
- "strategy_regime_fit" — which strategy types work in which market regimes
- "catalyst_assessment" — how to evaluate catalyst types (EDGAR vs news vs technical)
- "conviction_scoring" — how to calibrate confidence scores based on signal convergence
- "timing_evaluation" — when to create strategies vs wait for more signals
- "general" — strategist-wide patterns

## What lessons are NOT for the strategist:
- Execution timing (entry/exit) — that's trader territory
- Position management (stop levels, trailing stops) — that's trader territory
- Position sizing — that's trader territory

## Evolution rules:
- MERGE similar lessons (increase weight, update insight)
- OVERWRITE lessons that were contradicted
- REMOVE lessons that are no longer relevant (set deprecated=true)
- CREATE new lessons from novel insights about strategy formation
- Return ONLY the evolved active set (2-6 lessons). Drop deprecated lessons entirely.

Output ONLY valid JSON:
{
  "lessons": [
    {
      "id": "string",
      "category": "signal_quality|strategy_regime_fit|catalyst_assessment|conviction_scoring|timing_evaluation|general",
      "insight": "string — pattern about HOW to assess strategies and form better hypotheses, NOT a trading rule",
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

  const userPrompt = buildStrategistLessonPrompt(input, analysis);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://scrooge-trading-bot.local",
        "X-Title": "Scrooge Strategist Lesson Evolution",
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
      console.warn(`[STRAT-RETRO] Lesson evolution error: ${res.status} ${text.slice(0, 200)}`);
      return input.existingStrategistLessons;
    }

    const raw = await res.json();
    const content: string = raw.choices?.[0]?.message?.content || "";
    const parsed = extractJson<{ lessons: Lesson[] }>(content);

    if (!parsed || !Array.isArray(parsed.lessons) || parsed.lessons.length === 0) {
      console.warn("[STRAT-RETRO] LLM returned invalid lesson set — keeping existing");
      return input.existingStrategistLessons;
    }

    console.log(`[STRAT-RETRO] Evolved ${parsed.lessons.length} strategist lessons`);
    return parsed.lessons;
  } catch (e: any) {
    console.warn(`[STRAT-RETRO] Lesson evolution failed: ${e.message}`);
    return input.existingStrategistLessons;
  }
}

// ============================================================================
// PROMPT BUILDERS
// ============================================================================

function buildStrategistPrompt(input: StrategistRetroInput): string {
  const lines: string[] = [
    `## Strategist Retrospective -- ${input.date}`,
    ``,
    `### Overview`,
    `- Market Regime: ${input.marketRegime}`,
    `- Total Strategies Created: ${input.totalStrategiesCreated}`,
    `- Strategy Lifecycle: A:${input.strategyStateCounts.anticipated ?? 0} D:${input.strategyStateCounts.developing ?? 0} R:${input.strategyStateCounts.realized ?? 0} F:${input.strategyStateCounts.failed ?? 0} S:${input.strategyStateCounts.stale ?? 0}`,
    ``,
  ];

  if (input.whatIfAnalysis && input.whatIfAnalysis.totalStrategiesAnalyzed > 0) {
    const wa = input.whatIfAnalysis;
    lines.push(`### What-If Strategy Grades`);
    lines.push(`- Total Analyzed: ${wa.totalStrategiesAnalyzed}`);
    lines.push(`- Hypothetical P&L: $${wa.totalHypotheticalPnL.toFixed(2)}`);
    lines.push(`- Grade Distribution: ${Object.entries(wa.gradeDistribution).map(([k, v]) => `G${k}=${v}`).join(", ")}`);
    lines.push(``);

    lines.push(`### Graded Strategies`);
    for (const s of wa.strategies) {
      const e = s.grade >= 4 ? "+" : s.grade <= 2 ? "-" : "~";
      lines.push(`  ${e} [${s.ticker}] G${s.grade} ${s.direction[0].toUpperCase()} ${s.strategy_type} | Hypo P&L: $${s.potentialGainLoss.toFixed(2)} | State: ${s.state}`);
      lines.push(`    Pattern: ${s.abstraction}`);
      lines.push(`    ${s.gradeRationale}`);
    }
    lines.push(``);
  }

  if (input.patterns.length > 0) {
    lines.push(`### Recurring Patterns`);
    for (const p of input.patterns) {
      const dirEmoji = p.direction === "good" ? "+" : p.direction === "bad" ? "-" : "~";
      lines.push(`  ${dirEmoji} [x${p.count}] "${p.pattern}" avg grade: ${p.avgGrade.toFixed(1)} (${p.direction})`);
    }
    lines.push(``);
  }

  if (input.existingStrategistLessons.length > 0) {
    const active = input.existingStrategistLessons.filter((l) => !l.deprecated);
    if (active.length > 0) {
      lines.push(`### Existing Strategist Lessons`);
      for (const l of active) {
        lines.push(`- [${l.category}] (w: ${l.weight.toFixed(2)}, reinforced: ${l.reinforcementCount}x) "${l.insight}"`);
      }
      lines.push(``);
    }
  }

  lines.push(
    `---`,
    ``,
    `Evaluate the STRATEGIST's hypothesis quality only. Focus on:`,
    `1. Which signal sources produced the best and worst graded strategies?`,
    `2. Which strategy types fit which market regimes?`,
    `3. Was the lifecycle management appropriate?`,
    `4. Which catalyst types produced good strategies?`,
    `5. What recurring patterns emerged from the abstractions?`,
    ``,
    `Be direct and critical. Use specific examples from the what-if analysis.`
  );

  return lines.join("\n");
}

function buildStrategistLessonPrompt(input: StrategistRetroInput, analysis: StrategistAnalysis): string {
  const lines: string[] = [
    `## Strategist Lesson Evolution -- ${input.date}`,
    ``,
    `### Today's Strategist Analysis`,
    ``,
    `**Overview:**`,
    analysis.overview,
    ``,
    `**Signal Source Quality:**`,
    analysis.signalSourceQuality,
    ``,
    `**Strategy x Regime Fit:**`,
    analysis.strategyRegimeFit,
    ``,
    `**Lifecycle Management:**`,
    analysis.lifecycleManagement,
    ``,
    `**Catalyst Assessment:**`,
    analysis.catalystAssessment,
    ``,
    `### Existing Strategist Lessons (${input.existingStrategistLessons.length} total, ${input.existingStrategistLessons.filter((l) => !l.deprecated).length} active)`,
    ``,
  ];

  for (const l of input.existingStrategistLessons) {
    const status = l.deprecated ? "DEPRECATED" : `active (weight: ${l.weight.toFixed(2)}, reinforced: ${l.reinforcementCount}x)`;
    lines.push(`- [${l.id}] [${l.category}] ${status}`);
    lines.push(`  "${l.insight}"`);
    lines.push(`  Created: ${l.createdAt.slice(0, 10)} | Last reinforced: ${l.lastReinforcedAt.slice(0, 10)}`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`Now evolve the STRATEGIST lesson set based on today's retrospective. Return ONLY the evolved active set (2-6 lessons). DO NOT include deprecated lessons.`);

  return lines.join("\n");
}

// ============================================================================
// FALLBACK ANALYSIS (no LLM available)
// ============================================================================

function fallbackStrategistAnalysis(input: StrategistRetroInput): StrategistAnalysis {
  return {
    overview: fallbackOverview(input),
    signalSourceQuality: "No LLM analysis available. The what-if data shows " +
      (input.whatIfAnalysis?.totalStrategiesAnalyzed ?? 0) + " strategies graded. " +
      "Review the grade distribution for signal source patterns.",
    strategyRegimeFit: "No LLM analysis available. Consider reviewing which strategy types performed best in " +
      input.marketRegime + " regime.",
    lifecycleManagement: "No LLM analysis available. Current lifecycle: " +
      "A:" + (input.strategyStateCounts.anticipated ?? 0) +
      " D:" + (input.strategyStateCounts.developing ?? 0) +
      " R:" + (input.strategyStateCounts.realized ?? 0) +
      " F:" + (input.strategyStateCounts.failed ?? 0) +
      " S:" + (input.strategyStateCounts.stale ?? 0) + ".",
    catalystAssessment: "No LLM analysis available. Review what-if grades by catalyst type from the graded strategies.",
  };
}

function fallbackOverview(input: StrategistRetroInput): string {
  const wa = input.whatIfAnalysis;
  if (!wa || wa.totalStrategiesAnalyzed === 0) {
    return "No strategies were created or analyzed today. The strategist should review whether signal volume was low or if the research DB needs attention.";
  }

  const g4plus = (wa.gradeDistribution["4"] || 0) + (wa.gradeDistribution["5"] || 0);
  const g1minus = (wa.gradeDistribution["1"] || 0) + (wa.gradeDistribution["2"] || 0);
  const pctGood = wa.totalStrategiesAnalyzed > 0 ? (g4plus / wa.totalStrategiesAnalyzed * 100).toFixed(0) : "0";
  const pctBad = wa.totalStrategiesAnalyzed > 0 ? (g1minus / wa.totalStrategiesAnalyzed * 100).toFixed(0) : "0";

  return `The strategist had ${wa.totalStrategiesAnalyzed} strategies analyzed today. ` +
    `${g4plus} (${pctGood}%) were graded G4-5 (good/excellent), ` +
    `${g1minus} (${pctBad}%) were graded G1-2 (poor/terrible). ` +
    `Hypothetical P&L: $${wa.totalHypotheticalPnL.toFixed(2)}. ` +
    `The strategist ${g4plus > g1minus ? "showed good signal quality overall" : "needs to improve strategy quality"} in ${input.marketRegime} regime.`;
}

/**
 * Extract recurring patterns from the what-if analysis abstractions.
 * Called by the orchestrator to build the patterns array for the retro input.
 */
export function extractPatternsFromWhatIf(whatIf: WhatIfAnalysis): Array<{
  pattern: string;
  count: number;
  avgGrade: number;
  direction: "good" | "bad" | "mixed";
}> {
  const freq = new Map<string, { count: number; grades: number[] }>();

  for (const s of whatIf.strategies) {
    // Use the first 4 segments of the abstraction as the pattern key
    const parts = s.abstraction.split(" | ");
    const key = parts.slice(0, Math.min(4, parts.length)).join(" | ");
    if (!freq.has(key)) freq.set(key, { count: 0, grades: [] });
    const entry = freq.get(key)!;
    entry.count++;
    entry.grades.push(s.grade);
  }

  return Array.from(freq.entries())
    .filter(([_, v]) => v.count >= 2)
    .map(([pattern, v]) => {
      const avg = v.grades.reduce((a, b) => a + b, 0) / v.grades.length;
      const direction: "good" | "bad" | "mixed" =
        avg >= 4 ? "good" : avg <= 2 ? "bad" : "mixed";
      return { pattern, count: v.count, avgGrade: Math.round(avg * 10) / 10, direction };
    })
    .sort((a, b) => b.count - a.count);
}
