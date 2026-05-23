// QUALITY FILTER ENGINE
// "Tu sistema debe bloquear: baja liquidez, spread alto, mercado lento, horas malas, volatilidad tóxica"
//
// Before the auto-trader generates a signal, this filter checks market conditions
// to decide whether the environment is suitable for trading. A great setup in bad
// conditions is a bad trade. Quality first, always.
//
// Scoring: Start at 100, deduct for each active flag. Below 40 = BLOCKED.
// Hard blocks: OffHours session, Toxic Volatility, confirmed NO_EDGE.

import type { Candle } from './market-data';
import type { IndicatorSnapshot } from './indicators';
import type { SignalFeatures as FESignalFeatures } from './feature-engineering';

// ─── Quality Filter Features ──────────────────────────────────────────────────
// Derived from SignalFeatures but with additional fields needed for quality checks

export interface QualityFilterFeatures {
  relativeVolume: number;
  volumeSpike: boolean;
  atr: number | null;
  atrPercentile: number;
  avgATR: number | null;
  candleRange: number;
  spreadEstimate: number;
  assetType: 'forex' | 'crypto';
}

// Helper: Convert feature-engineering SignalFeatures to quality-filter features
export function toQualityFeatures(features: FESignalFeatures, asset: string): QualityFilterFeatures {
  const isCrypto = asset.includes('BTC') || asset.includes('ETH');
  return {
    relativeVolume: features.volume_percentile > 0 ? features.volume_percentile / 50 : 1,
    volumeSpike: features.volume_percentile > 80,
    atr: null, // Will be filled from indicators
    atrPercentile: features.volatility_percentile,
    avgATR: null,
    candleRange: features.candle_range / 100,
    spreadEstimate: features.spread_estimate / 100,
    assetType: isCrypto ? 'crypto' : 'forex',
  };
}

// ─── Quality Flags ────────────────────────────────────────────────────────────

export type QualityFlag =
  | 'LOW_LIQUIDITY'       // Volume well below average
  | 'HIGH_SPREAD'          // Estimated spread too wide
  | 'SLOW_MARKET'          // ATR very low, no movement
  | 'BAD_SESSION'          // Off-hours or suboptimal session
  | 'TOXIC_VOLATILITY'     // Extreme volatility (likely news event)
  | 'INSUFFICIENT_DATA'    // Not enough candle data
  | 'NO_EDGE'              // Historical WR < 48% with sufficient sample
  | 'REGIME_MISMATCH'      // Pattern doesn't work in current regime
  | 'LOW_SAMPLE_SIZE';     // Setup has < 30 historical samples

// ─── Quality Result ───────────────────────────────────────────────────────────

export interface QualityResult {
  score: number;               // 0-100: composite quality score
  flags: QualityFlag[];        // Active quality flags
  isBlocked: boolean;          // Should this signal be blocked?
  blockReason: string | null;  // Spanish reason if blocked
  details: Record<QualityFlag, {
    active: boolean;
    value: number;
    threshold: number;
    description: string;
  }>;
}

// ─── Flag Deduction Table ─────────────────────────────────────────────────────

interface FlagRule {
  deduction: number;
  check: (params: QualityCheckParams) => boolean;
  getValue: (params: QualityCheckParams) => number;
  getThreshold: () => number;
  getDescription: (params: QualityCheckParams) => string;
}

// ─── Regime Avoid Lists ───────────────────────────────────────────────────────
// Patterns that should be avoided in specific market regimes

const REGIME_AVOID_PATTERNS: Record<string, string[]> = {
  'RANGING': ['breakout', 'trend_continuation'],
  'TRENDING_UP': ['reversal', 'fakeout'],
  'TRENDING_DOWN': ['reversal', 'fakeout'],
  'HIGH_VOLATILITY': ['trend_continuation'],
  'LOW_VOLATILITY': ['breakout', 'liquidity_sweep'],
};

// ─── Main Quality Check ───────────────────────────────────────────────────────

interface QualityCheckParams {
  candles: Candle[];
  indicators: IndicatorSnapshot;
  regime: { regime: string; confidence: number };
  sessionInfo: { session: string; shouldTrade: boolean };
  setupStats: { winRate: number; sampleSize: number } | null;
  patternType: string | null;
  features: QualityFilterFeatures;
}

/**
 * Comprehensive quality check for a potential signal.
 * Evaluates liquidity, spread, market speed, session, volatility, data sufficiency,
 * historical edge, regime compatibility, and sample size.
 *
 * @param params - All contextual data needed for quality assessment
 * @returns QualityResult with score, flags, block status, and detailed breakdown
 */
export function checkQuality(params: {
  candles: Candle[];
  indicators: IndicatorSnapshot;
  regime: { regime: string; confidence: number };
  sessionInfo: { session: string; shouldTrade: boolean };
  setupStats: { winRate: number; sampleSize: number } | null;
  patternType: string | null;
  features: QualityFilterFeatures;
}): QualityResult {
  const flags: QualityFlag[] = [];
  const details: QualityResult['details'] = {} as QualityResult['details'];

  // Initialize all flag details as inactive
  const allFlags: QualityFlag[] = [
    'LOW_LIQUIDITY', 'HIGH_SPREAD', 'SLOW_MARKET', 'BAD_SESSION',
    'TOXIC_VOLATILITY', 'INSUFFICIENT_DATA', 'NO_EDGE', 'REGIME_MISMATCH',
    'LOW_SAMPLE_SIZE',
  ];

  for (const flag of allFlags) {
    details[flag] = {
      active: false,
      value: 0,
      threshold: 0,
      description: '',
    };
  }

  let score = 100;

  // ── LOW_LIQUIDITY: relativeVolume < 0.4 ──────────────────────────────────
  const lowLiquidityActive = params.features.relativeVolume < 0.4;
  details.LOW_LIQUIDITY = {
    active: lowLiquidityActive,
    value: params.features.relativeVolume,
    threshold: 0.4,
    description: lowLiquidityActive
      ? `Volumen relativo ${params.features.relativeVolume.toFixed(2)}x está por debajo del mínimo 0.4x. Liquidez insuficiente para entrar.`
      : `Volumen relativo ${params.features.relativeVolume.toFixed(2)}x es aceptable (≥0.4x).`,
  };
  if (lowLiquidityActive) {
    flags.push('LOW_LIQUIDITY');
    score -= 15;
  }

  // ── HIGH_SPREAD: spread_estimate > 0.003 (forex) or > 0.005 (crypto) ────
  const spreadThreshold = params.features.assetType === 'crypto' ? 0.005 : 0.003;
  const highSpreadActive = params.features.spreadEstimate > spreadThreshold;
  details.HIGH_SPREAD = {
    active: highSpreadActive,
    value: params.features.spreadEstimate,
    threshold: spreadThreshold,
    description: highSpreadActive
      ? `Spread estimado ${(params.features.spreadEstimate * 100).toFixed(2)}% excede el máximo ${(spreadThreshold * 100).toFixed(1)}% para ${params.features.assetType}. Slippage elevado.`
      : `Spread estimado ${(params.features.spreadEstimate * 100).toFixed(2)}% dentro del rango aceptable para ${params.features.assetType}.`,
  };
  if (highSpreadActive) {
    flags.push('HIGH_SPREAD');
    score -= 20;
  }

  // ── SLOW_MARKET: ATR < 30th percentile AND candle_range < 0.1% ──────────
  const slowMarketActive =
    params.features.atrPercentile < 30 &&
    params.features.candleRange < 0.001;
  details.SLOW_MARKET = {
    active: slowMarketActive,
    value: params.features.atrPercentile,
    threshold: 30,
    description: slowMarketActive
      ? `Mercado lento: ATR en percentil ${params.features.atrPercentile.toFixed(0)} (<30) y rango de vela ${(params.features.candleRange * 100).toFixed(3)}% (<0.1%). Sin movimiento.`
      : `Actividad de mercado aceptable: ATR percentil ${params.features.atrPercentile.toFixed(0)}, rango de vela ${(params.features.candleRange * 100).toFixed(3)}%.`,
  };
  if (slowMarketActive) {
    flags.push('SLOW_MARKET');
    score -= 10;
  }

  // ── BAD_SESSION: session = OffHours ───────────────────────────────────────
  const badSessionActive = params.sessionInfo.session === 'OffHours';
  details.BAD_SESSION = {
    active: badSessionActive,
    value: params.sessionInfo.session === 'OffHours' ? 1 : 0,
    threshold: 1,
    description: badSessionActive
      ? 'Sesión fuera de horario (OffHours). Liquidez mínima, spreads amplios. NO operar.'
      : `Sesión actual: ${params.sessionInfo.session}. Horario operable.`,
  };
  if (badSessionActive) {
    flags.push('BAD_SESSION');
    score -= 25;
  }

  // ── TOXIC_VOLATILITY: ATR > 3x average AND volume spike > 3x ────────────
  const toxicVolatilityActive =
    params.features.atr !== null &&
    params.features.avgATR !== null &&
    params.features.avgATR > 0 &&
    params.features.atr > params.features.avgATR * 3 &&
    params.features.relativeVolume > 3;
  const atrRatio = params.features.atr !== null && params.features.avgATR !== null && params.features.avgATR > 0
    ? params.features.atr / params.features.avgATR
    : 0;
  details.TOXIC_VOLATILITY = {
    active: toxicVolatilityActive,
    value: atrRatio,
    threshold: 3,
    description: toxicVolatilityActive
      ? `Volatilidad tóxica: ATR ${atrRatio.toFixed(1)}x el promedio (>3x) con volumen ${params.features.relativeVolume.toFixed(1)}x. Probable evento de noticias. PELIGRO.`
      : `Volatilidad controlada: ATR ${atrRatio.toFixed(1)}x el promedio. Sin señal de evento tóxico.`,
  };
  if (toxicVolatilityActive) {
    flags.push('TOXIC_VOLATILITY');
    score -= 30;
  }

  // ── INSUFFICIENT_DATA: candles < 50 ──────────────────────────────────────
  const insufficientDataActive = params.candles.length < 50;
  details.INSUFFICIENT_DATA = {
    active: insufficientDataActive,
    value: params.candles.length,
    threshold: 50,
    description: insufficientDataActive
      ? `Datos insuficientes: solo ${params.candles.length} velas (<50). Los indicadores no son fiables.`
      : `Datos suficientes: ${params.candles.length} velas disponibles (≥50).`,
  };
  if (insufficientDataActive) {
    flags.push('INSUFFICIENT_DATA');
    score -= 15;
  }

  // ── NO_EDGE: setupStats.winRate < 48% AND sampleSize >= 30 ──────────────
  const noEdgeActive =
    params.setupStats !== null &&
    params.setupStats.winRate < 48 &&
    params.setupStats.sampleSize >= 30;
  details.NO_EDGE = {
    active: noEdgeActive,
    value: params.setupStats?.winRate ?? 0,
    threshold: 48,
    description: noEdgeActive
      ? `Sin edge: WR ${(params.setupStats!.winRate).toFixed(1)}% < 48% con ${params.setupStats!.sampleSize} muestras. EV negativo confirmado.`
      : params.setupStats !== null
        ? `Edge verificable: WR ${(params.setupStats.winRate).toFixed(1)}% con ${params.setupStats.sampleSize} muestras.`
        : 'Sin datos históricos de setup. No se puede verificar edge.',
  };
  if (noEdgeActive) {
    flags.push('NO_EDGE');
    score -= 20;
  }

  // ── REGIME_MISMATCH: pattern in regime's avoid list ──────────────────────
  const avoidList = REGIME_AVOID_PATTERNS[params.regime.regime] ?? [];
  const regimeMismatchActive =
    params.patternType !== null &&
    avoidList.includes(params.patternType) &&
    params.regime.confidence > 0.5;
  details.REGIME_MISMATCH = {
    active: regimeMismatchActive,
    value: params.regime.confidence,
    threshold: 0.5,
    description: regimeMismatchActive
      ? `Patrón "${params.patternType}" no funciona en régimen "${params.regime.regime}" (confianza ${(params.regime.confidence * 100).toFixed(0)}%). Evitar.`
      : `Patrón "${params.patternType ?? 'N/A'}" compatible con régimen "${params.regime.regime}".`,
  };
  if (regimeMismatchActive) {
    flags.push('REGIME_MISMATCH');
    score -= 15;
  }

  // ── LOW_SAMPLE_SIZE: sampleSize < 30 (informational, don't block alone) ──
  const lowSampleActive =
    params.setupStats !== null &&
    params.setupStats.sampleSize < 30;
  details.LOW_SAMPLE_SIZE = {
    active: lowSampleActive,
    value: params.setupStats?.sampleSize ?? 0,
    threshold: 30,
    description: lowSampleActive
      ? `Muestra pequeña: ${params.setupStats!.sampleSize} señales (<30). Resultados estadísticos no fiables.`
      : params.setupStats !== null
        ? `Muestra adecuada: ${params.setupStats.sampleSize} señales (≥30).`
        : 'Sin datos de muestra histórica.',
  };
  if (lowSampleActive) {
    flags.push('LOW_SAMPLE_SIZE');
    score -= 5;
  }

  // Clamp score to [0, 100]
  score = Math.max(0, Math.min(100, score));

  // ── Determine if BLOCKED ─────────────────────────────────────────────────
  // isBlocked = true when:
  // - score < 40 (too many red flags)
  // - BAD_SESSION active (OffHours)
  // - TOXIC_VOLATILITY active
  // - NO_EDGE active with sampleSize >= 100 (we're confident the edge is negative)
  const isBlocked =
    score < 40 ||
    badSessionActive ||
    toxicVolatilityActive ||
    (noEdgeActive && (params.setupStats?.sampleSize ?? 0) >= 100);

  // ── Generate block reason in Spanish ─────────────────────────────────────
  let blockReason: string | null = null;
  if (isBlocked) {
    const reasons: string[] = [];

    if (badSessionActive) {
      reasons.push('Sesión fuera de horario — no operar');
    }
    if (toxicVolatilityActive) {
      reasons.push('Volatilidad tóxica detectada — probable evento de noticias');
    }
    if (noEdgeActive && (params.setupStats?.sampleSize ?? 0) >= 100) {
      reasons.push(`Edge negativo confirmado (WR ${(params.setupStats!.winRate).toFixed(1)}%, ${params.setupStats!.sampleSize} muestras)`);
    }
    if (score < 40 && reasons.length === 0) {
      reasons.push(`Score de calidad demasiado bajo (${score}/100). Demasiadas banderas rojas.`);
    }

    blockReason = reasons.join('. ') + '.';
  }

  return {
    score,
    flags,
    isBlocked,
    blockReason,
    details,
  };
}

// ─── Quick Quality Score ──────────────────────────────────────────────────────

/**
 * Fast quality score for auto-trader when full quality check is too expensive.
 * Uses simplified inputs and returns a score from 0-100.
 *
 * Scoring:
 * - Start at 70
 * - +10 if good session (London, Overlap, NewYork)
 * - +10 if volume normal/slightly high
 * - +10 if regime matches pattern
 * - -20 if OffHours
 * - -15 if low volume
 * - -10 if slow market
 *
 * @param session - Current session name
 * @param volumeSpike - Whether volume is spiking
 * @param atr - Current ATR value (null if unavailable)
 * @param relativeVolume - Current volume relative to average
 * @param regime - Current market regime
 * @param sampleSize - Number of historical samples for this setup
 * @returns Quality score from 0-100
 */
export function quickQualityScore(
  session: string,
  volumeSpike: boolean,
  atr: number | null,
  relativeVolume: number,
  regime: string,
  sampleSize: number
): number {
  let score = 70;

  // Session quality
  if (session === 'Overlap' || session === 'London' || session === 'NewYork') {
    score += 10;
  } else if (session === 'OffHours') {
    score -= 20;
  }
  // Asia: no change, neutral

  // Volume check
  if (volumeSpike || relativeVolume >= 1.0) {
    score += 10;
  } else if (relativeVolume < 0.4) {
    score -= 15; // Low volume penalty
  }

  // Regime compatibility (rough heuristic)
  // If we have a decent sample size and the regime is normal, boost
  const normalRegimes = ['RANGING', 'TRENDING_UP', 'TRENDING_DOWN'];
  if (normalRegimes.includes(regime) && sampleSize >= 30) {
    score += 10;
  }

  // Slow market check
  if (atr !== null && atr <= 0) {
    score -= 10; // Zero ATR = no movement
  }

  // Low sample size penalty
  if (sampleSize < 30) {
    score -= 5;
  }

  return Math.max(0, Math.min(100, score));
}
