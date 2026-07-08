/**
 * Portfolio state manager.
 * Full persistence for trades, snapshots, calibration, and vector memory.
 * Designed for dashboard rendering and machine learning.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getAccount } from "../execution/alpaca.js";
import { getTradingDate } from "../config.js";
import type {
  Position,
  TradeRecord,
  AgentMemory,
  PortfolioSnapshot,
  StrategyCalibration,
  VectorMemoryEntry,
  PersistedState,
  DailyTokenCost,
  DailyReport,
  Lesson,
  ActivityEvent,
  ActivityEventType,
} from "../types.js";

const DATA_DIR = join(process.cwd(), "data");
const STATE_FILE = join(DATA_DIR, "state.json");

export class PortfolioState {
  private state: PersistedState;
  private filePath: string;

  constructor(initialCapital = 100) {
    this.filePath = STATE_FILE;
    mkdirSync(dirname(this.filePath), { recursive: true });

    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, "utf-8");
        this.state = JSON.parse(raw) as PersistedState;
      } catch {
        this.state = this.defaultState(initialCapital);
      }
    } else {
      this.state = this.defaultState(initialCapital);
    }

    this.resetDailyIfNeeded();
    this._ensureFields(); // Backwards compat for loaded state
  }

  private defaultState(capital: number): PersistedState {
    return {
      cash: capital,
      settledCash: capital,
      dailyPnL: 0,
      today: getTradingDate(),
      positions: [],
      tradeHistory: [],
      portfolioHistory: [],
      calibrationTable: [],
      vectorMemory: [],
      memory: {
        lessons: [],
        strategyPerformance: {},
        lastReflection: null,
        contextNotes: [],
      },
      halted: false,
      haltReason: null,
      preMarketBriefing: null,
      tokenCosts: [],
      sessionInputTokens: 0,
      sessionOutputTokens: 0,
      sessionInputCost: 0,
      sessionOutputCost: 0,
      dailyReports: [],
      activityStream: [],
    };
  }

  /** Ensure missing fields exist (backwards compat). */
  private _ensureFields() {
    if (!this.state.portfolioHistory) this.state.portfolioHistory = [];
    if (!this.state.calibrationTable) this.state.calibrationTable = [];
    if (!this.state.vectorMemory) this.state.vectorMemory = [];
    if (!this.state.dailyReports) this.state.dailyReports = [];
    if (!this.state.activityStream) this.state.activityStream = [];
    if (!this.state.tokenCosts) this.state.tokenCosts = [];
    if (this.state.settledCash === null || this.state.settledCash === undefined) this.state.settledCash = this.state.cash;
    if (this.state.sessionInputTokens === undefined) this.state.sessionInputTokens = 0;
    if (this.state.sessionOutputTokens === undefined) this.state.sessionOutputTokens = 0;
    if (this.state.sessionInputCost === undefined) this.state.sessionInputCost = 0;
    if (this.state.sessionOutputCost === undefined) this.state.sessionOutputCost = 0;
    // Backwards compat: migrate old string-format lessons to Lesson objects
    if (this.state.memory?.lessons) {
      this.state.memory.lessons = this.state.memory.lessons
        .filter((l) => typeof l === 'object' && l !== null) as Lesson[];
    }
    // Backwards compat: ensure contextNotes exists in memory
    if (!this.state.memory.contextNotes) {
      this.state.memory.contextNotes = [];
    }
    // Backwards compat: add direction and lowestPrice to existing positions
    for (const pos of this.state.positions) {
      if (!pos.direction) pos.direction = "long";
      if (pos.lowestPrice === undefined) pos.lowestPrice = pos.entryPrice;
    }
  }

  private resetDailyIfNeeded() {
    const today = getTradingDate();
    if (this.state.today !== today) {
      // Finalize previous day's token costs into history
      if (this.state.sessionInputTokens > 0 || this.state.sessionOutputTokens > 0) {
        this._finalizeDailyTokenCost();
      }
      this.state.dailyPnL = 0;
      this.state.today = today;
      this.state.sessionInputTokens = 0;
      this.state.sessionOutputTokens = 0;
      this.state.sessionInputCost = 0;
      this.state.sessionOutputCost = 0;
      this.state.halted = false;
      this.state.haltReason = null;
      this.save();
    }
  }

  private _finalizeDailyTokenCost() {
    const entry: DailyTokenCost = {
      date: this.state.today,
      inputTokens: this.state.sessionInputTokens,
      outputTokens: this.state.sessionOutputTokens,
      inputCost: Math.round(this.state.sessionInputCost * 100000) / 100000,
      outputCost: Math.round(this.state.sessionOutputCost * 100000) / 100000,
      totalCost: Math.round((this.state.sessionInputCost + this.state.sessionOutputCost) * 100000) / 100000,
    };
    this.state.tokenCosts.push(entry);
    if (this.state.tokenCosts.length > 365) {
      this.state.tokenCosts = this.state.tokenCosts.slice(-365);
    }
  }

  save() {
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GETTERS
  // ═══════════════════════════════════════════════════════════════════════

  getCash(): number { return this.state.cash; }
  getSettledCash(): number { return this.state.settledCash; }
  getDailyPnL(): number { return this.state.dailyPnL; }
  getPositions(): Position[] { return this.state.positions; }
  getTradeHistory(): TradeRecord[] { return this.state.tradeHistory; }
  getPortfolioHistory(): PortfolioSnapshot[] { return this.state.portfolioHistory; }
  getCalibrationTable(): StrategyCalibration[] { return this.state.calibrationTable; }
  getVectorMemory(): VectorMemoryEntry[] { return this.state.vectorMemory; }
  getMemory(): AgentMemory { return this.state.memory; }
  isHalted(): { halted: boolean; reason: string | null } {
    return { halted: this.state.halted, reason: this.state.haltReason };
  }

  getPortfolio() {
    return {
      positions: this.state.positions,
      cash: this.state.cash,
      settledCash: this.state.settledCash,
      dailyPnL: this.state.dailyPnL,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SETTERS — Account sync
  // ═══════════════════════════════════════════════════════════════════════

  updateSettledCash(amount: number) {
    this.state.settledCash = Math.round(amount * 100) / 100;
    this.save();
  }

  syncAccount(cash: number, settledCash: number) {
    this.state.cash = Math.round(cash * 100) / 100;
    this.state.settledCash = Math.round(settledCash * 100) / 100;
    this.save();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SNAPSHOT — Equity curve data for dashboards
  // ═══════════════════════════════════════════════════════════════════════

  addSnapshot(vix: number | null, regime: string, alpacaEquity?: number | null) {
    const unrealized = this.state.positions.reduce(
      (sum, p) => sum + (p.unrealizedPnL || 0),
      0
    );
    const openNotional = this.state.positions.reduce(
      (sum, p) => sum + p.notional,
      0
    );

    let totalEquity: number;
    if (alpacaEquity != null && alpacaEquity > 0) {
      // Use Alpaca's official equity from /v2/account (accurate — includes fees, dividends, settled trades)
      totalEquity = Math.round(alpacaEquity * 100) / 100;
    } else {
      // Fallback: calculate from internal state
      totalEquity = Math.round((this.state.cash + openNotional + unrealized) * 100) / 100;
    }

    const snap: PortfolioSnapshot = {
      timestamp: new Date().toISOString(),
      totalEquity,
      cash: this.state.cash,
      settledCash: this.state.settledCash,
      positionsCount: this.state.positions.length,
      openNotional,
      dailyPnL: this.state.dailyPnL,
      unrealizedPnL: Math.round(unrealized * 100) / 100,
      vix,
      regime,
    };

    this.state.portfolioHistory.push(snap);
    // Keep last 10,000 snapshots (~1 week at 30s polling)
    if (this.state.portfolioHistory.length > 10000) {
      this.state.portfolioHistory = this.state.portfolioHistory.slice(-8000);
    }
    this.save();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ENTRY — Record new position
  // ═══════════════════════════════════════════════════════════════════════

  recordEntry(
    symbol: string,
    qty: number,
    price: number,
    notional: number,
    holdUntil: Date,
    strategy: string,
    marketContext?: {
      vix: number | null;
      spyChange: number | null;
      regime: string;
    },
    signalMeta?: {
      source: string;
      confidence: number;
      impactScore: number;
    },
    direction?: "long" | "short"
  ) {
    const isShort = direction === "short";
    // For shorts, 'qty' is positive (borrowed shares sold), 'notional' is proceeds received
    const pos: Position = {
      symbol,
      qty: Math.round(qty * 1000000) / 1000000,
      entryPrice: Math.round(price * 100) / 100,
      entryTime: new Date().toISOString(),
      holdUntil: holdUntil.toISOString(),
      notional: Math.round(notional * 100) / 100,
      unrealizedPnL: 0,
      strategy,
      direction: direction ?? "long",
      trailingStopPrice: null,
      highestPrice: isShort ? price : price,  // highestPrice used for exit tracking (re-used for shorts but different semantics)
      lowestPrice: isShort ? price : price,    // lowestPrice for shorts tracks the trough
      status: "initial",
      entryVix: marketContext?.vix ?? null,
      entrySpyChange: marketContext?.spyChange ?? null,
      entryRegime: marketContext?.regime ?? "unknown",
      entrySignalConfidence: signalMeta?.confidence ?? 0.5,
      entrySignalImpactScore: signalMeta?.impactScore ?? 0,
      entrySignalSource: signalMeta?.source ?? strategy,
    };
    this.state.positions.push(pos);
    // For shorts: notional is the cash received from the short sale (added to cash)
    // For longs: notional is cash spent (deducted from cash)
    if (isShort) {
      this.state.cash = Math.round((this.state.cash + notional) * 100) / 100;
    } else {
      this.state.cash = Math.round((this.state.cash - notional) * 100) / 100;
    }
    this.save();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXIT — Record completed trade, update calibration, vector memory
  // ═══════════════════════════════════════════════════════════════════════

  recordExit(
    symbol: string,
    exitPrice: number,
    exitReason: string,
    agentReasoning?: string
  ) {
    const idx = this.state.positions.findIndex((p) => p.symbol === symbol);
    if (idx === -1) return;

    const pos = this.state.positions[idx];
    const isShort = pos.direction === "short";

    let pnl: number;
    let pnlPct: number;
    let cashChange: number;

    if (isShort) {
      // Short: entered by selling (received notional), exit by buying back (pay exitPrice * qty)
      const buybackCost = pos.qty * exitPrice;
      pnl = Math.round((pos.notional - buybackCost) * 100) / 100;
      pnlPct = Math.round((pnl / pos.notional) * 10000) / 100;
      // Cash: we received notional at entry, now we spend to buy back
      cashChange = -buybackCost;
    } else {
      // Long: entered by buying (spent notional), exit by selling (receive exitPrice * qty)
      const proceeds = pos.qty * exitPrice;
      pnl = Math.round((proceeds - pos.notional) * 100) / 100;
      pnlPct = Math.round((pnl / pos.notional) * 10000) / 100;
      cashChange = proceeds;
    }

    const holdMin =
      (Date.now() - new Date(pos.entryTime).getTime()) / 60000;

    // Compute timeToGreen
    let timeToGreen: number | null = null;
    if (pos.status !== "initial") {
      timeToGreen = Math.round(holdMin * 0.6);
    }

    // Build feature vector using entry context stored in position
    const featureVector = [
      Math.min((pos.entryVix ?? 18) / 50, 1.0),
      Math.min(Math.max(pos.entrySignalConfidence, 0), 1),
      Math.min(Math.max(pos.entrySignalImpactScore / 10, -1), 1),
      Math.min(pos.notional / 100, 1.0),
      pos.entryRegime === "trending_up" ? 1 : 0,
      pos.entryRegime === "chop" ? 1 : 0,
      pos.entryRegime === "volatile" ? 1 : 0,
    ];

    const trade: TradeRecord = {
      id: `${symbol}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      symbol: pos.symbol,
      strategy: pos.strategy,
      direction: isShort ? "short" : "long",
      entryPrice: pos.entryPrice,
      exitPrice: Math.round(exitPrice * 100) / 100,
      qty: pos.qty,
      notional: pos.notional,
      pnl,
      pnlPct,
      exitReason,
      holdMinutesActual: Math.round(holdMin * 10) / 10,
      wasPromoted: pos.status !== "initial",
      timeToGreen,
      vixAtEntry: pos.entryVix,
      spyChangeAtEntry: pos.entrySpyChange,
      marketRegimeAtEntry: pos.entryRegime,
      signalSource: pos.entrySignalSource,
      signalConfidence: pos.entrySignalConfidence,
      signalImpactScore: pos.entrySignalImpactScore,
      agentReasoning: agentReasoning ?? "",
      featureVector,
    };

    this.state.tradeHistory.push(trade);
    this.state.cash = Math.round((this.state.cash + cashChange) * 100) / 100;
    this.state.dailyPnL = Math.round((this.state.dailyPnL + pnl) * 100) / 100;
    this.state.positions.splice(idx, 1);

    // Update strategy stats
    this._updateStrategyStats(pos.strategy, pnl);

    // Update calibration table
    this._updateCalibration(
      pos.strategy,
      pos.entryRegime,
      pnl,
      holdMin,
      pos.status !== "initial"
    );

    // Add to vector memory
    this._addVectorMemory(trade);

    this.save();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POSITION STATE — Promotions, trailing stop, P&L
  // ═══════════════════════════════════════════════════════════════════════

  updatePositionState(
    symbol: string,
    currentPrice: number,
    updates: {
      status?: Position["status"];
      trailingStopPrice?: number | null;
      highestPrice?: number;
      lowestPrice?: number;
    }
  ) {
    const pos = this.state.positions.find((p) => p.symbol === symbol);
    if (!pos) return;

    if (updates.status) pos.status = updates.status;
    if (updates.trailingStopPrice !== undefined)
      pos.trailingStopPrice = updates.trailingStopPrice;
    if (updates.highestPrice)
      pos.highestPrice = Math.max(pos.highestPrice, updates.highestPrice);
    if (updates.lowestPrice !== undefined)
      pos.lowestPrice = Math.min(pos.lowestPrice, updates.lowestPrice);

    // P&L calculation: for shorts, profit when price drops
    if (pos.direction === "short") {
      const unrealized = (pos.entryPrice - currentPrice) * pos.qty;
      pos.unrealizedPnL = Math.round(unrealized * 100) / 100;
    } else {
      const unrealized = (currentPrice - pos.entryPrice) * pos.qty;
      pos.unrealizedPnL = Math.round(unrealized * 100) / 100;
    }
    this.save();
  }

  updatePositionPnL(symbol: string, currentPrice: number) {
    const pos = this.state.positions.find((p) => p.symbol === symbol);
    if (!pos) return;
    if (pos.direction === "short") {
      const unrealized = (pos.entryPrice - currentPrice) * pos.qty;
      pos.unrealizedPnL = Math.round(unrealized * 100) / 100;
    } else {
      const unrealized = (currentPrice - pos.entryPrice) * pos.qty;
      pos.unrealizedPnL = Math.round(unrealized * 100) / 100;
    }
    this.save();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STRATEGY STATS (Traditional)
  // ═══════════════════════════════════════════════════════════════════════

  private _updateStrategyStats(strategy: string, pnl: number) {
    if (!this.state.memory.strategyPerformance[strategy]) {
      this.state.memory.strategyPerformance[strategy] = {
        wins: 0,
        losses: 0,
        avgWin: 0,
        avgLoss: 0,
        winRate: 0,
      };
    }
    const s = this.state.memory.strategyPerformance[strategy];
    if (pnl > 0) {
      s.wins++;
      s.avgWin = Math.round(((s.avgWin * (s.wins - 1)) + pnl) / s.wins * 100) / 100;
    } else {
      s.losses++;
      s.avgLoss = Math.round(((s.avgLoss * (s.losses - 1)) + pnl) / s.losses * 100) / 100;
    }
    s.winRate = Math.round((s.wins / (s.wins + s.losses)) * 100) / 100;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CALIBRATION TABLE — Phase 2: Data-driven confidence
  // ═══════════════════════════════════════════════════════════════════════

  private _updateCalibration(
    strategy: string,
    regime: string,
    pnl: number,
    holdMin: number,
    wasPromoted: boolean
  ) {
    let row = this.state.calibrationTable.find(
      (c) => c.strategy === strategy && c.regime === regime
    );
    if (!row) {
      row = {
        strategy,
        regime,
        wins: 0,
        losses: 0,
        avgWinPct: 0,
        avgLossPct: 0,
        winRate: 0,
        avgTimeToGreen: null,
        totalTrades: 0,
        lastUpdated: new Date().toISOString(),
      };
      this.state.calibrationTable.push(row);
    }

    row.totalTrades++;
    if (pnl > 0) {
      row.wins++;
      row.avgWinPct =
        Math.round(((row.avgWinPct * (row.wins - 1)) + (pnl / row.totalTrades)) / row.wins * 10000) /
        10000;
    } else {
      row.losses++;
      row.avgLossPct =
        Math.round(((row.avgLossPct * (row.losses - 1)) + (pnl / row.totalTrades)) / row.losses * 10000) /
        10000;
    }
    row.winRate = Math.round((row.wins / row.totalTrades) * 100) / 100;

    if (wasPromoted) {
      const prev = row.avgTimeToGreen ?? holdMin;
      row.avgTimeToGreen = Math.round(((prev * (row.wins + row.losses - 1)) + holdMin) / (row.wins + row.losses));
    }

    row.lastUpdated = new Date().toISOString();
  }

  /** Get calibrated confidence override if enough data exists. */
  getCalibratedConfidence(strategy: string, regime: string): {
    override: number | null;
    sampleSize: number;
  } {
    const row = this.state.calibrationTable.find(
      (c) => c.strategy === strategy && c.regime === regime
    );
    if (!row || row.totalTrades < 5) {
      return { override: null, sampleSize: row?.totalTrades ?? 0 };
    }
    return { override: row.winRate, sampleSize: row.totalTrades };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VECTOR MEMORY — Phase 3: Similarity search
  // ═══════════════════════════════════════════════════════════════════════

  private _addVectorMemory(trade: TradeRecord) {
    const entry: VectorMemoryEntry = {
      tradeId: trade.id,
      symbol: trade.symbol,
      featureVector: trade.featureVector,
      outcome: trade.pnl > 0 ? "win" : "loss",
      pnlPct: trade.pnlPct,
      timestamp: trade.timestamp,
    };
    this.state.vectorMemory.push(entry);
    // Keep last 500 for performance
    if (this.state.vectorMemory.length > 500) {
      this.state.vectorMemory = this.state.vectorMemory.slice(-400);
    }
  }

  /** Find most similar past trades by cosine similarity. */
  findSimilarTrades(featureVector: number[], topK: number = 5): (VectorMemoryEntry & { similarity: number })[] {
    const scored = this.state.vectorMemory.map((vm) => ({
      ...vm,
      similarity: this._cosineSimilarity(featureVector, vm.featureVector),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE VECTOR — Normalize trade conditions for ML
  // ═══════════════════════════════════════════════════════════════════════

  private _buildFeatureVector(
    marketCtx: { vix: number | null; regime: string } | undefined,
    pos: Position,
    signalMeta: { confidence: number; impactScore: number } | undefined
  ): number[] {
    // Normalized features:
    // 0: VIX / 50 (capped at 1.0)
    // 1: confidence
    // 2: impactScore / 10
    // 3: position size / 100
    // 4: isTrendingUp (1/0)
    // 5: isChop (1/0)
    // 6: isVolatile (1/0)
    const vixNorm = Math.min((marketCtx?.vix ?? 18) / 50, 1.0);
    const conf = Math.min(Math.max(signalMeta?.confidence ?? 0.5, 0), 1);
    const impact = Math.min(Math.max((signalMeta?.impactScore ?? 0) / 10, -1), 1);
    const size = Math.min(pos.notional / 100, 1.0);
    const regime = marketCtx?.regime ?? "unknown";

    return [
      vixNorm,
      conf,
      impact,
      size,
      regime === "trending_up" ? 1 : 0,
      regime === "chop" ? 1 : 0,
      regime === "volatile" ? 1 : 0,
    ];
  }

  private _cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ACTIVITY STREAM — Dashboard event log
  // ═══════════════════════════════════════════════════════════════════════

  recordActivity(
    type: ActivityEventType,
    summary: string,
    options?: {
      details?: string;
      metadata?: Record<string, unknown>;
    }
  ): ActivityEvent {
    const event: ActivityEvent = {
      id: `evt_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 14)}`,
      timestamp: new Date().toISOString(),
      type,
      summary,
      details: options?.details,
      metadata: options?.metadata,
    };
    this.state.activityStream.push(event);
    // Keep last 500 events
    if (this.state.activityStream.length > 500) {
      this.state.activityStream = this.state.activityStream.slice(-400);
    }
    this.save();
    return event;
  }

  /** Get activity stream events in reverse chronological order. */
  getActivityStream(limit: number = 50): ActivityEvent[] {
    return [...this.state.activityStream].reverse().slice(0, limit);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HALT / LESSONS
  // ═══════════════════════════════════════════════════════════════════════

  halt(reason: string) {
    this.state.halted = true;
    this.state.haltReason = reason;
    this.recordActivity("halt", `Trading halted — ${reason}`);
    this.save();
  }

  /** Lift the trading halt. */
  unhalt() {
    const wasHalted = this.state.halted;
    this.state.halted = false;
    this.state.haltReason = null;
    if (wasHalted) {
      this.recordActivity("halt_lifted", "Trading resumed after halt");
    }
    this.save();
  }

  /**
   * REPLACE the entire lesson set (called by the retrospective lesson integrator).
   * This is NOT additive. The LLM receives existing lessons + new data and returns
   * an evolved set — some merged, some modified, some removed, some new.
   */
  addLesson(lesson: Lesson | string) {
    const entry: Lesson = typeof lesson === "string"
      ? { id: crypto.randomUUID?.() || Math.random().toString(36).slice(2), category: "manual", insight: lesson, weight: 0.5, reinforcementCount: 0, lastReinforcedAt: new Date().toISOString(), createdAt: new Date().toISOString(), deprecated: false, featureVector: [] }
      : lesson;
    this.state.memory.lessons.push(entry);
    this.save();
  }

  replaceAllLessons(lessons: Lesson[]) {
    this.state.memory.lessons = lessons;
    this.state.memory.lastReflection = new Date().toISOString();
    this.save();
  }

  /** Get lessons that are active (not deprecated), sorted by weight descending. */
  getActiveLessons(): Lesson[] {
    return this.state.memory.lessons
      .filter((l): l is Lesson => typeof l === 'object' && l !== null && !l.deprecated)
      .sort((a, b) => b.weight - a.weight);
  }

  /** Format active lessons for the perception prompt — compact, weighted. */
  formatLessonsForPrompt(): string {
    const active = this.getActiveLessons();
    if (active.length === 0) return "";

    const lines = ["📚 ACTIVE LESSONS (from retrospective analysis):"];
    for (const l of active.slice(0, 5)) {
      // Safety: guard against legacy string-format lessons that might slip through
      if (typeof l !== 'object' || l === null) continue;
      const stars = l.weight >= 0.8 ? "🔴" : l.weight >= 0.5 ? "🟡" : "🟢";
      const ctx = l.context ? ` [${l.context}]` : "";
      lines.push(`  ${stars} [${l.category}]${ctx} ${(l.insight || "").slice(0, 150)}${l.reinforcementCount > 1 ? ` (confirmed ${l.reinforcementCount}x)` : ""}`);
    }
    if (active.length > 5) {
      lines.push(`  ... and ${active.length - 5} more lessons (use consult_memory to search all)`);
    }
    return lines.join("\n");
  }

  /**
   * Find lessons relevant to a specific trade setup.
   * Uses cosine similarity against lesson feature vectors.
   */
  findRelevantLessons(featureVector: number[], topK: number = 3): Lesson[] {
    const active = this.getActiveLessons();
    if (active.length === 0) return [];

    const scored = active.map((l) => ({
      lesson: l,
      similarity: this._cosineSimilarity(featureVector, l.featureVector),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK).map((s) => s.lesson);
  }

  /**
   * Build a lesson feature vector from current market + trade conditions.
   * Same 7-dim space as trade feature vectors so cosine similarity works.
   */
  buildLessonFeatureVector(params: {
    vix: number | null;
    regime: string;
    confidence: number;
    impactScore: number;
    notional: number;
  }): number[] {
    const vixNorm = Math.min((params.vix ?? 18) / 50, 1.0);
    const conf = Math.min(Math.max(params.confidence, 0), 1);
    const impact = Math.min(Math.max(params.impactScore / 10, -1), 1);
    const size = Math.min(params.notional / 100, 1.0);
    return [
      vixNorm,
      conf,
      impact,
      size,
      params.regime === "trending_up" ? 1 : 0,
      params.regime === "chop" ? 1 : 0,
      params.regime === "volatile" ? 1 : 0,
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRE-MARKET BRIEFING — Overnight data for market open
  // ═══════════════════════════════════════════════════════════════════════

  getPreMarketBriefing(): string | null {
    return this.state.preMarketBriefing ?? null;
  }

  setPreMarketBriefing(briefing: string) {
    this.state.preMarketBriefing = briefing;
    this.save();
  }

  clearPreMarketBriefing() {
    this.state.preMarketBriefing = null;
    this.save();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTEXT NOTES — Agent-curated persistent awareness
  // ═══════════════════════════════════════════════════════════════════════

  getContextNotes(): Array<{
    id: string;
    ticker?: string;
    topic: string;
    note: string;
    createdAt: string;
    lastSeen: string;
    cycleCount: number;
  }> {
    return this.state.memory.contextNotes || [];
  }

  addContextNote(note: {
    id: string;
    ticker?: string;
    topic: string;
    note: string;
    createdAt: string;
    lastSeen: string;
    cycleCount: number;
  }) {
    // If a note with same ticker+topic exists, update it instead (dedup)
    const existingIdx = this.state.memory.contextNotes.findIndex(
      (n) => n.ticker === note.ticker && n.topic === note.topic
    );
    if (existingIdx >= 0) {
      this.state.memory.contextNotes[existingIdx].note = note.note;
      this.state.memory.contextNotes[existingIdx].lastSeen = note.lastSeen;
      this.state.memory.contextNotes[existingIdx].cycleCount++;
    } else {
      this.state.memory.contextNotes.push(note);
    }
    // Keep max 50 notes
    if (this.state.memory.contextNotes.length > 50) {
      this.state.memory.contextNotes = this.state.memory.contextNotes.slice(-40);
    }
    this.save();
  }

  removeContextNotes(ids: string[]) {
    const idSet = new Set(ids);
    this.state.memory.contextNotes = this.state.memory.contextNotes.filter((n) => !idSet.has(n.id));
    this.save();
  }

  /** Remove notes not touched in N minutes. Returns count removed. */
  pruneStaleContextNotes(maxAgeMinutes: number): number {
    const cutoff = Date.now() - maxAgeMinutes * 60000;
    const before = this.state.memory.contextNotes.length;
    this.state.memory.contextNotes = this.state.memory.contextNotes.filter(
      (n) => new Date(n.lastSeen).getTime() > cutoff
    );
    const removed = before - this.state.memory.contextNotes.length;
    if (removed > 0) this.save();
    return removed;
  }

  /** Touch a note's lastSeen (called each cycle for notes the agent references). */
  touchContextNote(id: string) {
    const note = this.state.memory.contextNotes.find((n) => n.id === id);
    if (note) {
      note.lastSeen = new Date().toISOString();
      note.cycleCount++;
      this.save();
    }
  }

  /** Get context notes formatted for the perception prompt (compact). */
  formatContextNotesForPrompt(): string {
    const notes = this.getContextNotes();
    if (notes.length === 0) return "";

    const lines = ["📋 ACTIVE CONTEXT NOTES:"];
    for (const n of notes) {
      const age = Math.round((Date.now() - new Date(n.createdAt).getTime()) / 60000);
      const sinceLast = Math.round((Date.now() - new Date(n.lastSeen).getTime()) / 60000);
      lines.push(`   [${n.topic}]${n.ticker ? ` ${n.ticker}` : ""} — ${n.note.slice(0, 120)} (${age}m old, ${sinceLast}m since update)`);
    }
    return lines.join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOKEN COST TRACKING
  // ═══════════════════════════════════════════════════════════════════════

  recordTokenUsage(inputTokens: number, outputTokens: number, inputCost: number, outputCost: number) {
    this.state.sessionInputTokens += inputTokens;
    this.state.sessionOutputTokens += outputTokens;
    this.state.sessionInputCost += inputCost;
    this.state.sessionOutputCost += outputCost;
    this.save();
  }

  getSessionTokenTotals() {
    return {
      inputTokens: this.state.sessionInputTokens,
      outputTokens: this.state.sessionOutputTokens,
      inputCost: Math.round(this.state.sessionInputCost * 100000) / 100000,
      outputCost: Math.round(this.state.sessionOutputCost * 100000) / 100000,
      totalCost: Math.round((this.state.sessionInputCost + this.state.sessionOutputCost) * 100000) / 100000,
    };
  }

  getDailyTokenCost(date?: string): DailyTokenCost | null {
    const target = date ?? getTradingDate();
    const entry = this.state.tokenCosts.find(c => c.date === target);
    if (entry) return entry;
    // If it's today and not finalized yet, return current session
    if (target === this.state.today) {
      return {
        date: target,
        inputTokens: this.state.sessionInputTokens,
        outputTokens: this.state.sessionOutputTokens,
        inputCost: Math.round(this.state.sessionInputCost * 100000) / 100000,
        outputCost: Math.round(this.state.sessionOutputCost * 100000) / 100000,
        totalCost: Math.round((this.state.sessionInputCost + this.state.sessionOutputCost) * 100000) / 100000,
      };
    }
    return null;
  }

  getTokenCostHistory(days?: number): DailyTokenCost[] {
    const result = [...this.state.tokenCosts];
    // Include current session as a provisional entry
    const todayEntry = this.getDailyTokenCost();
    if (todayEntry && !result.find(c => c.date === todayEntry.date)) {
      result.push(todayEntry);
    }
    result.sort((a, b) => a.date.localeCompare(b.date));
    if (days && days < result.length) {
      return result.slice(-days);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DAILY RETROSPECTIVE REPORTS
  // ═══════════════════════════════════════════════════════════════════════

  /** Get all trades that were executed on a specific date. */
  getTradesForDay(date: string): TradeRecord[] {
    return this.state.tradeHistory.filter((t) => t.timestamp.slice(0, 10) === date);
  }

  /** Get portfolio snapshots for a specific date. */
  getSnapshotsForDay(date: string): PortfolioSnapshot[] {
    return this.state.portfolioHistory.filter((s) => s.timestamp.slice(0, 10) === date);
  }

  /** Get the full portfolio snapshot history (all dates). */
  getSnapshotHistory(): PortfolioSnapshot[] {
    return this.state.portfolioHistory;
  }

  /** Fetch current total account equity from Alpaca. Falls back to internal calculation on error. */
  async getAccountEquity(): Promise<number> {
    try {
      const account = await getAccount();
      if (account.equity != null && account.equity > 0) {
        return Math.round(account.equity * 100) / 100;
      }
    } catch {
      // fall through to internal calculation
    }
    // Fallback: compute from internal state
    const openNotional = this.state.positions.reduce((s, p) => s + p.notional, 0);
    const unrealizedPnL = this.state.positions.reduce((s, p) => s + (p.unrealizedPnL || 0), 0);
    return Math.round((this.state.cash + openNotional + unrealizedPnL) * 100) / 100;
  }

  /** Save a daily retrospective report. */
  saveDailyReport(report: DailyReport) {
    // Replace existing report for the same date, or append
    const idx = this.state.dailyReports.findIndex((r) => r.date === report.date);
    if (idx >= 0) {
      this.state.dailyReports[idx] = report;
    } else {
      this.state.dailyReports.push(report);
    }
    // Keep max 90 reports (3 months of daily)
    if (this.state.dailyReports.length > 90) {
      this.state.dailyReports = this.state.dailyReports.slice(-60);
    }
    this.save();
  }

  /** Get the latest daily retrospective report (most recent date). */
  getLatestReport(): DailyReport | null {
    if (this.state.dailyReports.length === 0) return null;
    const sorted = [...this.state.dailyReports].sort((a, b) => a.date.localeCompare(b.date));
    return sorted[sorted.length - 1];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXPORT — For dashboards
  // ═══════════════════════════════════════════════════════════════════════

  exportForDashboard() {
    return {
      portfolioHistory: this.state.portfolioHistory,
      tradeHistory: this.state.tradeHistory,
      calibrationTable: this.state.calibrationTable,
      positions: this.state.positions,
      cash: this.state.cash,
      settledCash: this.state.settledCash,
      dailyPnL: this.state.dailyPnL,
      lessons: this.state.memory.lessons.filter((l) => !l.deprecated).map((l) => l.insight),
      sessionTokens: {
        inputTokens: this.state.sessionInputTokens,
        outputTokens: this.state.sessionOutputTokens,
        totalCost: Math.round((this.state.sessionInputCost + this.state.sessionOutputCost) * 100000) / 100000,
      },
    };
  }
}
