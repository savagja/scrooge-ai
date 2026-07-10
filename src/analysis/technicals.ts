/**
 * Technical analysis calculations — pure functions, no side effects.
 *
 * All functions work on arrays of bars sorted chronologically (oldest first).
 * Bar type: { open, high, low, close, volume }
 *
 * These run on the research engine's schedule, computing indicators from
 * historical daily bars and storing results in the research DB.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface PriceBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  symbol: string;
  timestamp: string;           // Date of the last bar used (YYYY-MM-DD)

  // -- Trend --
  sma_20: number | null;
  sma_50: number | null;
  sma_200: number | null;
  ema_8: number | null;
  ema_21: number | null;
  ema_50: number | null;

  // -- Momentum --
  rsi_14: number | null;       // 0-100
  macd_line: number | null;
  macd_signal: number | null;
  macd_histogram: number | null;

  // -- Volatility --
  atr_14: number | null;
  bollinger_upper: number | null;
  bollinger_middle: number | null;
  bollinger_lower: number | null;
  bollinger_band_pct: number | null;

  // -- Streak & Structure --
  consecutive_up: number;
  consecutive_down: number;
  close_above_sma_20: boolean | null;
  close_above_sma_50: boolean | null;
  ema_8_above_ema_21: boolean | null;
  ema_21_above_ema_50: boolean | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }
  return result;
}

function trueRange(prevClose: number, high: number, low: number): number {
  return Math.max(
    high - low,
    Math.abs(high - prevClose),
    Math.abs(low - prevClose),
  );
}

function stddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPUTE ALL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════

export function computeIndicators(
  symbol: string,
  bars: PriceBar[],
): TechnicalIndicators {
  const closes = bars.map((b) => b.close);
  const lastBar = bars[bars.length - 1];
  const timestamp = lastBar.timestamp.slice(0, 10);

  const sma_20_v = sma(closes, 20);
  const sma_50_v = sma(closes, 50);
  const sma_200_v = sma(closes, 200);
  const ema_8_v = ema(closes, 8);
  const ema_21_v = ema(closes, 21);
  const ema_50_v = ema(closes, 50);

  // RSI(14)
  let rsi_14_v: number | null = null;
  if (closes.length >= 15) {
    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? -diff : 0);
    }
    const recentGains = gains.slice(-14);
    const recentLosses = losses.slice(-14);
    const avgGain = recentGains.reduce((a, b) => a + b, 0) / 14;
    const avgLoss = recentLosses.reduce((a, b) => a + b, 0) / 14;
    if (avgLoss === 0) {
      rsi_14_v = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi_14_v = 100 - (100 / (1 + rs));
    }
  }

  // MACD(12,26,9)
  let macd_line_v: number | null = null;
  let macd_signal_v: number | null = null;
  let macd_histogram_v: number | null = null;
  if (closes.length >= 26) {
    const ema_12 = ema(closes, 12);
    const ema_26 = ema(closes, 26);
    if (ema_12 !== null && ema_26 !== null) {
      macd_line_v = ema_12 - ema_26;
      const macdHistory: number[] = [];
      for (let i = 25; i < closes.length; i++) {
        const e12 = ema(closes.slice(0, i + 1), 12);
        const e26 = ema(closes.slice(0, i + 1), 26);
        if (e12 !== null && e26 !== null) macdHistory.push(e12 - e26);
      }
      if (macdHistory.length >= 9) {
        macd_signal_v = ema(macdHistory, 9) ?? null;
        if (macd_signal_v !== null) macd_histogram_v = macd_line_v - macd_signal_v;
      }
    }
  }

  // ATR(14)
  let atr_14_v: number | null = null;
  if (bars.length >= 15) {
    const trValues: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      trValues.push(trueRange(bars[i - 1].close, bars[i].high, bars[i].low));
    }
    atr_14_v = trValues.slice(-14).reduce((a, b) => a + b, 0) / 14;
  }

  // Bollinger Bands (20, 2)
  let bollinger_upper_v: number | null = null;
  let bollinger_middle_v: number | null = null;
  let bollinger_lower_v: number | null = null;
  let bollinger_band_pct_v: number | null = null;
  if (sma_20_v !== null && closes.length >= 20) {
    bollinger_middle_v = sma_20_v;
    const sd = stddev(closes.slice(-20), sma_20_v);
    bollinger_upper_v = round2(sma_20_v + 2 * sd);
    bollinger_lower_v = round2(sma_20_v - 2 * sd);
    if (bollinger_upper_v - bollinger_lower_v > 0.001) {
      bollinger_band_pct_v = round4(
        (lastBar.close - bollinger_lower_v) / (bollinger_upper_v - bollinger_lower_v)
      );
    }
  }

  // Consecutive candles
  let consecutive_up = 0;
  let consecutive_down = 0;
  for (let i = bars.length - 1; i >= 1; i--) {
    if (bars[i].close > bars[i - 1].close) {
      consecutive_up = 1;
      for (let j = i - 1; j >= 1; j--) {
        if (bars[j].close > bars[j - 1].close) consecutive_up++;
        else break;
      }
      break;
    } else if (bars[i].close < bars[i - 1].close) {
      consecutive_down = 1;
      for (let j = i - 1; j >= 1; j--) {
        if (bars[j].close < bars[j - 1].close) consecutive_down++;
        else break;
      }
      break;
    }
  }

  const lastClose = lastBar.close;
  const close_above_sma_20 = sma_20_v !== null ? lastClose > sma_20_v : null;
  const close_above_sma_50 = sma_50_v !== null ? lastClose > sma_50_v : null;
  const ema_8_above_ema_21 = ema_8_v !== null && ema_21_v !== null ? ema_8_v > ema_21_v : null;
  const ema_21_above_ema_50 = ema_21_v !== null && ema_50_v !== null ? ema_21_v > ema_50_v : null;

  return {
    symbol, timestamp,
    sma_20: sma_20_v !== null ? round2(sma_20_v) : null,
    sma_50: sma_50_v !== null ? round2(sma_50_v) : null,
    sma_200: sma_200_v !== null ? round2(sma_200_v) : null,
    ema_8: ema_8_v !== null ? round2(ema_8_v) : null,
    ema_21: ema_21_v !== null ? round2(ema_21_v) : null,
    ema_50: ema_50_v !== null ? round2(ema_50_v) : null,
    rsi_14: rsi_14_v !== null ? round2(rsi_14_v) : null,
    macd_line: macd_line_v !== null ? round4(macd_line_v) : null,
    macd_signal: macd_signal_v !== null ? round4(macd_signal_v) : null,
    macd_histogram: macd_histogram_v !== null ? round4(macd_histogram_v) : null,
    atr_14: atr_14_v !== null ? round2(atr_14_v) : null,
    bollinger_upper: bollinger_upper_v,
    bollinger_middle: bollinger_middle_v,
    bollinger_lower: bollinger_lower_v,
    bollinger_band_pct: bollinger_band_pct_v,
    consecutive_up, consecutive_down,
    close_above_sma_20, close_above_sma_50,
    ema_8_above_ema_21, ema_21_above_ema_50,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════

export type TechnicalSignalType =
  | "oversold_rsi"
  | "overbought_rsi"
  | "ema_bullish_cross"
  | "ema_bearish_cross"
  | "bollinger_break_high"
  | "bollinger_break_low"
  | "green_streak"
  | "red_streak"
  | "macd_bullish"
  | "macd_bearish"
  | "sma_breakout"
  | "sma_breakdown";

export interface TechnicalSignal {
  ticker: string;
  source: "technicals";
  score: number;
  direction: number;
  signalType: TechnicalSignalType;
  payload: Record<string, unknown>;
}

export function generateTechnicalSignals(
  ind: TechnicalIndicators,
): TechnicalSignal[] {
  const signals: TechnicalSignal[] = [];
  const t = ind.symbol;

  // RSI extremes
  if (ind.rsi_14 !== null) {
    if (ind.rsi_14 < 30) {
      signals.push({
        ticker: t, source: "technicals",
        score: Math.min(1, (30 - ind.rsi_14) / 20),
        direction: 1,
        signalType: "oversold_rsi",
        payload: { rsi_14: ind.rsi_14 },
      });
    } else if (ind.rsi_14 > 70) {
      signals.push({
        ticker: t, source: "technicals",
        score: Math.min(1, (ind.rsi_14 - 70) / 20),
        direction: -1,
        signalType: "overbought_rsi",
        payload: { rsi_14: ind.rsi_14 },
      });
    }
  }

  // EMA crossovers
  if (ind.ema_8_above_ema_21 !== null && ind.ema_21_above_ema_50 !== null) {
    if (ind.ema_8_above_ema_21 && ind.ema_21_above_ema_50) {
      signals.push({
        ticker: t, source: "technicals",
        score: 0.6, direction: 1,
        signalType: "ema_bullish_cross",
        payload: { ema_8: ind.ema_8, ema_21: ind.ema_21, ema_50: ind.ema_50 },
      });
    }
    if (!ind.ema_8_above_ema_21 && !ind.ema_21_above_ema_50) {
      signals.push({
        ticker: t, source: "technicals",
        score: 0.6, direction: -1,
        signalType: "ema_bearish_cross",
        payload: { ema_8: ind.ema_8, ema_21: ind.ema_21, ema_50: ind.ema_50 },
      });
    }
  }

  // Bollinger Band breaks
  if (ind.bollinger_band_pct !== null) {
    if (ind.bollinger_band_pct > 1.0) {
      signals.push({
        ticker: t, source: "technicals",
        score: Math.min(1, (ind.bollinger_band_pct - 1.0) * 2),
        direction: 1,
        signalType: "bollinger_break_high",
        payload: { band_pct: ind.bollinger_band_pct },
      });
    }
    if (ind.bollinger_band_pct < 0) {
      signals.push({
        ticker: t, source: "technicals",
        score: Math.min(1, Math.abs(ind.bollinger_band_pct) * 2),
        direction: -1,
        signalType: "bollinger_break_low",
        payload: { band_pct: ind.bollinger_band_pct },
      });
    }
  }

  // Consecutive candle streaks
  if (ind.consecutive_up >= 5) {
    signals.push({
      ticker: t, source: "technicals",
      score: Math.min(1, ind.consecutive_up / 10),
      direction: 1,
      signalType: "green_streak",
      payload: { count: ind.consecutive_up },
    });
  }
  if (ind.consecutive_down >= 5) {
    signals.push({
      ticker: t, source: "technicals",
      score: Math.min(1, ind.consecutive_down / 10),
      direction: -1,
      signalType: "red_streak",
      payload: { count: ind.consecutive_down },
    });
  }

  // MACD crossover
  if (ind.macd_histogram !== null && ind.macd_line !== null && ind.macd_signal !== null) {
    if (ind.macd_histogram > 0 && ind.macd_line > ind.macd_signal) {
      signals.push({
        ticker: t, source: "technicals",
        score: 0.5, direction: 1,
        signalType: "macd_bullish",
        payload: { macd_line: ind.macd_line, macd_signal: ind.macd_signal, histogram: ind.macd_histogram },
      });
    }
    if (ind.macd_histogram < 0 && ind.macd_line < ind.macd_signal) {
      signals.push({
        ticker: t, source: "technicals",
        score: 0.5, direction: -1,
        signalType: "macd_bearish",
        payload: { macd_line: ind.macd_line, macd_signal: ind.macd_signal, histogram: ind.macd_histogram },
      });
    }
  }


  // SMA breakouts (close crossed above/below SMA-50)
  if (ind.close_above_sma_50 === true && ind.sma_50 !== null) {
    signals.push({
      ticker: t, source: "technicals",
      score: 0.55, direction: 1,
      signalType: "sma_breakout",
      payload: { sma_50: ind.sma_50 },
    });
  }
  if (ind.close_above_sma_50 === false && ind.sma_50 !== null) {
    signals.push({
      ticker: t, source: "technicals",
      score: 0.55, direction: -1,
      signalType: "sma_breakdown",
      payload: { sma_50: ind.sma_50 },
    });
  }

  return signals;
}
