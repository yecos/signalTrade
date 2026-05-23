// MARKET REGIME DETECTION ENGINE
// "El mercado cambia. Un setup puede servir en tendencia y morir en rango."
// Detects the current market regime from OHLCV candle data + indicators
// to determine which patterns are optimal and which to avoid.

import type { Candle } from './market-data';
import type { IndicatorSnapshot } from './indicators';
import type { PatternType } from './patterns';
import { atr, bollingerBands, sma, rsi } from './indicators';

// === TYPES ===

export type MarketRegime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'LOW_VOL' | 'NEWS' | 'LIQUIDITY_TRAP';

export interface RegimeResult {
  regime: MarketRegime;
  confidence: number;              // 0-100: how confident in this regime classification
  subRegime: MarketRegime | null;  // secondary regime if mixed signals
  features: {
    trendStrength: number;         // 0-100: ADX-derived directional strength
    volatilityLevel: number;       // 0-100: ATR/BB-derived volatility
    rangeClarity: number;          // 0-100: how clearly ranging (SMA proximity)
    volumeProfile: number;         // 0-100: volume anomaly level
    momentumDirection: number;     // -100 to +100: net momentum direction
    priceEfficiency: number;       // 0-100: how efficiently price moves (low wicks = efficient)
  };
  regimeDescription: string;       // Spanish description
  optimalPatterns: PatternType[];  // Which patterns work best in this regime
  avoidPatterns: PatternType[];    // Which patterns to avoid in this regime
}

// === PATTERN COMPATIBILITY MAP ===

const REGIME_PATTERN_COMPAT: Record<MarketRegime, { optimal: PatternType[]; avoid: PatternType[] }> = {
  TRENDING: { optimal: ['trend_continuation', 'breakout'], avoid: ['fakeout'] },
  RANGING: { optimal: ['reversal', 'fakeout'], avoid: ['breakout', 'trend_continuation'] },
  VOLATILE: { optimal: ['liquidity_sweep'], avoid: ['trend_continuation', 'engulfing'] },
  LOW_VOL: { optimal: [], avoid: ['breakout', 'liquidity_sweep', 'trend_continuation'] },
  NEWS: { optimal: ['breakout'], avoid: ['trend_continuation', 'engulfing'] },
  LIQUIDITY_TRAP: { optimal: ['liquidity_sweep', 'fakeout'], avoid: ['breakout'] },
};

// === SPANISH DESCRIPTIONS ===

const REGIME_DESCRIPTIONS: Record<MarketRegime, (features: RegimeResult['features']) => string> = {
  TRENDING: (f) =>
    `Mercado en tendencia: fuerza direccional ${f.trendStrength.toFixed(0)}%, eficiencia de precio ${f.priceEfficiency.toFixed(0)}%. Preferir continuación de tendencia y rupturas confirmadas.`,
  RANGING: (f) =>
    `Mercado en rango: claridad lateral ${f.rangeClarity.toFixed(0)}%, volatilidad ${f.volatilityLevel.toFixed(0)}%. Operar reversiones y falsas rupturas; evitar buscar trend continuations.`,
  VOLATILE: (f) =>
    `Mercado volátil: volatilidad ${f.volatilityLevel.toFixed(0)}%, perfil de volumen ${f.volumeProfile.toFixed(0)}%. Riesgo alto; buscar barridos de liquidez, evitar engulfing y continuación de tendencia.`,
  LOW_VOL: (f) =>
    `Mercado de baja volatilidad: volatilidad ${f.volatilityLevel.toFixed(0)}%, eficiencia ${f.priceEfficiency.toFixed(0)}%. Sin setups confiables; evitar rupturas, barridos y continuación de tendencia.`,
  NEWS: (f) =>
    `Evento/noticia detectado: volumen anómalo ${f.volumeProfile.toFixed(0)}%, rango de vela extremo. Alta incertidumbre; solo considerar rupturas fuertes, evitar continuación y engulfing.`,
  LIQUIDITY_TRAP: (f) =>
    `Trampa de liquidez: barrido + reversión con volumen. Momentum ${f.momentumDirection > 0 ? 'positivo' : 'negativo'} ${Math.abs(f.momentumDirection).toFixed(0)}%. Preferir barridos de liquidez y fakeouts; evitar rupturas.`,
};

// === HELPER: PERCENTILE RANK ===
// Compute the percentile rank of a value within an array (0-100)

function percentileRank(values: number[], value: number): number {
  const validValues = values.filter(v => !isNaN(v) && isFinite(v));
  if (validValues.length === 0) return 50;
  const below = validValues.filter(v => v < value).length;
  return (below / validValues.length) * 100;
}

// === HELPER: AVERAGE OF ARRAY ===

function avg(values: number[]): number {
  const valid = values.filter(v => !isNaN(v) && isFinite(v));
  if (valid.length === 0) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// === HELPER: COUNT SMA CROSSES ===
// How many times price crossed the SMA in the last N candles

function countSmaCrosses(candles: Candle[], smaValues: number[], lookback: number): number {
  const last = candles.length - 1;
  const start = Math.max(0, last - lookback + 1);
  let crosses = 0;

  for (let i = start + 1; i <= last; i++) {
    if (isNaN(smaValues[i]) || isNaN(smaValues[i - 1])) continue;
    const prevClose = candles[i - 1].close;
    const currClose = candles[i].close;
    const prevSma = smaValues[i - 1];
    const currSma = smaValues[i];

    // Cross above
    if (prevClose <= prevSma && currClose > currSma) crosses++;
    // Cross below
    if (prevClose >= prevSma && currClose < currSma) crosses++;
  }

  return crosses;
}

// === HELPER: COMPUTE AVERAGE CANDLE RANGE ===

function avgCandleRange(candles: Candle[], lookback: number): number {
  const last = candles.length - 1;
  const start = Math.max(0, last - lookback + 1);
  let sum = 0;
  let count = 0;

  for (let i = start; i <= last; i++) {
    sum += candles[i].high - candles[i].low;
    count++;
  }

  return count > 0 ? sum / count : 0;
}

// === HELPER: COMPUTE BODY RATIO ===
// Average body/(high-low) ratio over lookback — measures price efficiency

function avgBodyRatio(candles: Candle[], lookback: number): number {
  const last = candles.length - 1;
  const start = Math.max(0, last - lookback + 1);
  let sum = 0;
  let count = 0;

  for (let i = start; i <= last; i++) {
    const range = candles[i].high - candles[i].low;
    if (range === 0) continue;
    const body = Math.abs(candles[i].close - candles[i].open);
    sum += body / range;
    count++;
  }

  return count > 0 ? sum / count : 0;
}

// === HELPER: COMPUTE AVERAGE VOLUME ===

function avgVolume(candles: Candle[], lookback: number): number {
  const last = candles.length - 1;
  const start = Math.max(0, last - lookback + 1);
  let sum = 0;
  let count = 0;

  for (let i = start; i <= last; i++) {
    sum += candles[i].volume;
    count++;
  }

  return count > 0 ? sum / count : 0;
}

// === HELPER: CHECK FOR GAP ===
// A gap exists when current open is significantly away from previous close

function hasGap(candles: Candle[], atrValue: number | null): boolean {
  if (candles.length < 2 || !atrValue) return false;
  const last = candles.length - 1;
  const gapSize = Math.abs(candles[last].open - candles[last - 1].close);
  return gapSize > atrValue * 0.5;
}

// === HELPER: DETECT LIQUIDITY TRAP PATTERN ===
// Price swept above recent high or below recent low, then reversed back
// with higher volume on the reversal candle

function detectLiquidityTrap(candles: Candle[], rsiValues: number[]): boolean {
  const last = candles.length - 1;
  if (last < 20) return false;

  // Recent 20-candle range (exclude current candle)
  const recentCandles = candles.slice(last - 20, last);
  const recentHighs = recentCandles.map(c => c.high);
  const recentLows = recentCandles.map(c => c.low);
  const maxHigh = Math.max(...recentHighs);
  const minLow = Math.min(...recentLows);

  const curr = candles[last];
  const prev = candles[last - 1];

  // Bullish liquidity trap: swept below recent low then reversed
  const sweptBelow = prev.low < minLow || curr.low < minLow;
  const reversedUp = curr.close > curr.open && curr.close > minLow;
  const volOnReversal = curr.volume > prev.volume;

  // RSI was oversold and is now reverting
  const rsiOversoldRevert =
    rsiValues.length > last &&
    !isNaN(rsiValues[last]) &&
    rsiValues[last] < 35;

  if (sweptBelow && reversedUp && volOnReversal) return true;
  if (sweptBelow && reversedUp && rsiOversoldRevert) return true;

  // Bearish liquidity trap: swept above recent high then reversed
  const sweptAbove = prev.high > maxHigh || curr.high > maxHigh;
  const reversedDown = curr.close < curr.open && curr.close < maxHigh;
  const volOnReversalDown = curr.volume > prev.volume;

  const rsiOverboughtRevert =
    rsiValues.length > last &&
    !isNaN(rsiValues[last]) &&
    rsiValues[last] > 65;

  if (sweptAbove && reversedDown && volOnReversalDown) return true;
  if (sweptAbove && reversedDown && rsiOverboughtRevert) return true;

  return false;
}

// === FEATURE COMPUTATION ===

function computeFeatures(
  candles: Candle[],
  indicators: IndicatorSnapshot,
  atrArray: number[],
  bbResult: ReturnType<typeof bollingerBands>,
  sma20Array: number[],
  rsiArray: number[]
): RegimeResult['features'] {
  const last = candles.length - 1;

  // --- trendStrength: 0-100 based on ADX + DI gap ---
  let trendStrength = 0;
  if (indicators.adx !== null) {
    // ADX contribution (0-60 range from ADX 0-50)
    const adxContrib = Math.min(60, (indicators.adx / 50) * 60);
    // DI gap contribution (0-40)
    let diGapContrib = 0;
    if (indicators.plusDi !== null && indicators.minusDi !== null) {
      const gap = Math.abs(indicators.plusDi - indicators.minusDi);
      diGapContrib = Math.min(40, (gap / 30) * 40);
    }
    trendStrength = Math.min(100, adxContrib + diGapContrib);
  }

  // --- volatilityLevel: 0-100 based on ATR ratio + BB bandwidth percentile ---
  let volatilityLevel = 50; // default to middle
  {
    const currentAtr = atrArray[last] ?? 0;
    // Average ATR over last 50 candles for baseline
    const atrLookback = Math.min(50, atrArray.filter(v => !isNaN(v)).length);
    const validAtrs = atrArray.slice(Math.max(0, last - atrLookback + 1), last + 1).filter(v => !isNaN(v));
    const avgAtr = avg(validAtrs);

    // ATR ratio: current vs average → map to 0-70
    const atrRatio = avgAtr > 0 ? currentAtr / avgAtr : 1;
    const atrContrib = Math.min(70, Math.max(0, ((atrRatio - 0.3) / 2.5) * 70));

    // BB bandwidth percentile → map to 0-30
    const validBandwidths = bbResult.bandwidth.filter(v => !isNaN(v) && isFinite(v));
    const currentBw = bbResult.bandwidth[last] ?? 0;
    const bwPercentile = percentileRank(validBandwidths, currentBw);
    const bwContrib = (bwPercentile / 100) * 30;

    volatilityLevel = Math.min(100, Math.max(0, atrContrib + bwContrib));
  }

  // --- rangeClarity: 0-100 based on SMA crosses + EMA proximity + ADX inverse ---
  let rangeClarity = 0;
  {
    // SMA20 crosses in last 20 candles → more crosses = more ranging
    const crosses = countSmaCrosses(candles, sma20Array, 20);
    const crossContrib = Math.min(40, (crosses / 6) * 40); // 6+ crosses = max

    // EMA12 vs EMA26 proximity (close together = ranging)
    let emaProximityContrib = 0;
    if (indicators.ema12 !== null && indicators.ema26 !== null && indicators.atr14 !== null) {
      const emaDist = Math.abs(indicators.ema12 - indicators.ema26);
      const atrNorm = indicators.atr14 * 0.2; // within 0.2 ATR = very close
      if (atrNorm > 0) {
        const proximity = Math.max(0, 1 - emaDist / (atrNorm * 5));
        emaProximityContrib = proximity * 30;
      }
    }

    // Low ADX contribution (inverse: lower ADX = more ranging)
    const adxInverseContrib = indicators.adx !== null
      ? Math.max(0, 30 - (indicators.adx / 50) * 30)
      : 15;

    // Price near SMA20
    let smaProximityContrib = 0;
    if (indicators.sma20 !== null) {
      const priceDist = Math.abs(candles[last].close - indicators.sma20);
      const atrVal = indicators.atr14 ?? candles[last].close * 0.005;
      const nearness = Math.max(0, 1 - priceDist / (atrVal * 2));
      smaProximityContrib = nearness * 20; // up to 20 bonus but total capped at 100
    }

    rangeClarity = Math.min(100, crossContrib + emaProximityContrib + adxInverseContrib + smaProximityContrib);
  }

  // --- volumeProfile: 0-100 based on relative volume ---
  let volumeProfile = 50;
  {
    const relVol = indicators.volumeAnalysis.relativeVolume;
    // Map relative volume: 1x = 30, 2x = 55, 3x = 75, 5x+ = 100
    if (relVol <= 1) {
      volumeProfile = Math.max(0, 30 * relVol);
    } else {
      volumeProfile = Math.min(100, 30 + (Math.log2(relVol) / Math.log2(5)) * 70);
    }
  }

  // --- momentumDirection: -100 to +100 based on price change + RSI + MACD ---
  let momentumDirection = 0;
  {
    // Price change over last 10 candles normalized by ATR
    const lookback = Math.min(10, candles.length - 1);
    const priceChange = candles[last].close - candles[last - lookback].close;
    const atrVal = indicators.atr14 ?? (Math.abs(priceChange) || 1);
    const priceMomentum = Math.max(-1, Math.min(1, priceChange / (atrVal * lookback * 0.5)));

    // RSI contribution (centered around 50)
    const rsiContrib = indicators.rsi14 !== null
      ? (indicators.rsi14 - 50) / 50  // -1 to +1
      : 0;

    // MACD histogram contribution
    const macdContrib = indicators.macdHistogram !== null && indicators.atr14 !== null
      ? Math.max(-1, Math.min(1, indicators.macdHistogram / (indicators.atr14 * 0.5)))
      : 0;

    momentumDirection = Math.max(-100, Math.min(100,
      priceMomentum * 40 + rsiContrib * 35 + macdContrib * 25
    ));
  }

  // --- priceEfficiency: 0-100 based on body ratio (wicks vs body) ---
  let priceEfficiency = 50;
  {
    const bodyRatio = avgBodyRatio(candles, 20);
    // bodyRatio: 1 = all body (efficient), 0 = all wicks (inefficient)
    priceEfficiency = Math.min(100, Math.max(0, bodyRatio * 100));
  }

  return {
    trendStrength: Math.round(trendStrength * 10) / 10,
    volatilityLevel: Math.round(volatilityLevel * 10) / 10,
    rangeClarity: Math.round(rangeClarity * 10) / 10,
    volumeProfile: Math.round(volumeProfile * 10) / 10,
    momentumDirection: Math.round(momentumDirection * 10) / 10,
    priceEfficiency: Math.round(priceEfficiency * 10) / 10,
  };
}

// === REGIME SCORING ===
// Each regime gets a score. The highest score wins.
// Secondary (subRegime) is the second-highest if close enough.

interface RegimeScore {
  regime: MarketRegime;
  score: number;
}

function scoreRegimes(
  candles: Candle[],
  indicators: IndicatorSnapshot,
  features: RegimeResult['features'],
  atrArray: number[],
  bbResult: ReturnType<typeof bollingerBands>,
  sma20Array: number[],
  rsiArray: number[]
): RegimeScore[] {
  const last = candles.length - 1;
  const scores: RegimeScore[] = [];

  // --- TRENDING ---
  let trendingScore = 0;
  {
    // ADX > 25
    if (indicators.adx !== null) {
      if (indicators.adx > 25) trendingScore += 25;
      else if (indicators.adx > 20) trendingScore += 10;
    }

    // Clear DI gap (directional)
    if (indicators.plusDi !== null && indicators.minusDi !== null) {
      const gap = Math.abs(indicators.plusDi - indicators.minusDi);
      if (gap > 10) trendingScore += 20;
      else if (gap > 5) trendingScore += 10;
    }

    // EMA12 clearly above/below EMA26 (distance > 0.5 * ATR)
    if (indicators.ema12 !== null && indicators.ema26 !== null && indicators.atr14 !== null) {
      const emaDist = Math.abs(indicators.ema12 - indicators.ema26);
      if (emaDist > indicators.atr14 * 0.5) trendingScore += 20;
      else if (emaDist > indicators.atr14 * 0.25) trendingScore += 10;
    }

    // BB bandwidth expanding (current > 75th percentile of recent)
    {
      const validBw = bbResult.bandwidth.filter(v => !isNaN(v) && isFinite(v));
      const currentBw = bbResult.bandwidth[last] ?? 0;
      const bwPerc = percentileRank(validBw, currentBw);
      if (bwPerc > 60) trendingScore += 10;
    }

    // Price mostly on one side of SMA20
    if (indicators.sma20 !== null) {
      const lookback = Math.min(20, candles.length);
      let aboveCount = 0;
      for (let i = last - lookback + 1; i <= last; i++) {
        if (candles[i].close > indicators.sma20) aboveCount++;
      }
      const ratio = aboveCount / lookback;
      if (ratio > 0.7 || ratio < 0.3) trendingScore += 15; // mostly one side
      else if (ratio > 0.6 || ratio < 0.4) trendingScore += 7;
    }

    // Body ratio > 0.5 (efficient moves)
    if (features.priceEfficiency > 50) trendingScore += 10;
  }
  scores.push({ regime: 'TRENDING', score: trendingScore });

  // --- RANGING ---
  let rangingScore = 0;
  {
    // ADX < 20
    if (indicators.adx !== null) {
      if (indicators.adx < 20) rangingScore += 25;
      else if (indicators.adx < 25) rangingScore += 10;
    }

    // BB bandwidth narrow (below 20th percentile)
    {
      const validBw = bbResult.bandwidth.filter(v => !isNaN(v) && isFinite(v));
      const currentBw = bbResult.bandwidth[last] ?? 0;
      const bwPerc = percentileRank(validBw, currentBw);
      if (bwPerc < 20) rangingScore += 20;
      else if (bwPerc < 35) rangingScore += 10;
    }

    // Price crosses SMA20 multiple times in last 20 candles
    {
      const crosses = countSmaCrosses(candles, sma20Array, 20);
      if (crosses >= 4) rangingScore += 20;
      else if (crosses >= 2) rangingScore += 10;
    }

    // EMA12 ≈ EMA26 (within 0.2 * ATR)
    if (indicators.ema12 !== null && indicators.ema26 !== null && indicators.atr14 !== null) {
      const emaDist = Math.abs(indicators.ema12 - indicators.ema26);
      if (emaDist < indicators.atr14 * 0.2) rangingScore += 20;
      else if (emaDist < indicators.atr14 * 0.35) rangingScore += 10;
    }

    // Low directional efficiency (body ratio low)
    if (features.priceEfficiency < 40) rangingScore += 15;
  }
  scores.push({ regime: 'RANGING', score: rangingScore });

  // --- VOLATILE ---
  let volatileScore = 0;
  {
    // ATR > 1.5 * average ATR(50)
    {
      const currentAtr = atrArray[last] ?? 0;
      const atrLookback = Math.min(50, atrArray.filter(v => !isNaN(v)).length);
      const validAtrs = atrArray.slice(Math.max(0, last - atrLookback + 1), last + 1).filter(v => !isNaN(v));
      const avgAtrVal = avg(validAtrs);
      if (avgAtrVal > 0) {
        const atrRatio = currentAtr / avgAtrVal;
        if (atrRatio > 1.5) volatileScore += 25;
        else if (atrRatio > 1.2) volatileScore += 10;
      }
    }

    // BB bandwidth > 75th percentile
    {
      const validBw = bbResult.bandwidth.filter(v => !isNaN(v) && isFinite(v));
      const currentBw = bbResult.bandwidth[last] ?? 0;
      const bwPerc = percentileRank(validBw, currentBw);
      if (bwPerc > 75) volatileScore += 20;
      else if (bwPerc > 60) volatileScore += 10;
    }

    // Large candle ranges (current range > 2 * average range)
    {
      const currentRange = candles[last].high - candles[last].low;
      const avgRange = avgCandleRange(candles, 50);
      if (avgRange > 0) {
        const rangeRatio = currentRange / avgRange;
        if (rangeRatio > 2) volatileScore += 20;
        else if (rangeRatio > 1.5) volatileScore += 10;
      }
    }

    // High volume (relative volume > 1.5)
    if (indicators.volumeAnalysis.relativeVolume > 1.5) volatileScore += 20;
    else if (indicators.volumeAnalysis.relativeVolume > 1.2) volatileScore += 10;

    // Feature-based bonus
    if (features.volatilityLevel > 70) volatileScore += 15;
  }
  scores.push({ regime: 'VOLATILE', score: volatileScore });

  // --- LOW_VOL ---
  let lowVolScore = 0;
  {
    // ATR < 0.5 * average ATR(50)
    {
      const currentAtr = atrArray[last] ?? 0;
      const atrLookback = Math.min(50, atrArray.filter(v => !isNaN(v)).length);
      const validAtrs = atrArray.slice(Math.max(0, last - atrLookback + 1), last + 1).filter(v => !isNaN(v));
      const avgAtrVal = avg(validAtrs);
      if (avgAtrVal > 0) {
        const atrRatio = currentAtr / avgAtrVal;
        if (atrRatio < 0.5) lowVolScore += 25;
        else if (atrRatio < 0.7) lowVolScore += 10;
      }
    }

    // BB bandwidth very narrow
    {
      const validBw = bbResult.bandwidth.filter(v => !isNaN(v) && isFinite(v));
      const currentBw = bbResult.bandwidth[last] ?? 0;
      const bwPerc = percentileRank(validBw, currentBw);
      if (bwPerc < 10) lowVolScore += 20;
      else if (bwPerc < 25) lowVolScore += 10;
    }

    // Small candle ranges
    {
      const currentRange = candles[last].high - candles[last].low;
      const avgRange = avgCandleRange(candles, 50);
      if (avgRange > 0) {
        const rangeRatio = currentRange / avgRange;
        if (rangeRatio < 0.5) lowVolScore += 20;
        else if (rangeRatio < 0.7) lowVolScore += 10;
      }
    }

    // Volume declining or very low
    if (indicators.volumeAnalysis.volumeTrend === 'DECREASING') lowVolScore += 15;
    if (indicators.volumeAnalysis.relativeVolume < 0.6) lowVolScore += 15;
    else if (indicators.volumeAnalysis.relativeVolume < 0.8) lowVolScore += 5;

    // Feature-based bonus
    if (features.volatilityLevel < 25) lowVolScore += 10;
  }
  scores.push({ regime: 'LOW_VOL', score: lowVolScore });

  // --- NEWS ---
  let newsScore = 0;
  {
    // Volume spike > 3x average (extreme)
    if (indicators.volumeAnalysis.relativeVolume > 3) newsScore += 30;
    else if (indicators.volumeAnalysis.relativeVolume > 2) newsScore += 10;

    // Candle range > 3 * average range
    {
      const currentRange = candles[last].high - candles[last].low;
      const avgRange = avgCandleRange(candles, 50);
      if (avgRange > 0) {
        const rangeRatio = currentRange / avgRange;
        if (rangeRatio > 3) newsScore += 25;
        else if (rangeRatio > 2) newsScore += 10;
      }
    }

    // Gap between candles
    if (hasGap(candles, indicators.atr14)) newsScore += 20;

    // Feature-based: extreme volume profile
    if (features.volumeProfile > 80) newsScore += 15;
  }
  scores.push({ regime: 'NEWS', score: newsScore });

  // --- LIQUIDITY_TRAP ---
  let liquidityTrapScore = 0;
  {
    const isTrap = detectLiquidityTrap(candles, rsiArray);
    if (isTrap) {
      liquidityTrapScore += 50; // strong primary signal

      // RSI at extremes then reverting
      if (indicators.rsi14 !== null) {
        if (indicators.rsi14 > 70 || indicators.rsi14 < 30) liquidityTrapScore += 15;
      }

      // Volume on reversal (already partially checked in detectLiquidityTrap)
      if (indicators.volumeAnalysis.relativeVolume > 1.5) liquidityTrapScore += 10;

      // Price swept and came back
      liquidityTrapScore += 10; // base for the pattern
    }
  }
  scores.push({ regime: 'LIQUIDITY_TRAP', score: liquidityTrapScore });

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

// === CONFIDENCE COMPUTATION ===
// Convert the scoring into a 0-100 confidence based on how dominant the winner is

function computeConfidence(scores: RegimeScore[]): number {
  if (scores.length === 0) return 0;

  const winner = scores[0];
  const runnerUp = scores.length > 1 ? scores[1] : null;

  // Base confidence from winner's score (max theoretical score varies by regime)
  // Normalize: most regimes can score ~80-100 max
  const maxTheoretical = 100;
  let rawConfidence = (winner.score / maxTheoretical) * 100;

  // If runner-up is close, reduce confidence (mixed signals)
  if (runnerUp && runnerUp.score > 0) {
    const gap = winner.score - runnerUp.score;
    const dominanceRatio = gap / (winner.score || 1);
    rawConfidence *= (0.5 + dominanceRatio * 0.5); // reduce by up to 50% if close
  }

  return Math.min(100, Math.max(0, Math.round(rawConfidence)));
}

// === MAIN DETECTION FUNCTION ===

export function detectRegime(candles: Candle[], indicators: IndicatorSnapshot): RegimeResult {
  // Fallback for insufficient data
  if (candles.length < 50) {
    return {
      regime: 'RANGING',
      confidence: 20,
      subRegime: null,
      features: {
        trendStrength: 0,
        volatilityLevel: 50,
        rangeClarity: 50,
        volumeProfile: 50,
        momentumDirection: 0,
        priceEfficiency: 50,
      },
      regimeDescription: 'Datos insuficientes (menos de 50 velas). Clasificación por defecto: rango. Se necesitan más datos para un análisis confiable.',
      optimalPatterns: REGIME_PATTERN_COMPAT.RANGING.optimal,
      avoidPatterns: REGIME_PATTERN_COMPAT.RANGING.avoid,
    };
  }

  // Compute intermediate indicator arrays needed for regime analysis
  const atrArray = atr(candles, 14);
  const bbResult = bollingerBands(candles, 20, 2);
  const sma20Array = sma(candles, 20);
  const rsiArray = rsi(candles, 14);

  // Compute features
  const features = computeFeatures(candles, indicators, atrArray, bbResult, sma20Array, rsiArray);

  // Score each regime
  const scores = scoreRegimes(candles, indicators, features, atrArray, bbResult, sma20Array, rsiArray);

  // Determine primary regime
  const primaryRegime = scores[0].regime;

  // Determine sub-regime: second-highest score if within 60% of winner's score
  let subRegime: MarketRegime | null = null;
  if (scores.length > 1 && scores[1].score > 0) {
    const ratio = scores[1].score / (scores[0].score || 1);
    if (ratio >= 0.6) {
      subRegime = scores[1].regime;
    }
  }

  // Compute confidence
  const confidence = computeConfidence(scores);

  // Generate Spanish description
  const regimeDescription = REGIME_DESCRIPTIONS[primaryRegime](features);

  // Pattern compatibility
  const compat = REGIME_PATTERN_COMPAT[primaryRegime];

  return {
    regime: primaryRegime,
    confidence,
    subRegime,
    features,
    regimeDescription,
    optimalPatterns: compat.optimal,
    avoidPatterns: compat.avoid,
  };
}

// === UTILITY: DESCRIBE REGIME (for UI display) ===

export const REGIME_LABELS: Record<MarketRegime, { name: string; nameEs: string; icon: string; color: string }> = {
  TRENDING: {
    name: 'Trending',
    nameEs: 'En tendencia',
    icon: '📈',
    color: 'text-green-500',
  },
  RANGING: {
    name: 'Ranging',
    nameEs: 'En rango',
    icon: '↔️',
    color: 'text-yellow-500',
  },
  VOLATILE: {
    name: 'Volatile',
    nameEs: 'Volátil',
    icon: '⚡',
    color: 'text-red-500',
  },
  LOW_VOL: {
    name: 'Low Volatility',
    nameEs: 'Baja volatilidad',
    icon: '😴',
    color: 'text-gray-400',
  },
  NEWS: {
    name: 'News/Event',
    nameEs: 'Noticia/Evento',
    icon: '📰',
    color: 'text-purple-500',
  },
  LIQUIDITY_TRAP: {
    name: 'Liquidity Trap',
    nameEs: 'Trampa de liquidez',
    icon: '🪤',
    color: 'text-orange-500',
  },
};

// === UTILITY: GET REGIME COMPATIBILITY (for external use) ===

export function getRegimePatternCompat(regime: MarketRegime): { optimal: PatternType[]; avoid: PatternType[] } {
  return REGIME_PATTERN_COMPAT[regime];
}

// === UTILITY: SHOULD TRADE IN REGIME ===
// Quick check: is it advisable to trade in the current regime?

export function shouldTradeInRegime(regime: MarketRegime): { canTrade: boolean; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'; reason: string } {
  switch (regime) {
    case 'TRENDING':
      return { canTrade: true, riskLevel: 'LOW', reason: 'Tendencia clara: setups de continuación y ruptura tienen alta probabilidad.' };
    case 'RANGING':
      return { canTrade: true, riskLevel: 'MEDIUM', reason: 'Mercado lateral: operar reversiones con stops ajustados.' };
    case 'VOLATILE':
      return { canTrade: true, riskLevel: 'HIGH', reason: 'Alta volatilidad: reducir tamaño de posición, stops amplios.' };
    case 'LOW_VOL':
      return { canTrade: false, riskLevel: 'LOW', reason: 'Sin volatilidad: no hay setups confiables. Mejor esperar.' };
    case 'NEWS':
      return { canTrade: false, riskLevel: 'EXTREME', reason: 'Evento/noticia: spread se amplía, slippage alto. No operar.' };
    case 'LIQUIDITY_TRAP':
      return { canTrade: true, riskLevel: 'HIGH', reason: 'Trampa de liquidez: solo operar sweeps confirmados, evitar rupturas.' };
  }
}
