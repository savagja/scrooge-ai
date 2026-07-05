#!/usr/bin/env python3
"""
Scrooge Dashboard API — Flask backend.

Reads the bot's state.json and exposes REST endpoints for the dashboard UI.
Designed to run on the same Pi as the bot, or alongside it.
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.request import Request, urlopen

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ── path to state.json ──────────────────────────────────────────────────
STATE_PATH = Path(os.environ.get("SCROOGE_STATE", "/home/admin/scrooge/data/state.json"))

# ── Alpaca live API helpers ──────────────────────────────────────────────
ALPACA_BASE = "https://paper-api.alpaca.markets"


def _get_alpaca_headers():
    key = os.environ.get("ALPACA_API_KEY", "")
    secret = os.environ.get("ALPACA_SECRET_KEY", "")
    return {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
    } if key and secret else None


def _alpaca_get(path: str):
    """GET from Alpaca REST API, return parsed JSON or None."""
    headers = _get_alpaca_headers()
    if not headers:
        return None
    req = Request(f"{ALPACA_BASE}/v2{path}", headers=headers)
    try:
        with urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        return None


def _get_live_account():
    """Fetch current account from Alpaca. Returns dict with cash, equity, last_equity, or None."""
    data = _alpaca_get("/account")
    if not data:
        return None
    return {
        "cash": float(data.get("cash", 0)),
        "equity": float(data.get("equity", 0)),
        "portfolio_value": float(data.get("portfolio_value", 0)),
        "last_equity": float(data["last_equity"]) if data.get("last_equity") else None,
    }


def _get_live_positions():
    """Fetch current open positions from Alpaca. Returns list or None."""
    data = _alpaca_get("/positions")
    if data is None:
        return None
    return [{
        "symbol": p["symbol"],
        "qty": float(p["qty"]),
        "avgEntryPrice": float(p["avg_entry_price"]),
        "currentPrice": float(p["current_price"]),
        "marketValue": float(p["market_value"]),
        "unrealizedPnl": float(p["unrealized_pl"]),
        "unrealizedPnlPct": float(p["unrealized_plpc"]),
        "costBasis": float(p["cost_basis"]),
        "side": p["side"],
    } for p in data]


def load_state():
    """Load and return the full persisted state."""
    if not STATE_PATH.exists():
        return {"error": f"state.json not found at {STATE_PATH}"}, 404
    with open(STATE_PATH) as f:
        return json.load(f)


def safe_float(v, default=0.0):
    if v is None:
        return default
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/overview
#  Quick summary for a high-level dashboard widget.
#  Merges live Alpaca data with state.json for accurate P&L.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/overview")
def overview():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    today = datetime.now().astimezone().strftime("%Y-%m-%d")

    # Attempt live Alpaca data for accurate cash/equity
    live_account = _get_live_account()
    live_positions = _get_live_positions()

    if live_account:
        total_equity = live_account["equity"]
        cash = live_account["cash"]
    else:
        # Fallback to state.json
        history = state.get("portfolioHistory", [])
        current_snap = history[-1] if history else None
        total_equity = safe_float(current_snap["totalEquity"]) if current_snap else safe_float(state["cash"])
        cash = safe_float(state["cash"])

    settled = safe_float(live_account["cash"]) if live_account else safe_float(state["settledCash"])
    pending_buys = max(0, cash - settled)
    positions_count = len(live_positions) if live_positions is not None else len(state.get("positions", []))

    # Token costs from state
    session_tokens = {
        "inputTokens": state.get("sessionInputTokens", 0),
        "outputTokens": state.get("sessionOutputTokens", 0),
        "totalCost": round(
            safe_float(state.get("sessionInputCost", 0)) + safe_float(state.get("sessionOutputCost", 0)),
            5
        ),
    }

    # Daily change: prefer Alpaca's last_equity (prior close), fall back to snapshot baseline
    if live_account and live_account.get("last_equity") is not None:
        daily_change = round(total_equity - live_account["last_equity"], 2)
    else:
        history = state.get("portfolioHistory", [])
        today_snaps = [s for s in history if s.get("timestamp", "").startswith(today)]
        if today_snaps:
            baseline_equity = safe_float(today_snaps[0]["totalEquity"])
        else:
            # Day rolled over — use last snapshot from previous day
            baseline_equity = safe_float(history[-1]["totalEquity"]) if history else cash
        daily_change = round(total_equity - baseline_equity, 2)

    daily_token_cost = session_tokens["totalCost"]

    return jsonify({
        "cash": round(cash, 2),
        "settledCash": round(settled, 2),
        "totalEquity": round(total_equity, 2),
        "dailyPnL": daily_change,
        "dailyTokenCost": daily_token_cost,
        "sessionTokens": session_tokens,
        "positionsCount": positions_count,
        "pendingBuys": round(pending_buys, 2),
        "halted": state.get("halted", False),
        "haltReason": state.get("haltReason"),
    })


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/daily-volume?date=YYYY-MM-DD
#  Trade volume for a given day (default: today).
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/daily-volume")
def daily_volume():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    date_str = request.args.get("date", datetime.now().astimezone().strftime("%Y-%m-%d"))
    trades = state.get("tradeHistory", [])

    # Filter trades by date
    day_trades = [t for t in trades if t.get("timestamp", "").startswith(date_str)]

    volume = round(sum(abs(safe_float(t["pnl"])) for t in day_trades), 2)
    trade_count = len(day_trades)

    return jsonify({
        "date": date_str,
        "tradeCount": trade_count,
        "totalVolume": volume,
        "wins": sum(1 for t in day_trades if safe_float(t["pnl"]) > 0),
        "losses": sum(1 for t in day_trades if safe_float(t["pnl"]) <= 0),
        "netPnL": round(sum(safe_float(t["pnl"]) for t in day_trades), 2),
    })


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/daily-range?date=YYYY-MM-DD
#  High / low / current equity for the day range slider widget.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/daily-range")
def daily_range():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    date_str = request.args.get("date", datetime.now().astimezone().strftime("%Y-%m-%d"))
    history = state.get("portfolioHistory", [])

    # Snapshots from this day only
    day_snaps = [s for s in history if s.get("timestamp", "").startswith(date_str)]

    if not day_snaps:
        return jsonify({
            "date": date_str,
            "high": 0,
            "low": 0,
            "current": 0,
            "open": 0,
            "samples": 0,
        })

    equities = [safe_float(s["totalEquity"]) for s in day_snaps]

    return jsonify({
        "date": date_str,
        "high": round(max(equities), 2),
        "low": round(min(equities), 2),
        "current": round(equities[-1], 2),
        "open": round(equities[0], 2),
        "samples": len(equities),
    })


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/equity-curve?days=30
#  Rolling balance history for the line chart.
#  Down-samples to one point per day (last snapshot of that day).
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/equity-curve")
def equity_curve():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    days = request.args.get("days", 30, type=int)
    history = state.get("portfolioHistory", [])

    if not history:
        return jsonify({"points": []})

    # Group snapshots by day — track last snapshot per day for dailyPnL
    day_map: dict[str, dict] = {}
    for snap in history:
        day = snap["timestamp"][:10]
        eq = safe_float(snap["totalEquity"])
        pnl = safe_float(snap.get("dailyPnL", 0))
        if day not in day_map:
            day_map[day] = {"equities": [], "lastDailyPnL": 0}
        day_map[day]["equities"].append(eq)
        day_map[day]["lastDailyPnL"] = pnl  # last snapshot's dailyPnL wins

    # Sort days, take last N
    sorted_days = sorted(day_map.keys())
    window = sorted_days[-days:] if len(sorted_days) > days else sorted_days

    points = []
    for day in window:
        eqs = day_map[day]["equities"]
        daily_pnl = day_map[day]["lastDailyPnL"]
        close = eqs[-1]
        high = max(eqs)
        low = min(eqs)
        points.append({
            "date": day,
            "close": round(close, 2),
            "high": round(high, 2),
            "low": round(low, 2),
            "dailyPnL": round(daily_pnl, 2),
        })

    return jsonify({"points": points})


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/positions
#  Current open positions with live P&L from Alpaca.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/positions")
def positions():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    live = _get_live_positions()
    if live is not None:
        return jsonify({"positions": live, "source": "live"})

    # Fallback to internal state
    return jsonify({
        "positions": state.get("positions", []),
        "source": "state",
    })


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/activity-stream?hours=24&type=regime_shift
#  Human-readable activity stream — the "what has Scrooge been doing?" feed.
#  Returns reverse-chronological events within a time window. Defaults to 24 hours.
#  Also accepts ?limit=N to override (e.g. ?limit=10 always returns 10).
#  If both hours and limit are given, hours takes precedence for filtering,
#  then limit constrains the response.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/activity-stream")
def activity_stream():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    hours = request.args.get("hours", 24, type=float)
    limit = request.args.get("limit", type=int)  # optional cap on top of time window
    event_type = request.args.get("type")

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    cutoff_str = cutoff.isoformat()

    stream = list(reversed(state.get("activityStream", [])))

    # Filter by time window first
    stream = [e for e in stream if e.get("timestamp", "") >= cutoff_str]

    # Then optional type filter
    if event_type:
        stream = [e for e in stream if e.get("type") == event_type]

    return jsonify({
        "events": stream[:limit] if limit else stream,
        "total": len(stream),
    })


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/trades?limit=20
#  Recent trade history.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/trades")
def trades():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    limit = request.args.get("limit", 20, type=int)
    all_trades = list(reversed(state.get("tradeHistory", [])))

    return jsonify({
        "trades": all_trades[:limit],
    })


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/token-stats?days=30
#  Token usage and cost history. Also includes ROI and daily efficiency.
#  Efficiency = dailyPnL / |totalCost| — computed per day from snapshotted data.
#  For today, uses the provisional session totals.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/token-stats")
def token_stats():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    days = request.args.get("days", 30, type=int)
    history = state.get("tokenCosts", [])
    portfolio_history = state.get("portfolioHistory", [])

    # Build daily cost map
    cost_map = {}
    for entry in history:
        cost_map[entry["date"]] = {
            "inputTokens": entry.get("inputTokens", 0),
            "outputTokens": entry.get("outputTokens", 0),
            "totalCost": entry.get("totalCost", 0),
        }

    # Add current session as today's provisional entry
    today = datetime.now().astimezone().strftime("%Y-%m-%d")
    session_input = state.get("sessionInputTokens", 0)
    session_output = state.get("sessionOutputTokens", 0)
    session_cost = round(state.get("sessionInputCost", 0) + state.get("sessionOutputCost", 0), 5)
    if session_input > 0 or session_output > 0:
        cost_map[today] = {
            "inputTokens": session_input,
            "outputTokens": session_output,
            "totalCost": session_cost,
        }

    # Build daily PnL map from snapshots (last snapshot per day)
    pnl_map = {}
    for snap in portfolio_history:
        day = snap["timestamp"][:10]
        pnl_map[day] = safe_float(snap.get("dailyPnL", 0))

    # Sort and slice
    sorted_dates = sorted(cost_map.keys())
    window = sorted_dates[-days:] if len(sorted_dates) > days else sorted_dates

    daily = []
    for d in window:
        entry = {"date": d, **cost_map[d]}
        # For closed days (not today), use the snapshotted daily PnL
        if d != today:
            entry["dailyPnL"] = pnl_map.get(d, 0)
        else:
            # Today: no snapshotted PnL yet — the overview is the live source
            entry["dailyPnL"] = None
        cost = entry["totalCost"]
        pnl = entry["dailyPnL"]
        if pnl is not None and cost is not None and abs(cost) > 0:
            entry["efficiency"] = round(pnl / abs(cost), 4)
        else:
            entry["efficiency"] = None
        daily.append(entry)

    total_tokens = sum(d["inputTokens"] + d["outputTokens"] for d in daily)
    total_cost = sum(d["totalCost"] for d in daily)

    # Compute trade profits per $ of token spend
    trades = state.get("tradeHistory", [])
    start_date = window[0] if window else None
    realized_pnl = 0.0
    for t in trades:
        ts = t.get("timestamp", "")
        entry_date = ts[:10] if ts else ""
        if start_date and entry_date >= start_date:
            realized_pnl += safe_float(t["pnl"])

    roi_ratio = round(realized_pnl / total_cost, 2) if total_cost > 0 else 0

    return jsonify({
        "daily": daily,
        "totalTokens": total_tokens,
        "totalCost": round(total_cost, 5),
        "windowRealizedPnL": round(realized_pnl, 2),
        "tradeProfitPerTokenDollar": roi_ratio,
    })


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/daily-report
#  Latest daily retrospective report (markdown + structured data).
#  If your assistant calls this, it gets the report to message you.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/daily-report")
def daily_report():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    reports = state.get("dailyReports", [])
    if not reports:
        return jsonify({
            "exists": False,
            "message": "No daily retrospective report available yet.",
        })

    # Latest report (most recent date)
    latest = max(reports, key=lambda r: r["date"])

    date_param = request.args.get("date")
    if date_param:
        target = next((r for r in reports if r["date"] == date_param), None)
        if not target:
            return jsonify({
                "exists": False,
                "message": f"No report found for {date_param}.",
            })
        latest = target

    return jsonify({
        "exists": True,
        "date": latest["date"],
        "timestamp": latest.get("timestamp", ""),
        "summary": {
            "tradeCount": latest.get("tradeCount", 0),
            "startingEquity": safe_float(latest.get("startingEquity", 0)),
            "endingEquity": safe_float(latest.get("endingEquity", 0)),
            "totalEquityChange": safe_float(latest.get("totalEquityChange", 0)),
            "netPnL": safe_float(latest.get("netPnL", 0)),
            "winCount": latest.get("winCount", 0),
            "lossCount": latest.get("lossCount", 0),
            "winRate": latest.get("winRate", 0),
            "tokenCost": safe_float(latest.get("tokenCost", 0)),
        },
        "prose": {
            "whatWorked": latest.get("whatWorked", ""),
            "whatDidnt": latest.get("whatDidnt", ""),
            "whatToChange": latest.get("whatToChange", ""),
        },
        "markdown": latest.get("markdown", ""),
    })


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/health
#  Health check.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "stateFile": str(STATE_PATH),
        "exists": STATE_PATH.exists(),
    })


# ─────────────────────────────────────────────────────────────────────────
#  Main
# ─────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("SCROOGE_API_PORT", 5000))
    host = os.environ.get("SCROOGE_API_HOST", "0.0.0.0")
    debug = os.environ.get("SCROOGE_API_DEBUG", "0") == "1"
    print(f"🚀 Scrooge API starting on {host}:{port} (debug={debug})")
    app.run(host=host, port=port, debug=debug)
