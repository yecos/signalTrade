// AUTO-TRADER ENGINE
// Automated signal generation: Market Data → Indicators → Patterns → Session → Signal
// Runs every X minutes, generates signals, saves to DB, waits for verification
// The goal is to BUILD THE DATASET - even if signals are bad, data is gold

import { db } from './db';
import { getCandles, generateNextCandle, getLatestPrice, ASSET_CONFIGS, generateHistoricalCandles } from './market-data';
import { computeAllIndicators, type IndicatorSnapshot } from './indicators';
import { detectPatterns, getBestPattern, type DetectedPattern, type PatternType, PATTERN_DESCRIPTIONS } from './patterns';
import { detectSession, shouldTradeSession, type SessionInfo, type SessionType } from './sessions';
import { evaluateSignal } from './signals';

// === TYPES ===

export interface AutoTraderConfig {
  enabled: boolean;
  assets: string[];
  timeframe: string;
  intervalMinutes: number;   // how often to check
  minSetupScore: number;     // minimum setup score to generate signal (0-100)
  maxConcurrentSignals: number; // max pending signals at once
  confidenceBoost: number;   // extra confidence from historical edge
  noOperarThreshold: number; // below this confidence → NO_OPERAR
}

export interface AutoTraderState {
  isRunning: boolean;
  lastCheck: Date | null;
  totalGenerated: number;
  totalVerified: number;
  currentPending: number;
  cyclesCompleted: number;
  errors: string[];
  recentSignals: Array<{
    id: string;
    asset: string;
    direction: string;
    pattern: string | null;
    confidence: number;
    setupScore: number | null;
    status: string;
  }>;
}

export interface SignalGenerationResult {
  signalId: string | null;
  direction: string;
  asset: string;
  pattern: PatternType | null;
  session: SessionType;
  confidence: number;
  setupScore: number;
  analysisMode: 'FULL' | 'PARTIAL' | 'FALLBACK';
  reason: string;
  indicators: IndicatorSnapshot | null;
  dataAvailability: Record<string, boolean>;
  skipped: boolean;
  skipReason?: string;
}

// === DEFAULT CONFIG ===

export const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false,
  assets: ['EUR/USD', 'GBP/USD', 'BTC/USD'],
  timeframe: 'M5',
  intervalMinutes: 5,
  minSetupScore: 30,
  maxConcurrentSignals: 10,
  confidenceBoost: 0,
  noOperarThreshold: 40,
};

// === SETUP SCORE CALCULATION ===
// Based on historical performance of this pattern + session + asset combination

export async function calculateSetupScore(
  patternType: PatternType | null,
  asset: string,
  session: SessionType,
  indicators: IndicatorSnapshot
): Promise<{ score: number; sampleSize: number; historicalWinRate: number }> {
  // Query SetupStats for this combination
  const exactMatch = await db.setupStats.findUnique({
    where: {
      patternType_asset_session_timeframe: {
        patternType: patternType || 'none',
        asset,
        session,
        timeframe: 'M5',
      },
    },
  });
  
  // Query broader stats (pattern + session, any asset)
  const broaderMatch = await db.setupStats.findMany({
    where: {
      patternType: patternType || 'none',
      session,
    },
  });
  
  const broaderStats = broaderMatch.reduce(
    (acc, s) => ({
      totalSignals: acc.totalSignals + s.totalSignals,
      wins: acc.wins + s.wins,
      losses: acc.losses + s.losses,
    }),
    { totalSignals: 0, wins: 0, losses: 0 }
  );
  
  // Determine historical win rate and sample size
  let historicalWinRate = 50; // default: no edge info
  let sampleSize = 0;
  
  if (exactMatch && exactMatch.totalSignals >= 5) {
    historicalWinRate = exactMatch.winRate;
    sampleSize = exactMatch.totalSignals;
  } else if (broaderStats.totalSignals >= 10) {
    historicalWinRate = broaderStats.totalSignals > 0 
      ? (broaderStats.wins / broaderStats.totalSignals) * 100 
      : 50;
    sampleSize = broaderStats.totalSignals;
  }
  
  // Calculate setup score (0-100)
  let score = 30; // base score
  
  // Pattern confidence contribution (0-25)
  if (patternType) {
    score += 10; // having a detected pattern is already worth something
  }
  
  // Historical win rate contribution (-20 to +25)
  if (sampleSize >= 10) {
    if (historicalWinRate > 65) score += 25;
    else if (historicalWinRate > 55) score += 15;
    else if (historicalWinRate > 50) score += 5;
    else if (historicalWinRate > 45) score -= 5;
    else score -= 20; // bad edge
  }
  
  // Indicator alignment contribution (0-20)
  const indAlignment = calculateIndicatorAlignment(indicators);
  score += indAlignment;
  
  // Session quality contribution (-5 to +10)
  const sessionInfo = detectSession();
  if (sessionInfo.session === 'Overlap') score += 10;
  else if (sessionInfo.session === 'London') score += 7;
  else if (sessionInfo.session === 'NewYork') score += 5;
  else if (sessionInfo.session === 'Asia') score -= 3;
  else if (sessionInfo.session === 'OffHours') score -= 15;
  
  // Volume confirmation (0-10)
  if (indicators.volumeAnalysis.volumeSpike) score += 10;
  else if (indicators.volumeAnalysis.relativeVolume > 1.5) score += 5;
  else if (indicators.volumeAnalysis.relativeVolume < 0.5) score -= 5;
  
  // Sample size penalty (less data = less reliable)
  if (sampleSize < 30) score -= 10;
  else if (sampleSize < 100) score -= 5;
  
  return {
    score: Math.min(100, Math.max(0, score)),
    sampleSize,
    historicalWinRate: Math.round(historicalWinRate * 10) / 10,
  };
}

// === INDICATOR ALIGNMENT SCORE ===

function calculateIndicatorAlignment(ind: IndicatorSnapshot): number {
  let alignment = 0;
  let count = 0;
  
  // RSI alignment
  if (ind.rsi14 !== null) {
    count++;
    if (ind.rsi14 > 50) alignment += 0.5;
    else alignment -= 0.5;
    if (ind.rsi14 > 60) alignment += 0.5;
    if (ind.rsi14 < 40) alignment -= 0.5;
  }
  
  // MACD alignment
  if (ind.macdHistogram !== null) {
    count++;
    if (ind.macdHistogram > 0) alignment += 1;
    else alignment -= 1;
  }
  
  // Trend alignment (EMA)
  if (ind.ema12 !== null && ind.ema26 !== null) {
    count++;
    if (ind.ema12 > ind.ema26) alignment += 1;
    else alignment -= 1;
  }
  
  // Price vs SMA
  if (ind.sma20 !== null && ind.rsi14 !== null) {
    count++;
    // Price above SMA + bullish = aligned
  }
  
  // Stochastic alignment
  if (ind.stochK !== null && ind.stochD !== null) {
    count++;
    if (ind.stochK > ind.stochD) alignment += 0.5;
    else alignment -= 0.5;
  }
  
  if (count === 0) return 0;
  
  // Normalize to 0-20 range
  const normalized = ((alignment / count) + 1) * 10;
  return Math.min(20, Math.max(0, normalized));
}

// === GENERATE SIGNAL (CORE PIPELINE) ===

export async function generateAutoSignal(
  asset: string,
  timeframe: string = 'M5'
): Promise<SignalGenerationResult> {
  const now = new Date();
  const session = detectSession(now);
  
  // Step 1: Get market data (candles)
  let candles = await getCandles(asset, timeframe, 100);
  
  // If not enough candles, generate them
  if (candles.length < 50) {
    await generateHistoricalCandles(asset, timeframe, 200);
    candles = await getCandles(asset, timeframe, 100);
  }
  
  // Also generate a new candle (advance time)
  await generateNextCandle(asset, timeframe);
  candles = await getCandles(asset, timeframe, 100);
  
  if (candles.length < 30) {
    return {
      signalId: null,
      direction: 'NO_OPERAR',
      asset,
      pattern: null,
      session: session.session,
      confidence: 0,
      setupScore: 0,
      analysisMode: 'FALLBACK',
      reason: `Datos insuficientes: solo ${candles.length} velas disponibles. Mínimo 30 necesarias.`,
      indicators: null,
      dataAvailability: { candles: false, indicators: false, patterns: false, session: true, volume: false },
      skipped: true,
      skipReason: 'INSUFFICIENT_DATA',
    };
  }
  
  // Step 2: Compute indicators
  const indicators = computeAllIndicators(candles);
  
  // Step 3: Detect patterns
  const patterns = detectPatterns(candles, indicators);
  const bestPattern = patterns.length > 0 ? patterns.reduce((a, b) => a.confidence > b.confidence ? a : b) : null;
  
  // Step 4: Determine direction
  let direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR' = 'NO_OPERAR';
  let confidence = 0;
  let reason = '';
  
  if (bestPattern) {
    direction = bestPattern.direction === 'BULLISH' ? 'HIGHER' : 'LOWER';
    confidence = bestPattern.confidence;
    reason = bestPattern.description;
  } else {
    // No pattern detected - use indicator consensus
    const indicatorDirection = getIndicatorDirection(indicators);
    direction = indicatorDirection.direction;
    confidence = indicatorDirection.confidence;
    reason = indicatorDirection.reason;
  }
  
  // Step 5: Calculate setup score
  const { score: setupScore, sampleSize, historicalWinRate } = await calculateSetupScore(
    bestPattern?.type || null,
    asset,
    session.session,
    indicators
  );
  
  // Step 6: Session check
  // DATA COLLECTION MODE: When sample size < 1000, we want to generate signals even in suboptimal sessions
  // because the dataset is the most valuable asset. Only block OffHours.
  const sessionCheck = shouldTradeSession(session, historicalWinRate, sampleSize);
  const isDataCollectionMode = sampleSize < 1000;
  
  if (!sessionCheck.shouldTrade && session.session === 'OffHours') {
    // NEVER trade during off-hours regardless of mode
    direction = 'NO_OPERAR';
    reason = sessionCheck.reason;
    confidence = 0;
  } else if (!sessionCheck.shouldTrade && !isDataCollectionMode) {
    // In production mode (1000+ signals), respect session warnings
    direction = 'NO_OPERAR';
    reason = sessionCheck.reason;
    confidence = 0;
  } else if (!sessionCheck.shouldTrade && isDataCollectionMode) {
    // In data collection mode, generate signal anyway but flag it
    reason += ' [MODO RECOLECCIÓN: Operando en sesión subóptima para recolectar datos]';
  }
  
  // Step 7: Adjust confidence with session and setup score
  confidence = Math.min(100, Math.max(0, confidence + sessionCheck.adjustedConfidence));
  
  // Step 8: Final NO_OPERAR check
  // DATA COLLECTION MODE: When sample size < 1000, we lower the threshold to generate more signals
  // "El dataset es el activo más valioso" - generate signals even if they're bad
  if (isDataCollectionMode) {
    // In data collection mode: only NO_OPERAR if we truly have no direction
    if (direction === 'NO_OPERAR' || (!bestPattern && confidence < 15)) {
      const noOperarReasons: string[] = [];
      if (!bestPattern) noOperarReasons.push('Sin patrón detectado');
      if (confidence < 15) noOperarReasons.push(`Sin dirección clara: ${confidence.toFixed(0)}%`);
      direction = 'NO_OPERAR';
      reason = `NO OPERAR [MODO RECOLECCIÓN]: ${noOperarReasons.join('. ')}. Sin suficiente señal para determinar dirección.`;
    }
    // If we have ANY direction from patterns or indicators, generate the signal
    // Tag it with data collection note
    if (direction !== 'NO_OPERAR' && confidence < 40) {
      reason += ` [MODO RECOLECCIÓN: Confianza baja (${confidence.toFixed(0)}%) pero generando señal para construir dataset]`;
    }
  } else {
    // Production mode: stricter filtering
    if (confidence < 40 || setupScore < 25) {
      const noOperarReasons: string[] = [];
      if (confidence < 40) noOperarReasons.push(`Confianza baja: ${confidence.toFixed(0)}%`);
      if (setupScore < 25) noOperarReasons.push(`Setup score bajo: ${setupScore.toFixed(0)}`);
      direction = 'NO_OPERAR';
      reason = `NO OPERAR: ${noOperarReasons.join('. ')}. Es mejor no operar que operar sin edge.`;
      confidence = Math.max(confidence, setupScore * 0.3);
    }
  }
  
  // Step 9: Determine analysis mode
  const dataAvailability: Record<string, boolean> = {
    candles: candles.length >= 50,
    indicators: indicators.rsi14 !== null,
    patterns: bestPattern !== null,
    session: true,
    volume: indicators.volumeAnalysis.avgVolume20 > 0,
  };
  
  const availableCount = Object.values(dataAvailability).filter(Boolean).length;
  const analysisMode: 'FULL' | 'PARTIAL' | 'FALLBACK' = 
    availableCount >= 4 ? 'FULL' : availableCount >= 3 ? 'PARTIAL' : 'FALLBACK';
  
  // Step 10: Determine statistical reliability
  const statisticalReliability = 
    sampleSize >= 500 ? 'HIGH' : 
    sampleSize >= 100 ? 'MEDIUM' : 
    sampleSize >= 30 ? 'LOW' : 'INSUFFICIENT';
  
  // Step 11: Get entry price
  const entryPrice = candles[candles.length - 1].close;
  
  // Step 12: Determine expiration
  const tfMinutes = { 'M1': 1, 'M5': 5, 'M15': 15, 'M30': 30, 'H1': 60 }[timeframe] || 5;
  const expirationMinutes = tfMinutes * 2; // 2 candles = expiration
  
  // Step 13: Save signal to database
  const signalData = {
    asset,
    timeframe,
    direction,
    entryPrice,
    entryTime: now,
    expirationMinutes,
    expirationTime: new Date(now.getTime() + expirationMinutes * 60 * 1000),
    confidence,
    aiReason: reason,
    patternType: bestPattern?.type || null,
    sessionType: session.session,
    setupScore,
    source: 'AUTO',
    analysisMode,
    dataAvailability: JSON.stringify(dataAvailability),
    statisticalReliability,
    historicalSampleSize: sampleSize,
    indicatorsJson: JSON.stringify(indicators),
    technicalJson: JSON.stringify({
      trend: indicators.trend,
      momentum: indicators.momentum,
      volatilityLevel: indicators.volatilityLevel,
    }),
    patternsJson: JSON.stringify(patterns.map(p => ({
      type: p.type,
      direction: p.direction,
      confidence: p.confidence,
      description: p.description,
    }))),
    volumeJson: JSON.stringify(indicators.volumeAnalysis),
    noOperarReason: direction === 'NO_OPERAR' ? reason : null,
    verificationMethod: 'SIMULATED',
  };
  
  const signal = await db.signal.create({ data: signalData });
  
  return {
    signalId: signal.id,
    direction,
    asset,
    pattern: bestPattern?.type || null,
    session: session.session,
    confidence,
    setupScore,
    analysisMode,
    reason,
    indicators,
    dataAvailability,
    skipped: direction === 'NO_OPERAR',
    skipReason: direction === 'NO_OPERAR' ? reason : undefined,
  };
}

// === INDICATOR-BASED DIRECTION (fallback when no pattern detected) ===

function getIndicatorDirection(ind: IndicatorSnapshot): { direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR'; confidence: number; reason: string } {
  let bullish = 0;
  let bearish = 0;
  let total = 0;
  
  if (ind.rsi14 !== null) {
    total++;
    if (ind.rsi14 > 55) bullish += 0.5;
    else if (ind.rsi14 < 45) bearish += 0.5;
    if (ind.rsi14 > 60) bullish += 0.5;
    if (ind.rsi14 < 40) bearish += 0.5;
  }
  
  if (ind.macdHistogram !== null) {
    total++;
    if (ind.macdHistogram > 0) bullish += 1;
    else bearish += 1;
  }
  
  if (ind.ema12 !== null && ind.ema26 !== null) {
    total++;
    if (ind.ema12 > ind.ema26) bullish += 1;
    else bearish += 1;
  }
  
  if (ind.trend !== 'RANGING') {
    total++;
    if (ind.trend === 'BULLISH') bullish += 1;
    else bearish += 1;
  }
  
  if (ind.stochK !== null) {
    total++;
    if (ind.stochK > 50) bullish += 0.5;
    else bearish += 0.5;
  }
  
  if (total === 0) {
    return { direction: 'NO_OPERAR', confidence: 0, reason: 'Sin indicadores suficientes para determinar dirección.' };
  }
  
  const balance = bullish - bearish;
  
  if (Math.abs(balance) < 0.5) {
    return { 
      direction: 'NO_OPERAR', 
      confidence: 20, 
      reason: `Indicadores sin consenso claro: ${bullish.toFixed(1)} alcista vs ${bearish.toFixed(1)} bajista. Mercado lateral.` 
    };
  }
  
  const direction: 'HIGHER' | 'LOWER' = balance > 0 ? 'HIGHER' : 'LOWER';
  const confidence = Math.min(70, 25 + Math.abs(balance) * 15);
  
  return {
    direction,
    confidence,
    reason: `Decisión por indicadores: ${direction === 'HIGHER' ? 'Alcista' : 'Bajista'} (${bullish.toFixed(1)} vs ${bearish.toFixed(1)}). Sin patrón claro detectado.`,
  };
}

// === UPDATE SETUP STATS ===
// Called after a signal is verified (WIN/LOSS)

export async function updateSetupStats(signal: {
  patternType: string | null;
  asset: string;
  sessionType: string | null;
  timeframe: string;
  result: string;
  confidence: number;
  setupScore: number | null;
}): Promise<void> {
  if (!signal.result || signal.result === 'NO_OPERAR' || signal.result === 'DRAW') return;
  
  const patternType = signal.patternType || 'none';
  const session = signal.sessionType || 'OffHours';
  
  // Update exact match stats
  try {
    const existing = await db.setupStats.findUnique({
      where: {
        patternType_asset_session_timeframe: {
          patternType,
          asset: signal.asset,
          session,
          timeframe: signal.timeframe,
        },
      },
    });
    
    if (existing) {
      const newWins = existing.wins + (signal.result === 'WIN' ? 1 : 0);
      const newLosses = existing.losses + (signal.result === 'LOSS' ? 1 : 0);
      const newTotal = existing.totalSignals + 1;
      const newWinRate = newTotal > 0 ? (newWins / newTotal) * 100 : 0;
      const newAvgConf = (existing.avgConfidence * existing.totalSignals + signal.confidence) / newTotal;
      const newAvgSetup = signal.setupScore 
        ? (existing.avgSetupScore * existing.totalSignals + signal.setupScore) / newTotal 
        : existing.avgSetupScore;
      
      await db.setupStats.update({
        where: { id: existing.id },
        data: {
          totalSignals: newTotal,
          wins: newWins,
          losses: newLosses,
          winRate: newWinRate,
          avgConfidence: newAvgConf,
          avgSetupScore: newAvgSetup,
        },
      });
    } else {
      await db.setupStats.create({
        data: {
          patternType,
          asset: signal.asset,
          session,
          timeframe: signal.timeframe,
          totalSignals: 1,
          wins: signal.result === 'WIN' ? 1 : 0,
          losses: signal.result === 'LOSS' ? 1 : 0,
          winRate: signal.result === 'WIN' ? 100 : 0,
          avgConfidence: signal.confidence,
          avgSetupScore: signal.setupScore || 0,
        },
      });
    }
  } catch (e) {
    // Unique constraint might fail for concurrent writes, that's OK
    console.error('Error updating setup stats:', e);
  }
}

// === GET AUTO-TRADER STATE ===

export async function getAutoTraderState(): Promise<AutoTraderState> {
  const pendingSignals = await db.signal.findMany({
    where: { status: 'PENDING', source: 'AUTO' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  
  const totalGenerated = await db.signal.count({ where: { source: 'AUTO' } });
  const totalVerified = await db.signal.count({ where: { source: 'AUTO', status: 'CLOSED' } });
  
  const recentSignals = await db.signal.findMany({
    where: { source: 'AUTO' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      asset: true,
      direction: true,
      patternType: true,
      confidence: true,
      setupScore: true,
      status: true,
    },
  });
  
  // Get running state from AppSettings
  const runningSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderRunning' } });
  const lastCheckSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderLastCheck' } });
  
  return {
    isRunning: runningSetting?.value === 'true',
    lastCheck: lastCheckSetting ? new Date(lastCheckSetting.value) : null,
    totalGenerated,
    totalVerified,
    currentPending: pendingSignals.length,
    cyclesCompleted: totalVerified,
    errors: [],
    recentSignals: recentSignals.map(s => ({
      id: s.id,
      asset: s.asset,
      direction: s.direction,
      pattern: s.patternType,
      confidence: s.confidence,
      setupScore: s.setupScore,
      status: s.status,
    })),
  };
}

// === RUN AUTO-TRADER CYCLE ===
// Called by the cron service

export async function runAutoTraderCycle(config?: Partial<AutoTraderConfig>): Promise<{
  signalsGenerated: number;
  signalsSkipped: number;
  errors: string[];
  results: SignalGenerationResult[];
}> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const results: SignalGenerationResult[] = [];
  let signalsGenerated = 0;
  let signalsSkipped = 0;
  const errors: string[] = [];
  
  // Check max concurrent signals
  const pendingCount = await db.signal.count({
    where: { status: 'PENDING', source: 'AUTO' },
  });
  
  if (pendingCount >= cfg.maxConcurrentSignals) {
    return {
      signalsGenerated: 0,
      signalsSkipped: cfg.assets.length,
      errors: [`Máximo de señales pendientes alcanzado: ${pendingCount}/${cfg.maxConcurrentSignals}`],
      results: [],
    };
  }
  
  // Process each asset
  for (const asset of cfg.assets) {
    try {
      const result = await generateAutoSignal(asset, cfg.timeframe);
      results.push(result);
      
      if (result.skipped) {
        signalsSkipped++;
      } else {
        signalsGenerated++;
      }
      
      // Update last check time
      await db.appSettings.upsert({
        where: { key: 'autoTraderLastCheck' },
        create: { key: 'autoTraderLastCheck', value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      });
    } catch (error: any) {
      errors.push(`${asset}: ${error.message}`);
    }
  }
  
  return { signalsGenerated, signalsSkipped, errors, results };
}

// === GET SETUP SCORES (for dashboard) ===

export async function getSetupScores(): Promise<Array<{
  patternType: string;
  asset: string | null;
  session: string | null;
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgSetupScore: number;
  avgConfidence: number;
  edge: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNKNOWN';
  sampleAdequacy: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';
}>> {
  const stats = await db.setupStats.findMany({
    orderBy: { winRate: 'desc' },
  });
  
  return stats.map(s => {
    const decisive = s.wins + s.losses;
    const edge: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNKNOWN' = 
      decisive < 10 ? 'UNKNOWN' :
      s.winRate > 55 ? 'POSITIVE' :
      s.winRate < 45 ? 'NEGATIVE' : 'NEUTRAL';
    
    const sampleAdequacy: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH' = 
      s.totalSignals < 30 ? 'INSUFFICIENT' :
      s.totalSignals < 100 ? 'LOW' :
      s.totalSignals < 500 ? 'MEDIUM' : 'HIGH';
    
    return {
      patternType: s.patternType,
      asset: s.asset,
      session: s.session,
      totalSignals: s.totalSignals,
      wins: s.wins,
      losses: s.losses,
      winRate: Math.round(s.winRate * 10) / 10,
      avgSetupScore: Math.round(s.avgSetupScore * 10) / 10,
      avgConfidence: Math.round(s.avgConfidence * 10) / 10,
      edge,
      sampleAdequacy,
    };
  });
}
