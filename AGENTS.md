# Scrooge — The AI-Native Portfolio Manager

## 🎯 What Is This?

Scrooge is an **autonomous, AI-native portfolio manager** that uses an LLM (via pi.dev SDK + OpenRouter) as its executive function — the agent *decides* what to do, not a hardcoded algorithm. It trades equities through **Alpaca** (cash account, fractional shares, paper-first), discovers tickers dynamically across the entire market, and implements a **3-phase learning system** to improve over time.

**Philosophy:** The LLM is the portfolio manager with tool access; risk guardrails are deterministic underneath. No fixed strategy routing — the agent picks the right tool for the market context. All analysis tools return **data only** — the agent does all reasoning, direction assessment, and execution decisions.

---

## 🧠 Architecture Overview

Scrooge runs **two separate agent processes** — a **Strategist** and a **Trader** — that share persistent state through SQLite databases and JSON files. The research engine runs 24/7 independently of both agents.

```
                        ┌──────────────────────────────┐
                        │   Research Engine (24/7)     │
                        │   data/research.db            │
                        │   Ingestion: yahoo, edgar,   │
                        │   reddit, alpaca news,       │
                        │   volume, gaps, range breaks │
                        └──────────┬───────────────────┘
                                   │ writes signals 24/7
                                   ▼
┌────────────────────────────────────────────────────────────┐
│                    strategist.ts                            │
│  Pre-market (T-30min): Full sweep → initial strategy slate│
│  During market (every 6th trader cycle): Refine strategies │
│  Market close: Wrap-up summary                             │
│                                                            │
│  Agent: Forms hypotheses, does NOT trade                   │
│  Tools: Research only — no execution                      │
│  Output: data/strategies.db                                │
└──────────────────────────┬─────────────────────────────────┘
                           │ writes strategies
                           ▼
┌────────────────────────────────────────────────────────────┐
│                    trader.ts                                │
│  Market open → close: Continuous event loop               │
│                                                            │
│  Each cycle:                                                │
│    1. Read current positions + linked strategies           │
│    2. Read top 10 non-position strategies from strategist  │
│    3. Agent session: perception → execution               │
│    4. Reconcile positions, update state.json              │
│                                                            │
│  Agent: Makes enter/exit decisions                         │
│  Tools: Execution + position management                   │
│  Input: strategies.db + state.json + research.db          │
└──────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────┐
│  Portfolio State (state.json)       │
│  — positions, trades, snapshots     │
│  — calibration table, vector memory │
│  — lessons, activity stream         │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│         Flask API (port 5000)       │
│         Dashboard endpoints          │
└─────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Two separate processes** | Each agent has focused context, tools, and token budget. No competition between research and execution. |
| **Strategist runs ~6-10x per day** | Doesn't need 2-min resolution. Data doesn't change that fast. Every 6th trader cycle (~12-20 min) is plenty. |
| **Strategist starts T-30min pre-market** | Overnight research DB is full of signals. Strategist queries it and builds the initial strategy slate before market open. |
| **Strategist ends at market close** | No point forming strategies when the trader can't execute. Writes a wrap-up summary. |
| **No hard cap on strategy count** | Strategist creates strategies for any ticker where signal density supports a thesis. Could be 5 on a quiet day, 25+ on a high-signal day. Trader only sees top 10. |
| **Stale strategies auto-pruned** | 48h without update = archived. Low-confidence strategies that never develop get pruned after 24h. |

---

## 📁 File Map

### Source Code (`src/`)

| File | Purpose |
|------|---------|
| `src/config.ts` | Loads `config.yaml` + `.env` overrides. Single source of truth for all parameters. |
| `src/types.ts` | All TypeScript interfaces: `Position`, `TradeRecord`, `PortfolioSnapshot`, `StrategyCalibration`, `VectorMemoryEntry`, `PersistedState`, `Strategy`, etc. |
| | |
| **`src/brain/`** | **Agent personality and tools** |
| `agent.ts` | pi.dev SDK agent session setup base — shared by strategist and trader |
| `trader-agent.ts` | Trader-specific: registers execution tools, position management tools |
| `trader-tools.ts` | Trader tool set: place_buy_order, place_short_order, place_sell_order, hold_cash, monitor_positions, close_position, consult_memory, get_active_strategies, update_strategy_on_exit, fetch_market_data |
| `trader-prompt.ts` | Trader system prompt — position-focused, strategy-aware |
| `strategist-agent.ts` | Strategist-specific: registers research-only tools |
| `strategist-tools.ts` | Strategist tool set: all research + create_strategy, update_strategy, archive_strategy |
| `strategist-prompt.ts` | Strategist system prompt — hypothesis formation, lifecycle management |
| `analysis.ts` | Market state classification (regime detection, breadth scoring). |
| | |
| **`src/index-trader.ts`** | **Trader event loop.** Market check → reconciliation → read strategies → agent session → execute → reconcile. Entry point. |
| | |
| **`src/index-strategist.ts`** | **Strategist event loop.** Timer-based, runs pre-market + during market every N cycles. No market clock dependency. Entry point. |
| | |
| **`src/ingestion/`** | **Free data sources** (no paid APIs) — same as before |
| `discovery.ts` | Dynamic ticker discovery — scans Yahoo Finance movers/gainers/losers, verifies Alpaca fractional eligibility. |
| `news.ts` | Alpaca News API wrapper (per-symbol news). |
| `expanded-news.ts` | Alpaca News API (multi-symbol, market-wide scan). |
| `market.ts` | Yahoo Finance scrapers — VIX, SPY change, price lookups, gainers/losers. |
| `scanner.ts` | Technical scanners — relative volume, pre-market gaps, range breaks. |
| `edgar.ts` | SEC EDGAR RSS (8-K filings) parser + ticker resolver. |
| `social.ts` | Reddit mention velocity (JSON API, no API key needed). |
| | |
| **`src/execution/`** | |
| `alpaca.ts` | Alpaca REST API wrapper — orders, account info, positions, market clock. |
| | |
| **`src/risk/`** | |
| `guardrails.ts` | `evaluateBuySignal()` — position sizing, portfolio limits, daily loss halt, calibration override. |
| | |
| **`src/state/`** | |
| `portfolio.ts` | **Portfolio state manager.** Saves to `data/state.json`. Full learning engine: calibration table updates, vector memory insertion, cosine similarity search, equity curve snapshots, dashboard export. |
| `strategies.ts` | **Strategy store.** SQLite wrapper for `data/strategies.db`. Read/write strategies, lifecycle updates, pruning, top-K queries. |
| | |
| **Entry scripts (root)** | |
| `strategist.ts` | CLI entry for the strategist: `tsx strategist.ts` |
| `trader.ts` | CLI entry for the trader: `tsx trader.ts` |

### Configuration & Secrets

| File | Purpose |
|------|---------|
| `config.yaml` | **All tunable parameters** — position sizing, risk limits, watchlist, signal filters, polling interval, data source toggles. Edit freely. |
| `.env` (not committed) | **API keys only** — `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `OPENROUTER_API_KEY`. |
| `.env.example` | Template for `.env`. |

### API (`api/`)

| File | Purpose |
|------|---------|
| `api/app.py` | Flask REST API — reads `state.json` + `strategies.db` and serves dashboard endpoints on port 5000. |
| `api/scrooge-api.service` | systemd unit file for auto-starting the API on boot. |

### Deploy (`deploy/`)

| File | Purpose |
|------|---------|
| `deploy/deploy.py` | Python deploy script (uses paramiko to ship code to Pi and restart service). |
| `deploy/deploy.sh` | Bash deploy script (alternative, uses rsync + ssh). |
| `deploy/CHECKLIST.md` | Step-by-step deployment checklist. |

### Data

| Path | Purpose |
|------|---------|
| `data/state.json` | **Runtime state** — all trades, portfolio snapshots, calibration table, vector memory. Auto-created. **Not committed to git.** |
| `data/strategies.db` | **Strategy database** — SQLite. All strategies with lifecycle states. **Not committed to git.** |
| `data/research.db` | **Research database** — SQLite. Signals, fundamentals, corporate events. **Not committed to git.** |
| `logs/scrooge.log` | Bot log output. **Not committed to git.** |
| `logs/api.log` | API access log. **Not committed to git.** |

---

## 🔄 Execution Flow

### Pre-Market (T-30 min before open)

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

### Trading Session (Market Open → Close)

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

### Market Close

```
Trader session ends
  ├─ Run daily retrospective
  └─ Save final state

Strategist session ends
  ├─ Write wrap-up: "Here's what I was watching, what played out"
  └─ Sleep until next pre-market
```

---

## 🧠 Strategist Details

### Philosophy

The strategist is an **anticipatory researcher**, not a trader. It forms hypotheses about what might happen and tracks them through a lifecycle of 5 states. It creates strategies based on signal density from the research DB — it does NOT invent things on quiet days.

**No hard cap on strategies.** If 50 tickers have signal activity, the strategist creates 50 strategies. The trader only sees the top 10. Low-confidence or stale strategies auto-prune.

### Strategy Lifecycle

```
                  ┌──────────────────┐
                  │   anticipated    │ ← Initial sighting, low confidence
                  │  (watching, no   │
                  │   clear thesis)  │
                  └────────┬─────────┘
                           │ additional signals confirm
                           ▼
                  ┌──────────────────┐
                  │   developing     │ ← Thesis forming, confidence growing
                  │  (2+ signals,    │
                  │   catalyst seen) │
                  └────────┬─────────┘
                           │ catalyst confirmed / timing right
                    ┌──────┴──────┐
                    ▼              ▼
          ┌──────────────┐  ┌──────────────┐
          │   realized    │  │    stale     │ ← Never reached confidence
          │  (executed as │  │ (pruned after│
          │   position)   │  │   24-48h)    │
          └──────┬───────┘  └──────────────┘
                 │
           ┌─────┴──────┐
           ▼             ▼
    ┌──────────┐  ┌──────────┐
    │  active  │  │  failed  │
    │ (working │  │ (lost its│
    │  thesis) │  │  thesis) │
    └──────────┘  └──────────┘
```

| State | Meaning | Confidence Range | Typical Duration |
|-------|---------|-----------------|-----------------|
| `anticipated` | First sighting — watching, no clear thesis yet | 0.1–0.35 | 1–4 cycles |
| `developing` | Thesis forming, 2+ signals converging, catalyst identified | 0.35–0.65 | 2–8 cycles |
| `realized` | Trader executed a position based on this strategy | 0.65+ | Tied to position |
| `active` | Position is open and strategy thesis is still valid | 0.5+ | Tied to position |
| `failed` | Thesis invalidated (catalyst dead, regime shift, opposite data) | — | Archived |
| `stale` | No new signals or strategist updates in 48h | — | Archived |

### Strategist Tools

The strategist gets **no execution tools**. It cannot place orders, check positions, or touch Alpaca trading. Its tools:

| Tool | Purpose |
|------|---------|
| `fetch_market_data` | VIX, SPY, regime, breadth |
| `fetch_news` | Full headlines for a specific ticker |
| `fetch_all_news` | ALL recent headlines (wider net) |
| `fetch_edgar_filings` | Detailed SEC 8-K filings |
| `scan_relative_volume` | Check if a move has volume confirmation |
| `scan_premarket_gaps` | Gap analysis for specific tickers |
| `scan_range_breaks` | 20-day range analysis |
| `scan_reddit` | Reddit sentiment details |
| `discover_opportunities` | Find NEW tickers outside current list |
| `search_signals` | Query research DB for signal history |
| `search_sector_signals` | Sector, macro, and political/regulatory signals |
| `get_macro_calendar` | Upcoming CPI, FOMC, NFP, PPI events |
| `describe_datasets` | See what data is in the research DB |
| `consult_memory` | **Read-only** — check past trade outcomes for similar setups |
| **`create_strategy`** | **New** — Store a new strategy with thesis, confidence, state |
| **`update_strategy`** | **New** — Update state, confidence, rationale of existing strategy |
| **`archive_strategy`** | **New** — Mark a strategy as stale/failed and stop tracking |

### Strategist Prompt Philosophy

```
You are Scrooge's strategist — you form hypotheses, you do NOT trade.

Your job:
1. Query the research DB and live APIs to find tickers with signal activity
2. For each cluster of signals, decide if a strategy thesis exists
3. C3. Classify each strategy into a lifecycle state — anticipated → developing → realized/active/failed/stale
4. Assign a confidence score (0.0–1.0) based on signal strength, cross-source convergence, and market regime
5. List what would confirm or invalidate your thesis
6. When a strategy reaches 'developing', increase its priority
7. Prune stale strategies (no updates in 48h) — they clutter the DB

Better to create 50 low-confidence "watching" strategies than miss the one that develops.
The trader only sees the top 10 by confidence × freshness.
```

---

## 🧪 Trader Details

### Philosophy

The trader is an **execution specialist**. It receives:
- Current positions with their linked strategies (thesis, catalyst, confidence at entry)
- Top 10 non-position strategies from the strategist, ranked by confidence × freshness
- Full market context (VIX, SPY, regime, news, movers)

It decides **what to enter** and **what to exit**. It does NOT do deep research — that's the strategist's job.

### Trader Tools

The trader gets execution tools + position management. The strategy-management tools are read-only. Pure research tools (discovery, Reddit, EDGAR search) are removed — the trader relies on the strategist's output.

| Tool | Purpose |
|------|---------|
| `fetch_market_data` | VIX, SPY, regime, breadth |
| `fetch_news` | Quick headline check for specific tickers |
| `get_active_strategies` | **Read** — Fetch top 10 non-position strategies + position-linked strategies |
| `update_strategy_on_exit` | **Write** — Mark a strategy as active/failed when a position closes |
| `monitor_positions` | Check all open positions' exit conditions |
| `close_position` | Evaluate whether a position's strategy still holds |
| `place_buy_order` | Enter a long position (risk guardrails validate) |
| `place_short_order` | Enter a short position (risk guardrails validate) |
| `place_sell_order` | Exit a position (covers both longs and shorts) |
| `hold_cash` | Explicitly do nothing (forces reasoning) |
| `record_decision` | Log what was decided and why |
| `consult_memory` | Check lessons and similar past trades before deciding |

### Trader Prompt Philosophy — Strategy-Aware

```
You are Scrooge's trader — you execute strategies formed by the strategist.

STRATEGIES are pre-vetted hypotheses. You do NOT create them.
You decide: "Does this strategy deserve capital RIGHT NOW?"

For each OPEN POSITION:
  - Its strategy tells you the original thesis (catalyst, regime, confidence)
  - Compare THAT against current conditions
  - If thesis is invalidated → exit even if stops haven't hit
  - If thesis is confirmed → let the trailing stop ride

For each CANDIDATE STRATEGY (top 10):
  - Each has a confidence score, lifecycle state, and thesis
  - A "developing" strategy is more actionable than an "anticipated" one
  - Consider: does current price action confirm the strategist's thesis?
  - If yes → place_buy_order or place_short_order
  - If no → skip and explain why

You are the trigger finger, not the brain. Trust the strategist's research,
but verify with price action before pulling the trigger.
```

---

## 🗃️ Strategy Database Schema

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
);

CREATE INDEX idx_strategies_state      ON strategies(state);
CREATE INDEX idx_strategies_ticker     ON strategies(ticker);
CREATE INDEX idx_strategies_confidence ON strategies(confidence DESC);
CREATE INDEX idx_strategies_updated    ON strategies(updated_at DESC);
```

---

## 🧪 Learning System (3 Phases) — Unchanged

The 3-phase learning system remains identical. It operates on trade outcomes from the trader, which now includes strategy linkage:

1. **Rich Trade Context:** Each position stores VIX, regime, confidence, impact score, source at entry. Now also stores the **strategy ID** so post-mortems can trace back to the strategist's thesis.
2. **Calibration Table:** `getCalibratedConfidence(strategy, regime)` queries win-rate history. Overrides LLM confidence when 5+ samples exist in that strategy×regime cell.
3. **Vector Memory:** `findSimilarTrades(featureVector)` returns top-K past trades with cosine similarity scores. Trader tool `consult_memory` lets the LLM query past outcomes for similar setups.

The retrospective also analyzes **strategy performance** — which strategy types and lifecycle paths produced the best outcomes.

---

## 🔧 Risk Architecture — Unchanged

| Guardrail | Value | Behavior |
|-----------|-------|----------|
| Hard stop loss | −3% from entry | `stop_loss_pct: 0.03` |
| Trailing stop | −5% from peak | `trailing_stop_pct: 0.05` |
| Green threshold | +1% | Promotes to trailing stop mode, cancels time stop |
| Time stop | 30 min | If not profitable by then, exit |
| Short squeeze protection | +5% intraday | Cover immediately on squeeze |

**Everything else — sizing, position count, risk per trade, strategy selection — is the trader's domain.**

---

## 🚀 Deployment Target — Unchanged

**Raspberry Pi** at `192.168.50.42` (user: `admin`, key: `~/.ssh/id_ed25519_pi`)
- OS: Raspbian 13 (trixie), armv7l
- Node.js 22.14.0 (armv7l binary)
- systemd services: `scrooge-strategist.service` + `scrooge-trader.service` (two processes)
- OR combined: `scrooge.service` (launches both strategist and trader)
- Bot logs: `/home/admin/scrooge/logs/`
- State: `/home/admin/scrooge/data/`
- API: `http://192.168.50.42:5000/api/`

---

## 📊 Position Context Spec — Updated for Strategy Linkage

Every open position includes its **linked strategy** at the top of the context block:

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

---

## 📋 Ticker Context Spec — Unchanged

When the trader evaluates a candidate strategy's ticker, it still gets the standard multi-timeframe price context without RISK/THESIS sections.

---

## 📡 Data Sources — Unchanged

| Source | What | How |
|--------|------|-----|
| **Alpaca** | Account, orders, positions, market clock, news, fractional eligibility | REST API |
| **Yahoo Finance** | VIX, SPY change, price, movers, gainers/losers | HTML scrape |
| **SEC EDGAR RSS** | 8-K corporate filings | RSS feed |
| **Reddit** | Mention velocity (r/wallstreetbets, r/stocks) | Undocumented JSON API |

---

## 🧠 Research Engine — Unchanged

The research engine (SQLite at `data/research.db`) continues to run 24/7, accumulating signals from all sources. Both the strategist and trader read from it. Only the strategist writes strategies based on it.

Research engine details remain identical to the previous architecture:
- 4 tables: tickers, signals, fundamentals, corporate_events
- Tiered time decay (raw → hourly → daily)
- Independent timer, no dependency on market hours or agent state
- `search_signals`, `search_sector_signals`, `get_macro_calendar`, `describe_datasets` tools

### What Changed

| Before | After |
|--------|-------|
| Single agent does everything | Split: Strategist (research) + Trader (execution) |
| Research and execution compete for context | Each agent has focused context and tools |
| Agent reacts to current data only | Strategist anticipates, creates lifecycle-tracked strategies |
| No strategy persistence | `data/strategies.db` with 6-state lifecycle |
| No linkage between position and research | Each position has a strategy_id linking back to the strategist's thesis |
| Discovery/research tools in execution context | Strategist has research tools; Trader has execution tools |

### What Stays the Same

- The 3-phase learning system (calibration table, vector memory, lesson reflection)
- Risk architecture (hard stop, trailing stop, green threshold, time stop, squeeze protection)
- Event loop structure (but now runs in the trader process only)
- Research engine (24/7 independent signal accumulation)
- Flask API dashboard (now reads both state.json and strategies.db)
- Deployment target (Raspberry Pi, systemd services)
- All existing data ingestion code (Yahoo, EDGAR, Reddit, Alpaca news, volume scanners)
- Position context spec format (now includes strategy linkage)
- Ticker context spec format (unchanged)
