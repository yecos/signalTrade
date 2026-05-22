// SESSION ENGINE
// Detects trading sessions and tracks session-specific performance
// Sessions: Asia, London, New York, Overlap (London-NY)

// === TYPES ===
export type SessionType = 'Asia' | 'London' | 'NewYork' | 'Overlap' | 'OffHours';

export interface SessionInfo {
  session: SessionType;
  sessionEs: string;        // Spanish name
  startUtc: string;         // HH:MM UTC
  endUtc: string;
  volatilityMultiplier: number;  // relative volatility in this session
  liquidityLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  bestFor: string[];        // which patterns work best
  avoidPatterns: string[];  // which patterns to avoid
  description: string;
}

// === SESSION DEFINITIONS (UTC) ===

export const SESSIONS: Record<SessionType, SessionInfo> = {
  Asia: {
    session: 'Asia',
    sessionEs: 'Sesión Asiática',
    startUtc: '00:00',
    endUtc: '08:00',
    volatilityMultiplier: 0.5,
    liquidityLevel: 'LOW',
    bestFor: ['range_breakout', 'trend_continuation'],
    avoidPatterns: ['breakout', 'liquidity_sweep'],
    description: 'Baja volatilidad y liquidez. Buenos para rangos y continuaciones. Evitar breakouts.',
  },
  London: {
    session: 'London',
    sessionEs: 'Sesión de Londres',
    startUtc: '07:00',
    endUtc: '16:00',
    volatilityMultiplier: 1.2,
    liquidityLevel: 'HIGH',
    bestFor: ['breakout', 'liquidity_sweep', 'engulfing'],
    avoidPatterns: ['trend_continuation'],  // at open, reversals more likely
    description: 'Alta volatilidad al open. Buenos para breakouts y sweeps. Las primeras 2 horas son las más volátiles.',
  },
  NewYork: {
    session: 'NewYork',
    sessionEs: 'Sesión de Nueva York',
    startUtc: '12:00',
    endUtc: '21:00',
    volatilityMultiplier: 1.0,
    liquidityLevel: 'HIGH',
    bestFor: ['reversal', 'fakeout', 'engulfing'],
    avoidPatterns: ['trend_continuation'],
    description: 'Alta liquidez. Buenos para reversiones y fakeouts. La apertura genera volatilidad.',
  },
  Overlap: {
    session: 'Overlap',
    sessionEs: 'Solape Londres-NY',
    startUtc: '12:00',
    endUtc: '16:00',
    volatilityMultiplier: 1.5,
    liquidityLevel: 'HIGH',
    bestFor: ['breakout', 'liquidity_sweep', 'engulfing', 'fakeout'],
    avoidPatterns: [],
    description: 'MÁXIMA volatilidad y liquidez. El mejor momento para todos los patrones. Edge estadístico más fuerte.',
  },
  OffHours: {
    session: 'OffHours',
    sessionEs: 'Horas fuera de sesión',
    startUtc: '21:00',
    endUtc: '00:00',
    volatilityMultiplier: 0.3,
    liquidityLevel: 'LOW',
    bestFor: [],
    avoidPatterns: ['breakout', 'liquidity_sweep', 'engulfing', 'fakeout'],
    description: 'Muy baja liquidez. NO operar. Spreads amplios, slippage alto.',
  },
};

// === DETECT CURRENT SESSION ===

export function detectSession(date: Date = new Date()): SessionInfo {
  const hourUtc = date.getUTCHours();
  const minuteUtc = date.getUTCMinutes();
  const timeInMinutes = hourUtc * 60 + minuteUtc;
  
  // Overlap: 12:00-16:00 UTC (takes priority)
  if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
    return SESSIONS.Overlap;
  }
  
  // London: 07:00-12:00 UTC
  if (timeInMinutes >= 7 * 60 && timeInMinutes < 12 * 60) {
    return SESSIONS.London;
  }
  
  // New York: 16:00-21:00 UTC (after overlap)
  if (timeInMinutes >= 16 * 60 && timeInMinutes < 21 * 60) {
    return SESSIONS.NewYork;
  }
  
  // Asia: 00:00-08:00 UTC
  if (timeInMinutes >= 0 && timeInMinutes < 7 * 60) {
    return SESSIONS.Asia;
  }
  
  // Also Asia for 08:00 (some overlap)
  if (timeInMinutes >= 8 * 60 && timeInMinutes < 9 * 60) {
    return SESSIONS.Asia;
  }
  
  // Off hours: 21:00-00:00 UTC
  return SESSIONS.OffHours;
}

// === SESSION PERFORMANCE TRACKING ===

export interface SessionPerformance {
  session: SessionType;
  totalSignals: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  bestPatterns: Array<{ pattern: string; winRate: number; count: number }>;
  worstPatterns: Array<{ pattern: string; winRate: number; count: number }>;
  avgConfidence: number;
  recommendation: string;
}

export function calculateSessionPerformance(
  signals: Array<{
    sessionType: string | null;
    patternType: string | null;
    result: string | null;
    confidence: number;
    status: string;
  }>
): SessionPerformance[] {
  const sessionGroups: Record<string, Array<typeof signals[0]>> = {};
  
  signals.forEach(s => {
    const session = s.sessionType || 'OffHours';
    if (!sessionGroups[session]) sessionGroups[session] = [];
    sessionGroups[session].push(s);
  });
  
  const results: SessionPerformance[] = [];
  
  for (const [session, group] of Object.entries(sessionGroups)) {
    const closed = group.filter(s => s.status === 'CLOSED' && s.result);
    const decisive = closed.filter(s => s.result === 'WIN' || s.result === 'LOSS');
    const wins = decisive.filter(s => s.result === 'WIN').length;
    const losses = decisive.filter(s => s.result === 'LOSS').length;
    const draws = closed.filter(s => s.result === 'DRAW').length;
    const winRate = decisive.length > 0 ? (wins / decisive.length) * 100 : 0;
    const avgConfidence = closed.length > 0 
      ? closed.reduce((sum, s) => sum + s.confidence, 0) / closed.length 
      : 0;
    
    // Pattern performance within this session
    const patternGroups: Record<string, { wins: number; total: number }> = {};
    closed.forEach(s => {
      const pattern = s.patternType || 'unknown';
      if (!patternGroups[pattern]) patternGroups[pattern] = { wins: 0, total: 0 };
      patternGroups[pattern].total++;
      if (s.result === 'WIN') patternGroups[pattern].wins++;
    });
    
    const patternStats = Object.entries(patternGroups)
      .map(([pattern, data]) => ({
        pattern,
        winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
        count: data.total,
      }))
      .sort((a, b) => b.winRate - a.winRate);
    
    const bestPatterns = patternStats.filter(p => p.count >= 2).slice(0, 3);
    const worstPatterns = patternStats.filter(p => p.count >= 2).slice(-3).reverse();
    
    // Generate recommendation
    let recommendation = '';
    const sessionInfo = SESSIONS[session as SessionType] || SESSIONS.OffHours;
    
    if (decisive.length < 10) {
      recommendation = `Datos insuficientes (${decisive.length} señales). Necesitas mínimo 30 para evaluar.`;
    } else if (winRate > 65) {
      recommendation = `Edge positivo en ${sessionInfo.sessionEs}. Win rate ${winRate.toFixed(1)}% es operable. Continuar recolectando datos.`;
    } else if (winRate > 55) {
      recommendation = `Edge marginal en ${sessionInfo.sessionEs}. Win rate ${winRate.toFixed(1)}% necesita más confirmación.`;
    } else if (winRate > 45) {
      recommendation = `Sin edge claro en ${sessionInfo.sessionEs}. Win rate ${winRate.toFixed(1)}% es cercano al azar. Considerar filtrar más.`;
    } else {
      recommendation = `Edge negativo en ${sessionInfo.sessionEs}. Win rate ${winRate.toFixed(1)}% indica que este setup NO funciona aquí. EVITAR.`;
    }
    
    results.push({
      session: session as SessionType,
      totalSignals: closed.length,
      wins,
      losses,
      draws,
      winRate: Math.round(winRate * 10) / 10,
      bestPatterns,
      worstPatterns,
      avgConfidence: Math.round(avgConfidence * 10) / 10,
      recommendation,
    });
  }
  
  return results.sort((a, b) => b.totalSignals - a.totalSignals);
}

// === SHOULD TRADE THIS SESSION? ===

export function shouldTradeSession(
  session: SessionInfo,
  historicalWinRate: number,
  sampleSize: number
): { shouldTrade: boolean; reason: string; adjustedConfidence: number } {
  // Off hours: never trade
  if (session.session === 'OffHours') {
    return {
      shouldTrade: false,
      reason: 'Horas fuera de sesión. Liquidez insuficiente, spreads amplios.',
      adjustedConfidence: 0,
    };
  }
  
  // Insufficient data
  if (sampleSize < 10) {
    return {
      shouldTrade: false,
      reason: `Datos insuficientes (${sampleSize} señales). Mínimo 30 para evaluar edge.`,
      adjustedConfidence: 0,
    };
  }
  
  // Low win rate in this session
  if (sampleSize >= 10 && historicalWinRate < 45) {
    return {
      shouldTrade: false,
      reason: `Win rate ${historicalWinRate.toFixed(1)}% en ${session.sessionEs} es demasiado bajo. Sin edge.`,
      adjustedConfidence: -20,
    };
  }
  
  // Adjust confidence based on session quality
  let adjustedConfidence = 0;
  
  if (session.session === 'Overlap') {
    adjustedConfidence = 15; // Best session, boost confidence
  } else if (session.session === 'London') {
    adjustedConfidence = 10;
  } else if (session.session === 'NewYork') {
    adjustedConfidence = 5;
  } else if (session.session === 'Asia') {
    adjustedConfidence = -5; // Lower liquidity
  }
  
  return {
    shouldTrade: true,
    reason: `Sesión operable: ${session.sessionEs}. ${session.description}`,
    adjustedConfidence,
  };
}
