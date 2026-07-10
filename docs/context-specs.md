# Context Specs

## Position Context Spec — Strategy Linkage

Every open position includes its **linked strategy** at the top of the context block.

### Format
```
══════════════════════════════════════════════════════════════════════════════
POSITION: [TICKER] LONG ~QTY @ $ENTRY_PRICE
STRATEGY: [strategy_type] — [state] | confidence: XX%
THESIS: [one-line thesis summary]
CATALYST: [what triggered entry]
══════════════════════════════════════════════════════════════════════════════

─ PRICE ACTION ─
  30d: $LOW–$HIGH | current: X% of 30d range | net: ±X.X% | avg vol: X.XM
  ...

─ RISK ─
  entry: $X.XX | current: $X.XX | P&L: ±$X.XX (±X.XX%)
  ...

─ THESIS TRACKING ─
  entry catalyst: SOURCE | current status: STATUS
  entry regime: REGIME | current regime: REGIME
  strategy confidence at entry: XX% | strategy state at entry: [state]
```

### Implementation

`buildTickerContext()` in `src/execution/alpaca.ts` generates the report. The strategy data is fetched from `strategies.db` via the strategy store.

## Ticker Context Spec

When the trader evaluates a candidate strategy's ticker, it still gets the standard multi-timeframe price context without RISK/THESIS sections.