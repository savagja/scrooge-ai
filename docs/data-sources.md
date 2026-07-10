# Data Sources

| Source | What | How |
|--------|------|-----|
| **Alpaca** | Account, orders, positions, market clock, news, fractional eligibility | REST API |
| **Yahoo Finance** | VIX, SPY change, price, movers, gainers/losers | HTML scrape |
| **SEC EDGAR RSS** | 8-K corporate filings | RSS feed |
| **Reddit** | Mention velocity (r/wallstreetbets, r/stocks) | Undocumented JSON API |

# Research Engine

The research engine (SQLite at `data/research.db`) runs 24/7, accumulating signals from all sources. Both the strategist and trader read from it. Only the strategist writes strategies based on it.

- 4 tables: tickers, signals, fundamentals, corporate_events
- Tiered time decay (raw → hourly → daily)
- Independent timer, no dependency on market hours or agent state
- `search_signals`, `search_sector_signals`, `get_macro_calendar`, `describe_datasets` tools