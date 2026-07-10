# Strategy Database Schema

A separate SQLite database at `data/strategies.db` stores all strategies. This is the bridge between strategist and trader.

```sql
CREATE TABLE strategies (
  id              TEXT PRIMARY KEY,
  ticker          TEXT NOT NULL,
  strategy_type   TEXT NOT NULL,   -- 'value', 'swing', 'day_trade', 'momentum', 'event_driven', 'mean_reversion'
  direction       TEXT NOT NULL,   -- 'long', 'short'
  state           TEXT NOT NULL,   -- 'anticipated', 'developing', 'realized', 'active', 'failed', 'stale'

  -- Core thesis
  thesis          TEXT NOT NULL,   -- One-sentence summary
  catalyst        TEXT,            -- What specific event/condition triggered this
  timeframe       TEXT,            -- 'intraday', '1-3_days', '1-2_weeks', 'multi_week'

  -- Confidence
  confidence      REAL NOT NULL,  -- 0.0 to 1.0 — rough numeric sort hint
  conviction      TEXT NOT NULL DEFAULT 'low',  -- 'low', 'medium', 'high' (primary tier the trader reads)

  -- Reasoning trail
  rationale       TEXT NOT NULL,   -- Why this strategy exists
  key_signals     TEXT,            -- JSON array of signal IDs from research.db that support this
  risk_factors    TEXT,            -- JSON array: what could invalidate the thesis

  -- Lifecycle timing
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_signal_at  TEXT,            -- When was the most recent supporting signal seen?

  -- Execution linkage
  position_id     TEXT,            -- Links to a position in state.json if executed

  -- Outcome tracking (populated when position closes)
  entry_price     REAL,
  exit_price      REAL,
  pnl             REAL,
  pnl_pct         REAL,
  exit_reason     TEXT,

  -- Source attribution
  created_by      TEXT DEFAULT 'strategist'  -- 'strategist', 'manual'
  -- What-If analysis (populated by retrospective)
  what_if         TEXT             -- JSON: grade, hypothetical P&L, abstraction, rationale
);
```