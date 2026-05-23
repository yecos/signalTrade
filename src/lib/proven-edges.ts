// PROVEN EDGES — SignalTrader Pro
// "Solo opera lo que tiene edge. Todo lo demás es ruido."
//
// Hardcoded allowlist of pattern+session+asset combos with PROVEN positive edge
// from the 6-month multi-expiry backtest (40 min expiration, M5 timeframe).
//
// Source: npx tsx scripts/backtest-expiry.ts --months 6 --save-db --expiry 40
// Date: 2026-05-23
//
// Classification:
//   TIER_1 — Raw WR > 60%, ≥30 samples → High confidence trades
//   TIER_2 — Raw WR > 55%, ≥20 samples → Solid edge, trade normally
//   TIER_3 — Raw WR > 53%, ≥50 samples → Marginal but significant, cautious
//   BLOCKED — Pattern-level WR < 50% → Never trade, confirmed losers

import type { PatternType } from './patterns';
import type { SessionType } from './sessions';

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

export type EdgeTier = 'TIER_1' | 'TIER_2' | 'TIER_3' | 'BLOCKED' | 'UNKNOWN';

export interface ProvenEdge {
  pattern: string;
  session: string;
  asset: string;
  tier: EdgeTier;
  rawWR: number;       // From 6-month backtest
  wins: number;
  losses: number;
  total: number;
  description: string; // Human-readable
}

export interface EdgeFilterResult {
  allowed: boolean;
  tier: EdgeTier;
  edge: ProvenEdge | null;
  reason: string;
  confidenceBoost: number;  // + or - to apply to signal confidence
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVEN EDGES — From 6-month backtest @ 40 min expiration
// ══════════════════════════════════════════════════════════════════════════════

const PROVEN_EDGES: ProvenEdge[] = [
  // ──── TIER 1: Raw WR > 60% — High confidence ────
  {
    pattern: 'liquidity_sweep',
    session: 'NewYork',
    asset: 'BTC/USD',
    tier: 'TIER_1',
    rawWR: 66.7,
    wins: 50,
    losses: 25,
    total: 75,
    description: 'liquidity_sweep en sesión NY + BTC — Edge más fuerte del sistema',
  },
  {
    pattern: 'liquidity_sweep',
    session: 'Asia',
    asset: 'BTC/USD',
    tier: 'TIER_1',
    rawWR: 62.2,
    wins: 56,
    losses: 34,
    total: 90,
    description: 'liquidity_sweep en sesión Asia + BTC — Excelente edge en overnight',
  },
  {
    pattern: 'liquidity_sweep',
    session: 'Overlap',
    asset: 'ETH/USD',
    tier: 'TIER_1',
    rawWR: 61.1,
    wins: 33,
    losses: 21,
    total: 54,
    description: 'liquidity_sweep en Overlap + ETH — Fuerte edge en transición de sesión',
  },

  // ──── TIER 2: Raw WR 55-60% — Solid edge ────
  {
    pattern: 'liquidity_sweep',
    session: 'NewYork',
    asset: 'ETH/USD',
    tier: 'TIER_2',
    rawWR: 58.2,
    wins: 32,
    losses: 23,
    total: 55,
    description: 'liquidity_sweep en NY + ETH — Edge sólido',
  },
  {
    pattern: 'liquidity_sweep',
    session: 'London',
    asset: 'BTC/USD',
    tier: 'TIER_2',
    rawWR: 55.7,
    wins: 34,
    losses: 27,
    total: 61,
    description: 'liquidity_sweep en London + BTC — Edge positivo en sesión europea',
  },
  {
    pattern: 'fakeout',
    session: 'Asia',
    asset: 'ETH/USD',
    tier: 'TIER_2',
    rawWR: 56.5,
    wins: 100,
    losses: 77,
    total: 177,
    description: 'fakeout en Asia + ETH — Amplia muestra, edge consistente',
  },

  // ──── TIER 3: Raw WR 53-55% — Marginal but significant ────
  {
    pattern: 'engulfing',
    session: 'Asia',
    asset: 'ETH/USD',
    tier: 'TIER_3',
    rawWR: 55.4,
    wins: 185,
    losses: 149,
    total: 334,
    description: 'engulfing en Asia + ETH — Muestra grande, edge marginal',
  },
  {
    pattern: 'reversal',
    session: 'Asia',
    asset: 'ETH/USD',
    tier: 'TIER_3',
    rawWR: 59.1,
    wins: 26,
    losses: 18,
    total: 44,
    description: 'reversal en Asia + ETH — Buen WR pero muestra pequeña',
  },
  {
    pattern: 'reversal',
    session: 'Asia',
    asset: 'BTC/USD',
    tier: 'TIER_3',
    rawWR: 55.6,
    wins: 15,
    losses: 12,
    total: 27,
    description: 'reversal en Asia + BTC — Muestra muy pequeña',
  },
  {
    pattern: 'liquidity_sweep',
    session: 'Asia',
    asset: 'ETH/USD',
    tier: 'TIER_3',
    rawWR: 53.4,
    wins: 64,
    losses: 56,
    total: 120,
    description: 'liquidity_sweep en Asia + ETH — Edge marginal pero muestra grande',
  },
  {
    pattern: 'liquidity_sweep',
    session: 'Overlap',
    asset: 'BTC/USD',
    tier: 'TIER_3',
    rawWR: 54.3,
    wins: 44,
    losses: 37,
    total: 81,
    description: 'liquidity_sweep en Overlap + BTC — Edge marginal',
  },
  {
    pattern: 'liquidity_sweep',
    session: 'London',
    asset: 'ETH/USD',
    tier: 'TIER_3',
    rawWR: 53.1,
    wins: 43,
    losses: 38,
    total: 81,
    description: 'liquidity_sweep en London + ETH — Edge marginal',
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// BLOCKED PATTERNS — Confirmed losers from backtest (WR < 50%)
// Even if a specific combo shows marginal WR, the pattern as a whole loses.
// ══════════════════════════════════════════════════════════════════════════════

const BLOCKED_PATTERNS: Record<string, { wr: number; reason: string }> = {
  'breakout': {
    wr: 45.6,
    reason: 'breakout pierde 54.4% de las veces — Señales falsas en rangos',
  },
  'trend_continuation': {
    wr: 46.8,
    reason: 'trend_continuation pierde 53.2% — Reversiones frecuentes',
  },
  'none': {
    wr: 48.9,
    reason: 'Sin patrón detectado — Random walk, sin edge',
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// PATTERN-LEVEL STATS (overall WR across all sessions/assets)
// Used for combos not in PROVEN_EDGES or BLOCKED_PATTERNS
// ══════════════════════════════════════════════════════════════════════════════

const PATTERN_OVERALL: Record<string, { wr: number; wins: number; losses: number; total: number }> = {
  'liquidity_sweep': { wr: 56.8, wins: 292, losses: 222, total: 514 },
  'fakeout':         { wr: 51.8, wins: 544, losses: 507, total: 1051 },
  'engulfing':       { wr: 51.1, wins: 1009, losses: 965, total: 1975 },
  'reversal':        { wr: 52.3, wins: 114, losses: 104, total: 218 },
  'breakout':        { wr: 45.6, wins: 442, losses: 528, total: 970 },
  'trend_continuation': { wr: 46.8, wins: 1240, losses: 1406, total: 2649 },
  'none':            { wr: 48.9, wins: 3545, losses: 3703, total: 7256 },
};

// ══════════════════════════════════════════════════════════════════════════════
// EDGE FILTER — Main function for auto-trader
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a pattern+session+asset combo should be traded.
 *
 * Strict mode: Only PROVEN edges (TIER_1, TIER_2, TIER_3) pass.
 *              Everything else → BLOCKED.
 *
 * Data collection mode: PROVEN edges + unproven combos with positive pattern-level WR
 *                       BLOCKED patterns still blocked.
 */
export function checkProvenEdge(
  patternType: PatternType | null,
  session: SessionType,
  asset: string,
  strict: boolean = true
): EdgeFilterResult {
  const key = patternType || 'none';

  // 1. Check if this exact combo is in PROVEN_EDGES
  const exactMatch = PROVEN_EDGES.find(
    e => e.pattern === key && e.session === session && e.asset === asset
  );

  if (exactMatch) {
    const boosts: Record<EdgeTier, number> = {
      'TIER_1': 15,   // +15 confidence for 60%+ WR
      'TIER_2': 8,    // +8 confidence for 55-60% WR
      'TIER_3': 0,    // No boost for marginal edge
      'BLOCKED': -50,
      'UNKNOWN': -20,
    };

    return {
      allowed: true,
      tier: exactMatch.tier,
      edge: exactMatch,
      reason: `✅ EDGE ${exactMatch.tier}: ${key}+${session}+${asset} WR ${exactMatch.rawWR.toFixed(1)}% (${exactMatch.wins}W/${exactMatch.losses}L)`,
      confidenceBoost: boosts[exactMatch.tier],
    };
  }

  // 2. Check if pattern is BLOCKED (confirmed loser)
  const blockedPattern = BLOCKED_PATTERNS[key];
  if (blockedPattern) {
    return {
      allowed: false,
      tier: 'BLOCKED',
      edge: null,
      reason: `🚫 PATRÓN BLOQUEADO: ${key} WR ${blockedPattern.wr}% — ${blockedPattern.reason}`,
      confidenceBoost: -50,
    };
  }

  // 3. Pattern not in PROVEN_EDGES and not BLOCKED
  //    Check if pattern has positive overall WR
  const overallStats = PATTERN_OVERALL[key];

  if (strict) {
    // In strict mode: only trade proven combos
    // Even if pattern has positive WR overall, specific combo isn't proven
    return {
      allowed: false,
      tier: 'UNKNOWN',
      edge: null,
      reason: `⚠️ NO PROBADO: ${key}+${session}+${asset} no tiene edge confirmado en backtest. WR patrón: ${overallStats?.wr.toFixed(1) || '?'}%. Solo operar combos probados.`,
      confidenceBoost: -20,
    };
  }

  // In data collection mode: allow if pattern has positive overall WR
  if (overallStats && overallStats.wr > 51) {
    return {
      allowed: true,
      tier: 'TIER_3',
      edge: {
        pattern: key,
        session,
        asset,
        tier: 'TIER_3',
        rawWR: overallStats.wr,
        wins: overallStats.wins,
        losses: overallStats.losses,
        total: overallStats.total,
        description: `Patrón con WR positivo (${overallStats.wr.toFixed(1)}%) pero combo específico no probado`,
      },
      reason: `🟡 MODO RECOLECCIÓN: ${key} WR general ${overallStats.wr.toFixed(1)}% pero ${session}+${asset} no probado`,
      confidenceBoost: -5,
    };
  }

  // Pattern has negative or unknown WR → block even in data collection
  return {
    allowed: false,
    tier: 'BLOCKED',
    edge: null,
    reason: `🚫 PATRÓN NEGATIVO: ${key} WR general ${overallStats?.wr.toFixed(1) || '?'}% — No operar`,
    confidenceBoost: -30,
  };
}

/**
 * Get all proven edges (for dashboard display).
 */
export function getAllProvenEdges(): ProvenEdge[] {
  return [...PROVEN_EDGES].sort((a, b) => b.rawWR - a.rawWR);
}

/**
 * Get all blocked patterns (for dashboard display).
 */
export function getBlockedPatterns(): Record<string, { wr: number; reason: string }> {
  return { ...BLOCKED_PATTERNS };
}

/**
 * Get the best combo for a given pattern.
 * Useful for suggesting optimal session/asset to the user.
 */
export function getBestComboForPattern(pattern: string): ProvenEdge | null {
  const matches = PROVEN_EDGES
    .filter(e => e.pattern === pattern)
    .sort((a, b) => b.rawWR - a.rawWR);
  return matches[0] || null;
}

/**
 * Get proven edges filtered by tier.
 */
export function getEdgesByTier(tier: EdgeTier): ProvenEdge[] {
  return PROVEN_EDGES.filter(e => e.tier === tier).sort((a, b) => b.rawWR - a.rawWR);
}

/**
 * Count stats for dashboard
 */
export function getProvenEdgesStats(): {
  total: number;
  tier1: number;
  tier2: number;
  tier3: number;
  blocked: number;
  bestWR: number;
  avgWR: number;
} {
  const tier1 = PROVEN_EDGES.filter(e => e.tier === 'TIER_1');
  const tier2 = PROVEN_EDGES.filter(e => e.tier === 'TIER_2');
  const tier3 = PROVEN_EDGES.filter(e => e.tier === 'TIER_3');

  return {
    total: PROVEN_EDGES.length,
    tier1: tier1.length,
    tier2: tier2.length,
    tier3: tier3.length,
    blocked: Object.keys(BLOCKED_PATTERNS).length,
    bestWR: PROVEN_EDGES.length > 0 ? Math.max(...PROVEN_EDGES.map(e => e.rawWR)) : 0,
    avgWR: PROVEN_EDGES.length > 0
      ? PROVEN_EDGES.reduce((sum, e) => sum + e.rawWR, 0) / PROVEN_EDGES.length
      : 0,
  };
}
