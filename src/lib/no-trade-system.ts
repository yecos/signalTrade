// NO-TRADE SYSTEM — "Cuándo NO operar" (El Core)
// La idea central: en lugar de buscar señales de entrada, monitoreamos condiciones
// que INVALIDAN cualquier estrategia. Solo cuando TODOS los filtros están en verde,
// el sistema de "Trade Permitido" puede evaluar.
//
// Filtros:
// 1. Riesgo Sistémico: VIX proxy, correlación extrema, flash crashes recientes
// 2. Régimen de Mercado: Rango vs Tendencia (muchas estrategias fallan en régimen incorrecto)
// 3. Noticias/Eventos: FOMC, NFP, earnings — horas donde ruido > señal
// 4. Liquidez: Spreads anormales, bajo volumen (especialmente en forex/crypto)

import type { IndicatorSnapshot } from './indicators';
import type { MarketRegime, RegimeResult } from './regime-engine';
import type { Candle } from './market-data';

// === TYPES ===

export type NoTradeFilter = 
  | 'SYSTEMIC_RISK'
  | 'REGIME_MISMATCH'
  | 'NEWS_EVENT'
  | 'LOW_LIQUIDITY'
  | 'HIGH_SPREAD'
  | 'FLASH_CRASH'
  | 'EXTREME_CORRELATION'
  | 'OFF_HOURS'
  | 'CIRCUIT_BREAKER';

export type FilterSeverity = 'BLOCK' | 'WARNING' | 'CAUTION' | 'CLEAR';

export interface NoTradeFilterResult {
  filter: NoTradeFilter;
  severity: FilterSeverity;
  score: number;          // 0-100 where 0=BLOCK, 100=CLEAR
  reason: string;
  details: Record<string, any>;
}

export interface NoTradeAssessment {
  overallScore: number;           // 0-100: 0=all blocked, 100=all clear
  canTrade: boolean;              // true if no BLOCK filters
  filters: NoTradeFilterResult[];
  blockedBy: NoTradeFilter[];     // Which filters are blocking
  warnings: NoTradeFilterResult[];// Non-blocking warnings
  summary: string;                // Spanish summary
  tradeQuality: 'OPTIMAL' | 'GOOD' | 'FAIR' | 'POOR' | 'DANGEROUS' | 'BLOCKED';
}

// === ECONOMIC CALENDAR — High-impact events that invalidate signals ===
// Times in UTC. These are approximate — real implementation would use an API.

interface EconomicEvent {
  name: string;
  nameEs: string;
  dayOfWeek: number;     // 0=Sunday, 1=Monday, etc.
  hourUtc: number;
  minuteUtc: number;
  impactLevel: 'HIGH' | 'MEDIUM';
  avoidMinutesBefore: number;
  avoidMinutesAfter: number;
  assets: string[];       // Which assets are affected
}

const ECONOMIC_CALENDAR: EconomicEvent[] = [
  // FOMC — Federal Reserve Rate Decision (usually Wednesday)
  { name: 'FOMC Rate Decision', nameEs: 'Decisión de tasa FOMC', dayOfWeek: 3, hourUtc: 18, minuteUtc: 0, impactLevel: 'HIGH', avoidMinutesBefore: 60, avoidMinutesAfter: 120, assets: ['*'] },
  // FOMC Minutes
  { name: 'FOMC Minutes', nameEs: 'Minutas FOMC', dayOfWeek: 3, hourUtc: 18, minuteUtc: 0, impactLevel: 'HIGH', avoidMinutesBefore: 30, avoidMinutesAfter: 60, assets: ['*'] },
  // NFP — Non-Farm Payrolls (usually first Friday of month)
  { name: 'Non-Farm Payrolls', nameEs: 'Nóminas no agrícolas', dayOfWeek: 5, hourUtc: 12, minuteUtc: 30, impactLevel: 'HIGH', avoidMinutesBefore: 60, avoidMinutesAfter: 90, assets: ['*'] },
  // CPI — Consumer Price Index
  { name: 'CPI', nameEs: 'IPC (Inflación)', dayOfWeek: 2, hourUtc: 12, minuteUtc: 30, impactLevel: 'HIGH', avoidMinutesBefore: 30, avoidMinutesAfter: 60, assets: ['*'] },
  // GDP
  { name: 'GDP', nameEs: 'PIB', dayOfWeek: 3, hourUtc: 12, minuteUtc: 30, impactLevel: 'MEDIUM', avoidMinutesBefore: 20, avoidMinutesAfter: 45, assets: ['*'] },
  // ECB Rate Decision
  { name: 'ECB Rate Decision', nameEs: 'Decisión de tasa BCE', dayOfWeek: 4, hourUtc: 11, minuteUtc: 45, impactLevel: 'HIGH', avoidMinutesBefore: 30, avoidMinutesAfter: 90, assets: ['EUR/USD', 'GBP/USD'] },
  // Jobless Claims
  { name: 'Jobless Claims', nameEs: 'Solicitudes de desempleo', dayOfWeek: 4, hourUtc: 12, minuteUtc: 30, impactLevel: 'MEDIUM', avoidMinutesBefore: 15, avoidMinutesAfter: 30, assets: ['*'] },
  // Retail Sales
  { name: 'Retail Sales', nameEs: 'Ventas minoristas', dayOfWeek: 3, hourUtc: 12, minuteUtc: 30, impactLevel: 'MEDIUM', avoidMinutesBefore: 15, avoidMinutesAfter: 30, assets: ['*'] },
  // BTC-specific: ETF decisions, large liquidations detected via unusual volume
  { name: 'Crypto ETF Decision', nameEs: 'Decisión ETF Crypto', dayOfWeek: -1, hourUtc: -1, minuteUtc: -1, impactLevel: 'HIGH', avoidMinutesBefore: 60, avoidMinutesAfter: 180, assets: ['BTC/USD', 'ETH/USD'] },
];

// === FLASH CRASH DETECTION ===
// Detects if a flash crash has occurred recently (price dropped >3% in <5 candles)

function detectFlashCrash(candles: Candle[]): { detected: boolean; magnitude: number; candlesAgo: number } {
  if (candles.length < 10) return { detected: false, magnitude: 0, candlesAgo: -1 };

  const lookback = Math.min(10, candles.length - 1);
  const last = candles.length - 1;

  for (let i = 0; i < lookback; i++) {
    const idx = last - i;
    if (idx < 5) break;

    const currentClose = candles[idx].close;
    const prevClose = candles[idx - 5].close;
    const pctChange = ((currentClose - prevClose) / prevClose) * 100;

    if (Math.abs(pctChange) > 3) {
      return { detected: true, magnitude: pctChange, candlesAgo: i };
    }
  }

  return { detected: false, magnitude: 0, candlesAgo: -1 };
}

// === SPREAD ANALYSIS ===
// Estimates spread from candle data (high-low vs body)

function estimateSpread(candles: Candle[], indicators: IndicatorSnapshot): {
  spreadEstimate: number;
  spreadPercentile: number;  // 0-100 relative to recent spreads
  isAbnormal: boolean;
} {
  if (candles.length < 20) {
    return { spreadEstimate: 0, spreadPercentile: 50, isAbnormal: false };
  }

  const last = candles.length - 1;

  // Estimate spread as the difference between close and open as a fraction of range
  // A wider gap suggests wider spread (especially in forex)
  const spreads: number[] = [];
  for (let i = Math.max(0, last - 50); i <= last; i++) {
    const range = candles[i].high - candles[i].low;
    const body = Math.abs(candles[i].close - candles[i].open);
    if (range > 0) {
      // Gap between wick and body suggests spread
      const wickRatio = (range - body) / range;
      spreads.push(wickRatio);
    }
  }

  if (spreads.length < 5) {
    return { spreadEstimate: 0, spreadPercentile: 50, isAbnormal: false };
  }

  const currentSpread = spreads[spreads.length - 1];
  const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const sortedSpreads = [...spreads].sort((a, b) => a - b);
  const percentileIdx = sortedSpreads.findIndex(s => s >= currentSpread);
  const spreadPercentile = (percentileIdx / sortedSpreads.length) * 100;

  // Spread is abnormal if current > 2x average
  const isAbnormal = currentSpread > avgSpread * 2;

  return { spreadEstimate: currentSpread, spreadPercentile, isAbnormal };
}

// === CORRELATION CHECK ===
// Checks for extreme correlation between assets (when everything moves together = systemic risk)

function checkCorrelation(candles: Candle[], asset: string): {
  extremeCorrelation: boolean;
  reason: string;
} {
  // For crypto: BTC and ETH often move together — check if correlation is extreme
  // This is a simplified heuristic: if current candle has both very large range AND
  // the direction matches the broader market trend, correlation is high
  const last = candles.length - 1;
  if (last < 5) return { extremeCorrelation: false, reason: '' };

  const currentRange = candles[last].high - candles[last].low;
  const avgRange = candles.slice(Math.max(0, last - 20), last).reduce((s, c) => s + (c.high - c.low), 0) / Math.min(20, last);

  // If current range > 3x average, it's likely a correlated move
  if (currentRange > avgRange * 3) {
    return {
      extremeCorrelation: true,
      reason: `Rango anómalo (${(currentRange / avgRange).toFixed(1)}x promedio) sugiere movimiento correlacionado sistémico`,
    };
  }

  return { extremeCorrelation: false, reason: '' };
}

// === LIQUIDITY ANALYSIS ===

function analyzeLiquidity(candles: Candle[], indicators: IndicatorSnapshot): {
  volumeLevel: 'VERY_LOW' | 'LOW' | 'NORMAL' | 'HIGH' | 'VERY_HIGH';
  relativeVolume: number;
  isLowLiquidity: boolean;
  reason: string;
} {
  const relVol = indicators.volumeAnalysis?.relativeVolume || 1;
  const volTrend = indicators.volumeAnalysis?.volumeTrend || 'STABLE';

  let volumeLevel: 'VERY_LOW' | 'LOW' | 'NORMAL' | 'HIGH' | 'VERY_HIGH';
  if (relVol < 0.3) volumeLevel = 'VERY_LOW';
  else if (relVol < 0.6) volumeLevel = 'LOW';
  else if (relVol < 1.5) volumeLevel = 'NORMAL';
  else if (relVol < 2.5) volumeLevel = 'HIGH';
  else volumeLevel = 'VERY_HIGH';

  const isLowLiquidity = relVol < 0.5 || (volTrend === 'DECREASING' && relVol < 0.8);

  let reason = '';
  if (isLowLiquidity) {
    reason = `Liquidez baja: volumen relativo ${relVol.toFixed(2)}x${volTrend === 'DECREASING' ? ' (decreciendo)' : ''}. Slippage probable, spreads amplios.`;
  }

  return { volumeLevel, relativeVolume: relVol, isLowLiquidity, reason };
}

// === MAIN ASSESSMENT FUNCTION ===

export function assessNoTrade(params: {
  asset: string;
  candles: Candle[];
  indicators: IndicatorSnapshot;
  regimeResult: RegimeResult;
  patternType: string | null;
  sessionType: string;
}): NoTradeAssessment {
  const { asset, candles, indicators, regimeResult, patternType, sessionType } = params;
  const filters: NoTradeFilterResult[] = [];
  const now = new Date();

  // ═══ FILTER 1: SYSTEMIC RISK — Flash Crash Detection ═══
  const flashCrash = detectFlashCrash(candles);
  if (flashCrash.detected) {
    const severity: FilterSeverity = Math.abs(flashCrash.magnitude) > 5 ? 'BLOCK' : 'WARNING';
    filters.push({
      filter: 'FLASH_CRASH',
      severity,
      score: Math.max(0, 100 - Math.abs(flashCrash.magnitude) * 15),
      reason: `Flash crash detectado: ${flashCrash.magnitude.toFixed(1)}% en ${flashCrash.candlesAgo} velas. ${severity === 'BLOCK' ? 'NO operar hasta estabilización.' : 'Precaución extrema.'}`,
      details: { magnitude: flashCrash.magnitude, candlesAgo: flashCrash.candlesAgo },
    });
  }

  // ═══ FILTER 2: EXTREME CORRELATION ═══
  const correlation = checkCorrelation(candles, asset);
  if (correlation.extremeCorrelation) {
    filters.push({
      filter: 'EXTREME_CORRELATION',
      severity: 'WARNING',
      score: 30,
      reason: correlation.reason,
      details: { asset },
    });
  }

  // ═══ FILTER 3: REGIME MISMATCH ═══
  // Check if the detected pattern is incompatible with current regime
  const regimeAdvice = regimeResult;
  const regimeScore = regimeResult.confidence;

  if (patternType && regimeResult.avoidPatterns.includes(patternType as any)) {
    filters.push({
      filter: 'REGIME_MISMATCH',
      severity: regimeScore > 60 ? 'BLOCK' : 'WARNING',
      score: Math.max(0, 50 - regimeScore * 0.5),
      reason: `Patrón ${patternType} NO es óptimo en régimen ${regimeResult.regime} (confianza ${regimeScore}%). Patrones óptimos: ${regimeResult.optimalPatterns.join(', ')}`,
      details: { regime: regimeResult.regime, pattern: patternType, optimalPatterns: regimeResult.optimalPatterns },
    });
  }

  // LOW_VOL regime = strong no-trade signal
  if (regimeResult.regime === 'LOW_VOL') {
    filters.push({
      filter: 'REGIME_MISMATCH',
      severity: 'BLOCK',
      score: 10,
      reason: `Régimen BAJA VOLATILIDAD: sin setups confiables. Mejor esperar volatilidad.`,
      details: { regime: 'LOW_VOL', confidence: regimeScore },
    });
  }

  // NEWS regime during event = block
  if (regimeResult.regime === 'NEWS') {
    filters.push({
      filter: 'REGIME_MISMATCH',
      severity: 'WARNING',
      score: 25,
      reason: `Régimen NOTICIA/EVENTO: alta incertidumbre, spreads amplios. Solo setups de muy alta calidad.`,
      details: { regime: 'NEWS', confidence: regimeScore },
    });
  }

  // ═══ FILTER 4: NEWS/EVENTS CALENDAR ═══
  // Check if we're near a high-impact economic event
  const currentDayOfWeek = now.getUTCDay();
  const currentHourUtc = now.getUTCHours();
  const currentMinuteUtc = now.getUTCMinutes();
  const currentTimeMinutes = currentHourUtc * 60 + currentMinuteUtc;

  for (const event of ECONOMIC_CALENDAR) {
    if (event.dayOfWeek < 0) continue; // Skip unscheduled events
    if (currentDayOfWeek !== event.dayOfWeek) continue;

    const eventTimeMinutes = event.hourUtc * 60 + event.minuteUtc;
    const minutesBefore = eventTimeMinutes - currentTimeMinutes;
    const minutesAfter = currentTimeMinutes - eventTimeMinutes;

    const isAffected = event.assets.includes('*') || event.assets.includes(asset);
    if (!isAffected) continue;

    if (minutesBefore > 0 && minutesBefore <= event.avoidMinutesBefore) {
      // Within pre-event window
      const severity: FilterSeverity = event.impactLevel === 'HIGH' ? 'BLOCK' : 'WARNING';
      filters.push({
        filter: 'NEWS_EVENT',
        severity,
        score: severity === 'BLOCK' ? 5 : 30,
        reason: `${event.nameEs} en ${minutesBefore} min. ${severity === 'BLOCK' ? 'NO operar antes de evento alto impacto.' : 'Precaución antes de evento.'}`,
        details: { event: event.name, minutesBefore, impactLevel: event.impactLevel },
      });
    }

    if (minutesAfter >= 0 && minutesAfter <= event.avoidMinutesAfter) {
      // Within post-event window
      const severity: FilterSeverity = event.impactLevel === 'HIGH' && minutesAfter < event.avoidMinutesAfter * 0.5 ? 'BLOCK' : 'WARNING';
      filters.push({
        filter: 'NEWS_EVENT',
        severity,
        score: severity === 'BLOCK' ? 10 : 35,
        reason: `${event.nameEs} hace ${minutesAfter} min. ${severity === 'BLOCK' ? 'Esperar estabilización.' : 'Ruido post-evento aún presente.'}`,
        details: { event: event.name, minutesAfter, impactLevel: event.impactLevel },
      });
    }
  }

  // ═══ FILTER 5: LIQUIDITY CHECK ═══
  const liquidity = analyzeLiquidity(candles, indicators);
  if (liquidity.isLowLiquidity) {
    filters.push({
      filter: 'LOW_LIQUIDITY',
      severity: liquidity.volumeLevel === 'VERY_LOW' ? 'BLOCK' : 'WARNING',
      score: liquidity.volumeLevel === 'VERY_LOW' ? 10 : 35,
      reason: liquidity.reason,
      details: { relativeVolume: liquidity.relativeVolume, volumeLevel: liquidity.volumeLevel },
    });
  }

  // ═══ FILTER 6: HIGH SPREAD CHECK ═══
  const spread = estimateSpread(candles, indicators);
  if (spread.isAbnormal) {
    filters.push({
      filter: 'HIGH_SPREAD',
      severity: spread.spreadPercentile > 90 ? 'BLOCK' : 'WARNING',
      score: Math.max(0, 100 - spread.spreadPercentile),
      reason: `Spread anómalo: percentil ${spread.spreadPercentile.toFixed(0)}%. ${spread.spreadPercentile > 90 ? 'NO operar con spreads extremos.' : 'Slippage probable.'}`,
      details: { spreadPercentile: spread.spreadPercentile, isAbnormal: spread.isAbnormal },
    });
  }

  // ═══ FILTER 7: OFF-HOURS CHECK ═══
  if (sessionType === 'OffHours') {
    filters.push({
      filter: 'OFF_HOURS',
      severity: 'WARNING',
      score: 25,
      reason: 'Fuera de horas de sesión principal. Liquidez reducida, spreads amplios.',
      details: { session: sessionType },
    });
  }

  // ═══ COMPUTE OVERALL ASSESSMENT ═══
  const blockedBy = filters.filter(f => f.severity === 'BLOCK').map(f => f.filter);
  const warnings = filters.filter(f => f.severity === 'WARNING' || f.severity === 'CAUTION');

  // Overall score: weighted average, BLOCK filters dominate
  let overallScore = 100;
  for (const f of filters) {
    switch (f.severity) {
      case 'BLOCK':
        overallScore = Math.min(overallScore, f.score * 0.3); // BLOCK dominates
        break;
      case 'WARNING':
        overallScore = Math.min(overallScore, f.score); // Reduce but don't dominate
        break;
      case 'CAUTION':
        overallScore = Math.min(overallScore, (100 + f.score) / 2); // Mild reduction
        break;
    }
  }

  const canTrade = blockedBy.length === 0;

  // Trade quality
  let tradeQuality: NoTradeAssessment['tradeQuality'];
  if (!canTrade) tradeQuality = 'BLOCKED';
  else if (overallScore >= 80) tradeQuality = 'OPTIMAL';
  else if (overallScore >= 60) tradeQuality = 'GOOD';
  else if (overallScore >= 40) tradeQuality = 'FAIR';
  else if (overallScore >= 20) tradeQuality = 'POOR';
  else tradeQuality = 'DANGEROUS';

  // Summary
  const parts: string[] = [];
  if (blockedBy.length > 0) {
    parts.push(`BLOQUEADO por: ${blockedBy.join(', ')}`);
  }
  if (warnings.length > 0) {
    parts.push(`Advertencias: ${warnings.map(w => w.filter).join(', ')}`);
  }
  if (canTrade && parts.length === 0) {
    parts.push('Todos los filtros en verde. Condiciones óptimas para operar.');
  }
  const summary = parts.join('. ') + `. Score: ${overallScore.toFixed(0)}/100 (${tradeQuality})`;

  return {
    overallScore,
    canTrade,
    filters,
    blockedBy,
    warnings,
    summary,
    tradeQuality,
  };
}

// === HELPER: Quick No-Trade Check ===
// Returns true if trading is blocked (fast check without full assessment)

export function isTradingBlocked(params: {
  asset: string;
  candles: Candle[];
  indicators: IndicatorSnapshot;
  regimeResult: RegimeResult;
  sessionType: string;
}): boolean {
  const assessment = assessNoTrade({
    ...params,
    patternType: null,
  });
  return !assessment.canTrade;
}
