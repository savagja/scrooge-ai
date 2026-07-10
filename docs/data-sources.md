# Data Sources

## Overview

The research engine discovers tickers autonomously — no static watchlist. Every data source feeds into a **self-reinforcing discovery loop**:

1. **Broad-market scanners** (Yahoo movers, Alpaca news, EDGAR high-impact filings) are unconditional — they screen the entire market every cycle
2. Any ticker they discover is added to the `tickers` table via `ensureTicker()`
3. The next cycle, that ticker gets picked up by **per-ticker scanners** (volume, gaps, range breaks, Reddit mentions)
4. Those scanners generate more signals, which reinforce the ticker's presence
5. Core seed tickers (SPY, QQQ, IWM, major large-caps) provide baseline coverage so we never go "blind"

| Layer | Sources | Scope | Watchlist Needed? |
|-------|---------|-------|-------------------|
| **Broad discovery** | Yahoo movers, Alpaca news, EDGAR high-impact | Entire market | No |
| **Per-ticker analysis** | Volume, gaps, range breaks, Reddit, technical indicators | Top ~100 tickers from DB | Dynamic (from DB) |
| **Fundamentals** | Asset metadata (name, sector) | Same dynamic set | Dynamic (from DB) |
| **Macro/sector** | Fed RSS, macro calendar, earnings | Market-wide | No |

## Data Flow

```
Every research tick (every 120s):

  ┌──────────────────────────────────────────────────────────┐
  │ BROAD DISCOVERY (unconditional — no ticker list needed)  │
  │  ├─ Yahoo Finance movers/gainers/losers/trending        │
  │  ├─ Alpaca news headlines (all tickers)                  │
  │  └─ SEC EDGAR 8-K filings (high-impact items only)       │
  │    → recordSignal() → ensureTicker() → ticker in DB     │
  └──────────────────────────────────────────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────┐
  │ BUILD DYNAMIC TICKER SET                                 │
  │  ├─ Core seeds (SPY, QQQ, IWM, AAPL, etc.)              │
  │  └─ Tickers with signals in last 7 days (from DB)        │
  └──────────────────────────────────────────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────┐
  │ PER-TICKER ANALYSIS (uses dynamic set)                    │
  │  ├─ Volume scanner (relative volume vs 20d avg)          │
  │  ├─ Pre-market gaps                                      │
  │  ├─ Range breaks (20-day highs/lows)                     │
  │  ├─ Reddit mention velocity                              │
  │  ├─ Technical indicators (RSI, EMA, MACD, Bollinger)     │
  │  └─ Corporate events (earnings, SEC filings)             │
  └──────────────────────────────────────────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────┐
  │ MACRO/SECTOR (unconditional)                              │
  │  ├─ Fed RSS press releases                               │
  │  ├─ Macro economic calendar (CPI, FOMC, NFP, PPI)        │
  │  └─ Earnings calendar from Alpaca news + EDGAR           │
  └──────────────────────────────────────────────────────────┘
```

## Key Architectural Principle: Tickener Registration

Every data source is responsible for adding its discovered tickers to the `tickers` table. This happens automatically because:

- `recordSignal()` calls `ensureTicker()` for every signal recorded
- `recordCorporateEvent()` calls `ensureTicker()` for every event
- The `tickers` table has `first_seen`/`last_seen` timestamps tracking when each ticker was first and most recently observed

This means a ticker is "in the system" from the moment any source reports it. No pre-defined list required.

## Per-Ticker Scanning

Per-ticker scanners (volume, gaps, range breaks, Reddit, technical indicators) use a **dynamic ticker set** rebuilt every cycle from:
1. Core seed tickers (SPY, QQQ, IWM, AAPL, MSFT, AMZN, GOOGL, META, NVDA, TSLA)
2. Tickers with signals in the last 7 days

This means:
- A ticker discovered by Yahoo movers today gets volume-scanned tomorrow
- A ticker that stops generating signals eventually drops off the scan list
- Core seeds ensure we always have market coverage

## Individual Sources

| Source | What | How | Scope |
|--------|------|-----|-------|
| **Yahoo Finance** | VIX, SPY change, gainers/losers/trending/most-active across entire market | `query1.finance.yahoo.com` screener API | Entire US equities |
| **Alpaca News API** | Top headlines across all tickers Alpaca covers | `v1beta1/news` REST endpoint | All tickers in Alpaca coverage |
| **SEC EDGAR RSS** | 8-K corporate filings with material event items (1.01, 2.02, 5.02, 7.01, 8.01, 2.01) | `sec.gov/cgi-bin/browse-edgar` Atom feed | Any filing with high-impact items |
| **Reddit** | Mention velocity from r/wallstreetbets, r/stocks, r/wallstreetbetselite | `old.reddit.com` JSON + RSS fallback | Dynamic ticker set only |
| **Alpaca Data API** | Historical bars (20-day avg volume), latest quotes/trades | `v2/stocks/{symbol}/bars`, `/quotes/latest`, `/trades/latest` | Dynamic ticker set only |
| **Technical Indicator Scanner** | Computes RSI(14), EMA(8/21/50), SMA(20/50/200), MACD(12,26,9), ATR(14), Bollinger Bands (20,2), and candle streak detection from daily bars | Derived from Alpaca daily bars via `src/analysis/technicals.ts` | Dynamic ticker set only (via research engine) |
| **Fed RSS** | Federal Reserve press releases (rate decisions, monetary policy, stress tests) | `federalreserve.gov/feeds/press_all.xml` | Market-wide |
| **Macro Calendar** | Hardcoded expected dates for CPI, FOMC, NFP, PPI (updated quarterly) | Hardcoded in `macro.ts` | Market-wide |

## Database

| Table | Purpose | Retention |
|-------|---------|-----------|
| `tickers` | All tickers ever seen, with `first_seen`/`last_seen` | Permanent |
| `signals` | Raw signal events from all sources | 14 days → rolled into hourly/daily |
| `signal_hourly` | Hourly aggregates (counts, avg/max score, bullish/bearish) | 90 days |
| `signal_daily` | Daily aggregates (counts, score, source count) | 365 days |
| `fundamentals` | Asset metadata (name, sector) refreshed daily | Replaced on refresh |
| `technical_indicators` | Per-ticker technical indicators (RSI, EMA, SMA, MACD, ATR, Bollinger Bands, streak counts) computed from daily bars every research tick | Replaced per-symbol on each calculation |
| `corporate_events` | Earnings reports, SEC filings | Permanent |
| `sector_signals` | Sector-level and macro signals | 90 days |
| `macro_events` | Macroeconomic calendar events | 30 days forward |

## Health Monitoring

Every data source has a health tracker (in-memory) that records success/failure counts. After 20 consecutive failures, a source is temporarily disabled. It auto-recovers after 100 cycles.

```typescript
getResearchHealth() → {
  yahoo_mover: { successes: 1420, failures: 3, consecutiveFailures: 0, enabled: true, ok: true },
  edgar: { successes: 10, failures: 22, consecutiveFailures: 22, enabled: false, ok: false },
  ...
}
```

Health is logged every 10 research cycles and exposed via the Flask API.