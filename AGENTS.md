# Scrooge — The AI-Native Portfolio Manager

## 🎯 What Is This?

Scrooge is an **autonomous, AI-native portfolio manager** that uses an LLM (via pi.dev SDK + OpenRouter) as its executive function — the agent *decides* what to do, not a hardcoded algorithm. It trades equities through **Alpaca** (cash account, fractional shares, paper-first), discovers tickers dynamically across the entire market, and implements a **3-phase learning system** to improve over time.

**Philosophy:** The LLM is the portfolio manager with tool access; risk guardrails are deterministic underneath. No fixed strategy routing — the agent picks the right tool for the market context. All analysis tools return **data only** — the agent does all reasoning, direction assessment, and execution decisions.

---

## 📚 Documentation Index

| Document | What It Covers |
|----------|----------------|
| [`docs/architecture.md`](docs/architecture.md) | System diagram, key design decisions, file map, data paths |
| [`docs/strategist.md`](docs/strategist.md) | Strategist philosophy, strategy lifecycle, tools, prompt philosophy |
| [`docs/trader.md`](docs/trader.md) | Trader philosophy, tools, prompt philosophy |
| [`docs/execution-flow.md`](docs/execution-flow.md) | Pre-market, trading session, and market close flows |
| [`docs/strategy-schema.md`](docs/strategy-schema.md) | SQLite database schema for `data/strategies.db` |
| [`docs/learning-system.md`](docs/learning-system.md) | 3-phase learning: calibration table, vector memory, retrospective |
| [`docs/risk-architecture.md`](docs/risk-architecture.md) | Guardrails: stop loss, trailing stop, time stop, squeeze protection |
| [`docs/deployment.md`](docs/deployment.md) | Deployment, data source convention, SSH/API quick refs |
| [`docs/context-specs.md`](docs/context-specs.md) | Position context and ticker context format specs |
| [`docs/data-sources.md`](docs/data-sources.md) | Data sources and research engine details |

---

## 🧠 Architecture at a Glance

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
│  Output: data/strategies.db + data/strategist-report.md │
└──────────────────────────┬─────────────────────────────────┘
                           │ writes strategies + report
                           ▼
┌────────────────────────────────────────────────────────────┐
│                    trader.ts                                │
│  Market open → close: Continuous event loop               │
│                                                            │
│  Each cycle:                                                │
│    1. Read current positions + linked strategies           │
│    2. Read strategist report (strategist-report.md)        │
│    3. Read top 10 non-position strategies from strategist  │
│    4. Agent session: perception → execution               │
│    5. Reconcile positions, update state.json              │
│                                                            │
│  Agent: Makes enter/exit decisions                         │
│  Tools: Execution + position management ONLY              │
│         (no research tools, no strategy-fetching tools)    │
│  Input: strategies.db + state.json + strategist-report.md │
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

See [`docs/architecture.md`](docs/architecture.md) for the full file map, key design decisions, and data paths.

---

## 🧪 The Two Agents

### [Strategist](docs/strategist.md) — The Researcher

The strategist is an **anticipatory researcher** that forms hypotheses and tracks them through a lifecycle:

| State | Meaning |
|-------|---------|
| `anticipated` | First sighting, low confidence |
| `developing` | Thesis forming, 2+ signals converging |
| `realized` | Trader executed a position based on this strategy |
| `active` | Position is open and thesis is still valid |
| `failed` | Thesis invalidated |
| `stale` | No updates in 48h, auto-pruned |

**No hard cap on strategies.** The trader only sees the top 10 by confidence × freshness.

### [Trader](docs/trader.md) — The Execution Specialist

The trader receives pre-vetted strategies directly in its prompt (from `data/strategies.db`)
along with the strategist's narrative report (`data/strategist-report.md`). It has **execution
tools only** — no research tools, no strategy-fetching tools. It cannot look up tickers beyond
what's provided. Its job: manage positions, read the strategist's analysis, and execute or hold.

---

## 🔄 [Execution Flow](docs/execution-flow.md)

- **Pre-market (T-30 min):** Strategist sweeps research DB, forms initial strategy slate, writes report
- **Trading session (open → close):** Trader runs event loop every ~2 min; strategist re-runs every 6th cycle
- **Each trader cycle:** Positions first → read strategist report → cross-reference with structured strategies → execute or hold
- **Market close:** Daily retrospective, final state save, strategist wrap-up

---

## 🗃️ [Strategy Schema](docs/strategy-schema.md)

The bridge between strategist and trader is `data/strategies.db` — a SQLite database with a `strategies` table linking each position to its originating thesis, lifecycle state, confidence, and outcome.

---

## 🧪 [Learning System](docs/learning-system.md)

3-phase system with **dual retrospective** — separate analyses for trader and strategist:
1. Rich trade context with strategy IDs
2. Calibration table (win-rate by strategy×regime)
3. Vector memory (cosine similarity search for past trades)
4. **Trader retrospective** — execution quality, trader-targeted lessons in state.json
5. **Strategist retrospective** — hypothesis quality, strategist-targeted lessons in strategies.db

---

## 🔧 [Risk Architecture](docs/risk-architecture.md)

| Guardrail | Value |
|-----------|-------|
| Hard stop loss | −3% from entry |
| Trailing stop | −5% from peak |
| Green threshold | +1% |
| Time stop | 30 min |
| Short squeeze protection | +5% intraday |

---

## 🚀 [Deployment](docs/deployment.md)

**Target:** Any server (replace `<host-ip>` with your server's IP)
- systemd services: `scrooge-trader`, `scrooge-strategist`, `scrooge-api`
- Flask API dashboard: `http://<host-ip>:5000/api/`
- Deploy via `git pull` — see [`docs/deployment.md`](docs/deployment.md)

**⚠️ The deployed server is the canonical data source.** Always pull production state from the deployed server, not from the local `data/` directory.

---

## 📋 [Context Specs](docs/context-specs.md)

Position context blocks include the linked strategy (thesis, catalyst, confidence at entry). Ticker context for candidate strategies uses the standard multi-timeframe price format.

---

## 📡 [Data Sources](docs/data-sources.md)

| Source | How |
|--------|-----|
| **Alpaca** | REST API |
| **Yahoo Finance** | HTML scrape |
| **SEC EDGAR RSS** | RSS feed |
| **Reddit** | Undocumented JSON API |

The research engine (`data/research.db`) runs 24/7, accumulating signals from all sources into 4 tables: tickers, signals, fundamentals, corporate_events.

---

## What Changed (from the old single-agent architecture)

| Before | After |
|--------|-------|
| Single agent does everything | Split: Strategist (research) + Trader (execution) |
| Research and execution compete for context | Each agent has focused context and tools |
| Agent reacts to current data only | Strategist anticipates, creates lifecycle-tracked strategies |
| No strategy persistence | `data/strategies.db` with 6-state lifecycle |
| No linkage between position and research | Each position has a strategy_id linking back to the strategist's thesis |
| Discovery/research tools in execution context | Strategist has research tools; Trader has execution tools only |
| No strategist-to-trader narrative flow | Strategist writes `data/strategist-report.md` per session; trader reads it every cycle |

### What Stays the Same

- The 3-phase learning system (calibration table, vector memory, lesson reflection)
- Risk architecture (hard stop, trailing stop, green threshold, time stop, squeeze protection)
- Event loop structure (but now runs in the trader process only)
- Research engine (24/7 independent signal accumulation)
- Flask API dashboard (now reads both state.json and strategies.db)
- Deployment target (systemd services)
- All existing data ingestion code (Yahoo, EDGAR, Reddit, Alpaca news, volume scanners)
- Position context spec format (now includes strategy linkage)
- Ticker context spec format (unchanged)