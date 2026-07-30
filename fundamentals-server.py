#!/usr/bin/env python3
"""
Simple Flask proxy that wraps yfinance fundamentals calls.
The TypeScript code hits this instead of the broken Yahoo Finance v10 quote-summary API.

Run: python3 fundamentals-server.py
Optional: python3 fundamentals-server.py --port 5001

The TS code in src/research/fundamentals.ts needs FUNDAMENTALS_PROXY_URL set.
"""

import argparse
import time
import traceback
import yfinance as yf
from flask import Flask, jsonify, request

app = Flask(__name__)

# Rate limiting: yfinance can trigger rate blocks if called too fast
MIN_INTERVAL = 1.0  # seconds between calls
_last_call = 0.0

# Cache: ticker -> (timestamp, data)
_cache = {}
CACHE_TTL = 3600  # 1 hour


def get_fundamentals(symbol: str) -> dict:
    """Fetch fundamentals for a single ticker via yfinance."""
    global _last_call

    # Rate limit
    now = time.time()
    since_last = now - _last_call
    if since_last < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - since_last)
    _last_call = time.time()

    ticker = yf.Ticker(symbol)
    info = ticker.info

    # Map yfinance fields to the same schema the TS code expects
    result = {
        # Identity
        "longName": info.get("longName") or info.get("shortName"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        # Valuation
        "marketCap": info.get("marketCap"),
        "enterpriseValue": info.get("enterpriseValue"),
        "peRatio": info.get("trailingPE"),
        "forwardPe": info.get("forwardEps"),
        "psRatio": info.get("priceToSalesTrailing12Months"),
        "pbRatio": info.get("priceToBook"),
        "evToEbitda": info.get("enterpriseToEbitda"),
        # Dividends
        "dividendYield": info.get("dividendYield"),
        "dividendRate": info.get("dividendRate"),
        "payoutRatio": info.get("payoutRatio"),
        "fiveYearAvgDividendYield": info.get("fiveYearAvgDividendYield"),
        # Financials
        "totalCash": info.get("totalCash"),
        "totalDebt": info.get("totalDebt"),
        "bookValue": info.get("bookValue"),
        "freeCashFlow": info.get("freeCashFlow"),
        "operatingCashFlow": info.get("operatingCashFlow"),
        "revenueTtm": info.get("totalRevenue"),
        "grossMargin": info.get("grossMargins"),
        "operatingMargin": info.get("operatingMargins"),
        "netMargin": info.get("profitMargins"),
        # Per-share
        "epsTtm": info.get("trailingEps"),
        "epsForward": info.get("forwardEps"),
        "epsGrowthYoY": info.get("earningsQuarterlyGrowth"),
        "revenueGrowthYoY": info.get("revenueGrowth"),
        # Technical
        "fiftyTwoWeekHigh": info.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow": info.get("fiftyTwoWeekLow"),
        "fiftyDayAverage": info.get("fiftyDayAverage"),
        "twoHundredDayAverage": info.get("twoHundredDayAverage"),
        "beta": info.get("beta"),
        "avgVolume10d": info.get("averageVolume10days"),
        "avgVolume30d": info.get("averageVolume"),
        "regularMarketPrice": info.get("currentPrice") or info.get("regularMarketPrice"),
        "regularMarketVolume": info.get("volume") or info.get("regularMarketVolume"),
        "returnOnEquity": info.get("returnOnEquity"),
        "debtToEquity": info.get("debtToEquity"),
        "currentRatio": info.get("currentRatio"),
        "earningsGrowth": info.get("earningsQuarterlyGrowth"),
        "revenuePerShare": info.get("revenuePerShare"),
    }

    return result


@app.route("/fundamentals/<symbol>")
def fundamentals(symbol: str):
    """Get fundamentals for a single ticker."""
    symbol = symbol.upper().strip()

    # Check cache
    now = time.time()
    if symbol in _cache:
        ts, data = _cache[symbol]
        if now - ts < CACHE_TTL:
            return jsonify(data)

    try:
        data = get_fundamentals(symbol)
        _cache[symbol] = (now, data)
        return jsonify(data)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/health")
def health():
    """Health check."""
    return jsonify({"status": "ok", "cache_size": len(_cache)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fundamentals proxy server")
    parser.add_argument("--port", type=int, default=5001, help="Port to listen on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to bind to")
    args = parser.parse_args()

    print(f"Fundamentals proxy server starting on {args.host}:{args.port}")
    import yfinance as yf; print(f"Using yfinance {yf.__version__}")
    print()
    app.run(host=args.host, port=args.port)