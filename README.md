# Scrooge — AI-Native Portfolio Manager

An autonomous trading agent built on **pi.dev SDK** + **OpenRouter**.

## Quick Start

```bash
cd scrooge
npm install

# 1. Set up secrets (one-time)
cp .env.example .env
# Edit .env with your API keys

# 2. Tune configuration (optional)
# Edit config.yaml — adjust risk, strategy, watchlist

# 3. Run
DRY_RUN=true npm run dev   # Test mode (recommended first)
ALPACA_PAPER=true npm run dev  # Paper trading
```

## File Structure

```
scrooge/
├── .env.example          # Secrets template (API keys, credentials)
├── .env                  # Your actual secrets (NEVER COMMIT)
├── config.yaml           # Trading parameters (tune freely)
├── src/
│   ├── config.ts         # Reads config.yaml + env overrides
│   ├── brain/            # Agent personality + tools
│   ├── ingestion/        # Free data sources (Alpaca, EDGAR, Yahoo, Reddit)
│   ├── execution/        # Alpaca order execution
│   ├── risk/             # Risk guardrails
│   └── state/            # Portfolio persistence
└── data/                 # Runtime state (auto-created)
```

## Secrets vs Configuration

| File | Purpose | Example |
|------|---------|---------|
| **`.env`** | API keys, credentials | `ALPACA_API_KEY`, `OPENROUTER_API_KEY` |
| **`config.yaml`** | Trading parameters | position size, stop loss, hold time, watchlist |

**Rule**: Put secrets in `.env`. Put tunable parameters in `config.yaml`.
