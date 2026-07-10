# Learning System (3 Phases + Dual Retrospective)

The learning system operates on **two separate tracks** — one for the trader (execution) and one for the strategist (hypothesis formation). Both share the same underlying data infrastructure but produce distinct lessons for each agent.

## Infrastructure (shared)

### 1. Rich Trade Context
Each position stores VIX, regime, confidence, impact score, source, direction, and **strategy ID** at entry. This enables post-mortems to trace back to the originating thesis and splits analysis by trader execution vs strategist hypothesis quality.

### 2. Calibration Table
`getCalibratedConfidence(strategy, regime)` queries win-rate history. Overrides LLM confidence when 5+ samples exist in that strategy×regime cell. This is strategy-level data used by both agents — the trader sees it as a confidence override, the strategist sees it as a signal quality signal.

### 3. Vector Memory
`findSimilarTrades(featureVector)` returns top-K past trades with cosine similarity scores. Both agents have access via `consult_memory` (trader) and `consult_memory` (strategist, read-only).

## Dual Retrospective

After each trading day, the retrospective runs **two separate LLM analyses**, each focused on one agent:

### Trader Retrospective

**Purpose:** Evaluate execution quality — how well the trader selected from the strategist's slate, entry timing, exit discipline, capital allocation.

**Input data:**
- All trades executed (entry/exit prices, hold time, exit reason, wasPromoted)
- Executed strategies from `strategies.db` (linked to positions)
- High-grade (G4-5) and low-grade (G1-2) strategies from what-if analysis
- Calibration table (strategy×regime win rates)
- Existing trader lessons (from `state.json`)

**Output:**
- `whatWorked` / `whatDidnt` / `whatToChange` (trader execution focus)
- Evolved trader lessons — stored in `state.memory.lessons` in `state.json`
- Trader lessons have categories: `execution_timing`, `exit_discipline`, `position_sizing`, `strategy_selection`, `capital_preservation`, `general`

**Who reads it:** The trader, via `consult_memory` tool. Lessons are surfaced before every trade decision.

### Strategist Retrospective

**Purpose:** Evaluate hypothesis quality — which signal sources produce good strategies, which strategy×regime combinations work, lifecycle management, catalyst assessment quality.

**Input data:**
- What-if analysis (all strategies graded 1-5 with hypothetical P&L)
- Recurring abstraction patterns (extracted from what-if grades)
- Strategy lifecycle state counts
- Existing strategist lessons (from `strategies.db`)

**Output:**
- `overview` / `signalSourceQuality` / `strategyRegimeFit` / `lifecycleManagement` / `catalystAssessment`
- Evolved strategist lessons — stored in `strategist_lessons` table in `strategies.db`
- Strategist lessons have categories: `signal_quality`, `strategy_regime_fit`, `catalyst_assessment`, `conviction_scoring`, `timing_evaluation`, `general`

**Who reads it:** The strategist, via `consult_strategist_lessons` tool. Called at the start of each pre-market and mid-session run.

### Combined Report

Both analyses are merged into a single `DailyReport` with separate sections:
- **Trader Analysis:** What worked (execution), what didn't, what to change
- **Strategist Analysis:** Overview, signal source quality, strategy×regime fit, lifecycle management, catalyst assessment
- **What-If Analysis:** Full graded strategy table with hypothetical P&L

The report is persisted in `state.dailyReports[]` and served via `GET /api/report`.

## Lesson Evolution

Both lesson tracks use the same evolution algorithm (non-additive):
- **MERGE** similar lessons (increase weight, update insight)
- **OVERWRITE** lessons that were contradicted
- **REMOVE** obsolete lessons (set deprecated=true)
- **CREATE** new lessons from novel insights

Each track returns 2-6 active lessons. Deprecated lessons are dropped from the output entirely.

## What-If Analysis (shared infrastructure)

The what-if analysis runs before either retrospective and is shared by both:

1. Fetch all strategies that were active/touched during the day
2. For each strategy: compute a hypothetical entry/exit price and P&L
3. Grade each strategy on a 1-5 scale based on P&L outcome, confidence alignment, regime fit, state quality, catalyst presence, and strategy×regime fit
4. Extract recurring abstraction patterns (e.g., "momentum long trending_up works" × 3 appearances)
5. Persist grades back to each strategy in `strategies.db`
6. Feed grades to both retrospectives

The what-if analysis produces a `WhatIfAnalysis` object with grade distribution, best/worst strategy, per-strategy grades, and abstraction patterns. The strategist retrospective uses this to evaluate signal source quality and strategy×regime fit. The trader retrospective uses it to identify missed opportunities and poor selections.