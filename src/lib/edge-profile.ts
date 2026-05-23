// EDGE PROFILE ENGINE — SignalTrader Pro
// "Solo opera lo que tiene edge probado. Todo lo demás es ruido."
//
// Loads backtest data from SetupStats and classifies each
// pattern+session+asset combination into actionable categories.
//
// Classification:
//   GREEN  — Confirmed positive edge (Bayesian WR > 55%, ≥30 samples, p < 0.1)
//   YELLOW — Marginal positive edge (Bayesian WR > 50%, ≥20 samples)
//   RED    — Confirmed negative edge (Bayesian WR < 48%, ≥30 samples)
//   GREY   — Unknown / insufficient data
//
// The auto-trader uses this to decide:
//   GREEN  → Trade normally, full confidence boost
//   YELLOW → Trade cautiously, only with high confidence (≥50%)
//   RED    → NEVER trade — confirmed losing setup → NO OPERAR
//   GREY   → Only in data collection mode

import { db } from './db';
import { quickBayesianWR, calculateBayesianStats } from './bayesian-engine';

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

export type EdgeClassification = 'GREEN' | 'YELLOW' | 'RED' | 'GREY';

export interface EdgeEntry {
  patternType: string;
  session: string;
  asset: string;
  classification: EdgeClassification;
  bayesianWR: number;
  rawWR: number;
  sampleSize: number;
  wins: number;
  losses: number;
  pValue: number;
  confidenceInterval: { lower: number; upper: number };
  avgExpectancy: number;
  avgSetupScore: number;
  lastUpdated: Date;
}

export interface EdgeProfile {
  entries: EdgeEntry[];
  greenCount: number;
  yellowCount: number;
  redCount: number;
  greyCount: number;
  totalCombos: number;
  loadedAt: Date;
}

export interface EdgeDecision {
  classification: EdgeClassification;
  shouldTrade: boolean;
  reason: string;
  confidenceAdjustment: number;  // + or - to apply to signal confidence
  setupScoreAdjustment: number;  // + or - to apply to setup score
  entry: EdgeEntry | null;       // The edge data (null if GREY)
}

// ══════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION RULES
// ══════════════════════════════════════════════════════════════════════════════

const MIN_SAMPLES_GREEN = 30;
const MIN_SAMPLES_YELLOW = 20;
const MIN_SAMPLES_RED = 30;
const WR_THRESHOLD_GREEN = 55;  // Bayesian WR above this = confirmed edge
const WR_THRESHOLD_YELLOW = 50;  // Bayesian WR above this = marginal edge
const WR_THRESHOLD_RED = 48;    // Bayesian WR below this = confirmed negative
const P_VALUE_THRESHOLD = 0.1;  // Statistical significance threshold

function classifyEdge(
  bayesianWR: number,
  rawWR: number,
  sampleSize: number,
  pValue: number
): EdgeClassification {
  // Insufficient data
  if (sampleSize < MIN_SAMPLES_YELLOW) {
    return 'GREY';
  }

  // Confirmed positive edge
  if (bayesianWR >= WR_THRESHOLD_GREEN && sampleSize >= MIN_SAMPLES_GREEN && pValue < P_VALUE_THRESHOLD) {
    return 'GREEN';
  }

  // Confirmed negative edge
  if (bayesianWR < WR_THRESHOLD_RED && sampleSize >= MIN_SAMPLES_RED) {
    return 'RED';
  }

  // Marginal positive
  if (bayesianWR >= WR_THRESHOLD_YELLOW && sampleSize >= MIN_SAMPLES_YELLOW) {
    return 'YELLOW';
  }

  // Everything else with enough samples but no clear edge
  if (sampleSize >= MIN_SAMPLES_RED && bayesianWR < WR_THRESHOLD_YELLOW) {
    return 'RED';  // Enough data to say it's probably negative
  }

  return 'GREY';
}

// ══════════════════════════════════════════════════════════════════════════════
// CACHED PROFILE
// ══════════════════════════════════════════════════════════════════════════════

let cachedProfile: EdgeProfile | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateEdgeProfileCache(): void {
  cachedProfile = null;
}

async function getProfile(): Promise<EdgeProfile> {
  if (cachedProfile && Date.now() - cachedProfile.loadedAt.getTime() < CACHE_TTL_MS) {
    return cachedProfile;
  }

  const stats = await db.setupStats.findMany({
    where: {
      timeframe: 'M5',
      asset: { not: null },
      session: { not: null },
    },
    orderBy: { winRate: 'desc' },
  });

  const entries: EdgeEntry[] = stats.map(s => {
    const bayesianWR = s.bayesianWinRate > 0
      ? s.bayesianWinRate
      : quickBayesianWR(s.wins, s.losses);

    const classification = classifyEdge(
      bayesianWR,
      s.winRate,
      s.totalSignals,
      s.pValue
    );

    return {
      patternType: s.patternType,
      session: s.session || 'Unknown',
      asset: s.asset || 'Unknown',
      classification,
      bayesianWR,
      rawWR: s.winRate,
      sampleSize: s.totalSignals,
      wins: s.wins,
      losses: s.losses,
      pValue: s.pValue,
      confidenceInterval: {
        lower: s.confidenceIntervalLower,
        upper: s.confidenceIntervalUpper,
      },
      avgExpectancy: s.avgExpectancy,
      avgSetupScore: s.avgSetupScore,
      lastUpdated: s.lastUpdated,
    };
  });

  const greenCount = entries.filter(e => e.classification === 'GREEN').length;
  const yellowCount = entries.filter(e => e.classification === 'YELLOW').length;
  const redCount = entries.filter(e => e.classification === 'RED').length;
  const greyCount = entries.filter(e => e.classification === 'GREY').length;

  cachedProfile = {
    entries,
    greenCount,
    yellowCount,
    redCount,
    greyCount,
    totalCombos: entries.length,
    loadedAt: new Date(),
  };

  return cachedProfile;
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Get the full edge profile (for dashboard display).
 */
export async function getEdgeProfile(): Promise<EdgeProfile> {
  return getProfile();
}

/**
 * Classify a specific setup and get a trading decision.
 *
 * This is the main function the auto-trader calls.
 * It checks the pattern+session+asset combo against the edge profile
 * and returns whether to trade, how to adjust confidence, and why.
 */
export async function getEdgeDecision(
  patternType: string | null,
  session: string,
  asset: string,
  currentConfidence: number = 50,
  isDataCollectionMode: boolean = true
): Promise<EdgeDecision> {
  const profile = await getProfile();
  const key = patternType || 'none';

  // Find matching entry
  const entry = profile.entries.find(
    e => e.patternType === key && e.session === session && e.asset === asset
  );

  if (!entry) {
    // No data at all for this combo
    if (isDataCollectionMode) {
      return {
        classification: 'GREY',
        shouldTrade: currentConfidence >= 15,  // Low bar in data collection mode
        reason: `Sin datos para ${key}+${session}+${asset}. Generando para dataset.`,
        confidenceAdjustment: -10,  // Penalize unknown combos
        setupScoreAdjustment: -15,
        entry: null,
      };
    }
    return {
      classification: 'GREY',
      shouldTrade: false,
      reason: `Sin datos para ${key}+${session}+${asset}. No operar sin evidencia.`,
      confidenceAdjustment: -20,
      setupScoreAdjustment: -20,
      entry: null,
    };
  }

  switch (entry.classification) {
    case 'GREEN':
      return {
        classification: 'GREEN',
        shouldTrade: true,
        reason: `EDGE VERDE: ${key}+${session}+${asset} WR bayesiana ${entry.bayesianWR.toFixed(1)}% (${entry.sampleSize} muestras, p=${entry.pValue.toFixed(3)}). Edge confirmado.`,
        confidenceAdjustment: Math.min(20, Math.round((entry.bayesianWR - 50) * 0.8)),  // Up to +20
        setupScoreAdjustment: Math.min(15, Math.round((entry.bayesianWR - 50) * 0.6)),  // Up to +15
        entry,
      };

    case 'YELLOW':
      // Only trade if confidence is high enough
      if (currentConfidence >= 50) {
        return {
          classification: 'YELLOW',
          shouldTrade: true,
          reason: `EDGE AMARILLO: ${key}+${session}+${asset} WR bayesiana ${entry.bayesianWR.toFixed(1)}% (${entry.sampleSize} muestras). Edge marginal - operar con cautela.`,
          confidenceAdjustment: -5,  // Slight penalty for marginal edge
          setupScoreAdjustment: -5,
          entry,
        };
      }
      return {
        classification: 'YELLOW',
        shouldTrade: isDataCollectionMode,
        reason: `EDGE AMARILLO: ${key}+${session}+${asset} WR ${entry.bayesianWR.toFixed(1)}% pero confianza baja (${currentConfidence.toFixed(0)}%). ${isDataCollectionMode ? 'Generando para dataset.' : 'No operar sin alta confianza.'}`,
        confidenceAdjustment: -10,
        setupScoreAdjustment: -10,
        entry,
      };

    case 'RED':
      // RED combos should NEVER be traded — confirmed losers
      if (isDataCollectionMode) {
        // In data collection mode, we might still generate for learning
        // but with very low confidence → will be NO_OPERAR
        return {
          classification: 'RED',
          shouldTrade: false,
          reason: `EDGE ROJO: ${key}+${session}+${asset} WR bayesiana ${entry.bayesianWR.toFixed(1)}% (${entry.sampleSize} muestras). Setup perdedor confirmado. NO OPERAR.`,
          confidenceAdjustment: -40,  // Heavy penalty
          setupScoreAdjustment: -30,
          entry,
        };
      }
      return {
        classification: 'RED',
        shouldTrade: false,
        reason: `EDGE ROJO: ${key}+${session}+${asset} WR bayesiana ${entry.bayesianWR.toFixed(1)}% (${entry.sampleSize} muestras). Setup perdedor confirmado. NO OPERAR.`,
        confidenceAdjustment: -50,
        setupScoreAdjustment: -40,
        entry,
      };

    case 'GREY':
    default:
      if (isDataCollectionMode) {
        return {
          classification: 'GREY',
          shouldTrade: currentConfidence >= 20,
          reason: `SIN DATOS SUFICIENTES: ${key}+${session}+${asset} (${entry.sampleSize} muestras). Generando para dataset.`,
          confidenceAdjustment: -5,
          setupScoreAdjustment: -10,
          entry,
        };
      }
      return {
        classification: 'GREY',
        shouldTrade: false,
        reason: `SIN DATOS SUFICIENTES: ${key}+${session}+${asset} (${entry.sampleSize} muestras). No operar sin evidencia.`,
        confidenceAdjustment: -15,
        setupScoreAdjustment: -15,
        entry,
      };
  }
}

/**
 * Get all GREEN edges (the ones worth trading).
 * Useful for dashboard display and strategy focus.
 */
export async function getGreenEdges(): Promise<EdgeEntry[]> {
  const profile = await getProfile();
  return profile.entries
    .filter(e => e.classification === 'GREEN')
    .sort((a, b) => b.bayesianWR - a.bayesianWR);
}

/**
 * Get all RED edges (the ones to avoid).
 */
export async function getRedEdges(): Promise<EdgeEntry[]> {
  const profile = await getProfile();
  return profile.entries
    .filter(e => e.classification === 'RED')
    .sort((a, b) => a.bayesianWR - b.bayesianWR);
}

/**
 * Quick check: does this setup have a confirmed edge?
 * Optimized for the hot path in auto-trader.
 */
export async function hasConfirmedEdge(
  patternType: string | null,
  session: string,
  asset: string
): Promise<boolean> {
  const profile = await getProfile();
  const key = patternType || 'none';
  const entry = profile.entries.find(
    e => e.patternType === key && e.session === session && e.asset === asset
  );
  return entry?.classification === 'GREEN';
}

/**
 * Quick check: is this setup confirmed to be a loser?
 */
export async function isConfirmedLoser(
  patternType: string | null,
  session: string,
  asset: string
): Promise<boolean> {
  const profile = await getProfile();
  const key = patternType || 'none';
  const entry = profile.entries.find(
    e => e.patternType === key && e.session === session && e.asset === asset
  );
  return entry?.classification === 'RED';
}

/**
 * Generate a human-readable edge profile summary (for CLI/dashboard).
 */
export async function getEdgeProfileSummary(): Promise<string> {
  const profile = await getProfile();
  const lines: string[] = [];

  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════════════');
  lines.push('  EDGE PROFILE — Clasificación de Setups');
  lines.push('══════════════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  🟢 GREEN (Operar):   ${profile.greenCount}`);
  lines.push(`  🟡 YELLOW (Cautela):  ${profile.yellowCount}`);
  lines.push(`  🔴 RED (Evitar):      ${profile.redCount}`);
  lines.push(`  ⬜ GREY (Sin datos):  ${profile.greyCount}`);
  lines.push(`  Total combinaciones:  ${profile.totalCombos}`);
  lines.push('');

  // GREEN edges
  const greens = profile.entries.filter(e => e.classification === 'GREEN').sort((a, b) => b.bayesianWR - a.bayesianWR);
  if (greens.length > 0) {
    lines.push('  🟢 EDGES CONFIRMADOS (GREEN):');
    for (const g of greens) {
      lines.push(`     ${g.patternType} + ${g.session} + ${g.asset}`);
      lines.push(`       WR bayesiana: ${g.bayesianWR.toFixed(1)}% | Muestras: ${g.sampleSize} | p=${g.pValue.toFixed(4)}`);
      lines.push(`       IC 95%: ${g.confidenceInterval.lower.toFixed(1)}%-${g.confidenceInterval.upper.toFixed(1)}% | EV: ${g.avgExpectancy.toFixed(3)}R`);
    }
    lines.push('');
  }

  // RED edges
  const reds = profile.entries.filter(e => e.classification === 'RED').sort((a, b) => a.bayesianWR - b.bayesianWR);
  if (reds.length > 0) {
    lines.push('  🔴 SETUPS PERDEDORES (RED — NO OPERAR):');
    for (const r of reds) {
      lines.push(`     ${r.patternType} + ${r.session} + ${r.asset}`);
      lines.push(`       WR bayesiana: ${r.bayesianWR.toFixed(1)}% | Muestras: ${r.sampleSize} | p=${r.pValue.toFixed(4)}`);
    }
    lines.push('');
  }

  // YELLOW edges
  const yellows = profile.entries.filter(e => e.classification === 'YELLOW').sort((a, b) => b.bayesianWR - a.bayesianWR);
  if (yellows.length > 0) {
    lines.push('  🟡 EDGES MARGINALES (YELLOW — Operar con cautela):');
    for (const y of yellows) {
      lines.push(`     ${y.patternType} + ${y.session} + ${y.asset}: WR bayesiana ${y.bayesianWR.toFixed(1)}% (${y.sampleSize} muestras)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get recommended assets and patterns to focus on.
 * Based on GREEN/YELLOW edges in the profile.
 */
export async function getTradingFocus(): Promise<{
  patterns: string[];
  sessions: string[];
  assets: string[];
  bestCombos: Array<{ pattern: string; session: string; asset: string; wr: number }>;
}> {
  const profile = await getProfile();
  const tradeable = profile.entries.filter(e => e.classification === 'GREEN' || e.classification === 'YELLOW');

  const patterns = [...new Set(tradeable.map(e => e.patternType))];
  const sessions = [...new Set(tradeable.map(e => e.session))];
  const assets = [...new Set(tradeable.map(e => e.asset))];

  const bestCombos = tradeable
    .sort((a, b) => b.bayesianWR - a.bayesianWR)
    .slice(0, 10)
    .map(e => ({
      pattern: e.patternType,
      session: e.session,
      asset: e.asset,
      wr: e.bayesianWR,
    }));

  return { patterns, sessions, assets, bestCombos };
}
