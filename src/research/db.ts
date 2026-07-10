/**
 * Research database layer.
 * SQLite-backed persistent store for signals, fundamentals, corporate events.
 * Uses sql.js (pure JS/WASM) — zero native deps, works on any platform including armv7l.
 *
 * All data gathered deterministically by code. The agent queries through tools.
 * No LLM involvement in data collection, aggregation, or storage.
 */

import initSqlJs, { type Database, type SqlValue } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import crypto from "crypto";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

// Major sector ETFs for tracking sector rotation
const SECTOR_ETFS: Record<string, string> = {
  "XLF": "Financials",
  "XLK": "Technology",
  "XLE": "Energy",
  "XLV": "Health Care",
  "XLI": "Industrials",
  "XLP": "Consumer Staples",
  "XLY": "Consumer Discretionary",
  "XLU": "Utilities",
  "XLB": "Materials",
  "XLRE": "Real Estate",
  "SMH": "Semiconductors",
  "IBB": "Biotechnology",
  "ARKK": "Innovation/Cathie Wood",
  "GDX": "Gold Miners",
  "SLV": "Silver",
  "TLT": "Long-Term Treasuries",
  "HYG": "High-Yield Bonds",
  "KWEB": "China Internet",
  "EEM": "Emerging Markets",
  "SPY": "S&P 500",
  "QQQ": "Nasdaq",
  "IWM": "Russell 2000 (Small Cap)",
  "DIA": "Dow Jones",
  "VXX": "VIX Short-Term Futures",
};

export { SECTOR_ETFS };

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type SignalSource =
  | "yahoo_mover"
  | "alpaca_news"
  | "edgar"
  | "reddit"
  | "volume_spike"
  | "gap"
  | "range_break"
  | "technicals";

export type CorporateEventType =
  | "earnings"
  | "dividend"
  | "split"
  | "buyback"
  | "acquisition"
  | "insider_trade"
  | "sec_filing";

export interface SignalQuery {
  ticker?: string;
  sources?: SignalSource[];
  minScore?: number;
  sinceMinutes?: number;
  granularity?: "raw" | "hourly" | "daily";
  sortBy?: "time" | "score";
  maxResults?: number;
  fundamentalsFilter?: string;
  includeFundamentals?: boolean;
}

export interface TableInfo {
  name: string;
  rowCount: number;
  columns: Array<{ name: string; type: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function uuid(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hourBucket(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:00:00`;
}

function dateBucket(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Execute a query and return rows as objects. */
function rowsToObjects(headers: string[], values: any[][]): Record<string, unknown>[] {
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = row[i];
    }
    return obj;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS tickers (
    symbol      TEXT PRIMARY KEY,
    name        TEXT,
    sector      TEXT,
    industry    TEXT,
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    is_active   INTEGER DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id          TEXT PRIMARY KEY,
    ticker      TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    source      TEXT NOT NULL,
    score       REAL NOT NULL,
    direction   REAL NOT NULL,
    payload     TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sig_ticker ON signals(ticker)`,
  `CREATE INDEX IF NOT EXISTS idx_sig_ts ON signals(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_sig_source ON signals(source)`,
  `CREATE INDEX IF NOT EXISTS idx_sig_lookup ON signals(ticker, timestamp DESC)`,
  `CREATE TABLE IF NOT EXISTS signal_hourly (
    ticker      TEXT NOT NULL,
    source      TEXT NOT NULL,
    bucket_hour TEXT NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    avg_score   REAL NOT NULL DEFAULT 0,
    max_score   REAL NOT NULL DEFAULT 0,
    bullish_ct  INTEGER NOT NULL DEFAULT 0,
    bearish_ct  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ticker, source, bucket_hour)
  )`,
  `CREATE TABLE IF NOT EXISTS signal_daily (
    ticker      TEXT NOT NULL,
    source      TEXT NOT NULL,
    bucket_date TEXT NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    avg_score   REAL NOT NULL DEFAULT 0,
    max_score   REAL NOT NULL DEFAULT 0,
    bullish_ct  INTEGER NOT NULL DEFAULT 0,
    bearish_ct  INTEGER NOT NULL DEFAULT 0,
    source_ct   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ticker, source, bucket_date)
  )`,
  `CREATE TABLE IF NOT EXISTS sector_signals (
    id          TEXT PRIMARY KEY,
    sector      TEXT NOT NULL,
    source      TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    headline    TEXT,
    score       REAL NOT NULL DEFAULT 0.5,
    direction   REAL NOT NULL DEFAULT 0,
    impact      TEXT  -- "high" | "medium" | "low"
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ss_sector ON sector_signals(sector)`,
  `CREATE INDEX IF NOT EXISTS idx_ss_ts ON sector_signals(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_ss_source ON sector_signals(source)`,
  `CREATE TABLE IF NOT EXISTS macro_events (
    id          TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,  -- "cpi" | "fomc" | "nfp" | "ppi" | "tariff" | "regulation" | "other"
    headline    TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    source      TEXT NOT NULL,
    impact      TEXT,  -- "high" | "medium" | "low"
    payload     TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_me_type ON macro_events(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_me_ts ON macro_events(timestamp)`,
  `CREATE VIEW IF NOT EXISTS v_cross_sector AS
   SELECT timestamp, sector, source, headline, score, direction
   FROM sector_signals
   WHERE impact = 'high'
   ORDER BY timestamp DESC
   LIMIT 100`,
  `CREATE TABLE IF NOT EXISTS fundamentals (
    ticker             TEXT NOT NULL,
    as_of_date         TEXT NOT NULL,
    source             TEXT NOT NULL,
    market_cap         REAL, pe_ratio     REAL, forward_pe    REAL,
    ps_ratio          REAL, pb_ratio     REAL, ev_to_ebitda  REAL,
    total_cash        REAL, total_debt   REAL, book_value    REAL,
    free_cash_flow    REAL, current_ratio REAL, debt_to_equity REAL,
    revenue_ttm       REAL, gross_margin REAL, operating_margin REAL,
    net_margin        REAL, eps_ttm      REAL, eps_growth_yoy REAL,
    revenue_growth_yoy REAL,
    avg_volume_20d    REAL, avg_volume_50d REAL, rsi_14        REAL,
    sma_20            REAL, sma_50       REAL, sma_200       REAL,
    volatility_30d    REAL, beta          REAL,
    sector_median_pe  REAL, sector_median_ps REAL,
    sector_avg_beta   REAL, sector_momentum REAL,
    PRIMARY KEY (ticker, as_of_date, source)
  )`,
  `CREATE TABLE IF NOT EXISTS corporate_events (
    id          TEXT PRIMARY KEY,
    ticker      TEXT NOT NULL,
    event_date  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    impact      REAL,
    details     TEXT,
    source_url  TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ev_ticker ON corporate_events(ticker)`,
  `CREATE INDEX IF NOT EXISTS idx_ev_date ON corporate_events(event_date)`,
  `CREATE INDEX IF NOT EXISTS idx_ev_type ON corporate_events(event_type)`,
  `CREATE VIEW IF NOT EXISTS v_cross_daily AS
   SELECT bucket_date, ticker,
          SUM(event_count) AS total_events,
          COUNT(DISTINCT source) AS source_count,
          AVG(avg_score) AS mean_score,
          SUM(bullish_ct) AS total_bullish,
          SUM(bearish_ct) AS total_bearish
   FROM signal_daily GROUP BY bucket_date, ticker`,
  `CREATE TABLE IF NOT EXISTS technical_indicators (
    symbol               TEXT NOT NULL,
    timestamp            TEXT NOT NULL,  -- date of the last bar used (YYYY-MM-DD)
    sma_20               REAL,
    sma_50               REAL,
    sma_200              REAL,
    ema_8                REAL,
    ema_21               REAL,
    ema_50               REAL,
    rsi_14               REAL,
    macd_line            REAL,
    macd_signal          REAL,
    macd_histogram       REAL,
    atr_14               REAL,
    bollinger_upper      REAL,
    bollinger_middle     REAL,
    bollinger_lower      REAL,
    bollinger_band_pct   REAL,
    consecutive_up       INTEGER NOT NULL DEFAULT 0,
    consecutive_down     INTEGER NOT NULL DEFAULT 0,
    close_above_sma_20   INTEGER,
    close_above_sma_50   INTEGER,
    ema_8_above_ema_21   INTEGER,
    ema_21_above_ema_50  INTEGER,
    PRIMARY KEY (symbol, timestamp)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ti_symbol ON technical_indicators(symbol)`,
  `CREATE INDEX IF NOT EXISTS idx_ti_ts ON technical_indicators(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_ti_rsi ON technical_indicators(rsi_14)`,
  `CREATE INDEX IF NOT EXISTS idx_ti_bb ON technical_indicators(bollinger_band_pct)`,
  `CREATE TABLE IF NOT EXISTS _internal (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

const RETENTION_RAW_MS = 14 * 86400_000;
const RETENTION_HOURLY_MS = 90 * 86400_000;
const RETENTION_DAILY_MS = 365 * 86400_000;

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL STORE CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class SignalStore {
  private db: Database | null = null;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private initDone = false;
  private meta: Record<string, string> = {};

  /** Internal metadata store for cursor tracking across restarts. */
  _getMeta(key: string): string | null {
    return this.meta[key] ?? null;
  }

  /** Internal metadata setter for cursor tracking. */
  _setMeta(key: string, value: string): void {
    this.meta[key] = value;
  }

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  // ── LIFECYCLE ─────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    mkdirSync(dirname(this.dbPath), { recursive: true });

    if (existsSync(this.dbPath)) {
      this.db = new SQL.Database(readFileSync(this.dbPath));
    } else {
      this.db = new SQL.Database();
    }

    for (const sql of SCHEMA_SQL) {
      this.db.run(sql);
    }

    // Persist empty schema to disk
    this.flush();
    this.initDone = true;

    // Load internal metadata from _internal table
    const metaResult = this.db.exec(`SELECT key, value FROM _internal`);
    if (metaResult.length > 0) {
      for (const row of metaResult[0].values) {
        this.meta[String(row[0])] = String(row[1]);
      }
    }
  }

  flush(): void {
    if (!this.db) return;
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }

  private _save(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.flush();
      this.saveTimer = null;
    }, 2000);
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flush();
    this.db?.close();
    this.db = null;
  }

  private assertReady(): Database {
    if (!this.db || !this.initDone) throw new Error("SignalStore not initialized. Call init() first.");
    return this.db;
  }

  /**
   * Execute arbitrary SQL and return results as objects.
   * Used by macro.ts for earnings tag queries.
   */
  _execSql(sql: string, params?: any[]): Record<string, unknown>[] {
    const db = this.assertReady();
    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  // ── TICKERS ─────────────────────────────────────────────────────────────

  ensureTicker(symbol: string, name?: string, sector?: string, industry?: string): void {
    const db = this.assertReady();
    const sym = symbol.toUpperCase();
    const now = new Date().toISOString();

    const existing = db.exec(`SELECT symbol FROM tickers WHERE symbol = ?`, [sym]);
    if (existing.length > 0 && existing[0].values.length > 0) {
      db.run(
        `UPDATE tickers SET last_seen = ?, sector = COALESCE(?, sector), industry = COALESCE(?, industry), name = COALESCE(?, name) WHERE symbol = ?`,
        [now, sector ?? null, industry ?? null, name ?? null, sym]
      );
    } else {
      db.run(
        `INSERT INTO tickers (symbol, name, sector, industry, first_seen, last_seen, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [sym, name ?? null, sector ?? null, industry ?? null, now, now]
      );
    }
    this._save();
  }

  // ── SIGNALS ───────────────────────────────────────────────────────────────

  recordSignal(params: {
    ticker: string;
    source: SignalSource;
    score: number;
    direction: number;
    payload?: Record<string, unknown>;
  }): void {
    this.recordSignals([params]);
  }

  recordSignals(signals: Array<{
    ticker: string;
    source: SignalSource;
    score: number;
    direction: number;
    payload?: Record<string, unknown>;
  }>): void {
    const db = this.assertReady();
    const now = new Date().toISOString();

    for (const s of signals) {
      const sym = s.ticker.toUpperCase();
      const id = uuid();
      const payloadStr = s.payload ? JSON.stringify(s.payload) : null;

      db.run(
        `INSERT INTO signals (id, ticker, timestamp, source, score, direction, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, sym, now, s.source, s.score, s.direction, payloadStr]
      );

      // Update hourly aggregate
      const hb = hourBucket(now);
      const isBullish = s.direction > 0 ? 1 : 0;
      const isBearish = s.direction < 0 ? 1 : 0;
      db.run(
        `INSERT INTO signal_hourly (ticker, source, bucket_hour, event_count, avg_score, max_score, bullish_ct, bearish_ct)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(ticker, source, bucket_hour) DO UPDATE SET
           event_count = event_count + 1,
           avg_score = (avg_score * (event_count - 1) + ?) / event_count,
           max_score = MAX(max_score, ?),
           bullish_ct = bullish_ct + ?,
           bearish_ct = bearish_ct + ?`,
        [sym, s.source, hb, s.score, s.score, isBullish, isBearish,
         s.score, s.score, isBullish, isBearish]
      );

      this.ensureTicker(sym);
    }
    this._save();
  }

  // ── SEARCH ────────────────────────────────────────────────────────────

  searchSignals(query: SignalQuery): Record<string, unknown>[] {
    const db = this.assertReady();
    const since = new Date(Date.now() - (query.sinceMinutes ?? 1440) * 60000).toISOString();
    const limit = Math.min(query.maxResults ?? 50, 200);

    // Choose granularity
    const useGranularity = query.granularity ?? "raw";

    if (useGranularity === "hourly") {
      return this._searchHourly(db, since, query, limit);
    }
    if (useGranularity === "daily") {
      return this._searchDaily(db, since, query, limit);
    }

    // Raw signal search
    let sql = `SELECT s.* FROM signals s WHERE s.timestamp >= ?`;
    const params: any[] = [since];

    if (query.ticker) {
      sql += ` AND s.ticker = ?`;
      params.push(query.ticker.toUpperCase());
    }
    if (query.sources && query.sources.length > 0) {
      const placeholders = query.sources.map(() => "?").join(",");
      sql += ` AND s.source IN (${placeholders})`;
      params.push(...query.sources);
    }
    if (query.minScore !== undefined) {
      sql += ` AND s.score >= ?`;
      params.push(query.minScore);
    }

    sql += query.sortBy === "time" ? ` ORDER BY s.timestamp DESC` : ` ORDER BY s.score DESC`;
    sql += ` LIMIT ?`;
    params.push(limit);

    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  private _searchHourly(db: Database, since: string, query: SignalQuery, limit: number): Record<string, unknown>[] {
    let sql = `SELECT * FROM signal_hourly WHERE bucket_hour >= ?`;
    const params: any[] = [since.slice(0, 16) + ":00"];

    if (query.ticker) {
      sql += ` AND ticker = ?`;
      params.push(query.ticker.toUpperCase());
    }
    if (query.sources && query.sources.length > 0) {
      const ph = query.sources.map(() => "?").join(",");
      sql += ` AND source IN (${ph})`;
      params.push(...query.sources);
    }
    if (query.minScore !== undefined) {
      sql += ` AND avg_score >= ?`;
      params.push(query.minScore);
    }
    sql += ` ORDER BY ${query.sortBy === "time" ? "bucket_hour DESC" : "max_score DESC"} LIMIT ?`;
    params.push(limit);

    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  private _searchDaily(db: Database, since: string, query: SignalQuery, limit: number): Record<string, unknown>[] {
    let sql = `SELECT * FROM signal_daily WHERE bucket_date >= ?`;
    const params: any[] = [since.slice(0, 10)];

    if (query.ticker) {
      sql += ` AND ticker = ?`;
      params.push(query.ticker.toUpperCase());
    }
    if (query.sources && query.sources.length > 0) {
      const ph = query.sources.map(() => "?").join(",");
      sql += ` AND source IN (${ph})`;
      params.push(...query.sources);
    }
    if (query.minScore !== undefined) {
      sql += ` AND avg_score >= ?`;
      params.push(query.minScore);
    }
    sql += ` ORDER BY ${query.sortBy === "time" ? "bucket_date DESC" : "max_score DESC"} LIMIT ?`;
    params.push(limit);

    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  // ── CROSS-SOURCE CLUSTERS ───────────────────────────────────────────────

  /**
   * Find tickers that appeared in 2+ sources within a time window.
   * Returns clusters sorted by source count descending.
   */
  findClusters(minSources: number = 2, sinceMinutes: number = 1440): Record<string, unknown>[] {
    const db = this.assertReady();
    const since = new Date(Date.now() - sinceMinutes * 60000).toISOString();

    const result = db.exec(
      `SELECT ticker, COUNT(DISTINCT source) AS source_count,
              AVG(score) AS avg_score, SUM(CASE WHEN direction > 0 THEN 1 ELSE 0 END) AS bullish_total,
              SUM(CASE WHEN direction < 0 THEN 1 ELSE 0 END) AS bearish_total,
              COUNT(*) AS total_signals
       FROM signals
       WHERE timestamp >= ?
       GROUP BY ticker
       HAVING source_count >= ?
       ORDER BY source_count DESC, avg_score DESC
       LIMIT 50`,
      [since, minSources]
    );

    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  // ── SECTOR SIGNALS ──────────────────────────────────────────────────────

  /**
   * Sector-level and macro signals (Fed, Treasury, sector rotation, political news).
   * Not scoped to a single ticker — scoped to a sector, asset class, or "macro"/"political".
   */
  recordSectorSignal(params: {
    sector: string;
    source: SignalSource | "sector_rotation" | "macro_event" | "political_news" | "sector_news";
    headline: string;
    score?: number;
    direction?: number;  // 1 = bullish for the sector, -1 = bearish, 0 = neutral
    impact?: "high" | "medium" | "low";
  }): void {
    const db = this.assertReady();
    const id = uuid();
    db.run(
      `INSERT INTO sector_signals (id, sector, source, timestamp, headline, score, direction, impact)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, params.sector, params.source, new Date().toISOString(), params.headline,
       params.score ?? 0.5, params.direction ?? 0, params.impact ?? "medium"]
    );
    this._save();
  }

  getSectorSignals(sector?: string, sinceMinutes?: number, impact?: string): Record<string, unknown>[] {
    const db = this.assertReady();
    let sql = `SELECT * FROM sector_signals WHERE 1=1`;
    const params: any[] = [];
    if (sector) { sql += ` AND sector = ?`; params.push(sector); }
    if (sinceMinutes !== undefined) {
      sql += ` AND timestamp >= ?`;
      params.push(new Date(Date.now() - sinceMinutes * 60000).toISOString());
    }
    if (impact) { sql += ` AND impact = ?`; params.push(impact); }
    sql += ` ORDER BY timestamp DESC LIMIT 100`;
    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  // ── MACRO EVENTS ────────────────────────────────────────────────────────

  recordMacroEvent(params: {
    eventType: string;
    headline: string;
    impact?: string;
    payload?: Record<string, unknown>;
  }): void {
    const db = this.assertReady();
    const id = uuid();
    db.run(
      `INSERT INTO macro_events (id, event_type, headline, timestamp, source, impact, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, params.eventType, params.headline, new Date().toISOString(), "macro_calendar",
       params.impact ?? "medium", params.payload ? JSON.stringify(params.payload) : null]
    );
    this._save();
  }

  getMacroEvents(eventType?: string, sinceMinutes?: number): Record<string, unknown>[] {
    const db = this.assertReady();
    let sql = `SELECT * FROM macro_events WHERE 1=1`;
    const params: any[] = [];
    if (eventType) { sql += ` AND event_type = ?`; params.push(eventType); }
    if (sinceMinutes !== undefined) {
      sql += ` AND timestamp >= ?`;
      params.push(new Date(Date.now() - sinceMinutes * 60000).toISOString());
    }
    sql += ` ORDER BY timestamp DESC LIMIT 50`;
    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  /** Get latest sector rotation data (which sectors are hot/cold). */
  getSectorRotation(sinceMinutes?: number): Record<string, unknown>[] {
    const db = this.assertReady();
    const since = new Date(Date.now() - (sinceMinutes ?? 1440) * 60000).toISOString();
    // Returns aggregate of sector signals grouped by sector, ordered by volume of activity
    const result = db.exec(
      `SELECT sector, COUNT(*) AS signal_count,
              AVG(score) AS avg_score,
              SUM(CASE WHEN direction > 0 THEN 1 ELSE 0 END) AS bullish,
              SUM(CASE WHEN direction < 0 THEN 1 ELSE 0 END) AS bearish
       FROM sector_signals
       WHERE timestamp >= ?
       GROUP BY sector
       ORDER BY signal_count DESC
       LIMIT 30`,
      [since]
    );
    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  upsertFundamentals(ticker: string, asOfDate: string, source: string, data: Record<string, unknown>): void {
    const db = this.assertReady();
    const sym = ticker.toUpperCase();

    const columns = Object.keys(data);
    const values = Object.values(data);
    const setClauses = columns.map((c) => `${c} = COALESCE(?, ${c})`);
    const placeholders = columns.map(() => "?").join(", ");

    db.run(
      `INSERT INTO fundamentals (ticker, as_of_date, source, ${columns.join(", ")})
       VALUES (?, ?, ?, ${placeholders})
       ON CONFLICT(ticker, as_of_date, source) DO UPDATE SET
         ${setClauses.join(", ")}`,
      [sym, asOfDate, source, ...values] as any
    );
    this.ensureTicker(sym);
    this._save();
  }

  getFundamentals(ticker: string, asOfDate?: string): Record<string, unknown> | null {
    const db = this.assertReady();
    const sym = ticker.toUpperCase();

    let sql, params;
    if (asOfDate) {
      sql = `SELECT * FROM fundamentals WHERE ticker = ? AND as_of_date = ? ORDER BY source DESC LIMIT 1`;
      params = [sym, asOfDate];
    } else {
      sql = `SELECT * FROM fundamentals WHERE ticker = ? ORDER BY as_of_date DESC LIMIT 1`;
      params = [sym];
    }

    const result = db.exec(sql, params);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowsToObjects(result[0].columns, [result[0].values[0]])[0];
  }

  // ── CORPORATE EVENTS ───────────────────────────────────────────────────

  recordCorporateEvent(params: {
    ticker: string;
    eventDate: string;
    eventType: CorporateEventType;
    impact?: number;
    details?: Record<string, unknown>;
    sourceUrl?: string;
  }): void {
    const db = this.assertReady();
    const id = uuid();
    db.run(
      `INSERT INTO corporate_events (id, ticker, event_date, event_type, impact, details, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.ticker.toUpperCase(),
        params.eventDate,
        params.eventType,
        params.impact ?? null,
        params.details ? JSON.stringify(params.details) : null,
        params.sourceUrl ?? null,
      ]
    );
    this.ensureTicker(params.ticker.toUpperCase());
    this._save();
  }

  getCorporateEvents(ticker: string, sinceMinutes?: number, eventType?: string): Record<string, unknown>[] {
    const db = this.assertReady();
    const sym = ticker.toUpperCase();

    let sql = `SELECT * FROM corporate_events WHERE ticker = ?`;
    const params: any[] = [sym];

    if (sinceMinutes !== undefined) {
      const since = new Date(Date.now() - sinceMinutes * 60000).toISOString();
      sql += ` AND event_date >= ?`;
      params.push(since);
    }
    if (eventType) {
      sql += ` AND event_type = ?`;
      params.push(eventType);
    }

    sql += ` ORDER BY event_date DESC LIMIT 50`;

    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  // ── TECHNICAL INDICATORS ───────────────────────────────────────────────

  /**
   * Upsert technical indicators for a symbol on a given date.
   * Inserts or replaces the row for (symbol, timestamp).
   */
  upsertTechnicalIndicators(symbol: string, indicators: Record<string, unknown>): void {
    const db = this.assertReady();
    const sym = symbol.toUpperCase();

    const fields = [
      "sma_20", "sma_50", "sma_200",
      "ema_8", "ema_21", "ema_50",
      "rsi_14",
      "macd_line", "macd_signal", "macd_histogram",
      "atr_14",
      "bollinger_upper", "bollinger_middle", "bollinger_lower", "bollinger_band_pct",
      "consecutive_up", "consecutive_down",
      "close_above_sma_20", "close_above_sma_50",
      "ema_8_above_ema_21", "ema_21_above_ema_50",
    ];

    const cols = fields.join(", ");
    const placeholders = fields.map(() => "?").join(", ");
    const updates = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");

    const values: SqlValue[] = fields.map((f) => {
      const v = indicators[f];
      if (v === null || v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      return v as SqlValue;
    });

    db.run(
      `INSERT INTO technical_indicators (symbol, timestamp, ${cols})
       VALUES (?, ?, ${placeholders})
       ON CONFLICT(symbol, timestamp) DO UPDATE SET
         ${updates}`,
      [sym, String(indicators.timestamp ?? ""), ...values]
    );
    this._save();
  }

  /**
   * Get the latest technical indicators for a symbol.
   * Returns null if none found.
   */
  getLatestTechnicalIndicators(symbol: string): Record<string, unknown> | null {
    const db = this.assertReady();
    const result = db.exec(
      `SELECT * FROM technical_indicators WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1`,
      [symbol.toUpperCase()]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowsToObjects(result[0].columns, [result[0].values[0]])[0];
  }

  /**
   * Query technical indicators with filters.
   * Useful for finding tickers matching specific technical setups.
   */
  queryTechnicalIndicators(params: {
    minRsi?: number;
    maxRsi?: number;
    minConsecutiveUp?: number;
    minConsecutiveDown?: number;
    aboveBollingerUpper?: boolean;
    belowBollingerLower?: boolean;
    emaBullishAlignment?: boolean;
    emaBearishAlignment?: boolean;
    aboveSma50?: boolean;
    belowSma50?: boolean;
    limit?: number;
  }): Record<string, unknown>[] {
    const db = this.assertReady();
    const conditions: string[] = [];
    const bindings: SqlValue[] = [];;

    if (params.minRsi !== undefined) {
      conditions.push("rsi_14 >= ?");
      bindings.push(params.minRsi);
    }
    if (params.maxRsi !== undefined) {
      conditions.push("rsi_14 <= ?");
      bindings.push(params.maxRsi);
    }
    if (params.minConsecutiveUp !== undefined) {
      conditions.push("consecutive_up >= ?");
      bindings.push(params.minConsecutiveUp);
    }
    if (params.minConsecutiveDown !== undefined) {
      conditions.push("consecutive_down >= ?");
      bindings.push(params.minConsecutiveDown);
    }
    if (params.aboveBollingerUpper === true) {
      conditions.push("bollinger_band_pct > 1.0");
    }
    if (params.belowBollingerLower === true) {
      conditions.push("bollinger_band_pct < 0");
    }
    if (params.emaBullishAlignment === true) {
      conditions.push("ema_8_above_ema_21 = 1 AND ema_21_above_ema_50 = 1");
    }
    if (params.emaBearishAlignment === true) {
      conditions.push("ema_8_above_ema_21 = 0 AND ema_21_above_ema_50 = 0");
    }
    if (params.aboveSma50 === true) {
      conditions.push("close_above_sma_50 = 1");
    }
    if (params.belowSma50 === true) {
      conditions.push("close_above_sma_50 = 0");
    }

    // Only get the latest record per symbol using a subquery
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit ?? 50;

    // Get the latest timestamp for each symbol
    const sql = `
      SELECT t.* FROM technical_indicators t
      INNER JOIN (
        SELECT symbol, MAX(timestamp) AS max_ts
        FROM technical_indicators
        GROUP BY symbol
      ) latest ON t.symbol = latest.symbol AND t.timestamp = latest.max_ts
      ${whereClause}
      ORDER BY t.rsi_14 ASC
      LIMIT ?
    `;

    const result = db.exec(sql, [...bindings, limit]);
    if (result.length === 0 || result[0].values.length === 0) return [];
    return rowsToObjects(result[0].columns, result[0].values);
  }

  // ── PRUNING ────────────────────────────────────────────────────────────

  /**
   * Roll up old raw signals into aggregates and delete them.
   * Should be called every ~60 cycles (~30 minutes at 30s poll).
   */
  prune(): { rawDeleted: number; hourlyDeleted: number; dailyDeleted: number } {
    const db = this.assertReady();
    const now = Date.now();
    const rawCutoff = new Date(now - RETENTION_RAW_MS).toISOString();
    const hourlyCutoff = new Date(now - RETENTION_HOURLY_MS).toISOString();
    const dailyCutoff = new Date(now - RETENTION_DAILY_MS).toISOString();

    let rawDeleted = 0;
    let hourlyDeleted = 0;
    let dailyDeleted = 0;

    // Fold raw signals > 14 days into daily aggregates, then delete
    const staleRaw = db.exec(
      `SELECT ticker, source, timestamp, score, direction FROM signals WHERE timestamp < ?`,
      [rawCutoff]
    );

    if (staleRaw.length > 0) {
      for (const row of staleRaw[0].values) {
        const ticker = String(row[0]);
        const source = String(row[1]);
        const ts = String(row[2]);
        const score = Number(row[3]);
        const direction = Number(row[4]);
        const bd = dateBucket(ts);
        const isBull = direction > 0 ? 1 : 0;
        const isBear = direction < 0 ? 1 : 0;

        db.run(
          `INSERT INTO signal_daily (ticker, source, bucket_date, event_count, avg_score, max_score, bullish_ct, bearish_ct, source_ct)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1)
           ON CONFLICT(ticker, source, bucket_date) DO UPDATE SET
             event_count = event_count + 1,
             avg_score = (avg_score * (event_count - 1) + ?) / event_count,
             max_score = MAX(max_score, ?),
             bullish_ct = bullish_ct + ?,
             bearish_ct = bearish_ct + ?,
             source_ct = source_ct + 1`,
          [ticker, source, bd, score, score, isBull, isBear, score, score, isBull, isBear]
        );
      }

      db.run(`DELETE FROM signals WHERE timestamp < ?`, [rawCutoff]);
      rawDeleted = staleRaw[0].values.length;
    }

    // Delete stale hourly
    const hrResult = db.exec(`SELECT COUNT(*) AS c FROM signal_hourly WHERE bucket_hour < ?`, [hourlyCutoff]);
    if (hrResult.length > 0 && hrResult[0].values.length > 0) {
      hourlyDeleted = Number(hrResult[0].values[0][0]);
      db.run(`DELETE FROM signal_hourly WHERE bucket_hour < ?`, [hourlyCutoff]);
    }

    // Delete stale daily
    const drResult = db.exec(`SELECT COUNT(*) AS c FROM signal_daily WHERE bucket_date < ?`, [dailyCutoff]);
    if (drResult.length > 0 && drResult[0].values.length > 0) {
      dailyDeleted = Number(drResult[0].values[0][0]);
      db.run(`DELETE FROM signal_daily WHERE bucket_date < ?`, [dailyCutoff]);
    }

    this._save();
    return { rawDeleted, hourlyDeleted, dailyDeleted };
  }

  // ── SCHEMA / DESCRIBE ──────────────────────────────────────────────────

  getTableInfo(): TableInfo[] {
    const db = this.assertReady();
    const tables = ["tickers", "signals", "signal_hourly", "signal_daily", "fundamentals", "corporate_events", "sector_signals", "macro_events", "technical_indicators"];
    const info: TableInfo[] = [];

    for (const name of tables) {
      const colResult = db.exec(`PRAGMA table_info(${name})`);
      const columns = colResult.length > 0
        ? colResult[0].values.map((r) => ({ name: String(r[1]), type: String(r[2]) }))
        : [];

      const countResult = db.exec(`SELECT COUNT(*) AS c FROM ${name}`);
      const rowCount = countResult.length > 0 ? Number(countResult[0].values[0][0]) : 0;

      info.push({ name, rowCount, columns });
    }

    return info;
  }

  getDateRange(): Record<string, { min: string | null; max: string | null }> {
    const db = this.assertReady();
    const ranges: Record<string, { min: string | null; max: string | null }> = {};

    const queries: [string, string][] = [
      ["signals", "timestamp"],
      ["signal_hourly", "bucket_hour"],
      ["signal_daily", "bucket_date"],
      ["fundamentals", "as_of_date"],
      ["corporate_events", "event_date"],
      ["sector_signals", "timestamp"],
      ["macro_events", "timestamp"],
    ];

    for (const [table, col] of queries) {
      const result = db.exec(`SELECT MIN(${col}), MAX(${col}) FROM ${table}`);
      if (result.length > 0 && result[0].values.length > 0) {
        ranges[table] = {
          min: result[0].values[0][0] ? String(result[0].values[0][0]) : null,
          max: result[0].values[0][1] ? String(result[0].values[0][1]) : null,
        };
      } else {
        ranges[table] = { min: null, max: null };
      }
    }

    return ranges;
  }

  getSourceBreakdown(): Record<string, number> {
    const db = this.assertReady();
    const result = db.exec(`SELECT source, COUNT(*) AS c FROM signals GROUP BY source ORDER BY c DESC`);
    const breakdown: Record<string, number> = {};
    if (result.length > 0) {
      for (const row of result[0].values) {
        breakdown[String(row[0])] = Number(row[1]);
      }
    }
    return breakdown;
  }
}
