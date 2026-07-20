<h1 align="center">Scrooge — AI-Native Portfolio Manager</h1>

<p align="center">
  <strong>An autonomous trading agent that thinks, learns, and executes — powered by LLMs.</strong>
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-how-it-works">How It Works</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-documentation">Docs</a>
</p>

---

## 🧠 What Is Scrooge?

Scrooge is an **AI-native portfolio manager** that uses a large language model (via the [pi.dev SDK](https://pi.dev) + OpenRouter) as its executive function — the agent *decides* what to do, not a hardcoded algorithm.

Unlike traditional trading bots with fixed rules, Scrooge:

- **Thinks for itself** — The LLM is the portfolio manager with tool access. It analyzes market data, forms hypotheses, and executes trades based on reasoning.
- **Learns over time** — A 3-phase learning system tracks what works (and what doesn't), building a calibration table, vector memory, and retrospective analysis.
- **Discovers opportunities dynamically** — No static watchlist. Scrooge scans the entire market via Yahoo Finance, SEC EDGAR filings, Reddit sentiment, and Alpaca news.
- **Runs 24/7** — A continuous research engine ingests signals around the clock, so the agents wake up ready to trade.

> **Philosophy:** The LLM is the portfolio manager. Risk guardrails are deterministic underneath. No fixed strategy routing — Scrooge picks the right tool for the market context.

---

## ✨ Features

| | |
|---|---|
| **🤖 Two-Agent Architecture** | A **Strategist** researches and forms hypotheses; a **Trader** executes — focused context means better decisions. |
| **📡 5 Data Sources** | Yahoo Finance, SEC EDGAR RSS, Reddit, Alpaca news, and volume/range-break scanners. All ingested 24/7. |
| **🧪 3-Phase Learning** | Calibration table (win-rate by strategy×regime), vector memory (cosine similarity for past trades), and dual retrospective (separate trader + strategist analyses). |
| **🛡️ Deterministic Risk Guardrails** | Hard stop loss (−3%), trailing stop (−5% from peak), time stop (30 min), squeeze protection (+5% intraday). |
| **📊 Flask Dashboard API** | REST API for positions, trades, equity curve, activity stream — ready for your dashboard. |
| **💵 Alpaca Integration** | Fractional shares, cash account, paper trading first. |
| **🔌 Built on pi.dev SDK** | Extensible agent framework with JSON Schema tools, multi-provider LLM support. |

---

## 🏗️ How It Works

```
                        ┌──────────────────────────────┐
                        │   Research Engine (24/7)     │
                        │  Ingests: yahoo, edgar,     │
                        │  reddit, alpaca news,       │
                        │  volume, gaps, range breaks │
                        └──────────┬──────────────────┘
                                   │ writes signals 24/7
                                   ▼
┌─────────────────────────────────────────────────────┐
│                    Strategist                         │
│  Researches → Forms hypotheses → Writes strategies   │
│  Tools: Research only — no execution                 │
│  Output: strategies.db + strategist-report.md         │
└──────────────────────────┬──────────────────────────┘
                           │ writes strategies
                           ▼
┌─────────────────────────────────────────────────────┐
│                    Trader                             │
│  Reads strategist analysis → Makes enter/exit        │
│  decisions                                          │
│  Tools: Execution + position management ONLY         │
│  Input: strategies.db + state.json                   │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────┐
│  Portfolio State (state.json)       │
│  — positions, trades, snapshots     │
│  — calibration table, vector memory │
│  — lessons, activity stream         │
└─────────────────────────────────────┘
```

### The Two Agents

| Agent | Role | Tools |
|-------|------|-------|
| **Strategist** | Anticipatory researcher — forms hypotheses, tracks a 6-state lifecycle (anticipated → developing → realized → active → failed → stale) | Research only (no trading) |
| **Trader** | Execution specialist — manages positions, reads strategist analysis, decides enter/exit | Execution + position management only (no research) |

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [Alpaca](https://alpaca.markets/) account (free paper trading)
- [OpenRouter](https://openrouter.ai/) API key (cheap LLM models)

### Setup

```bash
# Clone & install
git clone https://github.com/yourusername/scrooge.git
cd scrooge
npm install

# Set up secrets (one-time)
cp .env.example .env
# Edit .env with your Alpaca and OpenRouter API keys

# Configure (optional)
# Edit config.yaml — adjust risk, strategy, polling intervals
```

### Run

```bash
# Dry run (no real trading — recommended first!)
DRY_RUN=true npm run dev

# Paper trading (once dry run looks good)
ALPACA_PAPER=true npm run dev

# Production (real Alpaca account — caution!)
npm run dev
```

Scrooge comes with sensible defaults:
- **$100 initial capital** (configurable in `config.yaml`)
- **Alpaca paper trading** (set `ALPACA_PAPER=true` in `.env`)
- **Cheap LLM model** (default: `deepseek/deepseek-v4-flash` — ~$0.02/session)

---

## 📖 Documentation

| Document | What It Covers |
|----------|----------------|
| [`docs/architecture.md`](docs/architecture.md) | System diagram, file map, key design decisions |
| [`docs/strategist.md`](docs/strategist.md) | Strategist philosophy, tools, prompt design |
| [`docs/trader.md`](docs/trader.md) | Trader philosophy, tools, prompt design |
| [`docs/execution-flow.md`](docs/execution-flow.md) | Pre-market, trading session, market close flows |
| [`docs/strategy-schema.md`](docs/strategy-schema.md) | SQLite strategy database schema |
| [`docs/learning-system.md`](docs/learning-system.md) | 3-phase learning: calibration, vector memory, retrospective |
| [`docs/risk-architecture.md`](docs/risk-architecture.md) | Guardrails: stop loss, trailing stop, time stop, squeeze |
| [`docs/data-sources.md`](docs/data-sources.md) | Yahoo, EDGAR, Reddit, Alpaca news ingestion details |
| [`docs/context-specs.md`](docs/context-specs.md) | Position context and ticker context format specs |
| [`API.md`](API.md) | Flask REST API contract for the dashboard |

---

## 📁 Project Structure

```
scrooge/
├── src/
│   ├── brain/              # Agent personality + tools
│   │   ├── agent.ts         # Core LLM agent (pi.dev SDK)
│   │   ├── strategist-*     # Strategist agent + prompts + tools
│   │   ├── trader-*         # Trader agent + prompts + tools
│   │   └── tools.ts         # Shared tool definitions
│   ├── ingestion/           # Data ingestion (Yahoo, EDGAR, Reddit, etc.)
│   ├── research/            # Research engine (24/7 signal accumulation)
│   ├── execution/           # Alpaca order execution
│   ├── risk/                # Risk guardrails
│   ├── state/               # Portfolio + strategy persistence
│   ├── context/             # Context builders for the agent
│   └── analysis/            # Technical analysis
├── api/                     # Flask dashboard backend
├── docs/                    # Full documentation
├── strategist.ts            # Strategist entry point
├── trader.ts                # Trader entry point
├── config.yaml              # Trading parameters (tune freely)
├── .env.example             # API key template
└── AGENTS.md                # Full agent architecture reference
```

---

## 🔧 Configuration

| File | Purpose |
|------|---------|
| **`.env`** | API keys, credentials (never commit) |
| **`config.yaml`** | Trading parameters — position size, stop loss, polling, watchlist |

**Rule:** Secrets in `.env`. Tunable parameters in `config.yaml`.

### Key config options

```yaml
# In config.yaml:
initial_capital: 100
poll_interval_ms: 240000       # Trader cycle (4 min)
strategist.cycle_interval_ms: 720000  # Strategist cycle (12 min)
risk.stop_loss_pct: 0.03       # -3% hard stop
risk.trailing_stop_pct: 0.05   # -5% trailing stop from peak
```

---

## 🛡️ Risk Architecture

Scrooge enforces deterministic guardrails that the agent cannot override:

| Guardrail | Value | Trigger |
|-----------|-------|---------|
| Hard stop loss | −3% | Exit immediately at 3% loss from entry |
| Trailing stop | −5% from peak | Locks in gains as price rises |
| Green threshold | +1% | Activates trailing stop, cancels time stop |
| Time stop | 30 min | Exit if position hasn't proven itself |
| Squeeze protection | +5% intraday | Exit shorts if price spikes |

---

## 📊 Dashboard API

Scrooge ships with a Flask API for real-time monitoring:

```bash
# Start the API
cd api && pip install -r requirements.txt && python app.py

# Then query
curl http://localhost:5000/api/overview        # Account summary
curl http://localhost:5000/api/positions       # Open positions
curl http://localhost:5000/api/trades          # Trade history
curl http://localhost:5000/api/equity-curve    # Performance chart data
curl http://localhost:5000/api/activity-stream # Event log
```

See [`API.md`](API.md) for the full API contract.

---

## 🧪 Learning System

Scrooge learns from every trade through a 3-phase system:

1. **Calibration Table** — Tracks win-rate by strategy type × market regime (trending, choppy, volatile)
2. **Vector Memory** — Stores 7-dimensional feature vectors for similarity search across past trades
3. **Dual Retrospective** — Separate analyses for the **Strategist** (hypothesis quality) and **Trader** (execution quality)

Results are persisted in `state.json` and strategies are updated in `data/strategies.db`.

---

## 🏁 Running on a Raspberry Pi

Scrooge is designed to run 24/7 on a low-power device. See [`docs/deployment.md`](docs/deployment.md) for:

- Systemd service setup (strategist + trader + API)
- Automated deploy scripts
- Log management
- Production monitoring

---

## 🤝 Contributing

Scrooge is an experimental project. Contributions, ideas, and experiments are welcome!

- **Open an issue** for bugs, questions, or feature ideas
- **Submit a PR** for improvements
- **Try different LLM models** — swap `OPENROUTER_MODEL` in `.env`
- **Add a data source** — extend the research engine in `src/ingestion/`

---

## 📜 License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>Scrooge is experimental software.</strong><br />
  Always start with paper trading. Never deploy with real capital you can't afford to lose.<br />
  The LLM makes mistakes. Risk guardrails help, but they are not guarantees.
</p>
