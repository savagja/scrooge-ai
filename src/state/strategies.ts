/**
 * Strategy store — SQLite-backed persistence for the strategist/trader split.
 *
 * The strategist writes strategies; the trader reads them.
 * SQLite handles concurrent access via WAL mode.
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import type { Strategy, StrategyType, StrategyState, WhatIfEntry, WhatIfGrade, Lesson } from "../types.js";

const DATA_DIR = join(process.cwd(), "data");

export class StrategyStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? join(DATA_DIR, "strategies.db");
    mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this._ensureSchema();
    this._migrateFromV1();
  }

  private _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id              TEXT PRIMARY KEY,
        ticker          TEXT NOT NULL,
        strategy_type   TEXT NOT NULL,
        direction       TEXT NOT NULL DEFAULT 'long',
        state           TEXT NOT NULL DEFAULT 'anticipated',

        thesis          TEXT NOT NULL,
        catalyst        TEXT,
        timeframe       TEXT,

        confidence      REAL NOT NULL DEFAULT 0.0,
        conviction      TEXT NOT NULL DEFAULT 'low',

        rationale       TEXT NOT NULL DEFAULT '',
        key_signals     TEXT NOT NULL DEFAULT '[]',
        risk_factors    TEXT NOT NULL DEFAULT '[]',

        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        last_signal_at  TEXT,

        position_id     TEXT,

        entry_price     REAL,
        exit_price      REAL,
        pnl             REAL,
        pnl_pct         REAL,
        exit_reason     TEXT,

        entry_conditions TEXT NOT NULL DEFAULT '',
        exit_conditions  TEXT NOT NULL DEFAULT '',
        created_by       TEXT NOT NULL DEFAULT 'strategist'
      );

      CREATE INDEX IF NOT EXISTS idx_strategies_state      ON strategies(state);
      CREATE INDEX IF NOT EXISTS idx_strategies_ticker     ON strategies(ticker);
      CREATE INDEX IF NOT EXISTS idx_strategies_confidence ON strategies(confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_strategies_updated    ON strategies(updated_at DESC);

      -- Version tracking for migrations
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    // Seed version 1 if empty
    const versionRow = this.db.prepare(
      "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    ).get() as { version: number } | undefined;

    if (!versionRow) {
      this.db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (1, ?)"
      ).run(new Date().toISOString());
    }
  }

  /** Migrate from pre-lifecycle format if needed */
  private _migrateFromV1(): void {
    const currentVersion = (
      this.db.prepare(
        "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
      ).get() as { version: number } | undefined
    )?.version ?? 0;

    const migrations: Array<{ version: number; label: string; run: () => void }> = [
      {
        version: 2,
        label: "Add direction column",
        run: () => {
          try { this.db.exec("ALTER TABLE strategies ADD COLUMN direction TEXT NOT NULL DEFAULT 'long'"); }
          catch { /* column already exists */ }
        },
      },
      {
        version: 3,
        label: "Add entry_conditions and exit_conditions columns",
        run: () => {
          try { this.db.exec("ALTER TABLE strategies ADD COLUMN entry_conditions TEXT NOT NULL DEFAULT ''"); }
          catch { /* column already exists */ }
          try { this.db.exec("ALTER TABLE strategies ADD COLUMN exit_conditions TEXT NOT NULL DEFAULT ''"); }
          catch { /* column already exists */ }
        },
      },
      {
        version: 4,
        label: "Add conviction column",
        run: () => {
          try { this.db.exec("ALTER TABLE strategies ADD COLUMN conviction TEXT NOT NULL DEFAULT 'low'"); }
          catch { /* column already exists */ }
        },
      },
      {
        version: 5,
        label: "Add what_if column",
        run: () => {
          try { this.db.exec("ALTER TABLE strategies ADD COLUMN what_if TEXT"); }
          catch { /* column already exists */ }
        },
      },
      {
        version: 6,
        label: "Add strategist_lessons table",
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS strategist_lessons (
              id                TEXT PRIMARY KEY,
              category          TEXT NOT NULL,
              insight           TEXT NOT NULL,
              weight            REAL NOT NULL DEFAULT 0.3,
              reinforcementCount INTEGER NOT NULL DEFAULT 1,
              createdAt         TEXT NOT NULL,
              lastReinforcedAt  TEXT NOT NULL,
              deprecated        INTEGER NOT NULL DEFAULT 0,
              context           TEXT,
              featureVector     TEXT NOT NULL DEFAULT '[0.4,0.5,0,0.5,0,0,0]'
            );
          `);
        },
      },
    ];

    for (const m of migrations) {
      if (currentVersion >= m.version) continue;
      try {
        console.log(`[STRATEGIES] Migration V${m.version}: ${m.label}`);
        m.run();
        this.db.prepare(
          "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
        ).run(m.version, new Date().toISOString());
      } catch (e: any) {
        console.warn(`[STRATEGIES] Migration V${m.version} failed: ${e.message}`);
      }
    }
  }

  close() {
    this.db.close();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════════════════════

  /** Create a new strategy. Returns the created strategy with generated ID. */
  create(params: {
    ticker: string;
    strategy_type: StrategyType;
    direction?: "long" | "short";
    thesis: string;
    catalyst?: string | null;
    timeframe?: string | null;
    confidence?: number;
    rationale?: string;
    key_signals?: string[];
    risk_factors?: string[];
    conviction?: string;
    entry_conditions?: string | null;
    exit_conditions?: string | null;
    created_by?: "strategist" | "manual";
    state?: StrategyState;
  }): Strategy {
    const id = `strat_${randomUUID()}`;
    const now = new Date().toISOString();
    const direction = params.direction ?? "long";

    const stmt = this.db.prepare(`
      INSERT INTO strategies (
        id, ticker, strategy_type, direction, state,
        thesis, catalyst, timeframe,
        confidence, conviction, rationale,
        key_signals, risk_factors,
        entry_conditions, exit_conditions,
        created_at, updated_at,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      params.ticker.toUpperCase(),
      params.strategy_type,
      direction,
      params.state ?? "anticipated",
      params.thesis,
      params.catalyst ?? null,
      params.timeframe ?? null,
      params.confidence ?? 0.1,
      params.conviction ?? "low",
      params.rationale ?? "",
      JSON.stringify(params.key_signals ?? []),
      JSON.stringify(params.risk_factors ?? []),
      params.entry_conditions ?? "",
      params.exit_conditions ?? "",
      now,
      now,
      params.created_by ?? "strategist",
    );

    return this.getById(id)!;
  }

  /** Get a strategy by ID. */
  getById(id: string): Strategy | null {
    const row = this.db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this._rowToStrategy(row) : null;
  }

  /** Update a strategy's fields. Only provided fields are updated. */
  update(id: string, params: Partial<{
    state: StrategyState;
    confidence: number;
    conviction?: string;
    thesis: string;
    catalyst: string | null;
    timeframe: string | null;
    rationale: string;
    key_signals: string[];
    risk_factors: string[];
    entry_conditions?: string | null;
    exit_conditions?: string | null;
    position_id: string | null;
    entry_price: number | null;
    exit_price: number | null;
    pnl: number | null;
    pnl_pct: number | null;
    exit_reason: string | null;
    last_signal_at: string | null;
  }>): Strategy | null {
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const vals: unknown[] = [now];

    const fields: (keyof typeof params)[] = [
      "state", "confidence", "conviction", "thesis", "catalyst", "timeframe",
      "rationale", "key_signals", "risk_factors",
      "entry_conditions", "exit_conditions",
      "position_id", "entry_price", "exit_price", "pnl", "pnl_pct",
      "exit_reason", "last_signal_at",
    ];

    for (const field of fields) {
      if (params[field] !== undefined) {
        sets.push(`${field} = ?`);
        // Serialize arrays to JSON
        if (field === "key_signals" || field === "risk_factors") {
          vals.push(JSON.stringify(params[field]));
        } else {
          vals.push(params[field] as unknown);
        }
      }
    }

    vals.push(id);
    this.db.prepare(`UPDATE strategies SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getById(id);
  }

  /** Archive a strategy (mark as stale or failed). */
  archive(id: string, reason: "stale" | "failed", exitNote?: string): Strategy | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE strategies SET state = ?, updated_at = ?, exit_reason = ?
      WHERE id = ?
    `).run(reason, now, exitNote ?? null, id);
    return this.getById(id);
  }

  /** Permanently delete old stale/failed strategies beyond retention period. */
  purgeRetained(days: number = 14) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const result = this.db.prepare(
      "DELETE FROM strategies WHERE (state = 'stale' OR state = 'failed') AND updated_at < ?"
    ).run(cutoff);
    return result.changes;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // QUERIES — Used by the trader
  // ═══════════════════════════════════════════════════════════════════════

  /** Get the top-N non-position strategies sorted by confidence × freshness.
   *  Excludes: stale, failed, and strategies linked to open positions. */
  getTopStrategies(limit: number = 10): Strategy[] {
    const rows = this.db.prepare(`
      SELECT * FROM strategies
      WHERE state IN ('anticipated', 'developing')
        AND position_id IS NULL
      ORDER BY
        CASE state
          WHEN 'developing' THEN 2
          WHEN 'anticipated' THEN 1
        END DESC,
        CASE conviction
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
        END DESC,
        confidence DESC,
        updated_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map((r) => this._rowToStrategy(r));
  }

  /** Get strategies linked to a specific position ID. */
  getByPositionId(positionId: string): Strategy | null {
    const row = this.db.prepare(
      "SELECT * FROM strategies WHERE position_id = ? LIMIT 1"
    ).get(positionId) as Record<string, unknown> | undefined;
    return row ? this._rowToStrategy(row) : null;
  }

  /** Get all strategies for a ticker, ordered by recency. */
  getByTicker(ticker: string, limit: number = 10): Strategy[] {
    const rows = this.db.prepare(
      "SELECT * FROM strategies WHERE ticker = ? ORDER BY created_at DESC LIMIT ?"
    ).all(ticker.toUpperCase(), limit) as Record<string, unknown>[];
    return rows.map((r) => this._rowToStrategy(r));
  }

  /** Get all strategies matching a strategy type. */
  getByType(strategyType: string, limit: number = 50): Strategy[] {
    const rows = this.db.prepare(
      'SELECT * FROM strategies WHERE strategy_type = ? ORDER BY updated_at DESC LIMIT ?'
    ).all(strategyType, limit) as Record<string, unknown>[];
    return rows.map((r) => this._rowToStrategy(r));
  }

  /** Get all strategies in a given state. */
  getByState(state: StrategyState): Strategy[] {
    const rows = this.db.prepare(
      "SELECT * FROM strategies WHERE state = ? ORDER BY updated_at DESC"
    ).all(state) as Record<string, unknown>[];
    return rows.map((r) => this._rowToStrategy(r));
  }

  /** Get all strategies that have a position_id set (linked to open/closed positions). */
  getExecuted(limit: number = 50): Strategy[] {
    const rows = this.db.prepare(
      "SELECT * FROM strategies WHERE position_id IS NOT NULL ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as Record<string, unknown>[];
    return rows.map((r) => this._rowToStrategy(r));
  }

  /** Count strategies per state (for dashboard). */
  getStateCounts(): Record<string, number> {
    const rows = this.db.prepare(
      "SELECT state, COUNT(*) as count FROM strategies GROUP BY state"
    ).all() as { state: string; count: number }[];

    const counts: Record<string, number> = {
      anticipated: 0,
      developing: 0,
      realized: 0,
      active: 0,
      failed: 0,
      stale: 0,
    };
    for (const row of rows) {
      counts[row.state] = row.count;
    }
    return counts;
  }

  /** Get total count of strategies. */
  getTotalCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM strategies").get() as { count: number };
    return row.count;
  }

  /** Get strategies that haven't been updated in N hours (candidates for staleness). */
  getStaleCandidates(maxAgeHours: number = 48): Strategy[] {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM strategies
      WHERE state IN ('anticipated', 'developing')
        AND updated_at < ?
      ORDER BY updated_at ASC
    `).all(cutoff) as Record<string, unknown>[];
    return rows.map((r) => this._rowToStrategy(r));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private _rowToStrategy(row: Record<string, unknown>): Strategy {
    return {
      id: row.id as string,
      ticker: row.ticker as string,
      strategy_type: row.strategy_type as StrategyType,
      direction: (row.direction as "long" | "short") ?? "long",
      state: row.state as StrategyState,
      thesis: row.thesis as string,
      catalyst: (row.catalyst as string) ?? null,
      timeframe: (row.timeframe as string) ?? null,
      confidence: row.confidence as number,
      conviction: (row.conviction as string) ?? "low",
      rationale: (row.rationale as string) ?? "",
      key_signals: this._parseJsonArray(row.key_signals as string),
      risk_factors: this._parseJsonArray(row.risk_factors as string),
      what_if: this._parseWhatIf(row.what_if as string | null | undefined),
      entry_conditions: (row.entry_conditions as string) ?? null,
      exit_conditions: (row.exit_conditions as string) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      last_signal_at: (row.last_signal_at as string) ?? null,
      position_id: (row.position_id as string) ?? null,
      entry_price: (row.entry_price as number) ?? null,
      exit_price: (row.exit_price as number) ?? null,
      pnl: (row.pnl as number) ?? null,
      pnl_pct: (row.pnl_pct as number) ?? null,
      exit_reason: (row.exit_reason as string) ?? null,
      created_by: (row.created_by as "strategist" | "manual") ?? "strategist",
    };
  }

  private _parseJsonArray(val: string | null | undefined): string[] {
    if (!val) return [];
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private _parseWhatIf(val: string | null | undefined): WhatIfEntry | null {
    if (!val) return null;
    try {
      return JSON.parse(val) as WhatIfEntry;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STRATEGIST LESSONS — Persistent learning for the strategist
  // ═══════════════════════════════════════════════════════════════════════

  /** Get all strategist lessons, optionally filtering by active only. */
  getStrategistLessons(activeOnly: boolean = true): Lesson[] {
    const rows = activeOnly
      ? this.db.prepare("SELECT * FROM strategist_lessons WHERE deprecated = 0 ORDER BY weight DESC").all()
      : this.db.prepare("SELECT * FROM strategist_lessons ORDER BY weight DESC").all();
    return (rows as any[]).map((r) => ({
      id: r.id,
      category: r.category,
      insight: r.insight,
      weight: r.weight,
      reinforcementCount: r.reinforcementCount,
      createdAt: r.createdAt,
      lastReinforcedAt: r.lastReinforcedAt,
      deprecated: r.deprecated === 1,
      context: r.context ?? null,
      featureVector: JSON.parse(r.featureVector || '[0.4,0.5,0,0.5,0,0,0]'),
    }));
  }

  /** Replace ALL strategist lessons with a new set. */
  replaceStrategistLessons(lessons: Lesson[]): void {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM strategist_lessons");
      const insert = this.db.prepare(`
        INSERT INTO strategist_lessons (id, category, insight, weight, reinforcementCount, createdAt, lastReinforcedAt, deprecated, context, featureVector)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of lessons) {
        if (l.deprecated) continue; // Don't store deprecated lessons
        insert.run(
          l.id, l.category, l.insight, l.weight, l.reinforcementCount,
          l.createdAt, l.lastReinforcedAt, l.deprecated ? 1 : 0,
          l.context ?? null, JSON.stringify(l.featureVector),
        );
      }
    });
    tx();
  }

  /** Get active strategist lessons formatted for the strategist prompt. */
  formatStrategistLessons(): string {
    const lessons = this.getStrategistLessons(true);
    if (lessons.length === 0) return "No strategist lessons yet.";
    return lessons.map((l) =>
      `[${l.category}] (w: ${l.weight.toFixed(2)}, reinforced: ${l.reinforcementCount}x) ${l.insight}`
    ).join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WHAT-IF ANALYSIS — Strategy grading
  // ═══════════════════════════════════════════════════════════════════════

  /** Update a strategy's what-if analysis entry (grades, hypotheticals). */
  updateWhatIf(id: string, whatIf: WhatIfEntry): Strategy | null {
    this.db.prepare(
      "UPDATE strategies SET what_if = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(whatIf), new Date().toISOString(), id);
    return this.getById(id);
  }

  /** Get all strategies that were active/updated on a given date (for what-if analysis). */
  getStrategiesForDay(date: string): Strategy[] {
    // Strategies created, updated, or last_signal_at on this date, OR that were active
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;
    const rows = this.db.prepare(`
      SELECT * FROM strategies
      WHERE (created_at BETWEEN ? AND ?)
         OR (updated_at BETWEEN ? AND ?)
         OR (last_signal_at IS NOT NULL AND last_signal_at BETWEEN ? AND ?)
      ORDER BY updated_at DESC
    `).all(startOfDay, endOfDay, startOfDay, endOfDay, startOfDay, endOfDay) as Record<string, unknown>[];
    return rows.map((r) => this._rowToStrategy(r));
  }

  /** Get all strategies that were never what-if analyzed. */
  getUnanalyzedStrategies(limit: number = 100): Strategy[] {
    const rows = this.db.prepare(`
      SELECT * FROM strategies
      WHERE what_if IS NULL
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map((r) => this._rowToStrategy(r));
  }

  /** Get all strategies that have been what-if analyzed, newest first. */
  getAnalyzedStrategies(limit: number = 100): Strategy[] {
    const rows = this.db.prepare(`
      SELECT * FROM strategies
      WHERE what_if IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map((r) => this._rowToStrategy(r));
  }
}