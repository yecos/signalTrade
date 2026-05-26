// CONFLUENCE ENGINE — "Cuándo SÍ operar" (Sistema Trade Permitido)
// Cuando TODOS los filtros de "No-Trade" están en verde, este sistema evalúa:
// 1. Score de Confluencia: combina múltiples factores (técnico + fundamental + sentimiento)
// 2. Setup Contextualizado: no "BUY BTC" sino "BTC: condiciones favorables para estrategia X, stop en Y, riesgo Z%"
// 3. Backtest en Vivo: rendimiento histórico de ese setup específico en condiciones similares

import type { IndicatorSnapshot } from './indicators';
import type { MarketRegime, RegimeResult } from './regime-engine';
import type { PatternType, DetectedPattern } from './patterns';
import type { MTFConfluence } from './mtf-analysis';
import type { NoTradeAssessment } from './no-trade-system';
import type { SessionType } from './sessions';

// === TYPES ===

export interface ConfluenceFactor {
  name: string;
  nameEs: string;
  score: number;       // 0-100
  weight: number;      // 0-1 (how much this factor counts)
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  reason: string;
}

export interface ContextualizedSetup {
  asset: string;
  strategyName: string;         // e.g., "Liquidity Sweep BULL en Tendencia"
  strategyNameEs: string;       // Spanish name
  direction: 'HIGHER' | 'LOWER';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  riskPercent: number;           // % of account to risk
  confidence: number;            // 0-100
  confluenceScore: number;       // 0-100
  // Strategy-specific context
  regimeCompatibility: 'OPTIMAL' | 'COMPATIBLE' | 'NEUTRAL' | 'INCOMPATIBLE';
  sessionQuality: 'PRIME' | 'GOOD' | 'FAIR' | 'POOR';
  timeframeAlignment: 'ALIGNED' | 'MIXED' | 'CONFLICTING';
  // Historical performance
  historicalWinRate: number;
  historicalSampleSize: number;
  historicalExpectancy: number;
  // Risk context
  suggestedPositionSize: number;  // In base currency
  maxRiskAmount: number;         // In USD
  // Exit criteria
  thesisInvalidation: string;     // What would make this trade wrong
  partialProfitLevels: number[];  // Suggested partial TP levels
}

export interface ConfluenceResult {
  confluenceScore: number;       // 0-100: weighted combination of all factors
  factors: ConfluenceFactor[];   // Individual factor breakdown
  setup: ContextualizedSetup | null; // Null if no trade is recommended
  shouldTrade: boolean;
  reason: string;
}

// === FACTOR WEIGHTS ===
// These determine how much each factor contributes to the confluence score
// Total should equal ~1.0

const FACTOR_WEIGHTS = {
  TECHNICAL_PATTERN: 0.20,     // Pattern strength and quality
  REGIME_COMPAT: 0.15,         // Pattern-regime compatibility
  MTF_ALIGNMENT: 0.15,         // Multi-timeframe confluence
  MOMENTUM: 0.12,              // Momentum indicators alignment
  VOLUME: 0.10,                // Volume confirmation
  SESSION_QUALITY: 0.08,       // Session timing
  HISTORICAL_EDGE: 0.10,       // Historical performance of this setup
  NO_TRADE_CLEARANCE: 0.10,    // No-Trade system score
};

// === FACTOR COMPUTATION ===

function computeTechnicalPatternFactor(pattern: DetectedPattern | null): ConfluenceFactor {
  if (!pattern) {
    return {
      name: 'Technical Pattern',
      nameEs: 'Patrón Técnico',
      score: 10,
      weight: FACTOR_WEIGHTS.TECHNICAL_PATTERN,
      direction: 'NEUTRAL',
      reason: 'Sin patrón detectado. No hay edge técnico.',
    };
  }

  const direction = pattern.direction;
  const score = Math.min(100, pattern.confidence * 1.1); // Boost slightly

  const patternNames: Record<string, string> = {
    breakout: 'Ruptura',
    liquidity_sweep: 'Barrido de Liquidez',
    engulfing: 'Envolvente',
    fakeout: 'Falsa Ruptura',
    reversal: 'Reversión',
    trend_continuation: 'Continuación',
    momentum_shift: 'Cambio de Momentum',
  };

  return {
    name: 'Technical Pattern',
    nameEs: 'Patrón Técnico',
    score,
    weight: FACTOR_WEIGHTS.TECHNICAL_PATTERN,
    direction: direction as any,
    reason: `${patternNames[pattern.type] || pattern.type} ${direction === 'BULLISH' ? 'alcista' : 'bajista'} con confianza ${pattern.confidence.toFixed(0)}%`,
  };
}

function computeRegimeCompatFactor(
  regimeResult: RegimeResult,
  pattern: DetectedPattern | null
): ConfluenceFactor {
  if (!pattern) {
    return {
      name: 'Regime Compatibility',
      nameEs: 'Compatibilidad de Régimen',
      score: 30,
      weight: FACTOR_WEIGHTS.REGIME_COMPAT,
      direction: 'NEUTRAL',
      reason: `Régimen ${regimeResult.regime} — sin patrón para comparar.`,
    };
  }

  const isOptimal = regimeResult.optimalPatterns.includes(pattern.type);
  const isAvoid = regimeResult.avoidPatterns.includes(pattern.type);

  let score = 50; // Neutral
  let reason = '';

  if (isOptimal) {
    score = 80 + regimeResult.confidence * 0.2; // 80-100
    reason = `${pattern.type} es ÓPTIMO en régimen ${regimeResult.regime} (confianza ${regimeResult.confidence.toFixed(0)}%)`;
  } else if (isAvoid) {
    score = 10 + (100 - regimeResult.confidence) * 0.2; // 10-30
    reason = `${pattern.type} es INCOMPATIBLE con régimen ${regimeResult.regime}. Evitar.`;
  } else {
    score = 40 + regimeResult.confidence * 0.2; // 40-60
    reason = `${pattern.type} es NEUTRO en régimen ${regimeResult.regime}. Ni óptimo ni evitado.`;
  }

  return {
    name: 'Regime Compatibility',
    nameEs: 'Compatibilidad de Régimen',
    score: Math.min(100, Math.max(0, score)),
    weight: FACTOR_WEIGHTS.REGIME_COMPAT,
    direction: pattern.direction as any,
    reason,
  };
}

function computeMTFAlignmentFactor(
  mtfScore: number,
  mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  pattern: DetectedPattern | null
): ConfluenceFactor {
  const patternDir = pattern?.direction || 'NEUTRAL';

  let score = mtfScore;
  let reason = '';

  if (mtfDirection === 'NEUTRAL') {
    score = 40;
    reason = `MTF neutro: confluencia ${mtfScore.toFixed(0)}%. Sin dirección clara en timeframes superiores.`;
  } else if (patternDir !== 'NEUTRAL' && mtfDirection !== patternDir) {
    // MTF opposes the signal
    score = Math.max(5, mtfScore * 0.4);
    reason = `MTF CONTRA: ${mtfDirection} opuesto a señal ${patternDir}. Confluencia ${mtfScore.toFixed(0)}%. Alta probabilidad de fallo.`;
  } else {
    reason = `MTF A FAVOR: ${mtfDirection} alineado con señal. Confluencia ${mtfScore.toFixed(0)}%.`;
  }

  return {
    name: 'Multi-Timeframe Alignment',
    nameEs: 'Alineación Multi-Timeframe',
    score: Math.min(100, Math.max(0, score)),
    weight: FACTOR_WEIGHTS.MTF_ALIGNMENT,
    direction: mtfDirection,
    reason,
  };
}

function computeMomentumFactor(indicators: IndicatorSnapshot): ConfluenceFactor {
  let bullish = 0;
  let bearish = 0;
  const reasons: string[] = [];

  // RSI
  if (indicators.rsi14 !== null) {
    if (indicators.rsi14 > 55) { bullish += 1; reasons.push(`RSI ${indicators.rsi14.toFixed(0)} alcista`); }
    else if (indicators.rsi14 < 45) { bearish += 1; reasons.push(`RSI ${indicators.rsi14.toFixed(0)} bajista`); }
  }

  // MACD
  if (indicators.macdHistogram !== null) {
    if (indicators.macdHistogram > 0) { bullish += 1; reasons.push('MACD positivo'); }
    else { bearish += 1; reasons.push('MACD negativo'); }
  }

  // EMA
  if (indicators.ema12 !== null && indicators.ema26 !== null) {
    if (indicators.ema12 > indicators.ema26) { bullish += 1; reasons.push('EMA12 > EMA26'); }
    else { bearish += 1; reasons.push('EMA12 < EMA26'); }
  }

  // Stochastic
  if (indicators.stochK !== null && indicators.stochD !== null) {
    if (indicators.stochK > indicators.stochD) { bullish += 0.5; }
    else { bearish += 0.5; }
  }

  // ADX
  const adxStrength = indicators.adx && indicators.adx > 25 ? 10 : 0;

  const direction = bullish > bearish ? 'BULLISH' : bearish > bullish ? 'BEARISH' : 'NEUTRAL';
  const score = direction === 'NEUTRAL' ? 30 : Math.min(100, 40 + Math.abs(bullish - bearish) * 15 + adxStrength);

  return {
    name: 'Momentum',
    nameEs: 'Momentum',
    score,
    weight: FACTOR_WEIGHTS.MOMENTUM,
    direction,
    reason: reasons.length > 0 ? reasons.join(', ') : 'Sin señales de momentum claras',
  };
}

function computeVolumeFactor(indicators: IndicatorSnapshot): ConfluenceFactor {
  const relVol = indicators.volumeAnalysis?.relativeVolume || 1;
  const volSpike = indicators.volumeAnalysis?.volumeSpike || false;
  const volTrend = indicators.volumeAnalysis?.volumeTrend || 'STABLE';

  let score = 50;
  let reason = '';

  if (volSpike) {
    score = 85;
    reason = `Spike de volumen: ${relVol.toFixed(1)}x promedio. Confirmación fuerte.`;
  } else if (relVol > 1.5) {
    score = 75;
    reason = `Volumen alto: ${relVol.toFixed(1)}x promedio. Buena participación.`;
  } else if (relVol > 0.8) {
    score = 55;
    reason = `Volumen normal: ${relVol.toFixed(1)}x promedio.`;
  } else if (relVol > 0.5) {
    score = 35;
    reason = `Volumen bajo: ${relVol.toFixed(1)}x promedio. Falta de participantes.`;
  } else {
    score = 15;
    reason = `Volumen muy bajo: ${relVol.toFixed(1)}x promedio. Sin liquidez.`;
  }

  if (volTrend === 'INCREASING') {
    score = Math.min(100, score + 10);
    reason += ' Tendencia creciente.';
  } else if (volTrend === 'DECREASING') {
    score = Math.max(0, score - 10);
    reason += ' Tendencia decreciente.';
  }

  return {
    name: 'Volume',
    nameEs: 'Volumen',
    score,
    weight: FACTOR_WEIGHTS.VOLUME,
    direction: 'NEUTRAL', // Volume confirms but doesn't indicate direction
    reason,
  };
}

function computeSessionQualityFactor(sessionType: string): ConfluenceFactor {
  const sessionScores: Record<string, { score: number; label: string }> = {
    'Overlap': { score: 95, label: 'Solape Londres-NY: máxima liquidez y volatilidad' },
    'London': { score: 80, label: 'Sesión Londres: buena liquidez para forex' },
    'NewYork': { score: 75, label: 'Sesión NY: buena liquidez' },
    'Asia': { score: 45, label: 'Sesión Asia: liquidez limitada, spreads amplios' },
    'OffHours': { score: 15, label: 'Fuera de sesión: no operar' },
  };

  const config = sessionScores[sessionType] || sessionScores['OffHours'];

  return {
    name: 'Session Quality',
    nameEs: 'Calidad de Sesión',
    score: config.score,
    weight: FACTOR_WEIGHTS.SESSION_QUALITY,
    direction: 'NEUTRAL',
    reason: config.label,
  };
}

function computeHistoricalEdgeFactor(
  winRate: number,
  sampleSize: number,
  expectancy: number,
  edgeClassification: string
): ConfluenceFactor {
  let score = 30; // Default: no edge info
  let reason = 'Sin datos históricos suficientes.';

  if (sampleSize >= 30) {
    if (winRate > 60 && expectancy > 0) {
      score = 80 + Math.min(20, (winRate - 60) * 1.5);
      reason = `Edge confirmado: WR ${winRate.toFixed(1)}%, EV ${expectancy.toFixed(2)}R, n=${sampleSize}. Edge ${edgeClassification}.`;
    } else if (winRate > 50 && expectancy > 0) {
      score = 55 + Math.min(15, (winRate - 50) * 1.5);
      reason = `Edge moderado: WR ${winRate.toFixed(1)}%, EV ${expectancy.toFixed(2)}R, n=${sampleSize}. Edge ${edgeClassification}.`;
    } else {
      score = 15;
      reason = `Edge negativo: WR ${winRate.toFixed(1)}%, EV ${expectancy.toFixed(2)}R, n=${sampleSize}. NO operar.`;
    }
  } else if (sampleSize >= 10) {
    score = 35;
    reason = `Datos insuficientes (n=${sampleSize}). Se necesitan 30+ muestras para confirmar edge.`;
  }

  return {
    name: 'Historical Edge',
    nameEs: 'Edge Histórico',
    score: Math.min(100, Math.max(0, score)),
    weight: FACTOR_WEIGHTS.HISTORICAL_EDGE,
    direction: 'NEUTRAL',
    reason,
  };
}

function computeNoTradeClearanceFactor(noTradeAssessment: NoTradeAssessment | null): ConfluenceFactor {
  if (!noTradeAssessment) {
    return {
      name: 'No-Trade Clearance',
      nameEs: 'Autorización No-Trade',
      score: 50,
      weight: FACTOR_WEIGHTS.NO_TRADE_CLEARANCE,
      direction: 'NEUTRAL',
      reason: 'Evaluación No-Trade no disponible.',
    };
  }

  return {
    name: 'No-Trade Clearance',
    nameEs: 'Autorización No-Trade',
    score: noTradeAssessment.overallScore,
    weight: FACTOR_WEIGHTS.NO_TRADE_CLEARANCE,
    direction: 'NEUTRAL',
    reason: noTradeAssessment.summary,
  };
}

// === MAIN CONFLUENCE ASSESSMENT ===

export function assessConfluence(params: {
  asset: string;
  pattern: DetectedPattern | null;
  indicators: IndicatorSnapshot;
  regimeResult: RegimeResult;
  mtfScore: number;
  mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sessionType: string;
  historicalWinRate: number;
  historicalSampleSize: number;
  historicalExpectancy: number;
  edgeClassification: string;
  noTradeAssessment: NoTradeAssessment | null;
  entryPrice: number;
  atr: number;
}): ConfluenceResult {
  const {
    asset, pattern, indicators, regimeResult, mtfScore, mtfDirection,
    sessionType, historicalWinRate, historicalSampleSize, historicalExpectancy,
    edgeClassification, noTradeAssessment, entryPrice, atr,
  } = params;

  // ═══ COMPUTE ALL FACTORS ═══
  const factors: ConfluenceFactor[] = [
    computeTechnicalPatternFactor(pattern),
    computeRegimeCompatFactor(regimeResult, pattern),
    computeMTFAlignmentFactor(mtfScore, mtfDirection, pattern),
    computeMomentumFactor(indicators),
    computeVolumeFactor(indicators),
    computeSessionQualityFactor(sessionType),
    computeHistoricalEdgeFactor(historicalWinRate, historicalSampleSize, historicalExpectancy, edgeClassification),
    computeNoTradeClearanceFactor(noTradeAssessment),
  ];

  // ═══ COMPUTE WEIGHTED CONFLUENCE SCORE ═══
  let totalWeight = 0;
  let weightedSum = 0;
  for (const f of factors) {
    weightedSum += f.score * f.weight;
    totalWeight += f.weight;
  }

  const confluenceScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // ═══ DETERMINE DIRECTION ═══
  const directionFactors = factors.filter(f => f.direction !== 'NEUTRAL');
  let bullishWeight = 0;
  let bearishWeight = 0;
  for (const f of directionFactors) {
    if (f.direction === 'BULLISH') bullishWeight += f.weight * f.score;
    else bearishWeight += f.weight * f.score;
  }

  const direction: 'HIGHER' | 'LOWER' = bullishWeight >= bearishWeight ? 'HIGHER' : 'LOWER';

  // ═══ SHOULD TRADE? ═══
  // Need: confluenceScore >= 40, no BLOCK from NoTrade, pattern detected
  const hasPattern = pattern !== null;
  const noTradeBlocked = noTradeAssessment && !noTradeAssessment.canTrade;
  const shouldTrade = confluenceScore >= 40 && !noTradeBlocked && hasPattern;

  // ═══ CONTEXTUALIZE SETUP ═══
  let setup: ContextualizedSetup | null = null;

  if (shouldTrade && pattern) {
    // Calculate SL/TP based on pattern key levels + ATR
    const slDistance = atr * 1.5;
    const tpDistance = slDistance * (pattern.keyLevels ? 
      (Math.abs(pattern.keyLevels.takeProfit - pattern.keyLevels.entry) / Math.abs(pattern.keyLevels.stopLoss - pattern.keyLevels.entry)) : 2);

    let stopLoss: number;
    let takeProfit: number;

    if (direction === 'HIGHER') {
      stopLoss = entryPrice - slDistance;
      takeProfit = entryPrice + tpDistance;
    } else {
      stopLoss = entryPrice + slDistance;
      takeProfit = entryPrice - tpDistance;
    }

    const riskRewardRatio = tpDistance / slDistance;

    // Strategy name based on pattern + regime
    const patternNames: Record<string, string> = {
      breakout: 'Ruptura',
      liquidity_sweep: 'Barrido de Liquidez',
      engulfing: 'Envolvente',
      fakeout: 'Falsa Ruptura',
      reversal: 'Reversión',
      trend_continuation: 'Continuación de Tendencia',
      momentum_shift: 'Cambio de Momentum',
    };
    const regimeNames: Record<string, string> = {
      TRENDING: 'Tendencia',
      RANGING: 'Rango',
      VOLATILE: 'Volátil',
      LOW_VOL: 'Baja Volatilidad',
      NEWS: 'Noticias',
      LIQUIDITY_TRAP: 'Trampa de Liquidez',
    };

    const strategyName = `${patternNames[pattern.type] || pattern.type} ${direction === 'HIGHER' ? 'BULL' : 'BEAR'} en ${regimeNames[regimeResult.regime] || regimeResult.regime}`;

    // Regime compatibility
    let regimeCompatibility: ContextualizedSetup['regimeCompatibility'];
    if (regimeResult.optimalPatterns.includes(pattern.type)) regimeCompatibility = 'OPTIMAL';
    else if (regimeResult.avoidPatterns.includes(pattern.type)) regimeCompatibility = 'INCOMPATIBLE';
    else regimeCompatibility = 'COMPATIBLE';

    // Session quality
    let sessionQuality: ContextualizedSetup['sessionQuality'];
    if (sessionType === 'Overlap') sessionQuality = 'PRIME';
    else if (sessionType === 'London' || sessionType === 'NewYork') sessionQuality = 'GOOD';
    else if (sessionType === 'Asia') sessionQuality = 'FAIR';
    else sessionQuality = 'POOR';

    // Timeframe alignment
    let timeframeAlignment: ContextualizedSetup['timeframeAlignment'];
    if (mtfScore >= 70 && mtfDirection === (direction === 'HIGHER' ? 'BULLISH' : 'BEARISH')) timeframeAlignment = 'ALIGNED';
    else if (mtfDirection === 'NEUTRAL' || mtfScore < 30) timeframeAlignment = 'MIXED';
    else if (mtfDirection !== (direction === 'HIGHER' ? 'BULLISH' : 'BEARISH')) timeframeAlignment = 'CONFLICTING';
    else timeframeAlignment = 'MIXED';

    // Risk percent based on confluence
    let riskPercent = 1; // Default 1%
    if (confluenceScore >= 80) riskPercent = 2;
    else if (confluenceScore >= 60) riskPercent = 1.5;
    else if (confluenceScore >= 40) riskPercent = 1;
    else riskPercent = 0.5;

    // Reduce risk if regime incompatible or conflicting MTF
    if (regimeCompatibility === 'INCOMPATIBLE') riskPercent *= 0.3;
    if (timeframeAlignment === 'CONFLICTING') riskPercent *= 0.5;
    if (sessionQuality === 'POOR') riskPercent *= 0.5;

    // Position sizing
    const riskAmount = 10000 * (riskPercent / 100); // Assuming $10k account
    const positionSize = slDistance > 0 ? riskAmount / slDistance : 0;

    // Thesis invalidation
    const thesisInvalidation = direction === 'HIGHER'
      ? `Precio cierra debajo de ${stopLoss.toFixed(2)} invalida la thesis alcista`
      : `Precio cierra encima de ${stopLoss.toFixed(2)} invalida la thesis bajista`;

    // Partial profit levels (1:1, 1.5:1, 2:1)
    const partialProfitLevels = [
      entryPrice + (direction === 'HIGHER' ? 1 : -1) * slDistance,
      entryPrice + (direction === 'HIGHER' ? 1.5 : -1.5) * slDistance,
      takeProfit,
    ];

    setup = {
      asset,
      strategyName,
      strategyNameEs: strategyName,
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio,
      riskPercent,
      confidence: pattern.confidence,
      confluenceScore,
      regimeCompatibility,
      sessionQuality,
      timeframeAlignment,
      historicalWinRate,
      historicalSampleSize,
      historicalExpectancy,
      suggestedPositionSize: positionSize,
      maxRiskAmount: riskAmount,
      thesisInvalidation,
      partialProfitLevels,
    };
  }

  // ═══ BUILD REASON ═══
  const parts: string[] = [];
  if (!hasPattern) parts.push('Sin patrón técnico detectado');
  if (noTradeBlocked) parts.push(`Bloqueado por No-Trade: ${noTradeAssessment?.blockedBy.join(', ')}`);
  if (shouldTrade && setup) {
    parts.push(`${setup.strategyName}: Confluencia ${confluenceScore.toFixed(0)}%, R:R ${setup.riskRewardRatio.toFixed(1)}, Riesgo ${setup.riskPercent.toFixed(1)}%`);
  }
  const reason = parts.join('. ') || `Confluencia ${confluenceScore.toFixed(0)}%. ${shouldTrade ? 'Setup viable.' : 'No hay suficiente confluencia para operar.'}`;

  return {
    confluenceScore,
    factors,
    setup,
    shouldTrade,
    reason,
  };
}
