# Strategist

## Philosophy

The strategist is an **anticipatory researcher**, not a trader. It forms hypotheses about what might happen and tracks them through a lifecycle of 6 states. It creates strategies based on signal density from the research DB — it does NOT invent things on quiet days.

**No hard cap on strategies.** If 50 tickers have signal activity, the strategist creates 50 strategies. The trader only sees the top 10. Low-confidence or stale strategies auto-prune.

After each session (pre-market and mid-session), the strategist writes a structured markdown report to `data/strategist-report.md` containing:
- Market summary (VIX, SPY, regime)
- Strategy overview (state distribution counts)
- Top strategies with explanations of ranking
- The strategist's raw LLM output as commentary

The trader reads this report on every cycle to understand the narrative context behind the ranked strategies.

## Strategy Lifecycle

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

## Strategist Tools

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
| `query_technical_indicators` | Screen all tickers by RSI, Bollinger bands, EMA alignment, candle streaks, SMA position |
| `get_single_ticker_technicals` | Full technical indicator breakdown for a single ticker |
| `consult_memory` | **Read-only** — check past trade outcomes for similar setups |
| `consult_strategist_lessons` | **Strategist's own lessons** — signal quality, strategy×regime fit, catalyst assessment patterns. Updated daily by the strategist retrospective. Call at session start. |
| `list_strategies` | **List existing strategies** — filter by ticker, state, or type. Use BEFORE creating new strategies to check for duplicates and manage lifecycle. |
| `create_strategy` | Store a new strategy with thesis, confidence, state |
| `update_strategy` | Update state, confidence, rationale of existing strategy |
| `archive_strategy` | Mark a strategy as stale/failed and stop tracking |

## Strategist Prompt Philosophy

```
You are Scrooge's strategist — you form hypotheses, you do NOT trade.

Your job:
1. Query the research DB and live APIs to find tickers with signal activity
2. For each cluster of signals, decide if a strategy thesis exists
3. Classify each strategy into a lifecycle state — anticipated → developing → realized/active/failed/stale
4. Assign a confidence score (0.0–1.0) based on signal strength, cross-source convergence, and market regime
5. List what would confirm or invalidate your thesis
6. When a strategy reaches 'developing', increase its priority
7. Prune stale strategies (no updates in 48h) — they clutter the DB

Better to create 50 low-confidence "watching" strategies than miss the one that develops.
The trader only sees the top 10 by confidence × freshness.

After each session, the system generates a structured markdown report and writes
it to data/strategist-report.md. The report includes the market summary, strategy
overview, top strategies with explanations, and your session output as commentary.
This report is injected into the trader's prompt on every cycle.
```