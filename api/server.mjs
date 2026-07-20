/**
 * Lightweight Node.js API server for Scrooge.
 * Drop-in replacement for the Flask API — same endpoints.
 * Run with: node api/server.mjs
 */

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.SCROOGE_STATE || join(process.cwd(), "data", "state.json");
const PORT = parseInt(process.env.SCROOGE_API_PORT || "5000", 10);
const HOST = process.env.SCROOGE_API_HOST || "0.0.0.0";

// ── Helpers ──────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { error: `state.json not found at ${STATE_PATH}` };
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
}

function safeFloat(v, def = 0) {
  if (v == null) return def;
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function json(data, status = 200) {
  return { status, body: JSON.stringify(data) + "\n", headers: { "Content-Type": "application/json" } };
}

function error(msg, status = 404) {
  return json({ error: msg }, status);
}

// ── Routes ───────────────────────────────────────────────────────────────

function handleRequest(method, url) {
  const [path, queryString] = url.split("?");
  const params = Object.fromEntries(new URLSearchParams(queryString || ""));
  const state = loadState();

  if (path === "/api/health") {
    return json({ status: "ok", stateFile: STATE_PATH, exists: existsSync(STATE_PATH) });
  }

  if (path === "/api/overview") {
    const today = getToday();
    const cash = safeFloat(state.cash);
    const settled = safeFloat(state.settledCash);
    const positions = state.positions || [];
    const history = state.portfolioHistory || [];

    const todaySnaps = history.filter(s => (s.timestamp || "").startsWith(today));
    const currentSnap = todaySnaps.length > 0 ? todaySnaps[todaySnaps.length - 1] : history[history.length - 1];
    const totalEquity = currentSnap ? safeFloat(currentSnap.totalEquity) : cash;

    // Daily change from first snapshot today
    const baselineEquity = todaySnaps.length > 0 ? safeFloat(todaySnaps[0].totalEquity) : (history.length > 0 ? safeFloat(history[history.length - 1].totalEquity) : cash);
    const dailyPnL = Math.round((totalEquity - baselineEquity) * 100) / 100;

    const sessionTokens = {
      inputTokens: state.sessionInputTokens || 0,
      outputTokens: state.sessionOutputTokens || 0,
      totalCost: Math.round((safeFloat(state.sessionInputCost) + safeFloat(state.sessionOutputCost)) * 100000) / 100000,
    };

    return json({
      cash: Math.round(cash * 100) / 100,
      settledCash: Math.round(settled * 100) / 100,
      totalEquity: Math.round(totalEquity * 100) / 100,
      dailyPnL,
      dailyTokenCost: sessionTokens.totalCost,
      sessionTokens,
      positionsCount: positions.length,
      pendingBuys: Math.round(Math.max(0, cash - settled) * 100) / 100,
      halted: !!state.halted,
      haltReason: state.haltReason || null,
    });
  }

  if (path === "/api/activity-stream") {
    const hours = parseFloat(params.hours || "24");
    const limit = params.limit ? parseInt(params.limit, 10) : null;
    const eventType = params.type || null;
    const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

    let stream = [...(state.activityStream || [])].reverse();
    stream = stream.filter(e => (e.timestamp || "") >= cutoff);
    if (eventType) stream = stream.filter(e => e.type === eventType);

    return json({ events: limit ? stream.slice(0, limit) : stream, total: stream.length });
  }

  if (path === "/api/positions") {
    return json({ positions: state.positions || [], source: "state" });
  }

  if (path === "/api/trades") {
    const limit = parseInt(params.limit || "20", 10);
    const trades = [...(state.tradeHistory || [])].reverse().slice(0, limit);
    return json({ trades });
  }

  if (path === "/api/equity-curve") {
    const days = parseInt(params.days || "30", 10);
    const history = state.portfolioHistory || [];
    if (history.length === 0) return json({ points: [] });

    const dayMap = {};
    for (const snap of history) {
      const day = snap.timestamp.slice(0, 10);
      const eq = safeFloat(snap.totalEquity);
      const pnl = safeFloat(snap.dailyPnL);
      if (!dayMap[day]) dayMap[day] = { equities: [], lastDailyPnL: 0 };
      dayMap[day].equities.push(eq);
      dayMap[day].lastDailyPnL = pnl;
    }

    const sortedDays = Object.keys(dayMap).sort();
    const window = sortedDays.slice(-days);
    const points = window.map(day => {
      const d = dayMap[day];
      return {
        date: day,
        close: Math.round(d.equities[d.equities.length - 1] * 100) / 100,
        high: Math.round(Math.max(...d.equities) * 100) / 100,
        low: Math.round(Math.min(...d.equities) * 100) / 100,
        dailyPnL: Math.round(d.lastDailyPnL * 100) / 100,
      };
    });

    return json({ points });
  }

  if (path === "/api/daily-volume") {
    const dateStr = params.date || getToday();
    const trades = (state.tradeHistory || []).filter(t => (t.timestamp || "").startsWith(dateStr));
    const wins = trades.filter(t => safeFloat(t.pnl) > 0);
    const losses = trades.filter(t => safeFloat(t.pnl) <= 0);
    return json({
      date: dateStr,
      tradeCount: trades.length,
      totalVolume: Math.round(trades.reduce((s, t) => s + Math.abs(safeFloat(t.pnl)), 0) * 100) / 100,
      wins: wins.length,
      losses: losses.length,
      netPnL: Math.round(trades.reduce((s, t) => s + safeFloat(t.pnl), 0) * 100) / 100,
    });
  }

  if (path === "/api/daily-range") {
    const dateStr = params.date || getToday();
    const history = state.portfolioHistory || [];
    const daySnaps = history.filter(s => (s.timestamp || "").startsWith(dateStr));
    if (daySnaps.length === 0) return json({ date: dateStr, high: 0, low: 0, current: 0, open: 0, samples: 0 });
    const equities = daySnaps.map(s => safeFloat(s.totalEquity));
    return json({
      date: dateStr,
      high: Math.round(Math.max(...equities) * 100) / 100,
      low: Math.round(Math.min(...equities) * 100) / 100,
      current: Math.round(equities[equities.length - 1] * 100) / 100,
      open: Math.round(equities[0] * 100) / 100,
      samples: equities.length,
    });
  }

  if (path === "/api/daily-report") {
    const reports = state.dailyReports || [];
    if (reports.length === 0) return json({ exists: false, message: "No daily retrospective report available yet." });
    let latest = reports.reduce((a, b) => a.date > b.date ? a : b);
    if (params.date) {
      const target = reports.find(r => r.date === params.date);
      if (!target) return json({ exists: false, message: `No report found for ${params.date}.` });
      latest = target;
    }
    return json({
      exists: true,
      date: latest.date,
      timestamp: latest.timestamp || "",
      summary: {
        tradeCount: latest.tradeCount || 0,
        startingEquity: safeFloat(latest.startingEquity),
        endingEquity: safeFloat(latest.endingEquity),
        totalEquityChange: safeFloat(latest.totalEquityChange),
        netPnL: safeFloat(latest.netPnL),
        winCount: latest.winCount || 0,
        lossCount: latest.lossCount || 0,
        winRate: latest.winRate || 0,
        tokenCost: safeFloat(latest.tokenCost),
      },
      prose: {
        whatWorked: latest.whatWorked || "",
        whatDidnt: latest.whatDidnt || "",
        whatToChange: latest.whatToChange || "",
      },
      markdown: latest.markdown || "",
    });
  }

  if (path === "/api/token-stats") {
    const days = parseInt(params.days || "30", 10);
    const tokenCosts = state.tokenCosts || [];
    const portfolioHistory = state.portfolioHistory || [];

    const costMap = {};
    for (const entry of tokenCosts) costMap[entry.date] = { inputTokens: entry.inputTokens || 0, outputTokens: entry.outputTokens || 0, totalCost: safeFloat(entry.totalCost) };

    const today = getToday();
    const si = state.sessionInputTokens || 0;
    const so = state.sessionOutputTokens || 0;
    const sc = Math.round((safeFloat(state.sessionInputCost) + safeFloat(state.sessionOutputCost)) * 100000) / 100000;
    if (si > 0 || so > 0) costMap[today] = { inputTokens: si, outputTokens: so, totalCost: sc };

    const pnlMap = {};
    for (const snap of portfolioHistory) {
      const day = snap.timestamp.slice(0, 10);
      pnlMap[day] = safeFloat(snap.dailyPnL);
    }

    const sortedDates = Object.keys(costMap).sort();
    const window = sortedDates.slice(-days);
    const daily = window.map(d => {
      const entry = { date: d, ...costMap[d] };
      entry.dailyPnL = d !== today ? (pnlMap[d] || 0) : null;
      const cost = entry.totalCost;
      const pnl = entry.dailyPnL;
      entry.efficiency = (pnl != null && cost != null && Math.abs(cost) > 0) ? Math.round((pnl / Math.abs(cost)) * 10000) / 10000 : null;
      return entry;
    });

    const totalTokens = daily.reduce((s, d) => s + d.inputTokens + d.outputTokens, 0);
    const totalCost = Math.round(daily.reduce((s, d) => s + d.totalCost, 0) * 100000) / 100000;

    const startDate = window.length > 0 ? window[0] : null;
    let realizedPnl = 0;
    for (const t of state.tradeHistory || []) {
      const ts = t.timestamp || "";
      if (startDate && ts.slice(0, 10) >= startDate) realizedPnl += safeFloat(t.pnl);
    }
    const roiRatio = totalCost > 0 ? Math.round((realizedPnl / totalCost) * 100) / 100 : 0;

    return json({
      daily,
      totalTokens,
      totalCost,
      windowRealizedPnL: Math.round(realizedPnl * 100) / 100,
      tradeProfitPerTokenDollar: roiRatio,
    });
  }

  return error(`Not found: ${path}`, 404);
}

// ── Server ───────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  try {
    const result = handleRequest(req.method, req.url);
    res.writeHead(result.status, { ...result.headers, "Access-Control-Allow-Origin": "*" });
    res.end(result.body);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: e.message }) + "\n");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Scrooge API running on http://${HOST}:${PORT}`);
  console.log(`📂 Reading state from: ${STATE_PATH}`);
});