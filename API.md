# Scrooge Dashboard API Contract

This document describes the REST API served by the Scrooge Flask backend, designed for dashboard visualizations. The API reads directly from the bot's `state.json` file and requires no authentication (internal network only).

**Base URL:** `http://192.168.50.42:5000/api/`

**Data source:** `/home/admin/scrooge/data/state.json` (overridable via `SCROOGE_STATE` env var)

**CORS:** Enabled for all origins.

---

## `GET /api/overview`

High-level account summary — ideal for a top-bar widget.

### Response

```json
{
  "cash": 100000.0,
  "settledCash": 100000.0,
  "totalEquity": 100000.0,
  "dailyPnL": 0.0,
  "positionsCount": 0,
  "pendingBuys": 0.0,
  "halted": false,
  "haltReason": null
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `cash` | number | Total cash (including unsettled) |
| `settledCash` | number | Cash available to trade (T+1 settled) |
| `totalEquity` | number | Cash + open position notional + unrealized P&L |
| `dailyPnL` | number | Realized P&L for today |
| `positionsCount` | int | Number of open positions |
| `pendingBuys` | number | Unsettled cash (cash - settledCash) |
| `halted` | bool | Whether trading is halted |
| `haltReason` | string\|null | Reason for halt, if halted |

---

## `GET /api/daily-volume?date=YYYY-MM-DD`

Trade volume statistics for a specific day. Useful for a volume indicator widget.

### Query Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `date` | today (UTC) | Date in `YYYY-MM-DD` format |

### Response

```json
{
  "date": "2026-06-16",
  "tradeCount": 0,
  "totalVolume": 0.0,
  "wins": 0,
  "losses": 0,
  "netPnL": 0.0
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `date` | string | Requested date |
| `tradeCount` | int | Number of trades closed on this date |
| `totalVolume` | number | Sum of absolute P&L values of all closed trades |
| `wins` | int | Count of profitable trades |
| `losses` | int | Count of unprofitable trades |
| `netPnL` | number | Sum of all P&L (positive = green day) |

---

## `GET /api/daily-range?date=YYYY-MM-DD`

Daily equity price range — high, low, open, close. Designed for a range-slider widget.

### Query Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `date` | today (UTC) | Date in `YYYY-MM-DD` format |

### Response

```json
{
  "date": "2026-06-16",
  "high": 100000.0,
  "low": 100000.0,
  "current": 100000.0,
  "open": 100000.0,
  "samples": 566
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `date` | string | Requested date |
| `high` | number | Highest totalEquity of the day (from snapshots) |
| `low` | number | Lowest totalEquity of the day |
| `current` | number | Most recent totalEquity |
| `open` | number | First totalEquity of the day |
| `samples` | int | Number of portfolio snapshots taken today |

**Note:** If no snapshots exist for the requested date, all equity values fall back to `state.cash`.

---

## `GET /api/equity-curve?days=30`

Rolling equity curve — one data point per day. Down-sampled to daily close from intraday snapshots. Designed for a line chart.

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `days` | int | 30 | Number of trailing days to return |

### Response

```json
{
  "points": [
    {
      "date": "2026-06-10",
      "close": 100010.50,
      "high": 100025.00,
      "low": 99990.00
    },
    {
      "date": "2026-06-11",
      "close": 100000.00,
      "high": 100000.00,
      "low": 99980.00
    }
  ]
}
```

### Fields (per point)

| Field | Type | Description |
|-------|------|-------------|
| `date` | string | Trading day (`YYYY-MM-DD`) |
| `close` | number | Last portfolio snapshot's totalEquity for that day |
| `high` | number | Highest totalEquity that day |
| `low` | number | Lowest totalEquity that day |

**Note:** In a new bot with no trading history, all points show the initial capital since equity hasn't moved.

---

## `GET /api/positions`

Current open positions with full detail including unrealized P&L and status.

### Response

```json
{
  "positions": [
    {
      "symbol": "AAPL",
      "qty": 0.543210,
      "entryPrice": 185.20,
      "entryTime": "2026-06-16T14:30:00.000Z",
      "holdUntil": "2026-06-16T15:00:00.000Z",
      "notional": 100.50,
      "unrealizedPnL": 2.30,
      "strategy": "news_momentum",
      "trailingStopPrice": 187.45,
      "highestPrice": 189.00,
      "status": "trailing",
      "entryVix": 16.12,
      "entrySpyChange": 0.35,
      "entryRegime": "trending_up",
      "entrySignalConfidence": 0.78,
      "entrySignalImpactScore": 7.5,
      "entrySignalSource": "news_momentum"
    }
  ]
}
```

### Position Fields

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | Ticker symbol |
| `qty` | number | Shares held (may be fractional) |
| `entryPrice` | number | Price at entry |
| `entryTime` | string | ISO timestamp of entry |
| `holdUntil` | string | Time stop deadline (ISO) |
| `notional` | number | Dollar value at entry |
| `unrealizedPnL` | number | Current unrealized P&L |
| `strategy` | string | Strategy used (news_momentum, mean_reversion, edgar, etc.) |
| `trailingStopPrice` | number\|null | Active trailing stop price |
| `highestPrice` | number | Highest price since entry |
| `status` | string | `"initial"` \| `"green"` \| `"trailing"` |
| `entryVix` | number\|null | VIX at time of entry |
| `entrySpyChange` | number\|null | SPY % change at entry |
| `entryRegime` | string | Market regime at entry |
| `entrySignalConfidence` | number | LLM confidence (0–1) |
| `entrySignalImpactScore` | number | LLM impact score (−10 to 10) |
| `entrySignalSource` | string | Signal origin |

---

## `GET /api/trades?limit=20`

Recent trade history, newest first.

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 20 | Max trades to return |

### Response

```json
{
  "trades": [
    {
      "id": "AAPL-1718551800000",
      "timestamp": "2026-06-16T14:30:00.000Z",
      "symbol": "AAPL",
      "strategy": "news_momentum",
      "direction": "long",
      "entryPrice": 185.20,
      "exitPrice": 189.50,
      "qty": 0.543210,
      "notional": 100.50,
      "pnl": 2.34,
      "pnlPct": 2.33,
      "exitReason": "trailing_stop",
      "holdMinutesActual": 45.3,
      "wasPromoted": true,
      "timeToGreen": 12.0,
      "vixAtEntry": 16.12,
      "spyChangeAtEntry": 0.35,
      "marketRegimeAtEntry": "trending_up",
      "signalSource": "news_momentum",
      "signalConfidence": 0.78,
      "signalImpactScore": 7.5,
      "agentReasoning": "Strong positive news catalyst with increasing volume...",
      "featureVector": [0.32, 0.78, 0.75, 1.0, 1, 0, 0]
    }
  ]
}
```

### Trade Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique trade ID (`{symbol}-{timestamp}`) |
| `timestamp` | string | Exit timestamp (ISO) |
| `symbol` | string | Ticker |
| `strategy` | string | Strategy used |
| `direction` | string | `"long"` only (cash account) |
| `entryPrice` | number | Entry price |
| `exitPrice` | number | Exit price |
| `qty` | number | Shares traded |
| `notional` | number | Dollar value at entry |
| `pnl` | number | Realized P&L ($) |
| `pnlPct` | number | Realized P&L (%) |
| `exitReason` | string | Why exited: `"time_stop"`, `"trailing_stop"`, `"stop_loss"`, `"manual"`, `"emergency"` |
| `holdMinutesActual` | number | Actual hold time in minutes |
| `wasPromoted` | boolean | Did it hit green (+1%) and enter trailing mode? |
| `timeToGreen` | number\|null | Minutes to reach +1% (null if never) |
| `vixAtEntry` | number\|null | VIX at entry |
| `spyChangeAtEntry` | number\|null | SPY % change at entry |
| `marketRegimeAtEntry` | string | Regime at entry |
| `signalSource` | string | Origin of the signal |
| `signalConfidence` | number | LLM confidence (0–1) |
| `signalImpactScore` | number | LLM impact score (−10 to 10) |
| `agentReasoning` | string | LLM's reasoning for entering |
| `featureVector` | number[] | 7-dim normalized vector [vix, confidence, impact, size, trending, chop, volatile] |

---

## `GET /api/health`

Simple health check.

### Response

```json
{
  "status": "ok",
  "stateFile": "/home/admin/scrooge/data/state.json",
  "exists": true
}
```

---

## Error Responses

All endpoints return an error object with a 4xx or 5xx status code if something goes wrong:

```json
{
  "error": "state.json not found at /home/admin/scrooge/data/state.json"
}
```

---

## Server Details

| Property | Value |
|----------|-------|
| Host | `192.168.50.42` (Raspberry Pi) |
| Port | `5000` |
| Protocol | HTTP (internal network only) |
| Server | Gunicorn (WSGI) |
| Framework | Flask 3.x |
| Process management | systemd (`scrooge-api.service`, auto-restart) |
| State file | `/home/admin/scrooge/data/state.json` |
| Logs | `/home/admin/scrooge/logs/api.log` (access), `api-error.log` (errors) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCROOGE_STATE` | `/home/admin/scrooge/data/state.json` | Path to state file |
| `SCROOGE_API_PORT` | `5000` | Listening port |
| `SCROOGE_API_HOST` | `0.0.0.0` | Listening address |
| `SCROOGE_API_DEBUG` | `0` | Enable Flask debug mode |

---

## Example Usage (curl)

```bash
# Get overview
curl http://192.168.50.42:5000/api/overview

# Get today's volume
curl http://192.168.50.42:5000/api/daily-volume

# Get a specific day's range
curl "http://192.168.50.42:5000/api/daily-range?date=2026-06-16"

# Get 7-day equity curve
curl "http://192.168.50.42:5000/api/equity-curve?days=7"

# Get recent trades
curl "http://192.168.50.42:5000/api/trades?limit=10"

# Health check
curl http://192.168.50.42:5000/api/health
```