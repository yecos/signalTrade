// PATTERN ENGINE
// Detects chart patterns from candle data + indicators
// Patterns: breakout, liquidity_sweep, engulfing, fakeout, reversal, trend_continuation

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
  | 'trend_continuation';

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
  
  const last = candles.length - 1;
  const currentPrice = candles[last].close;
  const prevPrice = candles[last - 1].close;
  const prev2Price = candles[last - 2].close;
  
  // === BREAKOUT ===
  const breakout = detectBreakout(candles, ind);
  if (breakout) patterns.push(breakout);
  
  // === LIQUIDITY SWEEP ===
  const liqSweep = detectLiquiditySweep(candles, ind);
  if (liqSweep) patterns.push(liqSweep);
  
  // === ENGULFING ===
  const engulfing = detectEngulfing(candles, ind);
  if (engulfing) patterns.push(engulfing);
  
  // === FAKEOUT ===
  const fakeout = detectFakeout(candles, ind);
  if (fakeout) patterns.push(fakeout);
  
  // === REVERSAL ===
  const reversal = detectReversal(candles, ind);
  if (reversal) patterns.push(reversal);
  
  // === TREND CONTINUATION ===
  const trendCont = detectTrendContinuation(candles, ind);
  if (trendCont) patterns.push(trendCont);
  
  return patterns;
}

// === BREAKOUT DETECTION ===
// Price breaks above/below Bollinger Band or recent range with volume

function detectBreakout(candles: Candle[], ind: IndicatorSnapshot): DetectedPattern | null {
  const last = candles.length - 1;
  const currentPrice = candles[last].close;
  const prevClose = candles[last - 1].close;
  
  // Need Bollinger Bands
  if (!ind.bbUpper || !ind.bbLower || !ind.bbMiddle) return null;
  
  // Bullish breakout: price breaks above upper BB with volume
  if (currentPrice > ind.bbUpper && prevClose <= ind.bbUpper) {
    const volConf = ind.volumeAnalysis.volumeSpike ? 20 : 0;
    const trendConf = ind.trend === 'BULLISH' ? 15 : ind.trend === 'RANGING' ? 5 : -10;
    const adxConf = (ind.adx && ind.adx > 25) ? 15 : 0;
    const confidence = Math.min(95, Math.max(30, 50 + volConf + trendConf + adxConf));
    
    return {
      type: 'breakout',
      direction: 'BULLISH',
      confidence,
      description: `Breakout alcista: precio ${currentPrice.toFixed(5)} rompe BB superior ${ind.bbUpper.toFixed(5)} con ${ind.volumeAnalysis.volumeSpike ? 'spike de volumen' : 'volumen normal'}`,
      keyLevels: {
        entry: currentPrice,
        stopLoss: ind.bbMiddle,
        takeProfit: currentPrice + (currentPrice - ind.bbMiddle) * 2,
      },
      indicators: ['Bollinger Bands', ...(ind.volumeAnalysis.volumeSpike ? ['Volume'] : []), ...(ind.adx && ind.adx > 25 ? ['ADX'] : [])],
    };
  }
  
  // Bearish breakout: price breaks below lower BB with volume
  if (currentPrice < ind.bbLower && prevClose >= ind.bbLower) {
    const volConf = ind.volumeAnalysis.volumeSpike ? 20 : 0;
    const trendConf = ind.trend === 'BEARISH' ? 15 : ind.trend === 'RANGING' ? 5 : -10;
    const adxConf = (ind.adx && ind.adx > 25) ? 15 : 0;
    const confidence = Math.min(95, Math.max(30, 50 + volConf + trendConf + adxConf));
    
    return {
      type: 'breakout',
      direction: 'BEARISH',
      confidence,
      description: `Breakout bajista: precio ${currentPrice.toFixed(5)} rompe BB inferior ${ind.bbLower.toFixed(5)} con ${ind.volumeAnalysis.volumeSpike ? 'spike de volumen' : 'volumen normal'}`,
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

function detectLiquiditySweep(candles: Candle[], ind: IndicatorSnapshot): DetectedPattern | null {
  const last = candles.length - 1;
  if (last < 20) return null;
  
  // Find recent swing highs and lows (last 20 candles)
  const recentCandles = candles.slice(last - 20, last + 1);
  const highs = recentCandles.map(c => c.high);
  const lows = recentCandles.map(c => c.low);
  const maxHigh = Math.max(...highs.slice(0, -1)); // exclude current
  const minLow = Math.min(...lows.slice(0, -1));
  
  const currentHigh = candles[last].high;
  const currentLow = candles[last].low;
  const currentClose = candles[last].close;
  const currentOpen = candles[last].open;
  
  // Bullish liquidity sweep: price dips below recent low then reverses up
  if (currentLow < minLow && currentClose > currentOpen && currentClose > minLow) {
    const bodyRatio = Math.abs(currentClose - currentOpen) / (currentHigh - currentLow || 1);
    const confidence = Math.min(90, Math.max(35, 45 + bodyRatio * 30 + (ind.rsi14 && ind.rsi14 < 35 ? 20 : 0)));
    
    return {
      type: 'liquidity_sweep',
      direction: 'BULLISH',
      confidence,
      description: `Liquidity sweep alcista: precio barre mínimo ${minLow.toFixed(5)} y revierte con vela alcista. Body ratio: ${(bodyRatio * 100).toFixed(0)}%`,
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
      description: `Liquidity sweep bajista: precio barre máximo ${maxHigh.toFixed(5)} y revierte con vela bajista. Body ratio: ${(bodyRatio * 100).toFixed(0)}%`,
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

function detectEngulfing(candles: Candle[], ind: IndicatorSnapshot): DetectedPattern | null {
  const last = candles.length - 1;
  if (last < 1) return null;
  
  const curr = candles[last];
  const prev = candles[last - 1];
  
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

function detectFakeout(candles: Candle[], ind: IndicatorSnapshot): DetectedPattern | null {
  const last = candles.length - 1;
  if (last < 5 || !ind.bbUpper || !ind.bbLower) return null;
  
  const curr = candles[last];
  const prev1 = candles[last - 1];
  const prev2 = candles[last - 2];
  
  // Bullish fakeout: previous candle broke above BB, current falls back inside
  if (prev1.high > ind.bbUpper && curr.close < ind.bbUpper && curr.close < curr.open) {
    const confidence = Math.min(85, Math.max(30, 40 + (ind.rsi14 && ind.rsi14 > 70 ? 20 : 0) + (ind.volumeAnalysis.volumeSpike ? 10 : 0)));
    
    return {
      type: 'fakeout',
      direction: 'BEARISH', // fakeout bullish = bearish signal
      confidence,
      description: `Fakeout alcista: precio rompió BB superior ${ind.bbUpper.toFixed(5)} pero volvió dentro. Señal bajista.`,
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
      description: `Fakeout bajista: precio rompió BB inferior ${ind.bbLower.toFixed(5)} pero volvió dentro. Señal alcista.`,
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

function detectReversal(candles: Candle[], ind: IndicatorSnapshot): DetectedPattern | null {
  const last = candles.length - 1;
  if (last < 10 || ind.rsi14 === null) return null;
  
  // Bullish reversal: RSI oversold + bullish candle
  if (ind.rsi14 < 30 && candles[last].close > candles[last].open) {
    const rsiConf = ind.rsi14 < 20 ? 25 : 15;
    const trendConf = ind.trend === 'BEARISH' ? 10 : 0; // better after downtrend
    const bbConf = (ind.bbPercentB !== null && ind.bbPercentB < 0) ? 10 : 0;
    const confidence = Math.min(90, Math.max(35, 40 + rsiConf + trendConf + bbConf));
    
    return {
      type: 'reversal',
      direction: 'BULLISH',
      confidence,
      description: `Reversión alcista: RSI ${ind.rsi14.toFixed(1)} en sobreventa + vela alcista${ind.trend === 'BEARISH' ? ' tras tendencia bajista' : ''}`,
      keyLevels: {
        entry: candles[last].close,
        stopLoss: candles[last].low,
        takeProfit: candles[last].close + (candles[last].close - candles[last].low) * 2.5,
      },
      indicators: ['RSI', ...(ind.bbPercentB !== null && ind.bbPercentB < 0 ? ['Bollinger Bands'] : [])],
    };
  }
  
  // Bearish reversal: RSI overbought + bearish candle
  if (ind.rsi14 > 70 && candles[last].close < candles[last].open) {
    const rsiConf = ind.rsi14 > 80 ? 25 : 15;
    const trendConf = ind.trend === 'BULLISH' ? 10 : 0;
    const bbConf = (ind.bbPercentB !== null && ind.bbPercentB > 1) ? 10 : 0;
    const confidence = Math.min(90, Math.max(35, 40 + rsiConf + trendConf + bbConf));
    
    return {
      type: 'reversal',
      direction: 'BEARISH',
      confidence,
      description: `Reversión bajista: RSI ${ind.rsi14.toFixed(1)} en sobrecompra + vela bajista${ind.trend === 'BULLISH' ? ' tras tendencia alcista' : ''}`,
      keyLevels: {
        entry: candles[last].close,
        stopLoss: candles[last].high,
        takeProfit: candles[last].close - (candles[last].high - candles[last].close) * 2.5,
      },
      indicators: ['RSI', ...(ind.bbPercentB !== null && ind.bbPercentB > 1 ? ['Bollinger Bands'] : [])],
    };
  }
  
  return null;
}

// === TREND CONTINUATION DETECTION ===
// Pullback in established trend then continuation

function detectTrendContinuation(candles: Candle[], ind: IndicatorSnapshot): DetectedPattern | null {
  const last = candles.length - 1;
  if (last < 5 || !ind.sma20 || !ind.ema12 || !ind.ema26) return null;
  
  const curr = candles[last];
  const prev = candles[last - 1];
  
  // Bullish continuation: pullback to SMA20 then bounce
  if (ind.trend === 'BULLISH' && prev.low <= ind.sma20 * 1.001 && curr.close > curr.open && curr.close > prev.close) {
    const adxConf = (ind.adx && ind.adx > 20) ? 15 : 0;
    const smaTouch = Math.abs(prev.low - ind.sma20) / ind.sma20 < 0.002 ? 10 : 0;
    const confidence = Math.min(90, Math.max(35, 50 + adxConf + smaTouch));
    
    return {
      type: 'trend_continuation',
      direction: 'BULLISH',
      confidence,
      description: `Continuación alcista: pullback a SMA20 ${ind.sma20.toFixed(5)} y rebote. EMA12 > EMA26, tendencia BULLISH.`,
      keyLevels: {
        entry: curr.close,
        stopLoss: ind.sma20 - (ind.atr14 || 0) * 1.5,
        takeProfit: curr.close + (ind.atr14 || curr.close * 0.005) * 3,
      },
      indicators: ['SMA20', 'EMA12/26', ...(ind.adx && ind.adx > 20 ? ['ADX'] : [])],
    };
  }
  
  // Bearish continuation: pullback to SMA20 then rejection
  if (ind.trend === 'BEARISH' && prev.high >= ind.sma20 * 0.999 && curr.close < curr.open && curr.close < prev.close) {
    const adxConf = (ind.adx && ind.adx > 20) ? 15 : 0;
    const smaTouch = Math.abs(prev.high - ind.sma20) / ind.sma20 < 0.002 ? 10 : 0;
    const confidence = Math.min(90, Math.max(35, 50 + adxConf + smaTouch));
    
    return {
      type: 'trend_continuation',
      direction: 'BEARISH',
      confidence,
      description: `Continuación bajista: pullback a SMA20 ${ind.sma20.toFixed(5)} y rechazo. EMA12 < EMA26, tendencia BEARISH.`,
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
    description: 'Precio rompe nivel clave (Bollinger Band) con volumen. Señal de inicio de movimiento direccional.',
  },
  liquidity_sweep: {
    name: 'Liquidity Sweep',
    nameEs: 'Barrido de liquidez',
    description: 'Precio barre un extremo reciente capturando stops, luego revierte. Señal de reversión institucional.',
  },
  engulfing: {
    name: 'Engulfing',
    nameEs: 'Envolvente',
    description: 'Vela actual envuelve completamente la anterior. Señal fuerte de cambio de momentum.',
  },
  fakeout: {
    name: 'Fakeout',
    nameEs: 'Falsa ruptura',
    description: 'Precio rompe nivel clave pero vuelve rápidamente dentro. Señal contraria al falso breakout.',
  },
  reversal: {
    name: 'Reversal',
    nameEs: 'Reversión',
    description: 'RSI en sobrecompra/sobreventa + vela contraria. Señal de cambio de tendencia potencial.',
  },
  trend_continuation: {
    name: 'Trend Continuation',
    nameEs: 'Continuación de tendencia',
    description: 'Pullback a media móvil en tendencia establecida seguido de rebote. Señal de continuación.',
  },
};
