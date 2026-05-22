// MULTI-TIMEFRAME ANALYSIS ENGINE
// "El timeframe superior da el contexto. El inferior da la entrada."
// Analyzes market across H4 → H1 → M15 → M5 to build confluence scores.
// Professional traders NEVER enter on a single timeframe — this engine
// enforces multi-timeframe alignment before signal generation.

import type { Candle } from './market-data';
import { computeAllIndicators, type IndicatorSnapshot } from './indicators';
import { detectRegime, type MarketRegime, type RegimeResult } from './regime-engine';
import { detectSession, type SessionType } from './sessions';

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

export type TimeframeKey = 'H4' | 'H1' | 'M15' | 'M5';

export interface TimeframeAnalysis {
  timeframe: TimeframeKey;
  candles: Candle[];
  indicators: IndicatorSnapshot;
  regime: RegimeResult;
  trend: 'BULLISH' | 'BEARISH' | 'RANGING';
  trendStrength: number;          // 0-100
  momentum: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN';
  keyLevel: {
    support: number;              // nearest support
    resistance: number;           // nearest resistance
    pivot: number;                // central pivot
  };
  volumeContext: 'ACCUMULATING' | 'DISTRIBUTING' | 'NEUTRAL' | 'DRY';
  structureType: 'HH_HL' | 'LL_LH' | 'RANGE' | 'TRANSITION';
  description: string;           // Spanish description
}

export interface MTFConfluence {
  overallDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confluenceScore: number;       // 0-100: how aligned are all timeframes
  timeframeAlignments: number;   // count of aligned timeframes (0-4)
  totalTimeframes: number;       // how many timeframes had data

  // Per-timeframe results
  analyses: Record<TimeframeKey, TimeframeAnalysis | null>;

  // Confluence details
  h1Filter: 'PASS' | 'FAIL' | 'NO_DATA';   // Does H1 trend support the signal?
  h4Filter: 'PASS' | 'FAIL' | 'NO_DATA';   // Does H4 trend support the signal?

  // Risk assessment from MTF
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  riskReason: string;

  // Entry quality from MTF perspective
  entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DANGEROUS';
  entryReason: string;

  // Key levels from higher timeframes
  h4KeyLevel: { support: number; resistance: number } | null;
  h1KeyLevel: { support: number; resistance: number } | null;

  // MTF regime context
  dominantRegime: MarketRegime;
  regimeAlignment: boolean;       // Are all timeframes in compatible regimes?

  description: string;           // Spanish summary
}

// ══════════════════════════════════════════════════════════════════════════════
// TIMEFRAME HIERARCHY CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

export const TIMEFRAME_HIERARCHY: Record<TimeframeKey, {
  label: string;
  labelEs: string;
  minutes: number;
  role: string;
  weight: number;  // Importance in confluence scoring
  minCandles: number;
  description: string;
}> = {
  H4: {
    label: '4 Hour',
    labelEs: '4 Horas',
    minutes: 240,
    role: 'MACRO_TREND',
    weight: 35,
    minCandles: 50,
    description: 'Tendencia macro: define la dirección general del mercado.',
  },
  H1: {
    label: '1 Hour',
    labelEs: '1 Hora',
    minutes: 60,
    role: 'STRUCTURE',
    weight: 30,
    minCandles: 50,
    description: 'Estructura: confirma soportes/resistencias y zonas de interés.',
  },
  M15: {
    label: '15 Min',
    labelEs: '15 Minutos',
    minutes: 15,
    role: 'SETUP',
    weight: 20,
    minCandles: 50,
    description: 'Setup: identifica el patrón y la zona de entrada.',
  },
  M5: {
    label: '5 Min',
    labelEs: '5 Minutos',
    minutes: 5,
    role: 'ENTRY',
    weight: 15,
    minCandles: 50,
    description: 'Entrada: timing preciso y trigger de ejecución.',
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// SINGLE TIMEFRAME ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

function analyzeTimeframe(
  candles: Candle[],
  timeframe: TimeframeKey
): TimeframeAnalysis | null {
  const config = TIMEFRAME_HIERARCHY[timeframe];

  if (candles.length < config.minCandles) {
    return null; // Insufficient data
  }

  // Compute indicators
  const indicators = computeAllIndicators(candles);

  // Detect regime
  const regime = detectRegime(candles, indicators);

  // Determine trend
  const trend = determineTrend(candles, indicators);

  // Trend strength
  const trendStrength = computeTrendStrength(candles, indicators);

  // Momentum
  const momentum = determineMomentum(indicators);

  // Key levels (support/resistance/pivot)
  const keyLevel = computeKeyLevels(candles, indicators);

  // Volume context
  const volumeContext = assessVolumeContext(candles, indicators);

  // Market structure
  const structureType = identifyStructure(candles, indicators);

  // Spanish description
  const description = buildTimeframeDescription(timeframe, trend, momentum, regime, structureType, volumeContext);

  return {
    timeframe,
    candles,
    indicators,
    regime,
    trend,
    trendStrength,
    momentum,
    keyLevel,
    volumeContext,
    structureType,
    description,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TREND DETERMINATION
// ══════════════════════════════════════════════════════════════════════════════

function determineTrend(
  candles: Candle[],
  ind: IndicatorSnapshot
): 'BULLISH' | 'BEARISH' | 'RANGING' {
  const last = candles.length - 1;
  const price = candles[last].close;

  // Multi-MA alignment
  let bullishSignals = 0;
  let bearishSignals = 0;

  // Price vs SMA20
  if (ind.sma20 !== null) {
    if (price > ind.sma20) bullishSignals += 1;
    else bearishSignals += 1;
  }

  // Price vs SMA50
  if (ind.sma50 !== null) {
    if (price > ind.sma50) bullishSignals += 1.5;
    else bearishSignals += 1.5;
  }

  // EMA12 vs EMA26
  if (ind.ema12 !== null && ind.ema26 !== null) {
    if (ind.ema12 > ind.ema26) bullishSignals += 1;
    else bearishSignals += 1;
  }

  // SMA20 vs SMA50
  if (ind.sma20 !== null && ind.sma50 !== null) {
    if (ind.sma20 > ind.sma50) bullishSignals += 1;
    else bearishSignals += 1;
  }

  // MACD direction
  if (ind.macdHistogram !== null) {
    if (ind.macdHistogram > 0) bullishSignals += 0.5;
    else bearishSignals += 0.5;
  }

  // ADX strength check
  if (ind.adx !== null && ind.adx < 20) {
    // Weak trend — lean toward ranging
    return 'RANGING';
  }

  const diff = Math.abs(bullishSignals - bearishSignals);
  const total = bullishSignals + bearishSignals;

  if (total === 0) return 'RANGING';

  // Need at least 60% alignment to call a trend
  const alignment = diff / total;
  if (alignment < 0.25) return 'RANGING';

  return bullishSignals > bearishSignals ? 'BULLISH' : 'BEARISH';
}

// ══════════════════════════════════════════════════════════════════════════════
// TREND STRENGTH (0-100)
// ══════════════════════════════════════════════════════════════════════════════

function computeTrendStrength(candles: Candle[], ind: IndicatorSnapshot): number {
  let strength = 0;

  // ADX contribution (0-40)
  if (ind.adx !== null) {
    if (ind.adx > 40) strength += 40;
    else if (ind.adx > 25) strength += 25;
    else if (ind.adx > 20) strength += 15;
    else strength += 5;
  }

  // DI alignment contribution (0-30)
  if (ind.plusDi !== null && ind.minusDi !== null) {
    const gap = Math.abs(ind.plusDi - ind.minusDi);
    strength += Math.min(30, gap);
  }

  // Price distance from SMA20 (0-15)
  if (ind.sma20 !== null && ind.atr14 !== null) {
    const dist = Math.abs(candles[candles.length - 1].close - ind.sma20);
    const normalizedDist = ind.atr14 > 0 ? dist / ind.atr14 : 0;
    strength += Math.min(15, normalizedDist * 5);
  }

  // BB bandwidth contribution (0-15) — expanding bands = stronger trend
  if (ind.bbBandwidth !== null) {
    // Compare to median bandwidth (typical)
    if (ind.bbBandwidth > 0.02) strength += 15;
    else if (ind.bbBandwidth > 0.01) strength += 10;
    else if (ind.bbBandwidth > 0.005) strength += 5;
  }

  return Math.min(100, Math.max(0, Math.round(strength)));
}

// ══════════════════════════════════════════════════════════════════════════════
// MOMENTUM DETERMINATION
// ══════════════════════════════════════════════════════════════════════════════

function determineMomentum(ind: IndicatorSnapshot): TimeframeAnalysis['momentum'] {
  let score = 0;

  if (ind.rsi14 !== null) {
    if (ind.rsi14 > 65) score += 2;
    else if (ind.rsi14 > 55) score += 1;
    else if (ind.rsi14 < 35) score -= 2;
    else if (ind.rsi14 < 45) score -= 1;
  }

  if (ind.macdHistogram !== null) {
    if (ind.macdHistogram > 0) score += 1;
    else score -= 1;
  }

  if (ind.stochK !== null) {
    if (ind.stochK > 60) score += 0.5;
    else if (ind.stochK < 40) score -= 0.5;
  }

  if (score >= 3) return 'STRONG_UP';
  if (score >= 1) return 'UP';
  if (score <= -3) return 'STRONG_DOWN';
  if (score <= -1) return 'DOWN';
  return 'NEUTRAL';
}

// ══════════════════════════════════════════════════════════════════════════════
// KEY LEVELS (Support / Resistance / Pivot)
// ══════════════════════════════════════════════════════════════════════════════

function computeKeyLevels(
  candles: Candle[],
  ind: IndicatorSnapshot
): TimeframeAnalysis['keyLevel'] {
  const last = candles.length - 1;
  const lookback = Math.min(50, last + 1);
  const recent = candles.slice(last - lookback + 1, last + 1);
  const price = candles[last].close;

  // Find swing highs and lows
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  // Simple pivot: highest high, lowest low, midpoint
  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const pivot = (highestHigh + lowestLow) / 2;

  // Find nearest support (below current price)
  let support = lowestLow;
  let resistance = highestHigh;

  // Refine support: use SMA levels if they're below price
  if (ind.sma20 !== null && ind.sma20 < price) {
    support = Math.max(support, ind.sma20);
  }
  if (ind.sma50 !== null && ind.sma50 < price) {
    support = Math.max(support, ind.sma50);
  }

  // Refine resistance: use SMA levels if they're above price
  if (ind.sma20 !== null && ind.sma20 > price) {
    resistance = Math.min(resistance, ind.sma20);
  }
  if (ind.sma50 !== null && ind.sma50 > price) {
    resistance = Math.min(resistance, ind.sma50);
  }

  // Use BB as secondary levels
  if (ind.bbLower !== null && ind.bbLower < price) {
    support = Math.max(support, ind.bbLower);
  }
  if (ind.bbUpper !== null && ind.bbUpper > price) {
    resistance = Math.min(resistance, ind.bbUpper);
  }

  return {
    support: roundForAsset(support, candles[last]),
    resistance: roundForAsset(resistance, candles[last]),
    pivot: roundForAsset(pivot, candles[last]),
  };
}

function roundForAsset(value: number, candle: Candle): number {
  if (candle.close > 1000) return Math.round(value * 100) / 100;   // BTC, JPY pairs
  if (candle.close > 100) return Math.round(value * 100) / 100;    // JPY, ETH
  return Math.round(value * 100000) / 100000;                       // Forex pairs
}

// ══════════════════════════════════════════════════════════════════════════════
// VOLUME CONTEXT
// ══════════════════════════════════════════════════════════════════════════════

function assessVolumeContext(
  candles: Candle[],
  ind: IndicatorSnapshot
): TimeframeAnalysis['volumeContext'] {
  const relVol = ind.volumeAnalysis.relativeVolume;
  const trend = ind.trend;

  if (relVol < 0.5) return 'DRY';
  if (relVol > 2.0) {
    // High volume + bullish = accumulation
    // High volume + bearish = distribution
    return trend === 'BULLISH' ? 'ACCUMULATING' : 'DISTRIBUTING';
  }
  if (relVol > 1.2 && trend === 'BULLISH') return 'ACCUMULATING';
  if (relVol > 1.2 && trend === 'BEARISH') return 'DISTRIBUTING';
  return 'NEUTRAL';
}

// ══════════════════════════════════════════════════════════════════════════════
// MARKET STRUCTURE IDENTIFICATION
// ══════════════════════════════════════════════════════════════════════════════

function identifyStructure(
  candles: Candle[],
  ind: IndicatorSnapshot
): TimeframeAnalysis['structureType'] {
  const last = candles.length - 1;
  if (last < 20) return 'TRANSITION';

  // Look at last 20 candles for swing points
  const recent = candles.slice(last - 19, last + 1);

  // Find swing highs and lows
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 2; i < recent.length - 2; i++) {
    // Swing high: higher than 2 candles on each side
    if (recent[i].high > recent[i - 1].high && recent[i].high > recent[i - 2].high &&
        recent[i].high > recent[i + 1].high && recent[i].high > recent[i + 2].high) {
      swingHighs.push(recent[i].high);
    }
    // Swing low: lower than 2 candles on each side
    if (recent[i].low < recent[i - 1].low && recent[i].low < recent[i - 2].low &&
        recent[i].low < recent[i + 1].low && recent[i].low < recent[i + 2].low) {
      swingLows.push(recent[i].low);
    }
  }

  // Check for Higher Highs + Higher Lows (bullish structure)
  let hh = true;
  let hl = true;
  for (let i = 1; i < swingHighs.length; i++) {
    if (swingHighs[i] <= swingHighs[i - 1]) hh = false;
  }
  for (let i = 1; i < swingLows.length; i++) {
    if (swingLows[i] <= swingLows[i - 1]) hl = false;
  }
  if (hh && hl) return 'HH_HL';

  // Check for Lower Lows + Lower Highs (bearish structure)
  let ll = true;
  let lh = true;
  for (let i = 1; i < swingHighs.length; i++) {
    if (swingHighs[i] >= swingHighs[i - 1]) lh = false;
  }
  for (let i = 1; i < swingLows.length; i++) {
    if (swingLows[i] >= swingLows[i - 1]) ll = false;
  }
  if (ll && lh) return 'LL_LH';

  // Not enough swing points or mixed = range/transition
  if (swingHighs.length < 2 || swingLows.length < 2) return 'TRANSITION';
  return 'RANGE';
}

// ══════════════════════════════════════════════════════════════════════════════
// TIMEFRAME DESCRIPTION BUILDER
// ══════════════════════════════════════════════════════════════════════════════

function buildTimeframeDescription(
  tf: TimeframeKey,
  trend: 'BULLISH' | 'BEARISH' | 'RANGING',
  momentum: TimeframeAnalysis['momentum'],
  regime: RegimeResult,
  structure: TimeframeAnalysis['structureType'],
  volume: TimeframeAnalysis['volumeContext']
): string {
  const config = TIMEFRAME_HIERARCHY[tf];
  const trendEs = trend === 'BULLISH' ? 'alcista' : trend === 'BEARISH' ? 'bajista' : 'lateral';
  const momEs: Record<string, string> = {
    'STRONG_UP': 'fuerte alcista',
    'UP': 'alcista',
    'NEUTRAL': 'neutral',
    'DOWN': 'bajista',
    'STRONG_DOWN': 'fuerte bajista',
  };
  const structEs: Record<string, string> = {
    'HH_HL': 'maximos y minimos ascendentes',
    'LL_LH': 'maximos y minimos descendentes',
    'RANGE': 'rango definido',
    'TRANSITION': 'transicion / indefinido',
  };
  const volEs: Record<string, string> = {
    'ACCUMULATING': 'acumulacion',
    'DISTRIBUTING': 'distribucion',
    'NEUTRAL': 'neutral',
    'DRY': 'seco / sin interes',
  };

  return `${config.labelEs}: Tendencia ${trendEs}, momentum ${momEs[momentum]}, estructura ${structEs[structure]}, volumen ${volEs[volume]}. Regimen: ${regime.regime} (${regime.confidence}% confianza).`;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFLUENCE COMPUTATION
// ══════════════════════════════════════════════════════════════════════════════

export function computeMTFConfluence(
  m5Analysis: TimeframeAnalysis | null,
  m15Analysis: TimeframeAnalysis | null,
  h1Analysis: TimeframeAnalysis | null,
  h4Analysis: TimeframeAnalysis | null,
  signalDirection?: 'HIGHER' | 'LOWER'  // Optional: check if signal aligns
): MTFConfluence {
  const analyses: Record<TimeframeKey, TimeframeAnalysis | null> = {
    H4: h4Analysis,
    H1: h1Analysis,
    M15: m15Analysis,
    M5: m5Analysis,
  };

  // Count available timeframes
  const available: TimeframeKey[] = (['H4', 'H1', 'M15', 'M5'] as TimeframeKey[])
    .filter(tf => analyses[tf] !== null);
  const totalTimeframes = available.length;

  // Determine overall direction from weighted vote
  let bullishWeight = 0;
  let bearishWeight = 0;

  for (const tf of available) {
    const analysis = analyses[tf]!;
    const weight = TIMEFRAME_HIERARCHY[tf].weight;

    if (analysis.trend === 'BULLISH') bullishWeight += weight;
    else if (analysis.trend === 'BEARISH') bearishWeight += weight;
    // RANGING adds no weight to either side
  }

  let overallDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (bullishWeight > bearishWeight * 1.5) overallDirection = 'BULLISH';
  else if (bearishWeight > bullishWeight * 1.5) overallDirection = 'BEARISH';

  // Count alignments
  const directionForCount = overallDirection === 'NEUTRAL'
    ? (bullishWeight >= bearishWeight ? 'BULLISH' : 'BEARISH')
    : overallDirection;
  const timeframeAlignments = available.filter(tf => {
    const analysis = analyses[tf]!;
    return analysis.trend === directionForCount;
  }).length;

  // Confluence score (0-100)
  let confluenceScore = 0;

  if (totalTimeframes > 0) {
    // Base: alignment ratio * 60
    const alignmentRatio = timeframeAlignments / totalTimeframes;
    confluenceScore += alignmentRatio * 60;

    // Bonus for higher timeframe alignment (H4 + H1 aligned = strong)
    const h4Aligned = h4Analysis && h4Analysis.trend === directionForCount;
    const h1Aligned = h1Analysis && h1Analysis.trend === directionForCount;
    if (h4Aligned && h1Aligned) confluenceScore += 20;
    else if (h4Aligned || h1Aligned) confluenceScore += 10;

    // Bonus for structure alignment
    const bullishStructure = available.filter(tf => analyses[tf]!.structureType === 'HH_HL').length;
    const bearishStructure = available.filter(tf => analyses[tf]!.structureType === 'LL_LH').length;
    if (directionForCount === 'BULLISH' && bullishStructure >= 2) confluenceScore += 10;
    if (directionForCount === 'BEARISH' && bearishStructure >= 2) confluenceScore += 10;

    // Bonus for regime compatibility
    const compatibleRegimes = available.filter(tf => {
      const regime = analyses[tf]!.regime.regime;
      if (directionForCount === 'BULLISH' && (regime === 'TRENDING' || regime === 'RANGING')) return true;
      if (directionForCount === 'BEARISH' && (regime === 'TRENDING' || regime === 'VOLATILE')) return true;
      return false;
    }).length;
    confluenceScore += Math.min(10, compatibleRegimes * 5);
  }

  confluenceScore = Math.min(100, Math.max(0, Math.round(confluenceScore)));

  // H1 filter: does H1 trend support the signal direction?
  let h1Filter: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
  if (h1Analysis) {
    if (!signalDirection) {
      h1Filter = h1Analysis.trend !== 'RANGING' ? 'PASS' : 'FAIL';
    } else {
      const h1Dir = h1Analysis.trend === 'BULLISH' ? 'HIGHER' : h1Analysis.trend === 'BEARISH' ? 'LOWER' : 'NEUTRAL';
      h1Filter = (h1Dir === signalDirection || h1Dir === 'NEUTRAL') ? 'PASS' : 'FAIL';
    }
  }

  // H4 filter
  let h4Filter: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
  if (h4Analysis) {
    if (!signalDirection) {
      h4Filter = h4Analysis.trend !== 'RANGING' ? 'PASS' : 'FAIL';
    } else {
      const h4Dir = h4Analysis.trend === 'BULLISH' ? 'HIGHER' : h4Analysis.trend === 'BEARISH' ? 'LOWER' : 'NEUTRAL';
      h4Filter = (h4Dir === signalDirection || h4Dir === 'NEUTRAL') ? 'PASS' : 'FAIL';
    }
  }

  // Risk level
  let riskLevel: MTFConfluence['riskLevel'] = 'MEDIUM';
  let riskReason = '';

  if (h4Filter === 'FAIL') {
    riskLevel = 'HIGH';
    riskReason = 'H4 en contra de la señal.';
  } else if (h1Filter === 'FAIL') {
    riskLevel = 'HIGH';
    riskReason = 'H1 en contra de la señal.';
  } else if (h4Filter === 'NO_DATA' && h1Filter === 'NO_DATA') {
    riskLevel = 'EXTREME';
    riskReason = 'Sin datos de timeframes superiores.';
  } else if (confluenceScore >= 75) {
    riskLevel = 'LOW';
    riskReason = 'Alta confluencia multi-timeframe.';
  } else if (confluenceScore >= 50) {
    riskLevel = 'MEDIUM';
    riskReason = 'Confluencia moderada.';
  } else {
    riskLevel = 'HIGH';
    riskReason = 'Baja confluencia entre timeframes.';
  }

  // Check for regime conflicts
  const regimes = available.map(tf => analyses[tf]!.regime.regime);
  const hasExtremeRegime = regimes.some(r => r === 'NEWS' || r === 'LIQUIDITY_TRAP');
  if (hasExtremeRegime) {
    riskLevel = 'EXTREME';
    riskReason += ' Regimen extremo detectado.';
  }

  // Entry quality
  let entryQuality: MTFConfluence['entryQuality'] = 'FAIR';
  let entryReason = '';

  if (confluenceScore >= 80 && h4Filter === 'PASS' && h1Filter === 'PASS') {
    entryQuality = 'EXCELLENT';
    entryReason = 'Todos los timeframes alineados, alta confluencia.';
  } else if (confluenceScore >= 60 && (h4Filter === 'PASS' || h1Filter === 'PASS')) {
    entryQuality = 'GOOD';
    entryReason = 'Mayoria de timeframes alineados.';
  } else if (confluenceScore >= 40) {
    entryQuality = 'FAIR';
    entryReason = 'Confluencia parcial — operar con cautela.';
  } else if (confluenceScore >= 20) {
    entryQuality = 'POOR';
    entryReason = 'Baja confluencia — alta probabilidad de whipsaw.';
  } else {
    entryQuality = 'DANGEROUS';
    entryReason = 'Timeframes en conflicto — no operar.';
  }

  // Key levels from higher timeframes
  const h4KeyLevel = h4Analysis ? { support: h4Analysis.keyLevel.support, resistance: h4Analysis.keyLevel.resistance } : null;
  const h1KeyLevel = h1Analysis ? { support: h1Analysis.keyLevel.support, resistance: h1Analysis.keyLevel.resistance } : null;

  // Dominant regime (from H4 > H1 > M15 > M15 priority)
  let dominantRegime: MarketRegime = 'RANGING';
  if (h4Analysis) dominantRegime = h4Analysis.regime.regime;
  else if (h1Analysis) dominantRegime = h1Analysis.regime.regime;
  else if (m15Analysis) dominantRegime = m15Analysis.regime.regime;
  else if (m5Analysis) dominantRegime = m5Analysis.regime.regime;

  // Regime alignment check
  const uniqueRegimes = new Set(regimes);
  const regimeAlignment = uniqueRegimes.size <= 2; // 1-2 different regimes is OK

  // Build description
  const dirEs = overallDirection === 'BULLISH' ? 'ALCISTA' : overallDirection === 'BEARISH' ? 'BAJISTA' : 'NEUTRAL';
  const description = `Confluencia MTF: ${dirEs} (${confluenceScore}%). ${timeframeAlignments}/${totalTimeframes} timeframes alineados. H4: ${h4Filter}, H1: ${h1Filter}. Calidad entrada: ${entryQuality}. Riesgo: ${riskLevel}.`;

  return {
    overallDirection,
    confluenceScore,
    timeframeAlignments,
    totalTimeframes,
    analyses,
    h1Filter,
    h4Filter,
    riskLevel,
    riskReason,
    entryQuality,
    entryReason,
    h4KeyLevel,
    h1KeyLevel,
    dominantRegime,
    regimeAlignment,
    description,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// Fetches candles for all timeframes and runs full MTF analysis
// ══════════════════════════════════════════════════════════════════════════════

export async function analyzeMultiTimeframe(
  asset: string,
  m5Candles: Candle[],          // Already available from auto-trader
  fetchCandles: (asset: string, timeframe: string, count: number) => Promise<Candle[]>,
  signalDirection?: 'HIGHER' | 'LOWER'
): Promise<MTFConfluence> {
  // Analyze M5 (entry timeframe) — already have candles
  const m5Analysis = analyzeTimeframe(m5Candles, 'M5');

  // Fetch and analyze M15 (setup timeframe)
  let m15Candles: Candle[] = [];
  let m15Analysis: TimeframeAnalysis | null = null;
  try {
    m15Candles = await fetchCandles(asset, 'M15', 100);
    m15Analysis = analyzeTimeframe(m15Candles, 'M15');
  } catch {
    // M15 not available
  }

  // Fetch and analyze H1 (structure timeframe)
  let h1Candles: Candle[] = [];
  let h1Analysis: TimeframeAnalysis | null = null;
  try {
    h1Candles = await fetchCandles(asset, 'H1', 100);
    h1Analysis = analyzeTimeframe(h1Candles, 'H1');
  } catch {
    // H1 not available
  }

  // Fetch and analyze H4 (macro trend timeframe)
  let h4Candles: Candle[] = [];
  let h4Analysis: TimeframeAnalysis | null = null;
  try {
    h4Candles = await fetchCandles(asset, 'H4', 100);
    h4Analysis = analyzeTimeframe(h4Candles, 'H4');
  } catch {
    // H4 not available
  }

  return computeMTFConfluence(m5Analysis, m15Analysis, h1Analysis, h4Analysis, signalDirection);
}

// ══════════════════════════════════════════════════════════════════════════════
// QUICK MTF SCORE (for auto-trader pipeline, no async, uses pre-fetched candles)
// ══════════════════════════════════════════════════════════════════════════════

export function quickMTFScore(
  m5Candles: Candle[],
  m15Candles: Candle[] | null,
  h1Candles: Candle[] | null,
  h4Candles: Candle[] | null,
  signalDirection?: 'HIGHER' | 'LOWER'
): { confluence: MTFConfluence; score: number } {
  const m5 = m5Candles.length >= 50 ? analyzeTimeframe(m5Candles, 'M5') : null;
  const m15 = m15Candles && m15Candles.length >= 50 ? analyzeTimeframe(m15Candles, 'M15') : null;
  const h1 = h1Candles && h1Candles.length >= 50 ? analyzeTimeframe(h1Candles, 'H1') : null;
  const h4 = h4Candles && h4Candles.length >= 50 ? analyzeTimeframe(h4Candles, 'H4') : null;

  const confluence = computeMTFConfluence(m5, m15, h1, h4, signalDirection);

  return {
    confluence,
    score: confluence.confluenceScore,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MTF LABELS (for UI display)
// ══════════════════════════════════════════════════════════════════════════════

export const MTF_QUALITY_LABELS: Record<MTFConfluence['entryQuality'], { name: string; nameEs: string; icon: string; color: string }> = {
  EXCELLENT: { name: 'Excellent', nameEs: 'Excelente', icon: '🌟', color: 'text-green-400' },
  GOOD: { name: 'Good', nameEs: 'Buena', icon: '✅', color: 'text-green-500' },
  FAIR: { name: 'Fair', nameEs: 'Regular', icon: '⚡', color: 'text-yellow-500' },
  POOR: { name: 'Poor', nameEs: 'Mala', icon: '⚠️', color: 'text-orange-500' },
  DANGEROUS: { name: 'Dangerous', nameEs: 'Peligrosa', icon: '🚫', color: 'text-red-500' },
};

export const MTF_RISK_LABELS: Record<MTFConfluence['riskLevel'], { nameEs: string; icon: string; color: string }> = {
  LOW: { nameEs: 'Bajo', icon: '🟢', color: 'text-green-500' },
  MEDIUM: { nameEs: 'Medio', icon: '🟡', color: 'text-yellow-500' },
  HIGH: { nameEs: 'Alto', icon: '🟠', color: 'text-orange-500' },
  EXTREME: { nameEs: 'Extremo', icon: '🔴', color: 'text-red-500' },
};
