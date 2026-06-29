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
    maxPositionPct: number;
    maxDailyLossPct: number;
    stopLossPct: number;
    trailingStopPct: number;
    greenThreshold: number;
    shortSqueezeThreshold: number;
    cooldownMinutes: number;
    consecutiveLossesHalt: number;
    maxOpenPositions: number;
  };
  signal: {
    minImpactScore: number;
    minConfidence: number;
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
      maxPositionPct: num("MAX_POSITION_PCT", ["risk", "max_position_pct"], 0.30),
      maxDailyLossPct: num("MAX_DAILY_LOSS_PCT", ["risk", "max_daily_loss_pct"], 0.15),
      stopLossPct: num("STOP_LOSS_PCT", ["risk", "stop_loss_pct"], 0.03),
      trailingStopPct: num("TRAILING_STOP_PCT", ["risk", "trailing_stop_pct"], 0.05),
      greenThreshold: num("GREEN_THRESHOLD", ["risk", "green_threshold"], 0.01),
      shortSqueezeThreshold: num("SHORT_SQUEEZE_THRESHOLD", ["risk", "short_squeeze_threshold"], 0.05),
      cooldownMinutes: num("COOLDOWN_MINUTES", ["risk", "cooldown_minutes"], 3),
      consecutiveLossesHalt: num("CONSECUTIVE_LOSSES_HALT", ["risk", "consecutive_losses_halt"], 4),
      maxOpenPositions: num("MAX_OPEN_POSITIONS", ["risk", "max_open_positions"], 4),
    },
    signal: {
      minImpactScore: num("MIN_IMPACT_SCORE", ["signal", "min_impact_score"], 4),
      minConfidence: num("MIN_CONFIDENCE", ["signal", "min_confidence"], 0.45),
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
