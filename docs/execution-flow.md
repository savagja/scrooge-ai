# Execution Flow

## Pre-Market (T-30 min before open)

```
Strategist launches
  ├─ Connect to research.db (overnight signals already accumulated)
  ├─ Query research DB for high-signal tickers (multi-source clusters, EDGAR filings, pre-market movers)
  ├─ Strategist agent session:
  │   1. describe_datasets — understand what's available
  │   2. search_signals — find what's happening across the market
  │   3. search_sector_signals — check sector rotation / macro context
  │   4. get_macro_calendar — note any upcoming events in next 48h
  │   5. For each identified opportunity: create_strategy with thesis, confidence, state
  │   6. End session
  ├─ Save strategy slate to strategies.db
  └─ Wait for market open
```

## Trading Session (Market Open → Close)

```
Trader launches
  ├─ Reconcile with Alpaca (sync cash, absorb unknown positions)
  ├─ Verify market is open
  │
  └─ EVENT LOOP (every ~2 min):
       ├─ 1. Re-check market clock
       ├─ 2. [Every 6th cycle] Strategist runs:
       │     ├─ Query research.db for new signals since last run
       │     ├─ Agent session: update existing strategies, create new ones
       │     ├─ Promote/demote lifecycle states
       │     ├─ Prune stale strategies
       │     └─ Save to strategies.db
       │
       ├─ 3. Build perception prompt:
       │     ├─ Current market state (VIX, SPY, regime, breadth)
       │     ├─ Portfolio status (cash, P&L, open positions count)
       │     ├─ For EACH open position:
       │     │    ├─ Full price context (30d, 1d, volume, vs SPY)
       │     │    ├─ Risk metrics (stops, P&L, peak, trailing stop)
       │     │    └─ LINKED STRATEGY (thesis, catalyst, status at entry)
       │     ├─ TOP 10 ACTIVE STRATEGIES (non-position) sorted by confidence × freshness
       │     │    ├─ Each: ticker, strategy_type, direction, state, confidence
       │     │    ├─ Thesis summary, catalyst, timeframe
       │     │    └─ Key signals supporting the strategy
       │     ├─ Active lessons from retrospective
       │     └─ Pre-digested market context (news, movers, EDGAR, volume)
       │
       ├─ 4. Agent session — trader decides:
       │     ├─ "Does the position strategy still hold? If invalidated → exit."
       │     ├─ "Which of the top 10 strategies is most actionable RIGHT NOW?"
       │     ├─ "I have $X cash. Which strategy deserves capital?"
       │     ├─ Call tools: get ticker context, check memory, execute
       │     └─ Record decision
       │
       ├─ 5. Execute trades (risk guardrails validate)
       ├─ 6. Reconcile positions, update P&L, snapshots
       └─ 7. Sleep → repeat
```

## Market Close

```
Trader session ends
  ├─ Run daily retrospective
  └─ Save final state

Strategist session ends
  ├─ Write wrap-up: "Here's what I was watching, what played out"
  └─ Sleep until next pre-market
```