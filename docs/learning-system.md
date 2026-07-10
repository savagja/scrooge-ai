# Learning System (3 Phases)

The 3-phase learning system operates on trade outcomes from the trader, with strategy linkage.

1. **Rich Trade Context:** Each position stores VIX, regime, confidence, impact score, source at entry. Also stores the **strategy ID** so post-mortems can trace back to the strategist's thesis.
2. **Calibration Table:** `getCalibratedConfidence(strategy, regime)` queries win-rate history. Overrides LLM confidence when 5+ samples exist in that strategy×regime cell.
3. **Vector Memory:** `findSimilarTrades(featureVector)` returns top-K past trades with cosine similarity scores. Trader tool `consult_memory` lets the LLM query past outcomes for similar setups.

The retrospective also analyzes **strategy performance** — which strategy types and lifecycle paths produced the best outcomes.