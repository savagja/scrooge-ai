/**
 * Core types for the Scrooge trading brain.
 * Designed for persistence, dashboard rendering, and machine learning.
 */

// ═══════════════════════════════════════════════════════════════════════════
// MARKET & POSITIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface MarketState {
  timestamp: string;
  isMarketOpen: boolean;
  vix: number | null;
  spyChangePct: number | null;
  breadth: "strong" | "neutral" | "weak" | null;
  regime: "trending_up" | "trending_down" | "chop" | "volatile" | "unknown";
}

export interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryTime: string;
  holdUntil: string;
  notional: number;
  unrealizedPnL: number;
  strategy: string;
  trailingStopPrice: number | null;
  highestPrice: number;
  status: "initial" | "green" | "trailing";
  // Entry context — captured at entry time for learning
  entryVix: number | null;
  entrySpyChange: number | null;
  entryRegime: string;
  entrySignalConfidence: number;
  entrySignalImpactScore: number;
  entrySignalSource: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADES — Rich context for learning
// ═══════════════════════════════════════════════════════════════════════════

export interface TradeRecord {
  id: string;
  timestamp: string;        // Exit timestamp
  symbol: string;
  strategy: string;
  direction: "long" | "short";

  // Prices
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notional: number;
  pnl: number;
  pnlPct: number;

  // Exit metadata
  exitReason: string;
  holdMinutesActual: number;
  wasPromoted: boolean;     // Did it hit green (+1%) and activate trailing stop?
  timeToGreen: number | null; // Minutes to reach green threshold (null if never)

  // Market context AT ENTRY
  vixAtEntry: number | null;
  spyChangeAtEntry: number | null;
  marketRegimeAtEntry: string;

  // Signal metadata
  signalSource: string;     // "edgar", "news_momentum", "mean_reversion", "volume", "discovery"
  signalConfidence: number; // LLM confidence (0-1)
  signalImpactScore: number; // LLM impact score (-10 to 10)
  agentReasoning: string;   // Why the agent took this trade

  // For vector similarity search
  featureVector: number[];   // Normalized feature vector for similarity queries
}

// ═══════════════════════════════════════════════════════════════════════════
// PORTFOLIO SNAPSHOTS — For equity curves & dashboards
// ═══════════════════════════════════════════════════════════════════════════

export interface PortfolioSnapshot {
  timestamp: string;
  totalEquity: number;
  cash: number;
  settledCash: number;
  positionsCount: number;
  openNotional: number;     // Total $ in open positions
  dailyPnL: number;
  unrealizedPnL: number;
  vix: number | null;
  regime: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY CALIBRATION — Phase 2: Data-driven confidence adjustment
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategyCalibration {
  strategy: string;
  regime: string;
  wins: number;
  losses: number;
  avgWinPct: number;
  avgLossPct: number;
  winRate: number;
  avgTimeToGreen: number | null;
  totalTrades: number;
  // Updated after every trade
  lastUpdated: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR MEMORY — Phase 3: Similarity search
// ═══════════════════════════════════════════════════════════════════════════

export interface VectorMemoryEntry {
  tradeId: string;
  symbol: string;
  featureVector: number[];
  outcome: "win" | "loss";
  pnlPct: number;
  timestamp: string;
  similarity?: number;  // populated at query time by cosine similarity
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT MEMORY
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentMemory {
  lessons: string[];
  strategyPerformance: Record<string, {
    wins: number;
    losses: number;
    avgWin: number;
    avgLoss: number;
    winRate: number;
  }>;
  lastReflection: string | null;
  /** Persistent notes the agent has written about tickers, sectors, or market conditions it's tracking.
   *  Each note has a timestamp — the agent sees them every cycle and decides to keep or drop them. */
  contextNotes: Array<{
    id: string;
    ticker?: string;
    topic: string;
    note: string;
    createdAt: string;
    lastSeen: string;
    cycleCount: number;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNALS & RISK
// ═══════════════════════════════════════════════════════════════════════════

export interface Signal {
  symbol: string;
  strategy: string;
  direction: "long" | "short" | "neutral";
  confidence: number;
  impactScore: number;
  reasoning: string;
  suggestedSizePct: number;
  suggestedHoldMinutes: number;
}

export interface RiskCheck {
  allowed: boolean;
  size: number;
  reason: string;
}

export interface StrategyTool {
  name: string;
  description: string;
  whenToUse: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTED STATE (what goes into state.json)
// ═══════════════════════════════════════════════════════════════════════════

export interface PersistedState {
  cash: number;
  settledCash: number;
  dailyPnL: number;
  today: string;
  positions: Position[];
  tradeHistory: TradeRecord[];
  portfolioHistory: PortfolioSnapshot[];      // NEW: equity curve data
  calibrationTable: StrategyCalibration[];    // NEW: strategy × regime stats
  vectorMemory: VectorMemoryEntry[];          // NEW: similarity search index
  memory: AgentMemory;
  halted: boolean;
  haltReason: string | null;
  preMarketBriefing: string | null;           // Overnight briefing built before market open
}
