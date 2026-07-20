# Architecture Overview

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
│  Pre-market (T-30min): Full sweep → initial strategy slate→ report│
│  During market (every 6th trader cycle): Refine strategies → report│
│  Market close: Wrap-up summary                                    │
│                                                                   │
│  Agent: Forms hypotheses, does NOT trade                          │
│  Tools: Research only — no execution                              │
│  Output: data/strategies.db + data/strategist-report.md           │
└──────────────────────────┬─────────────────────────────────┘
                           │ writes strategies
                           ▼
┌────────────────────────────────────────────────────────────┐
│                    trader.ts                                │
│  Market open → close: Continuous event loop               │
│                                                            │
│  Each cycle:                                                │
│    1. Read current positions + linked strategies           │
│    2. Read strategist report (data/strategist-report.md)   │
│    3. Read top 10 non-position strategies from strategist  │
│    4. Agent session: perception → execution               │
│    5. Reconcile positions, update state.json              │
│                                                            │
│  Agent: Makes enter/exit decisions                         │
│  Tools: Execution + position management only              │
│         (no research tools, no strategy-fetching tools)    │
│  Input: strategies.db + state.json + strategist-report.md +│
│         research.db (pre-digested context only)            │
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

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Two separate processes** | Each agent has focused context, tools, and token budget. No competition between research and execution. |
| **Strategist runs ~6-10x per day** | Doesn't need 2-min resolution. Data doesn't change that fast. Every 6th trader cycle (~12-20 min) is plenty. |
| **Strategist starts T-30min pre-market** | Overnight research DB is full of signals. Strategist queries it and builds the initial strategy slate before market open. |
| **Strategist ends at market close** | No point forming strategies when the trader can't execute. Writes a wrap-up summary. |
| **No hard cap on strategy count** | Strategist creates strategies for any ticker where signal density supports a thesis. Could be 5 on a quiet day, 25+ on a high-signal day. Trader only sees top 10. |
| **Stale strategies auto-pruned** | 48h without update = archived. Low-confidence strategies that never develop get pruned after 24h. |

## File Map

### Source Code (`src/`)

| File | Purpose |
|------|---------|
| `src/config.ts` | Loads `config.yaml` + `.env` overrides. Single source of truth for all parameters. |
| `src/types.ts` | All TypeScript interfaces: `Position`, `TradeRecord`, `PortfolioSnapshot`, `StrategyCalibration`, `VectorMemoryEntry`, `PersistedState`, `Strategy`, etc. |
| | |
| **`src/brain/`** | **Agent personality and tools** |
| `agent.ts` | pi.dev SDK agent session setup base — shared by strategist and trader |
| `trader-agent.ts` | Trader-specific: registers execution-only tools (no research, no strategy fetching) |
| `strategist-agent.ts` | Strategist-specific: registers research-only tools |
| `tools.ts` | **All tool definitions** — both trader's execution tools and strategist's research tools in one file |
| `strategist-tools.ts` | Strategist-only tool set: research + strategy CRUD + technical indicators |
| | |
| **`src/analysis/`** | **Analysis and calculations** |
| `analysis.ts` | Market state classification (regime detection, breadth scoring). |
| `technicals.ts` | Technical indicator calculations (RSI, EMA, SMA, MACD, ATR, Bollinger Bands, streak detection). Pure functions, no side effects. |
| | |
| **`src/index.ts`** | **Trader event loop.** Market check → reconciliation → perception prompt (with strategist report injection) → agent session → execute → reconcile. Entry point for `trader.ts`. |
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
| `strategies.ts` | **Strategy store.** SQLite wrapper for `data/strategies.db`. Read/write strategies, lifecycle updates, pruning, top-K queries, strategist lesson storage. |
| |
| **`src/retrospective/`** | **Daily retrospective (cron/systemd-timer after market close)** |
| `retro-cli.ts` | Standalone CLI entry point |
| `retrospective.ts` | Orchestrator — runs what-if → trader retro → strategist retro |
| `analyzer.ts` | JSON extraction and shared utilities |
| `what-if.ts` | Strategy grading (1-5) with hypothetical P&L |
| `trader-retrospective.ts` | Trader retro — execution quality, trader lessons → state.json |
| `strategist-retrospective.ts` | Strategist retro — hypothesis quality, strategist lessons → strategies.db |
| | |
| **Entry scripts (root)** | |
| `strategist.ts` | CLI entry for the strategist: `tsx strategist.ts`. Includes strategist report generator (`generateStrategistReport()`) that writes to `data/strategist-report.md`. |
| `trader.ts` | CLI entry for the trader: `tsx trader.ts`. Imports and runs `src/index.ts`. |

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
| `deploy/deploy.py` | **Python deploy script** (ships code, installs deps, restarts services). |
| `deploy/deploy.sh` | Bash deploy script (alternative, uses rsync + ssh). |
| `deploy/CHECKLIST.md` | Step-by-step deployment checklist. |

## Data

| Path | Purpose |
|------|---------|
| `data/strategist-report.md` | **Strategist report** — Markdown report generated after each strategist session (pre-market + mid-session). Injected into the trader's perception prompt on every cycle. Provides narrative market summary, strategy overview, and ranking explanations. Auto-generated, **not committed to git.** |
| `data/state.json` | **Runtime state** — all trades, portfolio snapshots, calibration table, vector memory. Auto-created. **Not committed to git.** |
| `data/strategies.db` | **Strategy database** — SQLite. All strategies with lifecycle states. **Not committed to git.** |
| `data/research.db` | **Research database** — SQLite. Signals, fundamentals, corporate events. **Not committed to git.** |
| `logs/scrooge.log` | Bot log output. **Not committed to git.** |
| `logs/api.log` | API access log. **Not committed to git.** |