// INDICATOR ENGINE
// Computes technical indicators from OHLCV candle data
// All functions take Candle[] and return computed indicator values

import type { Candle } from './market-data';

// === MOVING AVERAGES ===

export function sma(candles: Candle[], period: number, source: 'close' | 'open' | 'high' | 'low' = 'close'): number[] {
  const values = candles.map(c => c[source]);
  const result: number[] = [];
  
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
  }
  
  return result;
}

export function ema(candles: Candle[], period: number, source: 'close' | 'open' | 'high' | 'low' = 'close'): number[] {
  const values = candles.map(c => c[source]);
  const result: number[] = [];
  const multiplier = 2 / (period + 1);
  
  // Start with SMA for first value
  let prevEma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else if (i === period - 1) {
      result.push(prevEma);
    } else {
      prevEma = (values[i] - prevEma) * multiplier + prevEma;
      result.push(prevEma);
    }
  }
  
  return result;
}

// === RSI (Relative Strength Index) ===

export function rsi(candles: Candle[], period: number = 14): number[] {
  const closes = candles.map(c => c.close);
  const result: number[] = [];
  
  if (closes.length < period + 1) {
    return closes.map(() => NaN);
  }
  
  // Calculate initial average gains/losses
  let avgGain = 0;
  let avgLoss = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  
  avgGain /= period;
  avgLoss /= period;
  
  for (let i = 0; i < period; i++) {
    result.push(NaN);
  }
  
  // First RSI
  const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - (100 / (1 + firstRs)));
  
  // Subsequent RSIs using smoothed method
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - (100 / (1 + rs)));
  }
  
  return result;
}

// === MACD (Moving Average Convergence Divergence) ===

export interface MACDResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

export function macd(
  candles: Candle[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDResult {
  const fastEma = ema(candles, fastPeriod);
  const slowEma = ema(candles, slowPeriod);
  
  // MACD line = fast EMA - slow EMA
  const macdLine = fastEma.map((f, i) => {
    if (isNaN(f) || isNaN(slowEma[i])) return NaN;
    return f - slowEma[i];
  });
  
  // Signal line = EMA of MACD line
  const validMacd = macdLine.filter(v => !isNaN(v));
  const signalLine: number[] = [];
  const multiplier = 2 / (signalPeriod + 1);
  
  let prevSignal = validMacd.length > 0 
    ? validMacd.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod 
    : 0;
  
  let validIdx = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (isNaN(macdLine[i])) {
      signalLine.push(NaN);
    } else if (validIdx < signalPeriod - 1) {
      signalLine.push(NaN);
      validIdx++;
    } else if (validIdx === signalPeriod - 1) {
      signalLine.push(prevSignal);
      validIdx++;
    } else {
      prevSignal = (macdLine[i] - prevSignal) * multiplier + prevSignal;
      signalLine.push(prevSignal);
      validIdx++;
    }
  }
  
  // Histogram = MACD - Signal
  const histogram = macdLine.map((m, i) => {
    if (isNaN(m) || isNaN(signalLine[i])) return NaN;
    return m - signalLine[i];
  });
  
  return { macdLine, signalLine, histogram };
}

// === BOLLINGER BANDS ===

export interface BollingerResult {
  upper: number[];
  middle: number[];  // SMA
  lower: number[];
  bandwidth: number[];
  percentB: number[];
}

export function bollingerBands(
  candles: Candle[],
  period: number = 20,
  stdDev: number = 2
): BollingerResult {
  const closes = candles.map(c => c.close);
  const middle = sma(candles, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];
  const percentB: number[] = [];
  
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(middle[i])) {
      upper.push(NaN);
      lower.push(NaN);
      bandwidth.push(NaN);
      percentB.push(NaN);
    } else {
      const slice = closes.slice(Math.max(0, i - period + 1), i + 1);
      const mean = middle[i];
      const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / slice.length;
      const sd = Math.sqrt(variance);
      
      upper.push(mean + stdDev * sd);
      lower.push(mean - stdDev * sd);
      bandwidth.push(mean !== 0 ? ((mean + stdDev * sd) - (mean - stdDev * sd)) / mean : 0);
      const range = (mean + stdDev * sd) - (mean - stdDev * sd);
      percentB.push(range !== 0 ? (closes[i] - (mean - stdDev * sd)) / range : 0.5);
    }
  }
  
  return { upper, middle, lower, bandwidth, percentB };
}

// === ATR (Average True Range) ===

export function atr(candles: Candle[], period: number = 14): number[] {
  const trueRanges: number[] = [];
  const result: number[] = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trueRanges.push(candles[i].high - candles[i].low);
    } else {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
      trueRanges.push(tr);
    }
  }
  
  // First ATR = simple average
  let avgTr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = 0; i < trueRanges.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else if (i === period - 1) {
      result.push(avgTr);
    } else {
      avgTr = (avgTr * (period - 1) + trueRanges[i]) / period;
      result.push(avgTr);
    }
  }
  
  return result;
}

// === STOCHASTIC RSI ===

export interface StochasticResult {
  k: number[];
  d: number[];
}

export function stochastic(
  candles: Candle[],
  kPeriod: number = 14,
  dPeriod: number = 3
): StochasticResult {
  const kValues: number[] = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i < kPeriod - 1) {
      kValues.push(NaN);
    } else {
      const slice = candles.slice(i - kPeriod + 1, i + 1);
      const highest = Math.max(...slice.map(c => c.high));
      const lowest = Math.min(...slice.map(c => c.low));
      const range = highest - lowest;
      kValues.push(range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100);
    }
  }
  
  // D = SMA of K
  const dValues: number[] = [];
  for (let i = 0; i < kValues.length; i++) {
    if (isNaN(kValues[i]) || i < kPeriod - 1 + dPeriod - 1) {
      dValues.push(NaN);
    } else {
      const slice = kValues.slice(i - dPeriod + 1, i + 1).filter(v => !isNaN(v));
      dValues.push(slice.length >= dPeriod ? slice.reduce((a, b) => a + b, 0) / slice.length : NaN);
    }
  }
  
  return { k: kValues, d: dValues };
}

// === ADX (Average Directional Index) ===

export interface ADXResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

export function adx(candles: Candle[], period: number = 14): ADXResult {
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const trValues: number[] = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      plusDm.push(0);
      minusDm.push(0);
      trValues.push(candles[i].high - candles[i].low);
    } else {
      const upMove = candles[i].high - candles[i - 1].high;
      const downMove = candles[i - 1].low - candles[i].low;
      
      plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
      trValues.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      ));
    }
  }
  
  // Smoothed values
  const smoothedPlusDm: number[] = [];
  const smoothedMinusDm: number[] = [];
  const smoothedTr: number[] = [];
  const plusDi: number[] = [];
  const minusDi: number[] = [];
  const dx: number[] = [];
  const adxResult: number[] = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      smoothedPlusDm.push(NaN);
      smoothedMinusDm.push(NaN);
      smoothedTr.push(NaN);
      plusDi.push(NaN);
      minusDi.push(NaN);
      dx.push(NaN);
      adxResult.push(NaN);
    } else if (i === period - 1) {
      const sp = plusDm.slice(0, period).reduce((a, b) => a + b, 0);
      const sm = minusDm.slice(0, period).reduce((a, b) => a + b, 0);
      const st = trValues.slice(0, period).reduce((a, b) => a + b, 0);
      smoothedPlusDm.push(sp);
      smoothedMinusDm.push(sm);
      smoothedTr.push(st);
      plusDi.push(st !== 0 ? (sp / st) * 100 : 0);
      minusDi.push(st !== 0 ? (sm / st) * 100 : 0);
      const diSum = Math.abs((st !== 0 ? (sp / st) * 100 : 0) + (st !== 0 ? (sm / st) * 100 : 0));
      dx.push(diSum !== 0 ? Math.abs((st !== 0 ? (sp / st) * 100 : 0) - (st !== 0 ? (sm / st) * 100 : 0)) / diSum * 100 : 0);
      adxResult.push(NaN);
    } else {
      const sp = smoothedPlusDm[i - 1] - (smoothedPlusDm[i - 1] / period) + plusDm[i];
      const sm = smoothedMinusDm[i - 1] - (smoothedMinusDm[i - 1] / period) + minusDm[i];
      const st = smoothedTr[i - 1] - (smoothedTr[i - 1] / period) + trValues[i];
      smoothedPlusDm.push(sp);
      smoothedMinusDm.push(sm);
      smoothedTr.push(st);
      const pdi = st !== 0 ? (sp / st) * 100 : 0;
      const mdi = st !== 0 ? (sm / st) * 100 : 0;
      plusDi.push(pdi);
      minusDi.push(mdi);
      const diSum = Math.abs(pdi + mdi);
      dx.push(diSum !== 0 ? Math.abs(pdi - mdi) / diSum * 100 : 0);
      
      // ADX = smoothed DX
      if (i < period * 2 - 2) {
        adxResult.push(NaN);
      } else if (i === period * 2 - 2) {
        const validDx = dx.slice(period - 1, i + 1);
        adxResult.push(validDx.reduce((a, b) => a + (isNaN(b) ? 0 : b), 0) / validDx.length);
      } else {
        const prevAdx = adxResult[i - 1];
        adxResult.push((prevAdx * (period - 1) + dx[i]) / period);
      }
    }
  }
  
  return { adx: adxResult, plusDi, minusDi };
}

// === VOLUME ANALYSIS ===

export interface VolumeAnalysis {
  relativeVolume: number;    // current vs average
  volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
  volumeSpike: boolean;      // volume > 2x average
  avgVolume20: number;
  currentVolume: number;
}

export function analyzeVolume(candles: Candle[], currentIndex?: number): VolumeAnalysis {
  const idx = currentIndex ?? candles.length - 1;
  if (idx < 20) {
    return {
      relativeVolume: 1,
      volumeTrend: 'STABLE',
      volumeSpike: false,
      avgVolume20: 0,
      currentVolume: candles[idx]?.volume || 0,
    };
  }
  
  const recentVolumes = candles.slice(idx - 19, idx + 1).map(c => c.volume);
  const avgVolume20 = recentVolumes.reduce((a, b) => a + b, 0) / 20;
  const currentVolume = candles[idx].volume;
  const relativeVolume = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;
  
  // Volume trend
  const firstHalf = recentVolumes.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
  const secondHalf = recentVolumes.slice(10, 20).reduce((a, b) => a + b, 0) / 10;
  const volumeTrend = secondHalf > firstHalf * 1.2 ? 'INCREASING' 
    : secondHalf < firstHalf * 0.8 ? 'DECREASING' 
    : 'STABLE';
  
  return {
    relativeVolume: Math.round(relativeVolume * 100) / 100,
    volumeTrend,
    volumeSpike: relativeVolume > 2,
    avgVolume20: Math.round(avgVolume20),
    currentVolume: Math.round(currentVolume),
  };
}

// === COMPREHENSIVE INDICATOR SNAPSHOT ===
// Returns all indicators at the latest candle

export interface IndicatorSnapshot {
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  bbBandwidth: number | null;
  bbPercentB: number | null;
  atr14: number | null;
  stochK: number | null;
  stochD: number | null;
  adx: number | null;
  plusDi: number | null;
  minusDi: number | null;
  volumeAnalysis: VolumeAnalysis;
  trend: 'BULLISH' | 'BEARISH' | 'RANGING';
  momentum: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN';
  volatilityLevel: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
}

export function computeAllIndicators(candles: Candle[]): IndicatorSnapshot {
  if (candles.length < 30) {
    return emptySnapshot();
  }
  
  const last = candles.length - 1;
  
  const sma20Arr = sma(candles, 20);
  const sma50Arr = sma(candles, 50);
  const sma200Arr = sma(candles, 200);
  const ema12Arr = ema(candles, 12);
  const ema26Arr = ema(candles, 26);
  const rsi14Arr = rsi(candles, 14);
  const macdResult = macd(candles);
  const bbResult = bollingerBands(candles);
  const atr14Arr = atr(candles, 14);
  const stochResult = stochastic(candles);
  const adxResult = adx(candles);
  const volAnalysis = analyzeVolume(candles);
  
  const currentPrice = candles[last].close;
  const currentRsi = rsi14Arr[last] || null;
  const currentSma20 = sma20Arr[last] || null;
  const currentSma50 = sma50Arr[last] || null;
  const currentEma12 = ema12Arr[last] || null;
  const currentEma26 = ema26Arr[last] || null;
  const currentMacd = macdResult.macdLine[last] || null;
  const currentMacdSignal = macdResult.signalLine[last] || null;
  const currentMacdHist = macdResult.histogram[last] || null;
  const currentBbUpper = bbResult.upper[last] || null;
  const currentBbMiddle = bbResult.middle[last] || null;
  const currentBbLower = bbResult.lower[last] || null;
  const currentBbBandwidth = bbResult.bandwidth[last] || null;
  const currentBbPercentB = bbResult.percentB[last] || null;
  const currentAtr = atr14Arr[last] || null;
  const currentStochK = stochResult.k[last] || null;
  const currentStochD = stochResult.d[last] || null;
  const currentAdx = adxResult.adx[last] || null;
  const currentPlusDi = adxResult.plusDi[last] || null;
  const currentMinusDi = adxResult.minusDi[last] || null;
  
  // Determine trend
  let trend: IndicatorSnapshot['trend'] = 'RANGING';
  if (currentSma20 && currentSma50 && currentEma12) {
    if (currentPrice > currentSma20 && currentSma20 > currentSma50 && currentEma12 > currentEma26) {
      trend = 'BULLISH';
    } else if (currentPrice < currentSma20 && currentSma20 < currentSma50 && currentEma12 < currentEma26) {
      trend = 'BEARISH';
    }
  }
  
  // Determine momentum
  let momentum: IndicatorSnapshot['momentum'] = 'NEUTRAL';
  if (currentRsi !== null) {
    if (currentRsi > 70) momentum = 'STRONG_UP';
    else if (currentRsi > 55) momentum = 'UP';
    else if (currentRsi < 30) momentum = 'STRONG_DOWN';
    else if (currentRsi < 45) momentum = 'DOWN';
  }
  
  // Determine volatility
  let volatilityLevel: IndicatorSnapshot['volatilityLevel'] = 'NORMAL';
  if (currentBbBandwidth !== null) {
    if (currentBbBandwidth > 0.04) volatilityLevel = 'EXTREME';
    else if (currentBbBandwidth > 0.02) volatilityLevel = 'HIGH';
    else if (currentBbBandwidth < 0.005) volatilityLevel = 'LOW';
  }
  
  return {
    sma20: currentSma20,
    sma50: currentSma50,
    sma200: isNaN(sma200Arr[last]) ? null : sma200Arr[last],
    ema12: currentEma12,
    ema26: currentEma26,
    rsi14: currentRsi,
    macdLine: currentMacd,
    macdSignal: currentMacdSignal,
    macdHistogram: currentMacdHist,
    bbUpper: currentBbUpper,
    bbMiddle: currentBbMiddle,
    bbLower: currentBbLower,
    bbBandwidth: currentBbBandwidth,
    bbPercentB: currentBbPercentB,
    atr14: currentAtr,
    stochK: currentStochK,
    stochD: currentStochD,
    adx: currentAdx,
    plusDi: currentPlusDi,
    minusDi: currentMinusDi,
    volumeAnalysis: volAnalysis,
    trend,
    momentum,
    volatilityLevel,
  };
}

function emptySnapshot(): IndicatorSnapshot {
  return {
    sma20: null, sma50: null, sma200: null,
    ema12: null, ema26: null,
    rsi14: null,
    macdLine: null, macdSignal: null, macdHistogram: null,
    bbUpper: null, bbMiddle: null, bbLower: null,
    bbBandwidth: null, bbPercentB: null,
    atr14: null,
    stochK: null, stochD: null,
    adx: null, plusDi: null, minusDi: null,
    volumeAnalysis: {
      relativeVolume: 1, volumeTrend: 'STABLE', volumeSpike: false,
      avgVolume20: 0, currentVolume: 0,
    },
    trend: 'RANGING',
    momentum: 'NEUTRAL',
    volatilityLevel: 'NORMAL',
  };
}
