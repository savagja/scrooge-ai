/**
 * Configuration loader.
 * Reads config.yaml for trading parameters.
 * Reads .env for secrets only.
 * Environment variables override config.yaml values (for backwards compat).
 */

import { readFileSync } from "fs";
import { parse } from "yaml";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

interface AppConfig {
  initialCapital: number;
  pollIntervalMs: number;
  watchlist: string[];
  discovery: {
    enabled: boolean;
    maxDiscovered: number;
    refreshIntervalCycles: number;
  };
  risk: {
    stopLossPct: number;
    trailingStopPct: number;
    greenThreshold: number;
    shortSqueezeThreshold: number;
  };
  signal: {
    holdMinutes: number;
  };
  execution: {
    dryRun: boolean;
    fractionalEnabled: boolean;
    defaultTimeInForce: "day" | "ioc" | "fok";
  };
  data: {
    edgarEnabled: boolean;
    redditEnabled: boolean;
    yahooDiscovery: boolean;
    volumeLookbackDays: number;
    rangeLookbackDays: number;
  };
  agent: {
    thinkingLevel: string;
    maxToolCallsPerTurn: number;
    enableReflection: boolean;
  };
  research: {
    enabled: boolean;
    dbPath: string;
    rawRetentionDays: number;
    hourlyRetentionDays: number;
    dailyRetentionDays: number;
    pruneIntervalCycles: number;
    fundamentalsRefreshHours: number;
  };
}

let _config: AppConfig | null = null;

function loadConfig(): AppConfig {
  let yamlConfig: any = {};
  try {
    const raw = readFileSync("config.yaml", "utf-8");
    yamlConfig = parse(raw) || {};
  } catch {
    console.warn("[CONFIG] No config.yaml found. Using defaults.");
  }

  // Helper: env override or yaml fallback
  const num = (key: string, yamlPath: string[], fallback: number): number => {
    if (process.env[key]) return Number(process.env[key]);
    let val: any = yamlConfig;
    for (const p of yamlPath) { val = val?.[p]; }
    return val !== undefined ? Number(val) : fallback;
  };

  const bool = (key: string, yamlPath: string[], fallback: boolean): boolean => {
    if (process.env[key]) return process.env[key] === "true";
    let val: any = yamlConfig;
    for (const p of yamlPath) { val = val?.[p]; }
    return val !== undefined ? Boolean(val) : fallback;
  };

  const str = (key: string, yamlPath: string[], fallback: string): string => {
    if (process.env[key]) return process.env[key]!;
    let val: any = yamlConfig;
    for (const p of yamlPath) { val = val?.[p]; }
    return val !== undefined ? String(val) : fallback;
  };

  const strArr = (yamlPath: string[], fallback: string[]): string[] => {
    let val: any = yamlConfig;
    for (const p of yamlPath) { val = val?.[p]; }
    if (Array.isArray(val)) return val.map(String);
    if (process.env.WATCHLIST) return process.env.WATCHLIST.split(",");
    return fallback;
  };

  return {
    initialCapital: num("INITIAL_CAPITAL", ["initial_capital"], 100),
    pollIntervalMs: num("POLL_INTERVAL_MS", ["poll_interval_ms"], 120000),
    watchlist: strArr(["watchlist"], [
      "AAPL", "TSLA", "NVDA", "AMD", "MSFT", "AMZN",
      "GOOGL", "META", "NFLX", "CRM", "PLTR", "COIN",
      "HOOD", "SOFI", "ENPH", "FSLR",
    ]),
    discovery: {
      enabled: bool("DISCOVERY_ENABLED", ["discovery", "enabled"], true),
      maxDiscovered: num("DISCOVERY_MAX", ["discovery", "max_discovered"], 10),
      refreshIntervalCycles: num("DISCOVERY_REFRESH", ["discovery", "refresh_interval_cycles"], 3),
    },
    risk: {
      stopLossPct: num("STOP_LOSS_PCT", ["risk", "stop_loss_pct"], 0.03),
      trailingStopPct: num("TRAILING_STOP_PCT", ["risk", "trailing_stop_pct"], 0.05),
      greenThreshold: num("GREEN_THRESHOLD", ["risk", "green_threshold"], 0.01),
      shortSqueezeThreshold: num("SHORT_SQUEEZE_THRESHOLD", ["risk", "short_squeeze_threshold"], 0.05),
    },
    signal: {
      holdMinutes: num("HOLD_MINUTES", ["signal", "hold_minutes"], 30),
    },
    execution: {
      dryRun: bool("DRY_RUN", ["execution", "dry_run"], true),
      fractionalEnabled: bool("FRACTIONAL_ENABLED", ["execution", "fractional_enabled"], true),
      defaultTimeInForce: str("DEFAULT_TIME_IN_FORCE", ["execution", "default_time_in_force"], "day") as any,
    },
    data: {
      edgarEnabled: bool("EDGAR_ENABLED", ["data", "edgar_enabled"], true),
      redditEnabled: bool("REDDIT_ENABLED", ["data", "reddit_enabled"], true),
      yahooDiscovery: bool("YAHOO_DISCOVERY", ["data", "yahoo_discovery"], true),
      volumeLookbackDays: num("VOLUME_LOOKBACK_DAYS", ["data", "volume_lookback_days"], 20),
      rangeLookbackDays: num("RANGE_LOOKBACK_DAYS", ["data", "range_lookback_days"], 20),
    },
    agent: {
      thinkingLevel: str("THINKING_LEVEL", ["agent", "thinking_level"], "medium"),
      maxToolCallsPerTurn: num("MAX_TOOL_CALLS", ["agent", "max_tool_calls_per_turn"], 6),
      enableReflection: bool("ENABLE_REFLECTION", ["agent", "enable_reflection"], false),
    },
    research: {
      enabled: bool("RESEARCH_ENABLED", ["research", "enabled"], true),
      dbPath: str("RESEARCH_DB_PATH", ["research", "db_path"], "data/research.db"),
      rawRetentionDays: num("RESEARCH_RAW_RETENTION", ["research", "raw_retention_days"], 14),
      hourlyRetentionDays: num("RESEARCH_HOURLY_RETENTION", ["research", "hourly_retention_days"], 90),
      dailyRetentionDays: num("RESEARCH_DAILY_RETENTION", ["research", "daily_retention_days"], 365),
      pruneIntervalCycles: num("RESEARCH_PRUNE_INTERVAL", ["research", "prune_interval_cycles"], 60),
      fundamentalsRefreshHours: num("RESEARCH_FUNDAMENTALS_REFRESH", ["research", "fundamentals_refresh_hours"], 24),
    },
  };
}

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function reloadConfig(): AppConfig {
  _config = loadConfig();
  return _config;
}

/**
 * Get the current trading date (US/Eastern timezone).
 * All date-sensitive decisions (daily P&L reset, snapshots, reports) use this.
 */
export function getTradingDate(): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    return formatter.format(new Date()); // returns YYYY-MM-DD
  } catch {
    // Fallback: UTC (better than nothing)
    return new Date().toISOString().slice(0, 10);
  }
}
