# Scrooge — The AI-Native Portfolio Manager

## 🎯 What Is This?

Scrooge is an **autonomous, AI-native portfolio manager** that uses an LLM (via pi.dev SDK + OpenRouter) as its executive function — the agent *decides* what to do, not a hardcoded algorithm. It trades equities through **Alpaca** (cash account, fractional shares, paper-first), discovers tickers dynamically across the entire market, and implements a **3-phase learning system** to improve over time.

**Philosophy:** The LLM is the portfolio manager with tool access; risk guardrails are deterministic underneath. No fixed strategy routing — the agent picks the right tool for the market context. All analysis tools return **data only** — the agent does all reasoning, direction assessment, and execution decisions.

---

## 🧠 Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                    index.ts (event loop)                    │
│  Every N seconds: market check → perception → agent → exec │
└──────────────────┬─────────────────────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
┌─────────┐  ┌──────────┐  ┌────────────┐
│ Ingestion│  │  Brain   │  │  Execution  │
│ (data)  │  │  (LLM)   │  │  (Alpaca)  │
└────┬────┘  └────┬─────┘  └─────┬──────┘
     │            │              │
     ▼            ▼              ▼
┌─────────────────────────────────────┐
│          Portfolio State            │
│  (state.json — trades, snapshots,   │
│   calibration table, vector memory) │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│         Flask API (port 5000)       │
│         Dashboard endpoints          │
└─────────────────────────────────────┘
```

---

## 📁 File Map

### Source Code (`src/`)

| File | Purpose |
|------|---------|
| `src/index.ts` | **Event loop.** Market check → perception → agent session → tool execution → reconcile. Entry point. |
| `src/config.ts` | Loads `config.yaml` + `.env` overrides. Single source of truth for all parameters. |
| `src/types.ts` | All TypeScript interfaces: `Position`, `TradeRecord`, `PortfolioSnapshot`, `StrategyCalibration`, `VectorMemoryEntry`, `PersistedState`, etc. |
| | |
| **`src/brain/`** | **Agent personality and tools** |
| `agent.ts` | pi.dev SDK agent session setup (model selection, tool registration, system prompt). |
| `tools.ts` | **18 custom agent tools** — every action the LLM can take (fetch data, trade, discover, reflect, find_similar_trades). |
| `system-prompt.ts` | System prompt defining agent persona, strategy philosophy, tool guidance. |
| `analysis.ts` | Market state classification (regime detection, breadth scoring). |
| | |
| **`src/ingestion/`** | **Free data sources** (no paid APIs) |
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

### Configuration & Secrets

| File | Purpose |
|------|---------|
| `config.yaml` | **All tunable parameters** — position sizing, risk limits, watchlist, signal filters, polling interval, data source toggles. Edit freely. |
| `.env` (not committed) | **API keys only** — `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `OPENROUTER_API_KEY`. |
| `.env.example` | Template for `.env`. |

### API (`api/`)

| File | Purpose |
|------|---------|
| `api/app.py` | Flask REST API — reads `state.json` and serves dashboard endpoints on port 5000. |
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
| `logs/scrooge.log` | Bot log output. **Not committed to git.** |
| `logs/api.log` | API access log. **Not committed to git.** |

---

## 🔄 Execution Flow

1. **Startup:** `index.ts` loads config, reconciles with Alpaca (syncs cash, absorbs unknown positions)
2. **Market check:** If market is closed, sleep `pollIntervalMs` and retry
3. **Perception:** Gather market data (VIX, SPY, regime, watchlist prices, news, movers, filings)
4. **Agent decision:** Send perception to LLM with tool access → agent chooses tools (fetch, analyze, trade, hold)
5. **Execution:** If agent calls a buy/sell tool, risk guardrails validate → Alpaca API executes
6. **Reconciliation:** Update positions, P&L, snapshots, check stops/trailing stops
7. **Loop:** Sleep `pollIntervalMs`, repeat

---

## 🧪 Learning System (3 Phases)

1. **Rich Trade Context:** Each position stores VIX, regime, confidence, impact score, source at entry. `recordExit` pulls from stored position data (no caller args needed).
2. **Calibration Table:** `getCalibratedConfidence(strategy, regime)` queries win-rate history. Overrides LLM confidence when 5+ samples exist in that strategy×regime cell.
3. **Vector Memory:** `findSimilarTrades(featureVector)` returns top-K past trades with cosine similarity scores. Agent tool `find_similar_trades` lets the LLM query past outcomes for similar setups.

---

## 🔧 Risk Architecture

Scrooge is an intelligent portfolio manager, not a rule-driven trading bot. The only deterministic guardrails are position-level safety systems:

| Guardrail | Value | Behavior |
|-----------|-------|----------|
| Hard stop loss | −3% from entry | `stop_loss_pct: 0.03` |
| Trailing stop | −5% from peak | `trailing_stop_pct: 0.05` |
| Green threshold | +1% | Promotes to trailing stop mode, cancels time stop |
| Time stop | 30 min | If not profitable by then, exit |
| Short squeeze protection | +5% intraday | Cover immediately on squeeze |

**Everything else — sizing, position count, risk per trade, strategy selection — is the agent's domain.** The LLM decides based on context, memory, and judgement.

---

## 🚀 Deployment Target

**Raspberry Pi** at `192.168.50.42` (user: `admin`, key: `~/.ssh/id_ed25519_pi`)
- OS: Raspbian 13 (trixie), armv7l
- Node.js 22.14.0 (armv7l binary)
- systemd service: `scrooge.service` (bot) + `scrooge-api.service` (Flask API)
- Bot logs: `/home/admin/scrooge/logs/scrooge.log`
- State: `/home/admin/scrooge/data/state.json`
- API: `http://192.168.50.42:5000/api/`

---

## 📊 Position Context Spec

Every open position is automatically injected into the agent's perception context. The format is identical regardless of strategy. **The agent does all reasoning** — no verdicts, recommendations, emoji, or analysis appear in the output.

### Format
```
══════════════════════════════════════════════════════════════════════════════
POSITION: [TICKER] LONG ~QTY @ $ENTRY_PRICE
THESIS: source | duration: Xd | strategy: STRATEGY | source: SOURCE | entry: MM/DD HH:MM
══════════════════════════════════════════════════════════════════════════════

─ PRICE ACTION ─
  30d: $LOW–$HIGH | current: X% of 30d range | net: ±X.X% | avg vol: X.XM
  5d closes: $X.XX → $X.XX → $X.XX → $X.XX → $X.XX
  1d: $LOW–$HIGH | current: X% of 1d range | net: ±X.XX% | vol: XXXXK
  1d bars (15m): HH:MM C$X.XX ±X.X% | HH:MM C$X.XX ±X.X% | ...

─ RELATIVE ─
  vs SPY 30d: ±X.X% vs ±X.X%
  vs SPY today: ±X.XX% vs ±X.XX%
  vol: X.XM today vs X.XM avg (X.Xx avg)

─ RISK ─
  entry: $X.XX | current: $X.XX | P&L: ±$X.XX (±X.XX%)
  peak: $X.XX | change from peak: ±X.X%
  trailing stop: $X.XX (5% below peak) | distance from current: ±X.X%
  hard stop: $X.XX (3% from entry) | distance from current: X.X%

─ THESIS TRACKING ─
  entry catalyst: SOURCE | current status: STATUS
  entry regime: REGIME | current regime: REGIME
  entry VIX: X.X | current VIX: X.X
  entry confidence: XX% | entry impact score: X/10
```

### Data Sources

| Section | Data | Source |
|---------|------|-------|
| PRICE ACTION | 30d daily bars (O/H/L/C/V) | Alpaca data API — 1Day, last 30 bars |
| PRICE ACTION | 1d 15min bars (O/H/L/C/V) | Alpaca data API — 15Min, from market open |
| RELATIVE | SPY comparison | Alpaca data API — same bar queries for SPY |
| RELATIVE | Volume | Derived from bar data |
| RISK | Entry/peak/stops/P&L | Internal state |
| THESIS TRACKING | Entry metadata | Internal state |

### Rules

- All data shown if available; nothing shown if unavailable (no "N/A" placeholders)
- No verdicts, recommendations, emoji, or signal labels — raw context only
- The agent decides direction, sizing, holding period, and when to exit. The code provides data.

### Implementation

`buildTickerContext()` in `src/execution/alpaca.ts` generates the report for both positions and tickers.
- Called from `buildPerceptionPrompt` in `src/index.ts` (positions → includes RISK + THESIS)
- Called from analysis tools in `src/brain/tools.ts` (candidates → no RISK/THESIS)

## 📋 Ticker Context Spec (New Analysis)

When the agent evaluates a ticker it does not currently hold (via tools like `trade_news_momentum`, `trade_mean_reversion`), it receives the same multi-timeframe context without RISK/THESIS sections.

### Format
```
══════════════════════════════════════════════════════════════════════════════
TICKER: [TICKER]
══════════════════════════════════════════════════════════════════════════════

─ PRICE ACTION ─
  30d: $LOW–$HIGH | current: X% of 30d range | net: ±X.X% | avg vol: X.XM
  5d closes: $X.XX → $X.XX → $X.XX → $X.XX → $X.XX
  1d: $LOW–$HIGH | current: X% of 1d range | net: ±X.XX% | vol: XXXXK
  1d bars (15m): HH:MM C$X.XX ±X.X% | HH:MM C$X.XX ±X.X% | ...

─ RELATIVE ─
  vs SPY 30d: ±X.X% vs ±X.X%
  vs SPY today: ±X.XX% vs ±X.XX%
  vol: X.XM today vs X.XM avg (X.Xx avg)
```

### Rules

- **Analysis tools return data only.** No direction signals, impact scores, confidence levels, or "next step" suggestions.
- The agent receives the price context + article text and reasons over it.
- Same buildTickerContext() function — just without entry data.

## 📡 Data Sources (All Free)

| Source | What | How |
|--------|------|-----|
| **Alpaca** | Account, orders, positions, market clock, news, fractional eligibility | REST API |
| **Yahoo Finance** | VIX, SPY change, price, movers, gainers/losers | HTML scrape |
| **SEC EDGAR RSS** | 8-K corporate filings | RSS feed |
| **Reddit** | Mention velocity (r/wallstreetbets, r/stocks) | Undocumented JSON API |

---

## 🧠 Research Engine

### Philosophy

Scrooge maintains a **persistent, code-driven research database** that accumulates every data point the ingestion layer produces. The LLM does **zero data collection or analysis computation** — all data gathering, aggregation, cross-source correlation, and fundamental metric calculation is done deterministically by the code. The agent accesses this data through structured tools that reveal the schema and let it query across signals, fundamentals, and corporate events in one shot.

**Key principle:** The research engine is a *data warehouse for the agent*, not a *signal generator*. The code writes data; the agent reads it and decides what matters.

### Storage Layer

A single **SQLite database** at `data/research.db` stores everything the ingestion layer discovers. This replaces ephemeral in-memory patterns (the rolling 8-cycle ring buffer in `context/builder.ts`) with persistent, queryable history.

**Why SQLite instead of JSON:**
- Indexed queries: O(log n) instead of O(n) scans across hundreds of thousands of events
- Joins: the agent can query across signals + fundamentals + corporate events in one call
- Pruning: `DELETE WHERE timestamp < ?` with an index is instant — no file rewrite
- Concurrency: WAL mode handles simultaneous reads (dashboard) + writes (bot)
- Single file: trivial to backup, copy, or inspect with any SQLite tool
- Pi-friendly: no daemon, no extra memory — same resource footprint as a JSON file

**`state.json` is untouched.** Positions, trades, portfolio snapshots, calibration table, vector memory, lessons, and activity stream remain in JSON. The research DB is the *analytical* layer — it can lag, be stale, or be temporarily unavailable without breaking trading operations.

### Schema (4 Tables)

```sql
-- TICKERS — Every ticker ever encountered
CREATE TABLE tickers (
  symbol      TEXT PRIMARY KEY,
  name        TEXT,
  sector      TEXT,
  industry    TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  is_active   INTEGER DEFAULT 1
);

-- SIGNALS — Every data source writes normalized events here
CREATE TABLE signals (
  id          TEXT PRIMARY KEY,
  ticker      TEXT NOT NULL REFERENCES tickers(symbol),
  timestamp   TEXT NOT NULL,
  source      TEXT NOT NULL,
  -- 'yahoo_mover' | 'alpaca_news' | 'edgar' | 'reddit' | 'volume_spike' | 'gap' | 'range_break'
  score       REAL NOT NULL,     -- 0.0 to 1.0
  direction   REAL NOT NULL,     -- -1 (bearish) to +1 (bullish)
  payload     TEXT               -- JSON blob with source-specific fields
);

CREATE INDEX idx_signals_ticker    ON signals(ticker);
CREATE INDEX idx_signals_ts        ON signals(timestamp);
CREATE INDEX idx_signals_source    ON signals(source);
CREATE INDEX idx_signals_lookup    ON signals(ticker, timestamp DESC);

-- FUNDAMENTALS — Company financial data and technical indicators
CREATE TABLE fundamentals (
  ticker        TEXT NOT NULL REFERENCES tickers(symbol),
  as_of_date    TEXT NOT NULL,
  source        TEXT NOT NULL,     -- 'yahoo_finance' | 'sec_edgar' | 'alpaca_bars'

  -- Valuation
  market_cap    REAL,  pe_ratio  REAL,  forward_pe    REAL,
  ps_ratio      REAL,  pb_ratio  REAL,  ev_to_ebitda  REAL,

  -- Financial health
  total_cash    REAL,  total_debt     REAL,  book_value       REAL,
  free_cash_flow REAL,  current_ratio REAL,  debt_to_equity   REAL,

  -- Performance
  revenue_ttm        REAL,  gross_margin       REAL,
  operating_margin   REAL,  net_margin         REAL,
  eps_ttm            REAL,  eps_growth_yoy     REAL,
  revenue_growth_yoy REAL,

  -- Technical (pre-computed from Alpaca bars)
  avg_volume_20d  REAL,  avg_volume_50d  REAL,
  rsi_14          REAL,  sma_20          REAL,
  sma_50          REAL,  sma_200         REAL,
  volatility_30d  REAL,  beta            REAL,

  -- Sector context (pre-computed for peer comparison)
  sector_median_pe  REAL,  sector_median_ps REAL,
  sector_avg_beta   REAL,  sector_momentum  REAL,

  PRIMARY KEY (ticker, as_of_date, source)
);

-- CORPORATE EVENTS — Structured event log (earnings, filings, etc.)
CREATE TABLE corporate_events (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL REFERENCES tickers(symbol),
  event_date    TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  -- 'earnings' | 'dividend' | 'split' | 'buyback' | 'acquisition' | 'insider_trade' | 'sec_filing'
  impact        REAL,             -- -1.0 to +1.0 (pre-computed)
  details       TEXT,             -- JSON blob with event-specific fields
  source_url    TEXT
);

CREATE INDEX idx_events_ticker ON corporate_events(ticker);
CREATE INDEX idx_events_date   ON corporate_events(event_date);
CREATE INDEX idx_events_type   ON corporate_events(event_type);
```

### Ingestion — Code Writes on Its Own Schedule

Every data source calls `signalStore.record()` every time the research timer fires. No LLM involvement — this is deterministic, fire-and-forget, and decoupled from trading hours or agent state:

| Source | Signal Event Written | Research Timer Cadence |
|--------|---------------------|----------------------|
| Yahoo gainers/losers | `source: yahoo_mover, score: changePct/50, direction: sign` | Every research tick (~30s) |
| Alpaca news headlines | `source: alpaca_news, score: 0.6, direction: per classification` | Every research tick |
| EDGAR 8-K filings | `source: edgar, score: impactScore/10, direction: per filing type` | Every research tick |
| Reddit mention velocity | `source: reddit, score: velocity/5, direction: 0` | Every research tick |
| Volume standouts | `source: volume_spike, score: relVol/10, direction: price sign` | Every research tick |
| Pre-market gaps | `source: gap, score: abs(gapPct)/10, direction: gap sign` | Every research tick |
| Range breaks | `source: range_break, score: proximity/2, direction: top/bottom` | Every research tick |

Fundamentals refresh on independent schedules, each keyed to data availability:

| Source | Data Written | Refresh |
|--------|-------------|---------|
| Yahoo Finance quote endpoint | P/E, market cap, EPS, beta, sector | Daily (free, no auth) |
| Yahoo Finance statistics page | Debt, cash, book value, margins | Weekly |
| SEC EDGAR 10-K / 10-Q parsing | Revenue, earnings, cash flow | Quarterly |
| Alpaca assets endpoint | Sector, industry classification | On first encounter |
| Alpaca historical bars | SMA crossovers, RSI, volatility | Daily after market close |

### Schedule — Runs on Its Own Clock

The research engine has **no dependency on market hours or the agent session**. It runs on a fixed timer from startup, separate from the trading event loop. The agent session is a consumer of the research DB, not the orchestrator of it.

```
Bot startup
  ├─ research engine (setInterval, runs immediately, forever)
  └─ market check
       ├─ [if open]  trading loop (agent session, perception, execution)
       └─ [if closed] sleep → retry
```

This means:
- **Off-hours matter.** Overnight EDGAR filings (drop 24/7), pre-market Yahoo movers (live from 4 AM ET), and Reddit sentiment (always running) all get captured while the market is closed. The agent wakes up to a full history.
- **The agent is optional.** If no trading session runs for a week (e.g., holiday), the research DB keeps accumulating. Nothing stalls or breaks.
- **Live API tools become fallbacks.** `discover_opportunities`, `fetch_edgar_filings`, `scan_reddit` still exist for real-time queries when the agent wants something fresher than the DB — but most cycles the data is already there.

Fundamentals refresh on their own schedules independent of both the research loop and the trading loop — a simple `if (shouldRefresh())` check in `src/index.ts` startup, not a scheduler daemon:

| Refresh | When |
|---------|------|
| Yahoo quote data | Every 24h after market close |
| Yahoo statistics | Every 7 days |
| Alpaca bar indicators (SMA, RSI, volume) | Daily after market close |
| EDGAR 10-K / 10-Q | Quarterly (date-driven) |

### Retention — Tiered Time Decay

The research DB keeps high-resolution raw events for shorter periods and pre-computed aggregates for longer horizons. This matches the strategies Scrooge runs — day trades need minute-level resolution, swing trades need daily aggregates, position trades need weekly patterns.

| Tier | Resolution | Retention | Storage |
|------|-----------|-----------|---------|
| **Raw events** (`signals` table) | Per-event | 14 days | ~100K events, 20MB |
| **Hourly buckets** (`signal_hourly` table) | Aggregated per hour per ticker per source | 90 days | ~30K rows |
| **Daily buckets** (`signal_daily` table) | Aggregated per day per ticker per source | 365 days | ~40K rows |

Pruning runs every 60 cycles (~30 min at 30s poll):
1. Raw events > 14 days old → folded into hourly bucket → `DELETE`
2. Hourly buckets > 90 days old → folded into daily bucket → `DELETE`
3. Daily buckets > 365 days old → `DELETE`

### Agent Tools

The agent accesses the research engine through two tools:

#### `search_signals`

```
search_signals({
  ticker?: string,              // Optional — one ticker or omit for market-wide
  sources?: string[],            // Filter to specific signal types
  min_score?: number,            // Minimum signal strength (0-1)
  since_minutes?: number,        // How far back to look (default: 1440 = 24h)
  granularity?: 'auto' | 'raw' | 'hourly' | 'daily',  // 'auto' selects based on since_minutes
  sort_by?: 'time' | 'score' | 'source_count',         // default: 'score'
  max_results?: number,          // default: 20
  fundamentals_filter?: string,  // Optional SQL WHERE clause on fundamentals table
  include_fundamentals?: boolean // Include fundamental snapshot for each result
})
```

Returns structured data with timeline of signals, cross-source clusters (tickers appearing in 2+ sources within a time window), and optional fundamentals overlay. The tool resolves `fundamentals_filter` against the schema and constructs the join internally — the agent just asks.

**Example agent queries the tool can answer:**
- "Show me tickers with 3+ different signal sources in the last 7 days."
- "What signals has $XYZ had over the past 30 days and which sources fired?"
- "Show me tickers with multi-source signal convergence AND P/E below sector median AND positive EPS growth."
- "Which tickers had EDGAR filings in the last 2 weeks, and did they also get Reddit heat?"
- "Give me the hourly signal density for $ABC over the last 14 days."

#### `describe_datasets`

```
describe_datasets({
  table?: string,   // Optional — describe one table, or omit for all tables
})
```

Returns the full schema of the research database — table names, column names, types, and a summary of what data is currently available (date range, row counts per source). The agent can call this at startup or anytime it wants to understand what data it can query.

This tool exists because the agent needs to **reason about its own data capabilities**. Without it, the agent has no way to know what's in the DB or what queries are possible.

### File Layout

```
data/
  state.json       -- Operational state (positions, trades, lessons, vector memory, activity stream)
  research.db      -- Analytical database (signals, fundamentals, corporate events, aggregates)
```

### What This Changes

| Before | After |
|--------|-------|
| In-memory ring buffer (8 cycles, ~4 min of memory) | Persistent DB with 365 days of tiered signal history |
| Each tool call queries a live API and discards result | Tools query the local research DB — instant, offline-capable |
| Agent has no memory of what signals a ticker had yesterday | Agent can ask "show me everything for $XYZ over 30 days" |
| Fundamentals don't exist | P/E, sector, cash, debt, EPS growth, RSI, SMA — all queryable |
| Cross-source pattern detection is impossible | One SQL join reveals how multiple data sources converged on a ticker over time |
| Each ingestion source is an island | Every source writes to the same signals table — correlations emerge naturally |

### What Doesn't Change

- The agent still decides everything — no hardcoded strategy routing, no deterministic trade triggers
- The event loop structure is identical
- All existing tools remain and continue to work
- The 3-phase learning system (calibration table, vector memory, lesson reflection) is untouched — it operates on trade outcomes, not signal correlation