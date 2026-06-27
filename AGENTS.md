# Scrooge — The AI-Native Portfolio Manager

## 🎯 What Is This?

Scrooge is an **autonomous, AI-native portfolio manager** that uses an LLM (via pi.dev SDK + OpenRouter) as its executive function — the agent *decides* what to do, not a hardcoded algorithm. It trades equities through **Alpaca** (cash account, fractional shares, paper-first), discovers tickers dynamically across the entire market, and implements a **3-phase learning system** to improve over time.

**Philosophy:** The LLM is the portfolio manager with tool access; risk guardrails are deterministic underneath. No fixed strategy routing — the agent picks the right tool for the market context.

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

## 🔧 Key Risk Architecture

| Guardrail | Value | Behavior |
|-----------|-------|----------|
| Max position | 30% of account | `max_position_pct: 0.30` |
| Hard stop loss | −3% from entry | `stop_loss_pct: 0.03` |
| Trailing stop | −5% from peak | `trailing_stop_pct: 0.05` |
| Green threshold | +1% | Promotes to trailing stop mode, cancels time stop |
| Initial hold | 30 min | Time stop: if not profitable by then, exit |
| Daily loss halt | −15% of $100 | `max_daily_loss_pct: 0.15` |
| Consecutive losses | 4 | `consecutive_losses_halt: 4` |
| Cooldown | 3 min | Per-ticker trade cooldown |

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

## 📡 Data Sources (All Free)

| Source | What | How |
|--------|------|-----|
| **Alpaca** | Account, orders, positions, market clock, news, fractional eligibility | REST API |
| **Yahoo Finance** | VIX, SPY change, price, movers, gainers/losers | HTML scrape |
| **SEC EDGAR RSS** | 8-K corporate filings | RSS feed |
| **Reddit** | Mention velocity (r/wallstreetbets, r/stocks) | Undocumented JSON API |