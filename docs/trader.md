# Trader

## Philosophy

The trader is an **execution-only specialist**. It receives:
- Current positions with their linked strategies (thesis, catalyst, confidence at entry)
- Top 10 non-position strategies from the strategist, ranked by confidence × conviction × freshness
- The strategist's latest markdown report with narrative context, market summary, and reasoning
- Full market context (VIX, SPY, regime, news, movers)

It decides **what to exit** (positions first) and **what to enter** using the strategist's pre-vetted candidates. It does NOT do research — the strategist provides all analysis and the trader has no research tools.

## Trader Tools

The trader has **no research tools** and **no strategy-fetching tools**. All candidate strategies are injected directly into every cycle's prompt. The strategist's report is read from `data/strategist-report.md` and injected as a briefing section.

| Tool | Purpose |
|------|---------|
| `check_portfolio` | View cash, P&L, open positions |
| `monitor_positions` | Check all open positions' exit conditions |
| `place_buy_order` | Enter a long position (risk guardrails validate) |
| `place_short_order` | Enter a short position (risk guardrails validate) |
| `place_sell_order` | Exit a position (covers both longs and shorts) |
| `close_position` | Evaluate whether a position's strategy still holds |
| `hold_cash` | Explicitly do nothing (forces reasoning) |
| `record_decision` | Log what was decided and why |
| `consult_memory` | Check **trader** lessons and similar past trades before deciding |
| `reflect_on_performance` | End-of-session retrospective |
| `emergency_close_all` | Emergency risk — shut everything down |
| `note_context` / `view_context` / `prune_context` | Persistent agent-curated context notes |
| `update_strategy_on_exit` | Report position outcome back to the strategist |

## Data Flow

```
Strategist writes to:
  ├─ data/strategies.db        ← lifecycle-tracked strategies
  └─ data/strategist-report.md ← narrative report (per session)

Trader reads on each cycle:
  ├─ data/strategies.db        ← via StrategyStore (top 10 + linked)
  ├─ data/strategist-report.md ← via readFileSync (injected into prompt)
  └─ data/state.json           ← portfolio state, memory, lessons
```

## Trader Prompt Flow

Each cycle's prompt follows this structure:

1. **Current positions** with full price context + linked strategy data (thesis, catalyst, what-if grade)
2. **Top candidate strategies** (up to 10) with metadata, what-if historical grades, and real-time price context
3. **Strategist's Briefing** — the full strategist report markdown, providing narrative context and reasoning
4. **Pre-digested market context** (VIX, SPY, news, movers, volume)
5. **Real market clock** from Alpaca
6. **Available tools** — only execution tools listed
7. **Restrictions** reminder: no research capability, no strategy fetching, must use only what's in the prompt