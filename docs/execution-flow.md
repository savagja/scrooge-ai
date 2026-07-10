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
  │   5. query_technical_indicators — screen for RSI extremes, Bollinger breaks, EMA alignment
  │   6. For each identified opportunity: create_strategy with thesis, confidence, state
  │   7. End session
  ├─ Save strategy slate to strategies.db
  ├─ Generate strategist report → data/strategist-report.md
  │     Includes: market summary, strategy overview, top strategies with explanations,
  │               strategist's raw session output as commentary
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
       │     ├─ Save to strategies.db
       │     └─ Generate strategist report → data/strategist-report.md
       │
       ├─ 3. Build perception prompt:
       │     ├─ Current market state (VIX, SPY, regime, breadth)
       │     ├─ Portfolio status (cash, P&L, open positions count)
       │     ├─ For EACH open position:
       │     │    ├─ Full price context (30d, 1d, volume, vs SPY)
       │     │    ├─ Risk metrics (stops, P&L, peak, trailing stop)
       │     │    └─ LINKED STRATEGY (thesis, catalyst, status at entry, what-if grade)
       │     ├─ TOP 10 CANDIDATE STRATEGIES (non-position) sorted by state > conviction > confidence > recency
       │     │    ├─ Each: ticker, strategy_type, direction, state, conviction, confidence
       │     │    ├─ Thesis summary, catalyst, timeframe, entry/exit conditions
       │     │    ├─ What-if historical grade (1-5) + hypothetical P&L
       │     │    └─ Real-time price context + why-this-rank explanation
       │     ├─ STRATEGIST'S BRIEFING — full strategist report injected from data/strategist-report.md
       │     │    Provides narrative context, market summary, strategy overview, ranking explanations
       │     ├─ Active lessons from retrospective
       │     └─ Pre-digested market context (news, movers, EDGAR, volume)
       │
       ├─ 4. Agent session — trader decides:
       │     ├─ 1. Review current positions — check linked strategy validity
       │     ├─ 2. Read strategist briefing for narrative context
       │     ├─ 3. Cross-reference strategist reasoning with structured strategy data
       │     ├─ 4. For exits: close_position → place_sell_order → update_strategy_on_exit
       │     ├─ 5. For entries: consult_memory → place_buy_order / place_short_order / hold_cash
       │     └─ 6. Record decision
       │
       ├─ 5. Execute trades (risk guardrails validate)
       ├─ 6. Reconcile positions, update P&L, snapshots
       └─ 7. Sleep → repeat
```

## Market Close

```
Trader session ends
  └─ Save final state

Strategist session ends
  └─ Sleep until next pre-market

Retrospective process launches (independent process via cron/systemd-timer):
  ├─ 1. Run what-if analysis on ALL strategies from today
  │     Grade each strategy 1-5 based on hypothetical P&L.
  │     Extract recurring patterns (abstractions).
  │
  ├─ 2. Run TRADER retrospective
  │     Input: trades + executed strategies + what-if grades + calibration table
  │     LLM evaluates: entry timing, exit discipline, strategy selection, missed G4-5s
  │     Output: trader whatWorked/whatDidnt/whatToChange + evolved trader lessons
  │     Persist: trader lessons → state.memory.lessons (state.json)
  │
  ├─ 3. Run STRATEGIST retrospective
  │     Input: what-if grades + abstractions + lifecycle counts + existing strategist lessons
  │     LLM evaluates: signal source quality, strategy×regime fit, lifecycle mgmt, catalyst assessment
  │     Output: strategist overview + 4 analysis sections + evolved strategist lessons
  │     Persist: strategist lessons → strategist_lessons table (strategies.db)
  │
  └─ 4. Build combined markdown report
        Sections: Summary | Trader Analysis (whatWorked/whatDidnt/whatToChange) |
                  Strategist Analysis (overview, signals, regime-fit, lifecycle, catalysts) |
                  What-If Strategy Analysis
        Persist: state.dailyReports[]
        Serve: GET /api/report
```

### Next Day Pre-Market

```
Strategist launches
  ├─ 1. consult_strategist_lessons — read evolved lessons from last night's retro
  ├─ 2. Then normal pre-market flow (research DB, signals, create strategies)
  └─ 3. Generate strategist report → data/strategist-report.md
```

### Next Day Trading Session

```
Trader launches
  ├─ consult_memory — reads evolved trader lessons
  ├─ Then normal event loop (strategist report injected from file)
  ...
```