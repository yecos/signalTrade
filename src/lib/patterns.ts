// PATTERN ENGINE v2 — Wider detection window + new momentum_shift pattern
// Detects chart patterns from candle data + indicators
// Patterns: breakout, liquidity_sweep, engulfing, fakeout, reversal, trend_continuation, momentum_shift
// v2: Scans last 3 candles for pattern formations (not just the very last candle)
//     Added momentum_shift for detecting indicator-driven directional signals

import type { Candle } from './market-data';
import type { IndicatorSnapshot } from './indicators';
import { computeAllIndicators, sma, bollingerBands, rsi } from './indicators';

// === TYPES ===
export type PatternType = 
  | 'breakout' 
  | 'liquidity_sweep' 
  | 'engulfing' 
  | 'fakeout' 
  | 'reversal' 
  | 'trend_continuation'
  | 'momentum_shift';

export interface DetectedPattern {
  type: PatternType;
  direction: 'BULLISH' | 'BEARISH';
  confidence: number;       // 0-100: how strong the pattern signal is
  description: string;
  keyLevels: {
    entry: number;
    stopLoss: number;
    takeProfit: number;
  };
  indicators: string[];     // which indicators support this pattern
}

// === PATTERN DETECTION ===

export function detectPatterns(candles: Candle[], indicators?: IndicatorSnapshot): DetectedPattern[] {
  if (candles.length < 30) return [];
  
  const ind = indicators || computeAllIndicators(candles);
  const patterns: DetectedPattern[] = [];
  const seen = new Set<string>(); // avoid duplicates from multi-candle scan
  
  const tryAdd = (p: DetectedPattern | null) => {
    if (p && !seen.has(p.type + p.direction)) {
      seen.add(p.type + p.direction);
      patterns.push(p);
    }
  };

  // Scan last 3 candles for patterns (not just the very last one)
  // This dramatically increases detection rate on M5 timeframe
  for (let offset = 0; offset <= 2; offset++) {
    const idx = candles.length - 1 - offset;
    if (idx < 5) break;

    // === BREAKOUT (look at candle at idx vs BB) ===
    tryAdd(detectBreakoutAt(candles, ind, idx));

    // === LIQUIDITY SWEEP (look at candle at idx vs recent range) ===
    tryAdd(detectLiquiditySweepAt(candles, ind, idx));

    // === ENGULFING (look at pair idx, idx-1) ===
    tryAdd(detectEngulfingAt(candles, ind, idx));

    // === FAKEOUT (look at pair idx, idx-1) ===
    tryAdd(detectFakeoutAt(candles, ind, idx));

    // === REVERSAL (look at candle at idx + RSI) ===
    tryAdd(detectReversalAt(candles, ind, idx));

    // === TREND CONTINUATION (look at candle at idx) ===
    tryAdd(detectTrendContinuationAt(candles, ind, idx));
  }

  // === MOMENTUM SHIFT (indicator-based, not time-specific) ===
  tryAdd(detectMomentumShift(candles, ind));
  
  return patterns;
}

// === BREAKOUT DETECTION ===
// Price breaks above/below Bollinger Band with volume

function detectBreakoutAt(candles: Candle[], ind: IndicatorSnapshot, idx: number): DetectedPattern | null {
  const currentPrice = candles[idx].close;
  const prevClose = candles[idx - 1].close;
  
  if (!ind.bbUpper || !ind.bbLower || !ind.bbMiddle) return null;
  
  // Bullish breakout: price breaks above upper BB
  if (currentPrice > ind.bbUpper && prevClose <= ind.bbUpper) {
    const volConf = ind.volumeAnalysis.volumeSpike ? 20 : 0;
    const trendConf = ind.trend === 'BULLISH' ? 15 : ind.trend === 'RANGING' ? 5 : -10;
    const adxConf = (ind.adx && ind.adx > 25) ? 15 : 0;
    const confidence = Math.min(95, Math.max(30, 50 + volConf + trendConf + adxConf));
    
    return {
      type: 'breakout',
      direction: 'BULLISH',
      confidence,
      description: `Breakout alcista: precio ${currentPrice.toFixed(2)} rompe BB superior ${ind.bbUpper.toFixed(2)} con ${ind.volumeAnalysis.volumeSpike ? 'spike de volumen' : 'volumen normal'}`,
      keyLevels: {
        entry: currentPrice,
        stopLoss: ind.bbMiddle,
        takeProfit: currentPrice + (currentPrice - ind.bbMiddle) * 2,
      },
      indicators: ['Bollinger Bands', ...(ind.volumeAnalysis.volumeSpike ? ['Volume'] : []), ...(ind.adx && ind.adx > 25 ? ['ADX'] : [])],
    };
  }
  
  // Bearish breakout: price breaks below lower BB
  if (currentPrice < ind.bbLower && prevClose >= ind.bbLower) {
    const volConf = ind.volumeAnalysis.volumeSpike ? 20 : 0;
    const trendConf = ind.trend === 'BEARISH' ? 15 : ind.trend === 'RANGING' ? 5 : -10;
    const adxConf = (ind.adx && ind.adx > 25) ? 15 : 0;
    const confidence = Math.min(95, Math.max(30, 50 + volConf + trendConf + adxConf));
    
    return {
      type: 'breakout',
      direction: 'BEARISH',
      confidence,
      description: `Breakout bajista: precio ${currentPrice.toFixed(2)} rompe BB inferior ${ind.bbLower.toFixed(2)} con ${ind.volumeAnalysis.volumeSpike ? 'spike de volumen' : 'volumen normal'}`,
      keyLevels: {
        entry: currentPrice,
        stopLoss: ind.bbMiddle,
        takeProfit: currentPrice - (ind.bbMiddle - currentPrice) * 2,
      },
      indicators: ['Bollinger Bands', ...(ind.volumeAnalysis.volumeSpike ? ['Volume'] : []), ...(ind.adx && ind.adx > 25 ? ['ADX'] : [])],
    };
  }
  
  return null;
}

// === LIQUIDITY SWEEP DETECTION ===
// Price sweeps beyond recent high/low then reverses sharply

function detectLiquiditySweepAt(candles: Candle[], ind: IndicatorSnapshot, idx: number): DetectedPattern | null {
  if (idx < 20) return null;
  
  // Find recent swing highs and lows (20 candles before idx)
  const recentCandles = candles.slice(idx - 20, idx + 1);
  const highs = recentCandles.map(c => c.high);
  const lows = recentCandles.map(c => c.low);
  const maxHigh = Math.max(...highs.slice(0, -1)); // exclude current
  const minLow = Math.min(...lows.slice(0, -1));
  
  const currentHigh = candles[idx].high;
  const currentLow = candles[idx].low;
  const currentClose = candles[idx].close;
  const currentOpen = candles[idx].open;
  
  // Bullish liquidity sweep: price dips below recent low then reverses up
  if (currentLow < minLow && currentClose > currentOpen && currentClose > minLow) {
    const bodyRatio = Math.abs(currentClose - currentOpen) / (currentHigh - currentLow || 1);
    const confidence = Math.min(90, Math.max(35, 45 + bodyRatio * 30 + (ind.rsi14 && ind.rsi14 < 35 ? 20 : 0)));
    
    return {
      type: 'liquidity_sweep',
      direction: 'BULLISH',
      confidence,
      description: `Liquidity sweep alcista: precio barre minimo ${minLow.toFixed(2)} y revierte con vela alcista. Body ratio: ${(bodyRatio * 100).toFixed(0)}%`,
      keyLevels: {
        entry: currentClose,
        stopLoss: currentLow,
        takeProfit: currentClose + (currentClose - currentLow) * 2,
      },
      indicators: ['Price Action', ...(ind.rsi14 && ind.rsi14 < 35 ? ['RSI'] : [])],
    };
  }
  
  // Bearish liquidity sweep: price spikes above recent high then reverses down
  if (currentHigh > maxHigh && currentClose < currentOpen && currentClose < maxHigh) {
    const bodyRatio = Math.abs(currentClose - currentOpen) / (currentHigh - currentLow || 1);
    const confidence = Math.min(90, Math.max(35, 45 + bodyRatio * 30 + (ind.rsi14 && ind.rsi14 > 65 ? 20 : 0)));
    
    return {
      type: 'liquidity_sweep',
      direction: 'BEARISH',
      confidence,
      description: `Liquidity sweep bajista: precio barre maximo ${maxHigh.toFixed(2)} y revierte con vela bajista. Body ratio: ${(bodyRatio * 100).toFixed(0)}%`,
      keyLevels: {
        entry: currentClose,
        stopLoss: currentHigh,
        takeProfit: currentClose - (currentHigh - currentClose) * 2,
      },
      indicators: ['Price Action', ...(ind.rsi14 && ind.rsi14 > 65 ? ['RSI'] : [])],
    };
  }
  
  return null;
}

// === ENGULFING DETECTION ===
// Current candle engulfs previous candle completely

function detectEngulfingAt(candles: Candle[], ind: IndicatorSnapshot, idx: number): DetectedPattern | null {
  if (idx < 1) return null;
  
  const curr = candles[idx];
  const prev = candles[idx - 1];
  
  // Bullish engulfing: current bullish candle engulfs previous bearish
  if (
    curr.close > curr.open &&        // current is bullish
    prev.close < prev.open &&         // previous is bearish
    curr.open <= prev.close &&        // current open <= prev close
    curr.close >= prev.open           // current close >= prev open
  ) {
    const bodySize = Math.abs(curr.close - curr.open);
    const prevBodySize = Math.abs(prev.close - prev.open);
    const engulfRatio = bodySize / (prevBodySize || 1);
    const volConf = ind.volumeAnalysis.relativeVolume > 1.5 ? 15 : 0;
    const trendConf = ind.trend === 'BEARISH' || ind.trend === 'RANGING' ? 10 : -5; // better at reversal
    const confidence = Math.min(90, Math.max(35, 45 + (engulfRatio > 1.5 ? 15 : 0) + volConf + trendConf));
    
    return {
      type: 'engulfing',
      direction: 'BULLISH',
      confidence,
      description: `Engulfing alcista: vela actual envuelve completamente la anterior. Ratio: ${engulfRatio.toFixed(1)}x`,
      keyLevels: {
        entry: curr.close,
        stopLoss: curr.low,
        takeProfit: curr.close + bodySize * 2,
      },
      indicators: ['Price Action', ...(ind.volumeAnalysis.relativeVolume > 1.5 ? ['Volume'] : [])],
    };
  }
  
  // Bearish engulfing
  if (
    curr.close < curr.open &&         // current is bearish
    prev.close > prev.open &&         // previous is bullish
    curr.open >= prev.close &&        // current open >= prev close
    curr.close <= prev.open           // current close <= prev open
  ) {
    const bodySize = Math.abs(curr.close - curr.open);
    const prevBodySize = Math.abs(prev.close - prev.open);
    const engulfRatio = bodySize / (prevBodySize || 1);
    const volConf = ind.volumeAnalysis.relativeVolume > 1.5 ? 15 : 0;
    const trendConf = ind.trend === 'BULLISH' || ind.trend === 'RANGING' ? 10 : -5;
    const confidence = Math.min(90, Math.max(35, 45 + (engulfRatio > 1.5 ? 15 : 0) + volConf + trendConf));
    
    return {
      type: 'engulfing',
      direction: 'BEARISH',
      confidence,
      description: `Engulfing bajista: vela actual envuelve completamente la anterior. Ratio: ${engulfRatio.toFixed(1)}x`,
      keyLevels: {
        entry: curr.close,
        stopLoss: curr.high,
        takeProfit: curr.close - bodySize * 2,
      },
      indicators: ['Price Action', ...(ind.volumeAnalysis.relativeVolume > 1.5 ? ['Volume'] : [])],
    };
  }
  
  return null;
}

// === FAKEOUT DETECTION ===
// Breakout that fails - price breaks key level then returns inside range

function detectFakeoutAt(candles: Candle[], ind: IndicatorSnapshot, idx: number): DetectedPattern | null {
  if (idx < 2 || !ind.bbUpper || !ind.bbLower) return null;
  
  const curr = candles[idx];
  const prev1 = candles[idx - 1];
  
  // Bullish fakeout: previous candle broke above BB, current falls back inside
  if (prev1.high > ind.bbUpper && curr.close < ind.bbUpper && curr.close < curr.open) {
    const confidence = Math.min(85, Math.max(30, 40 + (ind.rsi14 && ind.rsi14 > 70 ? 20 : 0) + (ind.volumeAnalysis.volumeSpike ? 10 : 0)));
    
    return {
      type: 'fakeout',
      direction: 'BEARISH', // fakeout bullish = bearish signal
      confidence,
      description: `Fakeout alcista: precio rompio BB superior ${ind.bbUpper.toFixed(2)} pero volvio dentro. Senal bajista.`,
      keyLevels: {
        entry: curr.close,
        stopLoss: prev1.high,
        takeProfit: ind.bbLower || curr.close - (prev1.high - curr.close),
      },
      indicators: ['Bollinger Bands', ...(ind.rsi14 && ind.rsi14 > 70 ? ['RSI'] : [])],
    };
  }
  
  // Bearish fakeout: previous candle broke below BB, current rises back inside
  if (prev1.low < ind.bbLower && curr.close > ind.bbLower && curr.close > curr.open) {
    const confidence = Math.min(85, Math.max(30, 40 + (ind.rsi14 && ind.rsi14 < 30 ? 20 : 0) + (ind.volumeAnalysis.volumeSpike ? 10 : 0)));
    
    return {
      type: 'fakeout',
      direction: 'BULLISH', // fakeout bearish = bullish signal
      confidence,
      description: `Fakeout bajista: precio rompio BB inferior ${ind.bbLower.toFixed(2)} pero volvio dentro. Senal alcista.`,
      keyLevels: {
        entry: curr.close,
        stopLoss: prev1.low,
        takeProfit: ind.bbUpper || curr.close + (curr.close - prev1.low),
      },
      indicators: ['Bollinger Bands', ...(ind.rsi14 && ind.rsi14 < 30 ? ['RSI'] : [])],
    };
  }
  
  return null;
}

// === REVERSAL DETECTION ===
// RSI divergence + key candle patterns at extremes
// v2: Relaxed thresholds — RSI < 35 (was 30) and RSI > 65 (was 70)

function detectReversalAt(candles: Candle[], ind: IndicatorSnapshot, idx: number): DetectedPattern | null {
  if (idx < 10 || ind.rsi14 === null) return null;
  
  // Bullish reversal: RSI oversold + bullish candle
  if (ind.rsi14 < 35 && candles[idx].close > candles[idx].open) {
    const rsiConf = ind.rsi14 < 20 ? 25 : ind.rsi14 < 25 ? 20 : 10;
    const trendConf = ind.trend === 'BEARISH' ? 10 : 0; // better after downtrend
    const bbConf = (ind.bbPercentB !== null && ind.bbPercentB < 0.05) ? 10 : 0;
    const confidence = Math.min(90, Math.max(35, 40 + rsiConf + trendConf + bbConf));
    
    return {
      type: 'reversal',
      direction: 'BULLISH',
      confidence,
      description: `Reversion alcista: RSI ${ind.rsi14.toFixed(1)} en sobreventa + vela alcista${ind.trend === 'BEARISH' ? ' tras tendencia bajista' : ''}`,
      keyLevels: {
        entry: candles[idx].close,
        stopLoss: candles[idx].low,
        takeProfit: candles[idx].close + (candles[idx].close - candles[idx].low) * 2.5,
      },
      indicators: ['RSI', ...(ind.bbPercentB !== null && ind.bbPercentB < 0.05 ? ['Bollinger Bands'] : [])],
    };
  }
  
  // Bearish reversal: RSI overbought + bearish candle
  if (ind.rsi14 > 65 && candles[idx].close < candles[idx].open) {
    const rsiConf = ind.rsi14 > 80 ? 25 : ind.rsi14 > 75 ? 20 : 10;
    const trendConf = ind.trend === 'BULLISH' ? 10 : 0;
    const bbConf = (ind.bbPercentB !== null && ind.bbPercentB > 0.95) ? 10 : 0;
    const confidence = Math.min(90, Math.max(35, 40 + rsiConf + trendConf + bbConf));
    
    return {
      type: 'reversal',
      direction: 'BEARISH',
      confidence,
      description: `Reversion bajista: RSI ${ind.rsi14.toFixed(1)} en sobrecompra + vela bajista${ind.trend === 'BULLISH' ? ' tras tendencia alcista' : ''}`,
      keyLevels: {
        entry: candles[idx].close,
        stopLoss: candles[idx].high,
        takeProfit: candles[idx].close - (candles[idx].high - candles[idx].close) * 2.5,
      },
      indicators: ['RSI', ...(ind.bbPercentB !== null && ind.bbPercentB > 0.95 ? ['Bollinger Bands'] : [])],
    };
  }
  
  return null;
}

// === TREND CONTINUATION DETECTION ===
// Pullback in established trend then continuation
// v2: Wider tolerance for SMA20 proximity (0.3% instead of 0.2%)

function detectTrendContinuationAt(candles: Candle[], ind: IndicatorSnapshot, idx: number): DetectedPattern | null {
  if (idx < 1 || !ind.sma20 || !ind.ema12 || !ind.ema26) return null;
  
  const curr = candles[idx];
  const prev = candles[idx - 1];
  
  // Bullish continuation: pullback to SMA20 then bounce
  if (ind.trend === 'BULLISH' && prev.low <= ind.sma20 * 1.003 && curr.close > curr.open && curr.close > prev.close) {
    const adxConf = (ind.adx && ind.adx > 20) ? 15 : 0;
    const smaTouch = Math.abs(prev.low - ind.sma20) / ind.sma20 < 0.003 ? 10 : 0;
    const confidence = Math.min(90, Math.max(35, 50 + adxConf + smaTouch));
    
    return {
      type: 'trend_continuation',
      direction: 'BULLISH',
      confidence,
      description: `Continuacion alcista: pullback a SMA20 ${ind.sma20.toFixed(2)} y rebote. EMA12 > EMA26, tendencia BULLISH.`,
      keyLevels: {
        entry: curr.close,
        stopLoss: ind.sma20 - (ind.atr14 || 0) * 1.5,
        takeProfit: curr.close + (ind.atr14 || curr.close * 0.005) * 3,
      },
      indicators: ['SMA20', 'EMA12/26', ...(ind.adx && ind.adx > 20 ? ['ADX'] : [])],
    };
  }
  
  // Bearish continuation: pullback to SMA20 then rejection
  if (ind.trend === 'BEARISH' && prev.high >= ind.sma20 * 0.997 && curr.close < curr.open && curr.close < prev.close) {
    const adxConf = (ind.adx && ind.adx > 20) ? 15 : 0;
    const smaTouch = Math.abs(prev.high - ind.sma20) / ind.sma20 < 0.003 ? 10 : 0;
    const confidence = Math.min(90, Math.max(35, 50 + adxConf + smaTouch));
    
    return {
      type: 'trend_continuation',
      direction: 'BEARISH',
      confidence,
      description: `Continuacion bajista: pullback a SMA20 ${ind.sma20.toFixed(2)} y rechazo. EMA12 < EMA26, tendencia BEARISH.`,
      keyLevels: {
        entry: curr.close,
        stopLoss: ind.sma20 + (ind.atr14 || 0) * 1.5,
        takeProfit: curr.close - (ind.atr14 || curr.close * 0.005) * 3,
      },
      indicators: ['SMA20', 'EMA12/26', ...(ind.adx && ind.adx > 20 ? ['ADX'] : [])],
    };
  }
  
  return null;
}

// === MOMENTUM SHIFT DETECTION (NEW in v2) ===
// Detects when multiple indicators align to signal a directional shift
// This is the "catch-all" pattern that fires when indicators show clear direction
// even if no classic candlestick pattern is present
// Requirements: At least 3 of 5 indicator signals agree on direction

function detectMomentumShift(candles: Candle[], ind: IndicatorSnapshot): DetectedPattern | null {
  const last = candles.length - 1;
  if (last < 5) return null;
  
  const currentPrice = candles[last].close;
  let bullishSignals = 0;
  let bearishSignals = 0;
  const bullishIndicators: string[] = [];
  const bearishIndicators: string[] = [];
  
  // Signal 1: EMA crossover direction
  if (ind.ema12 !== null && ind.ema26 !== null) {
    if (ind.ema12 > ind.ema26) {
      bullishSignals += 1;
      bullishIndicators.push('EMA12/26');
    } else {
      bearishSignals += 1;
      bearishIndicators.push('EMA12/26');
    }
  }
  
  // Signal 2: MACD histogram
  if (ind.macdHistogram !== null) {
    if (ind.macdHistogram > 0) {
      bullishSignals += 1;
      bullishIndicators.push('MACD');
    } else {
      bearishSignals += 1;
      bearishIndicators.push('MACD');
    }
  }
  
  // Signal 3: RSI zone
  if (ind.rsi14 !== null) {
    if (ind.rsi14 > 55) {
      bullishSignals += 1;
      bullishIndicators.push('RSI');
    } else if (ind.rsi14 < 45) {
      bearishSignals += 1;
      bearishIndicators.push('RSI');
    }
    // RSI 45-55 = neutral, no signal
  }
  
  // Signal 4: Price vs SMA20
  if (ind.sma20 !== null) {
    const priceVsSma = (currentPrice - ind.sma20) / ind.sma20;
    if (priceVsSma > 0.002) {
      bullishSignals += 1;
      bullishIndicators.push('SMA20');
    } else if (priceVsSma < -0.002) {
      bearishSignals += 1;
      bearishIndicators.push('SMA20');
    }
  }
  
  // Signal 5: Stochastic
  if (ind.stochK !== null && ind.stochD !== null) {
    if (ind.stochK > ind.stochD && ind.stochK > 50) {
      bullishSignals += 1;
      bullishIndicators.push('Stoch');
    } else if (ind.stochK < ind.stochD && ind.stochK < 50) {
      bearishSignals += 1;
      bearishIndicators.push('Stoch');
    }
  }
  
  // Need at least 3 signals agreeing for a momentum shift
  const MIN_SIGNALS = 3;
  const atr = ind.atr14 || currentPrice * 0.005;
  
  if (bullishSignals >= MIN_SIGNALS) {
    // Calculate confidence based on signal strength
    const baseConf = 30 + (bullishSignals - MIN_SIGNALS) * 10; // 30 for 3, 40 for 4, 50 for 5
    const adxBoost = (ind.adx && ind.adx > 25) ? 10 : 0;
    const volBoost = ind.volumeAnalysis.relativeVolume > 1.3 ? 5 : 0;
    const trendBoost = ind.trend === 'BULLISH' ? 10 : 0;
    const confidence = Math.min(80, Math.max(30, baseConf + adxBoost + volBoost + trendBoost));
    
    return {
      type: 'momentum_shift',
      direction: 'BULLISH',
      confidence,
      description: `Momentum shift alcista: ${bullishSignals}/5 indicadores alineados (${bullishIndicators.join(', ')}). ADX ${ind.adx?.toFixed(0) || 'N/A'}.`,
      keyLevels: {
        entry: currentPrice,
        stopLoss: currentPrice - atr * 1.5,
        takeProfit: currentPrice + atr * 3,
      },
      indicators: bullishIndicators,
    };
  }
  
  if (bearishSignals >= MIN_SIGNALS) {
    const baseConf = 30 + (bearishSignals - MIN_SIGNALS) * 10;
    const adxBoost = (ind.adx && ind.adx > 25) ? 10 : 0;
    const volBoost = ind.volumeAnalysis.relativeVolume > 1.3 ? 5 : 0;
    const trendBoost = ind.trend === 'BEARISH' ? 10 : 0;
    const confidence = Math.min(80, Math.max(30, baseConf + adxBoost + volBoost + trendBoost));
    
    return {
      type: 'momentum_shift',
      direction: 'BEARISH',
      confidence,
      description: `Momentum shift bajista: ${bearishSignals}/5 indicadores alineados (${bearishIndicators.join(', ')}). ADX ${ind.adx?.toFixed(0) || 'N/A'}.`,
      keyLevels: {
        entry: currentPrice,
        stopLoss: currentPrice + atr * 1.5,
        takeProfit: currentPrice - atr * 3,
      },
      indicators: bearishIndicators,
    };
  }
  
  return null;
}

// === GET BEST PATTERN ===
// Returns the highest-confidence pattern, or null if none detected

export function getBestPattern(candles: Candle[], indicators?: IndicatorSnapshot): DetectedPattern | null {
  const patterns = detectPatterns(candles, indicators);
  if (patterns.length === 0) return null;
  
  // Sort by confidence descending
  patterns.sort((a, b) => b.confidence - a.confidence);
  return patterns[0];
}

// === PATTERN DESCRIPTIONS (for UI) ===

export const PATTERN_DESCRIPTIONS: Record<PatternType, { name: string; nameEs: string; description: string }> = {
  breakout: {
    name: 'Breakout',
    nameEs: 'Ruptura',
    description: 'Precio rompe nivel clave (Bollinger Band) con volumen. Senal de inicio de movimiento direccional.',
  },
  liquidity_sweep: {
    name: 'Liquidity Sweep',
    nameEs: 'Barrido de liquidez',
    description: 'Precio barre un extremo reciente capturando stops, luego revierte. Senal de reversion institucional.',
  },
  engulfing: {
    name: 'Engulfing',
    nameEs: 'Envolvente',
    description: 'Vela actual envuelve completamente la anterior. Senal fuerte de cambio de momentum.',
  },
  fakeout: {
    name: 'Fakeout',
    nameEs: 'Falsa ruptura',
    description: 'Precio rompe nivel clave pero vuelve rapidamente dentro. Senal contraria al falso breakout.',
  },
  reversal: {
    name: 'Reversal',
    nameEs: 'Reversion',
    description: 'RSI en sobrecompra/sobreventa + vela contraria. Senal de cambio de tendencia potencial.',
  },
  trend_continuation: {
    name: 'Trend Continuation',
    nameEs: 'Continuacion de tendencia',
    description: 'Pullback a media movil en tendencia establecida seguido de rebote. Senal de continuacion.',
  },
  momentum_shift: {
    name: 'Momentum Shift',
    nameEs: 'Cambio de momentum',
    description: '3+ indicadores alineados en la misma direccion (EMA, MACD, RSI, SMA20, Stoch). Senal de momentum direccional.',
  },
};
