// FEATURE ENGINEERING MODULE
// Computes 20+ features from candle data + indicators + regime for each signal.
// These features are saved in featuresJson and used later for feature importance analysis.
// Pure computation — no DB access.

import type { Candle } from './market-data';
import type { IndicatorSnapshot } from './indicators';
import { ema, atr, macd } from './indicators';
import { detectSession } from './sessions';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SignalFeatures {
  // Structure
  trend_strength: number;        // 0-100
  distance_to_ema: number;       // % distance from price to EMA20 (signed)
  candle_range: number;          // Current candle range as % of price
  wick_ratio: number;            // 0-1: wick/total ratio
  body_direction: number;        // +1 bullish, -1 bearish, 0 doji
  price_efficiency: number;      // 0-1: how directional the candle

  // Liquidity
  sweep_high: boolean;           // Swept above recent 20-candle high
  sweep_low: boolean;            // Swept below recent 20-candle low
  equal_highs: boolean;          // Multiple similar highs within 0.1 * ATR
  equal_lows: boolean;           // Multiple similar lows within 0.1 * ATR
  imbalance: boolean;            // Directional imbalance (3 candles same dir)

  // Context
  session: string;               // Current session name
  overlap: boolean;              // London/NY overlap
  spread_estimate: number;       // Estimated spread %
  market_speed: number;          // 0-100: how fast market moves
  volatility_percentile: number; // 0-100: ATR percentile
  volume_percentile: number;     // 0-100: volume percentile

  // Indicators
  rsi_zone: 'oversold' | 'neutral' | 'overbought';
  macd_signal: 'bullish_cross' | 'bearish_cross' | 'divergent' | 'neutral';
  bb_position: number;           // 0-1: position within BB
  stoch_zone: 'oversold' | 'neutral' | 'overbought';

  // Regime
  market_regime: string;         // TRENDING, RANGING, etc.
  regime_confidence: number;     // 0-100
}

// ─── Default Features ───────────────────────────────────────────────────────

function defaultFeatures(): SignalFeatures {
  return {
    trend_strength: 0,
    distance_to_ema: 0,
    candle_range: 0,
    wick_ratio: 0,
    body_direction: 0,
    price_efficiency: 0,

    sweep_high: false,
    sweep_low: false,
    equal_highs: false,
    equal_lows: false,
    imbalance: false,

    session: 'OffHours',
    overlap: false,
    spread_estimate: 0,
    market_speed: 0,
    volatility_percentile: 50,
    volume_percentile: 50,

    rsi_zone: 'neutral',
    macd_signal: 'neutral',
    bb_position: 0.5,
    stoch_zone: 'neutral',

    market_regime: 'UNKNOWN',
    regime_confidence: 0,
  };
}

// ─── Helper: Percentile Rank ────────────────────────────────────────────────
// Computes the percentile rank of `value` within `values` array (0-100).

function percentileRank(value: number, values: number[]): number {
  if (values.length === 0) return 50;
  let countBelow = 0;
  for (const v of values) {
    if (v < value) countBelow++;
  }
  // Use midpoint formula for more stable percentile
  const countEqual = values.filter(v => v === value).length;
  return ((countBelow + 0.5 * countEqual) / values.length) * 100;
}

// ─── Structure Features ─────────────────────────────────────────────────────

function computeTrendStrength(indicators: IndicatorSnapshot): number {
  // ADX ranges from 0 to 100 in practice (typically 0-60).
  // We clamp to 0-100 as the final output.
  if (indicators.adx === null) return 0;
  const adx = indicators.adx;
  // ADX < 20 = no trend, 20-25 = weak, 25-50 = strong, 50+ = very strong
  return Math.min(100, Math.max(0, adx));
}

function computeDistanceToEma(candles: Candle[], indicators: IndicatorSnapshot): number {
  // Compute EMA20 and measure signed % distance from current price
  const last = candles.length - 1;
  const currentPrice = candles[last].close;

  // If we have candles, compute EMA20 ourselves (IndicatorSnapshot has ema12/ema26 but not ema20)
  const ema20Arr = ema(candles, 20);
  const ema20 = ema20Arr[last];

  if (isNaN(ema20) || ema20 === 0) {
    // Fallback: use sma20 from indicators if available
    if (indicators.sma20 !== null && indicators.sma20 !== 0) {
      return ((currentPrice - indicators.sma20) / indicators.sma20) * 100;
    }
    return 0;
  }

  // Signed: positive = price above EMA (bullish), negative = below (bearish)
  return ((currentPrice - ema20) / ema20) * 100;
}

function computeCandleRange(candle: Candle): number {
  // Current candle range as % of price (using close as reference)
  if (candle.close === 0) return 0;
  return ((candle.high - candle.low) / candle.close) * 100;
}

function computeWickRatio(candle: Candle): number {
  // (upper wick + lower wick) / total range
  // 0 = all body, 1 = all wick (no body)
  const totalRange = candle.high - candle.low;
  if (totalRange === 0) return 0;

  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  const upperWick = candle.high - bodyHigh;
  const lowerWick = bodyLow - candle.low;

  return (upperWick + lowerWick) / totalRange;
}

function computeBodyDirection(candle: Candle): number {
  const body = candle.close - candle.open;
  const threshold = (candle.high - candle.low) * 0.05; // 5% of range = doji threshold
  if (Math.abs(body) <= threshold) return 0;
  return body > 0 ? 1 : -1;
}

function computePriceEfficiency(candle: Candle): number {
  // |close - open| / (high - low) — how directional the candle is (0-1)
  const totalRange = candle.high - candle.low;
  if (totalRange === 0) return 0;
  return Math.abs(candle.close - candle.open) / totalRange;
}

// ─── Liquidity Features ─────────────────────────────────────────────────────

function computeSweepHigh(candles: Candle[]): boolean {
  // Did the current candle sweep above the recent 20-candle high (excluding current)?
  const last = candles.length - 1;
  if (last < 20) return false;

  const prevHighs = candles.slice(last - 20, last).map(c => c.high);
  const recentHigh = Math.max(...prevHighs);
  return candles[last].high > recentHigh;
}

function computeSweepLow(candles: Candle[]): boolean {
  // Did the current candle sweep below the recent 20-candle low (excluding current)?
  const last = candles.length - 1;
  if (last < 20) return false;

  const prevLows = candles.slice(last - 20, last).map(c => c.low);
  const recentLow = Math.min(...prevLows);
  return candles[last].low < recentLow;
}

function computeEqualHighs(candles: Candle[], atrValue: number): boolean {
  // Are there 2+ similar highs within 0.1 * ATR in the last 20 candles?
  const last = candles.length - 1;
  if (last < 5) return false;

  const threshold = 0.1 * atrValue;
  if (threshold <= 0) return false;

  const recentCandles = candles.slice(Math.max(0, last - 19), last + 1);
  const highs = recentCandles.map(c => c.high);

  // Check for 2+ highs within threshold of each other
  for (let i = 0; i < highs.length; i++) {
    let matchCount = 0;
    for (let j = 0; j < highs.length; j++) {
      if (i !== j && Math.abs(highs[i] - highs[j]) <= threshold) {
        matchCount++;
      }
    }
    if (matchCount >= 1) return true; // 2+ similar = at least 1 other match
  }

  return false;
}

function computeEqualLows(candles: Candle[], atrValue: number): boolean {
  // Are there 2+ similar lows within 0.1 * ATR in the last 20 candles?
  const last = candles.length - 1;
  if (last < 5) return false;

  const threshold = 0.1 * atrValue;
  if (threshold <= 0) return false;

  const recentCandles = candles.slice(Math.max(0, last - 19), last + 1);
  const lows = recentCandles.map(c => c.low);

  for (let i = 0; i < lows.length; i++) {
    let matchCount = 0;
    for (let j = 0; j < lows.length; j++) {
      if (i !== j && Math.abs(lows[i] - lows[j]) <= threshold) {
        matchCount++;
      }
    }
    if (matchCount >= 1) return true;
  }

  return false;
}

function computeImbalance(candles: Candle[]): boolean {
  // Is there a 3-candle directional imbalance (all bullish or all bearish bodies)?
  const last = candles.length - 1;
  if (last < 2) return false;

  const last3 = candles.slice(last - 2, last + 1);

  const allBullish = last3.every(c => c.close > c.open);
  const allBearish = last3.every(c => c.close < c.open);

  return allBullish || allBearish;
}

// ─── Context Features ───────────────────────────────────────────────────────

function computeSession(candles: Candle[]): { session: string; overlap: boolean } {
  const last = candles.length - 1;
  const timestamp = candles[last].timestamp;
  const sessionInfo = detectSession(timestamp);

  // London/NY overlap detection
  const hourUtc = timestamp.getUTCHours();
  const minuteUtc = timestamp.getUTCMinutes();
  const timeInMinutes = hourUtc * 60 + minuteUtc;
  const isOverlap = timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60;

  return {
    session: sessionInfo.session,
    overlap: isOverlap,
  };
}

function computeSpreadEstimate(candles: Candle[]): number {
  // Use min(high - low) of last 3 candles as spread proxy, as % of price
  const last = candles.length - 1;
  if (last < 2) return 0;

  const last3 = candles.slice(last - 2, last + 1);
  const ranges = last3.map(c => c.high - c.low);
  const minRange = Math.min(...ranges);

  const currentPrice = candles[last].close;
  if (currentPrice === 0) return 0;

  return (minRange / currentPrice) * 100;
}

function computeMarketSpeed(candles: Candle[], atrValue: number): number {
  // ATR * (count of directional candles in last 10 / 10), normalized to 0-100
  const last = candles.length - 1;
  if (last < 9) return 0;

  const last10 = candles.slice(last - 9, last + 1);
  let directionalCount = 0;
  for (const c of last10) {
    if (Math.abs(c.close - c.open) > 0) directionalCount++;
  }

  const directionRatio = directionalCount / 10;
  const currentPrice = candles[last].close;
  if (currentPrice === 0) return 0;

  // Normalize: ATR as % of price * direction ratio, then scale to 0-100
  // Typical ATR% for forex: 0.05-0.5%, for crypto: 1-5%
  // We normalize assuming max useful speed is ~2% ATR * full directional
  const atrPercent = (atrValue / currentPrice) * 100;
  const rawSpeed = atrPercent * directionRatio;

  // Scale: 0.5% ATR * 1.0 directional = 100 (max useful speed)
  // Use a reasonable scaling factor
  const normalized = Math.min(100, (rawSpeed / 0.5) * 100);

  return Math.max(0, normalized);
}

function computeVolatilityPercentile(candles: Candle[]): number {
  // Rank current ATR among last 50 ATR values (0-100)
  const last = candles.length - 1;
  if (last < 50) return 50; // insufficient data, return median

  // Compute ATR array for the candle history
  const atr14Arr = atr(candles, 14);

  // Collect last 50 valid ATR values (excluding current)
  const historicalAtrs: number[] = [];
  for (let i = Math.max(0, last - 50); i < last; i++) {
    if (!isNaN(atr14Arr[i])) {
      historicalAtrs.push(atr14Arr[i]);
    }
  }

  const currentAtr = atr14Arr[last];
  if (isNaN(currentAtr) || historicalAtrs.length === 0) return 50;

  return percentileRank(currentAtr, historicalAtrs);
}

function computeVolumePercentile(candles: Candle[]): number {
  // Current volume vs 20-candle volume percentile (0-100)
  const last = candles.length - 1;
  if (last < 20) return 50;

  const recentVolumes = candles.slice(last - 19, last).map(c => c.volume);
  const currentVolume = candles[last].volume;

  return percentileRank(currentVolume, recentVolumes);
}

// ─── Indicator Features ─────────────────────────────────────────────────────

function computeRsiZone(indicators: IndicatorSnapshot): 'oversold' | 'neutral' | 'overbought' {
  if (indicators.rsi14 === null) return 'neutral';
  if (indicators.rsi14 < 30) return 'oversold';
  if (indicators.rsi14 > 70) return 'overbought';
  return 'neutral';
}

function computeMacdSignal(candles: Candle[], indicators: IndicatorSnapshot): 'bullish_cross' | 'bearish_cross' | 'divergent' | 'neutral' {
  // 'bullish_cross': histogram just turned positive (was negative, now positive)
  // 'bearish_cross': histogram just turned negative (was positive, now negative)
  // 'divergent': price making new highs/lows but MACD doesn't confirm
  // 'neutral': none of the above

  if (indicators.macdHistogram === null) return 'neutral';

  const last = candles.length - 1;
  if (last < 2) return 'neutral';

  const currentHist = indicators.macdHistogram;

  // Recompute MACD from candles to access historical histogram values
  let prevHist: number | null = null;
  try {
    const macdResult = macd(candles);
    const prevIdx = last - 1;
    if (prevIdx >= 0 && !isNaN(macdResult.histogram[prevIdx])) {
      prevHist = macdResult.histogram[prevIdx];
    }
  } catch {
    return 'neutral';
  }

  // Detect crosses
  if (prevHist !== null) {
    if (prevHist <= 0 && currentHist > 0) return 'bullish_cross';
    if (prevHist >= 0 && currentHist < 0) return 'bearish_cross';
  }

  // Check for divergence: price makes new extreme but MACD doesn't
  if (last >= 10) {
    const recentCandles = candles.slice(last - 9, last + 1);
    const earlierCandles = candles.slice(Math.max(0, last - 19), last - 9);

    if (earlierCandles.length >= 5) {
      const recentHigh = Math.max(...recentCandles.map(c => c.high));
      const earlierHigh = Math.max(...earlierCandles.map(c => c.high));
      const recentLow = Math.min(...recentCandles.map(c => c.low));
      const earlierLow = Math.min(...earlierCandles.map(c => c.low));

      // Bullish divergence: price makes lower low but MACD makes higher low
      if (recentLow < earlierLow && indicators.macdLine !== null && indicators.macdLine > 0) {
        return 'divergent';
      }
      // Bearish divergence: price makes higher high but MACD makes lower high
      if (recentHigh > earlierHigh && indicators.macdLine !== null && indicators.macdLine < 0) {
        return 'divergent';
      }
    }
  }

  return 'neutral';
}

function computeBbPosition(indicators: IndicatorSnapshot): number {
  // 0 = at lower band, 0.5 = at middle, 1 = at upper band
  if (indicators.bbPercentB !== null) {
    // bbPercentB is already 0-1 scale (from Bollinger Bands calculation)
    return Math.max(0, Math.min(1, indicators.bbPercentB));
  }

  // Fallback: compute manually from bb values
  if (indicators.bbUpper === null || indicators.bbLower === null || indicators.bbMiddle === null) {
    return 0.5;
  }

  const bbRange = indicators.bbUpper - indicators.bbLower;
  if (bbRange === 0) return 0.5;

  // We need current price — estimate from the middle of the snapshot
  // Use the bbPercentB if available, otherwise default
  return 0.5;
}

function computeStochZone(indicators: IndicatorSnapshot): 'oversold' | 'neutral' | 'overbought' {
  if (indicators.stochK === null) return 'neutral';
  if (indicators.stochK < 20) return 'oversold';
  if (indicators.stochK > 80) return 'overbought';
  return 'neutral';
}

// ─── Main Function ──────────────────────────────────────────────────────────

export function computeSignalFeatures(
  candles: Candle[],
  indicators: IndicatorSnapshot,
  regime: { regime: string; confidence: number },
  sessionInfo: { session: string }
): SignalFeatures {
  // Need at least 20 candles for meaningful features
  if (candles.length < 20) {
    return defaultFeatures();
  }

  const last = candles.length - 1;
  const currentCandle = candles[last];

  // Get ATR value for various computations
  const atrValue = indicators.atr14 ?? 0;

  // Compute session info from candle timestamp
  const sessionContext = computeSession(candles);

  // ─── Structure ───────────────────────────────────────────────────────────
  const trend_strength = computeTrendStrength(indicators);
  const distance_to_ema = computeDistanceToEma(candles, indicators);
  const candle_range = computeCandleRange(currentCandle);
  const wick_ratio = computeWickRatio(currentCandle);
  const body_direction = computeBodyDirection(currentCandle);
  const price_efficiency = computePriceEfficiency(currentCandle);

  // ─── Liquidity ──────────────────────────────────────────────────────────
  const sweep_high = computeSweepHigh(candles);
  const sweep_low = computeSweepLow(candles);
  const equal_highs = computeEqualHighs(candles, atrValue);
  const equal_lows = computeEqualLows(candles, atrValue);
  const imbalance = computeImbalance(candles);

  // ─── Context ────────────────────────────────────────────────────────────
  const session = sessionContext.session;
  const overlap = sessionContext.overlap;
  const spread_estimate = computeSpreadEstimate(candles);
  const market_speed = computeMarketSpeed(candles, atrValue);
  const volatility_percentile = computeVolatilityPercentile(candles);
  const volume_percentile = computeVolumePercentile(candles);

  // ─── Indicators ─────────────────────────────────────────────────────────
  const rsi_zone = computeRsiZone(indicators);
  const macd_signal = computeMacdSignal(candles, indicators);
  const bb_position = computeBbPosition(indicators);
  const stoch_zone = computeStochZone(indicators);

  // ─── Regime ─────────────────────────────────────────────────────────────
  const market_regime = regime.regime;
  const regime_confidence = Math.min(100, Math.max(0, regime.confidence));

  return {
    // Structure
    trend_strength,
    distance_to_ema,
    candle_range,
    wick_ratio,
    body_direction,
    price_efficiency,

    // Liquidity
    sweep_high,
    sweep_low,
    equal_highs,
    equal_lows,
    imbalance,

    // Context
    session,
    overlap,
    spread_estimate,
    market_speed,
    volatility_percentile,
    volume_percentile,

    // Indicators
    rsi_zone,
    macd_signal,
    bb_position,
    stoch_zone,

    // Regime
    market_regime,
    regime_confidence,
  };
}
