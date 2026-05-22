// LEARNING ENGINE
// Discovers which setups work, when, and why.
// "La ventaja NO sale de 'usar IA'. Sale de datos buenos + patrones medibles + muchas muestras + estadística real."
//
// This engine:
// 1. Analyzes historical signals to find edges
// 2. Tracks setup performance over time
// 3. Detects regime changes (when a pattern stops working)
// 4. Recommends which setups to trade and which to avoid
// 5. Calculates statistical significance of every edge

import { db } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EdgeDiscovery {
  patternType: string;
  session: string;
  asset: string | null;
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  edge: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNKNOWN';
  edgeMagnitude: number; // How strong the edge is (0-100)
  confidence: number; // Statistical confidence (0-100)
  pValue: number; // Approximate p-value
  isSignificant: boolean; // Is this edge statistically significant?
  recommendation: string;
  sampleAdequacy: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';
  regimeChange: boolean; // Has this setup changed behavior recently?
  recentWinRate: number; // Win rate in last 30 signals
  regimeDirection: 'IMPROVING' | 'DECLINING' | 'STABLE'; // Trend of recent performance
}

export interface LearningReport {
  totalDataPoints: number;
  totalDecisive: number;
  overallWinRate: number;
  hasAnyEdge: boolean;
  bestSetup: EdgeDiscovery | null;
  worstSetup: EdgeDiscovery | null;
  discoveries: EdgeDiscovery[];
  recommendations: string[];
  warnings: string[];
  dataQuality: 'INSUFFICIENT' | 'POOR' | 'ACCEPTABLE' | 'GOOD' | 'EXCELLENT';
  nextMilestone: string;
  datasetHealth: {
    total: number;
    decisive: number;
    pending: number;
    noOperar: number;
    neededForGood: number;
    neededForExcellent: number;
  };
}

export interface SetupRecommendation {
  patternType: string;
  session: string;
  asset: string | null;
  action: 'OPERAR' | 'EVITAR' | 'OBSERVAR' | 'SIN_DATOS';
  reason: string;
  expectedWinRate: number;
  confidence: number;
}

// ─── Core Analysis ────────────────────────────────────────────────────────────

/**
 * Approximate p-value using normal approximation to binomial.
 * Tests H0: winRate = 50% against H1: winRate != 50%
 */
function approximatePValue(wins: number, total: number): number {
  if (total < 5) return 1.0; // Not enough data
  
  const p0 = 0.5; // null hypothesis: random
  const pHat = wins / total;
  const se = Math.sqrt((p0 * (1 - p0)) / total);
  const z = Math.abs(pHat - p0) / se;
  
  // Two-tailed test: P(|Z| > z) ≈ 2 * (1 - Φ(z))
  // Using approximation for standard normal CDF
  const pValue = 2 * (1 - normalCDF(z));
  return Math.max(0, Math.min(1, pValue));
}

/**
 * Standard normal CDF approximation (Abramowitz and Stegun)
 */
function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  
  return 0.5 * (1.0 + sign * y);
}

/**
 * Detect regime change by comparing recent vs historical performance
 */
async function detectRegimeChange(
  patternType: string,
  session: string,
  asset: string | null
): Promise<{ changed: boolean; recentWinRate: number; direction: 'IMPROVING' | 'DECLINING' | 'STABLE' }> {
  // Get all closed signals for this setup
  const where: any = {
    status: 'CLOSED',
    result: { in: ['WIN', 'LOSS'] },
    patternType,
    sessionType: session,
  };
  if (asset) where.asset = asset;
  
  const signals = await db.signal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { result: true, createdAt: true },
  });
  
  if (signals.length < 20) {
    return { changed: false, recentWinRate: 0, direction: 'STABLE' };
  }
  
  // Split into recent (last 30) and historical
  const recent = signals.slice(0, Math.min(30, signals.length));
  const historical = signals.slice(Math.min(30, signals.length));
  
  const recentWins = recent.filter(s => s.result === 'WIN').length;
  const recentWinRate = recentWins / recent.length * 100;
  
  if (historical.length < 10) {
    return { changed: false, recentWinRate, direction: 'STABLE' };
  }
  
  const histWins = historical.filter(s => s.result === 'WIN').length;
  const histWinRate = histWins / historical.length * 100;
  
  // Check if there's a significant difference (>15% change)
  const diff = recentWinRate - histWinRate;
  const changed = Math.abs(diff) > 15;
  const direction: 'IMPROVING' | 'DECLINING' | 'STABLE' = 
    diff > 10 ? 'IMPROVING' : diff < -10 ? 'DECLINING' : 'STABLE';
  
  return { changed, recentWinRate, direction };
}

// ─── Main Learning Engine ─────────────────────────────────────────────────────

export async function runLearningAnalysis(): Promise<LearningReport> {
  // Get overall statistics
  const totalSignals = await db.signal.count();
  const totalDecisive = await db.signal.count({
    where: { result: { in: ['WIN', 'LOSS'] } },
  });
  const totalWins = await db.signal.count({
    where: { result: 'WIN' },
  });
  const totalPending = await db.signal.count({
    where: { status: 'PENDING' },
  });
  const totalNoOperar = await db.signal.count({
    where: { direction: 'NO_OPERAR' },
  });
  
  const overallWinRate = totalDecisive > 0 ? (totalWins / totalDecisive) * 100 : 0;
  
  // Get all setup stats
  const setupStats = await db.setupStats.findMany({
    orderBy: { winRate: 'desc' },
  });
  
  // Analyze each setup for edges
  const discoveries: EdgeDiscovery[] = [];
  
  for (const stat of setupStats) {
    const decisive = stat.wins + stat.losses;
    const pValue = approximatePValue(stat.wins, decisive);
    const isSignificant = pValue < 0.05 && decisive >= 30;
    
    // Detect regime change
    const regime = await detectRegimeChange(stat.patternType, stat.session, stat.asset);
    
    // Calculate edge magnitude (how far from 50%)
    const edgeMagnitude = Math.abs(stat.winRate - 50);
    
    // Determine edge direction
    let edge: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNKNOWN';
    if (decisive < 10) {
      edge = 'UNKNOWN';
    } else if (stat.winRate > 55 && isSignificant) {
      edge = 'POSITIVE';
    } else if (stat.winRate < 45 && isSignificant) {
      edge = 'NEGATIVE';
    } else {
      edge = 'NEUTRAL';
    }
    
    // Sample adequacy
    const sampleAdequacy: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH' = 
      decisive < 30 ? 'INSUFFICIENT' :
      decisive < 100 ? 'LOW' :
      decisive < 500 ? 'MEDIUM' : 'HIGH';
    
    // Generate recommendation
    let recommendation = '';
    if (edge === 'POSITIVE' && isSignificant) {
      recommendation = `OPERAR: Edge positivo significativo (${stat.winRate.toFixed(1)}%, p=${pValue.toFixed(3)})`;
    } else if (edge === 'NEGATIVE' && isSignificant) {
      recommendation = `EVITAR: Edge negativo significativo (${stat.winRate.toFixed(1)}%, p=${pValue.toFixed(3)})`;
    } else if (edge === 'NEUTRAL') {
      recommendation = `OBSERVAR: Sin edge claro (${stat.winRate.toFixed(1)}%, p=${pValue.toFixed(3)})`;
    } else {
      recommendation = `SIN DATOS: Muestra insuficiente (${decisive} señales, necesitas ≥30)`;
    }
    
    if (regime.changed) {
      recommendation += ` [ALERTA: Cambio de régimen - ${regime.direction}]`;
    }
    
    // Statistical confidence (based on sample size and p-value)
    let confidence = 0;
    if (decisive >= 30) confidence += 30;
    if (decisive >= 100) confidence += 20;
    if (decisive >= 500) confidence += 20;
    if (isSignificant) confidence += 30;
    confidence = Math.min(100, confidence);
    
    discoveries.push({
      patternType: stat.patternType,
      session: stat.session,
      asset: stat.asset,
      totalSignals: stat.totalSignals,
      wins: stat.wins,
      losses: stat.losses,
      winRate: Math.round(stat.winRate * 10) / 10,
      edge,
      edgeMagnitude: Math.round(edgeMagnitude * 10) / 10,
      confidence,
      pValue: Math.round(pValue * 10000) / 10000,
      isSignificant,
      recommendation,
      sampleAdequacy,
      regimeChange: regime.changed,
      recentWinRate: Math.round(regime.recentWinRate * 10) / 10,
      regimeDirection: regime.direction,
    });
  }
  
  // Sort by edge magnitude (strongest edges first)
  discoveries.sort((a, b) => {
    // Positive edges first, then by magnitude
    if (a.edge === 'POSITIVE' && b.edge !== 'POSITIVE') return -1;
    if (b.edge === 'POSITIVE' && a.edge !== 'POSITIVE') return 1;
    return b.edgeMagnitude - a.edgeMagnitude;
  });
  
  // Find best and worst setups
  const positiveSetups = discoveries.filter(d => d.edge === 'POSITIVE' && d.isSignificant);
  const negativeSetups = discoveries.filter(d => d.edge === 'NEGATIVE' && d.isSignificant);
  
  const bestSetup = positiveSetups.length > 0 ? positiveSetups[0] : null;
  const worstSetup = negativeSetups.length > 0 ? negativeSetups[0] : null;
  
  // Generate recommendations
  const recommendations: string[] = [];
  const warnings: string[] = [];
  
  if (totalDecisive < 30) {
    warnings.push(`Dataset insuficiente: ${totalDecisive} señales decisivas. Necesitas mínimo 30 para conclusions básicas.`);
    recommendations.push('Sigue recolectando datos. El dataset es tu activo más valioso.');
  } else if (totalDecisive < 100) {
    warnings.push(`Dataset bajo: ${totalDecisive} señales. Las conclusiones pueden ser ruido estadístico.`);
    recommendations.push('Continúa en modo recolección. No operes con tamaño real hasta tener 100+ señales.');
  } else if (totalDecisive < 500) {
    recommendations.push('Dataset aceptable. Empieza a filtrar setups: opera solo los que muestran edge positivo significativo.');
  } else {
    recommendations.push('Dataset bueno. Puedes confiar en los edges detectados. Monitorea cambios de régimen.');
  }
  
  if (positiveSetups.length === 0) {
    warnings.push('NO HAY EDGE POSITIVO DETECTADO en ningún setup. No operes con tamaño real.');
    recommendations.push('Sigue recolectando datos. Es mejor NO OPERAR que operar sin edge.');
  } else {
    recommendations.push(`Mejor setup: ${bestSetup?.patternType} en sesión ${bestSetup?.session} (${bestSetup?.winRate.toFixed(1)}% win rate, p=${bestSetup?.pValue.toFixed(3)})`);
  }
  
  if (negativeSetups.length > 0) {
    recommendations.push(`EVITAR: ${negativeSetups.map(s => `${s.patternType} en ${s.session}`).join(', ')}`);
  }
  
  // Detect regime changes
  const regimeChanges = discoveries.filter(d => d.regimeChange);
  if (regimeChanges.length > 0) {
    warnings.push(`${regimeChanges.length} setup(s) con cambio de régimen detectado. Reevalúa antes de operar.`);
  }
  
  // Data quality assessment
  const dataQuality: 'INSUFFICIENT' | 'POOR' | 'ACCEPTABLE' | 'GOOD' | 'EXCELLENT' = 
    totalDecisive < 30 ? 'INSUFFICIENT' :
    totalDecisive < 100 ? 'POOR' :
    totalDecisive < 500 ? 'ACCEPTABLE' :
    totalDecisive < 1000 ? 'GOOD' : 'EXCELLENT';
  
  // Next milestone
  const nextMilestone = 
    totalDecisive < 30 ? `Faltan ${30 - totalDecisive} señales para conclusions básicas (30)` :
    totalDecisive < 100 ? `Faltan ${100 - totalDecisive} señales para filtrado confiable (100)` :
    totalDecisive < 500 ? `Faltan ${500 - totalDecisive} señales para edge detection sólido (500)` :
    totalDecisive < 1000 ? `Faltan ${1000 - totalDecisive} señales para aprendizaje IA (1000)` :
    'Dataset suficiente para aprendizaje automático avanzado';
  
  return {
    totalDataPoints: totalSignals,
    totalDecisive,
    overallWinRate: Math.round(overallWinRate * 10) / 10,
    hasAnyEdge: positiveSetups.length > 0,
    bestSetup,
    worstSetup,
    discoveries,
    recommendations,
    warnings,
    dataQuality,
    nextMilestone,
    datasetHealth: {
      total: totalSignals,
      decisive: totalDecisive,
      pending: totalPending,
      noOperar: totalNoOperar,
      neededForGood: Math.max(0, 500 - totalDecisive),
      neededForExcellent: Math.max(0, 1000 - totalDecisive),
    },
  };
}

// ─── Setup Recommendations ────────────────────────────────────────────────────

export async function getSetupRecommendations(): Promise<SetupRecommendation[]> {
  const report = await runLearningAnalysis();
  
  return report.discoveries.map(d => {
    let action: 'OPERAR' | 'EVITAR' | 'OBSERVAR' | 'SIN_DATOS';
    
    if (d.sampleAdequacy === 'INSUFFICIENT') {
      action = 'SIN_DATOS';
    } else if (d.edge === 'POSITIVE' && d.isSignificant && !d.regimeChange) {
      action = 'OPERAR';
    } else if (d.edge === 'NEGATIVE' && d.isSignificant) {
      action = 'EVITAR';
    } else {
      action = 'OBSERVAR';
    }
    
    return {
      patternType: d.patternType,
      session: d.session,
      asset: d.asset,
      action,
      reason: d.recommendation,
      expectedWinRate: d.winRate,
      confidence: d.confidence,
    };
  });
}

// ─── Quick Edge Check ─────────────────────────────────────────────────────────

/**
 * Quick check: does this setup have a positive edge?
 * Used by the auto-trader to decide whether to generate a signal.
 */
export async function hasEdge(
  patternType: string | null,
  session: string,
  asset: string
): Promise<{ hasEdge: boolean; winRate: number; sampleSize: number; confidence: number }> {
  if (!patternType) {
    return { hasEdge: false, winRate: 50, sampleSize: 0, confidence: 0 };
  }
  
  const stat = await db.setupStats.findUnique({
    where: {
      patternType_asset_session_timeframe: {
        patternType,
        asset,
        session,
        timeframe: 'M5',
      },
    },
  });
  
  if (!stat || (stat.wins + stat.losses) < 10) {
    return { hasEdge: false, winRate: 50, sampleSize: stat?.totalSignals || 0, confidence: 0 };
  }
  
  const decisive = stat.wins + stat.losses;
  const pValue = approximatePValue(stat.wins, decisive);
  
  return {
    hasEdge: stat.winRate > 53 && pValue < 0.1 && decisive >= 10,
    winRate: Math.round(stat.winRate * 10) / 10,
    sampleSize: decisive,
    confidence: decisive >= 100 ? 80 : decisive >= 30 ? 50 : 20,
  };
}
