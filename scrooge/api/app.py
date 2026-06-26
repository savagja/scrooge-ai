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

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ── path to state.json ──────────────────────────────────────────────────
STATE_PATH = Path(os.environ.get("SCROOGE_STATE", "/home/admin/scrooge/data/state.json"))


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
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/overview")
def overview():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Latest snapshot for current equity
    history = state.get("portfolioHistory", [])
    current_snap = history[-1] if history else None
    total_equity = safe_float(current_snap["totalEquity"]) if current_snap else safe_float(state["cash"])

    # Pending buys from unsettled cash
    settled = safe_float(state["settledCash"])
    pending_buys = max(0, safe_float(state["cash"]) - settled)

    return jsonify({
        "cash": safe_float(state["cash"]),
        "settledCash": settled,
        "totalEquity": round(total_equity, 2),
        "dailyPnL": safe_float(state["dailyPnL"]),
        "positionsCount": len(state.get("positions", [])),
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

    date_str = request.args.get("date", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
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

    date_str = request.args.get("date", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    history = state.get("portfolioHistory", [])

    # Snapshots from this day only
    day_snaps = [s for s in history if s.get("timestamp", "").startswith(date_str)]

    if not day_snaps:
        return jsonify({
            "date": date_str,
            "high": safe_float(state["cash"]),
            "low": safe_float(state["cash"]),
            "current": safe_float(state["cash"]),
            "open": safe_float(state["cash"]),
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

    # Group snapshots by day
    day_map: dict[str, list[float]] = {}
    for snap in history:
        day = snap["timestamp"][:10]
        eq = safe_float(snap["totalEquity"])
        day_map.setdefault(day, []).append(eq)

    # Sort days, take last N
    sorted_days = sorted(day_map.keys())
    window = sorted_days[-days:] if len(sorted_days) > days else sorted_days

    points = []
    for day in window:
        eqs = day_map[day]
        close = eqs[-1]          # last snapshot = end of day-ish
        high = max(eqs)
        low = min(eqs)
        points.append({
            "date": day,
            "close": round(close, 2),
            "high": round(high, 2),
            "low": round(low, 2),
        })

    return jsonify({"points": points})


# ─────────────────────────────────────────────────────────────────────────
#  GET /api/positions
#  Current open positions with P&L and status.
# ─────────────────────────────────────────────────────────────────────────
@app.route("/api/positions")
def positions():
    state = load_state()
    if isinstance(state, tuple):
        return jsonify(state[0]), state[1]

    return jsonify({
        "positions": state.get("positions", []),
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