// AUTO-TRADER ENGINE v3 — Full Statistical Pipeline + Multi-Timeframe Confluence
// Market Data → Indicators → Patterns → Session → Regime → MTF → Features → Quality → Bayesian → Expectancy → Signal
// The goal is to BUILD THE DATASET with maximum feature richness for later analysis
// "La ventaja NO sale de usar IA. Sale de datos buenos + patrones medibles + muchas muestras + estadística real."

import { db } from './db';
import { getCandles as getEngineCandles, getLatestPrice as getEnginePrice, getAnalysisMode } from './market-engine';
import { getCandles as getDBCandles, generateNextCandle, ASSET_CONFIGS, generateHistoricalCandles } from './market-data';
import { computeAllIndicators, type IndicatorSnapshot } from './indicators';
import { detectPatterns, getBestPattern, type DetectedPattern, type PatternType, PATTERN_DESCRIPTIONS } from './patterns';
import { detectSession, shouldTradeSession, type SessionInfo, type SessionType } from './sessions';
import { evaluateSignal } from './signals';
import { detectRegime, type MarketRegime, type RegimeResult, shouldTradeInRegime, getRegimePatternCompat } from './regime-engine';
import { computeSignalFeatures, type SignalFeatures } from './feature-engineering';
import { checkQuality, quickQualityScore, toQualityFeatures, type QualityResult, type QualityFlag } from './quality-filter';
import { calculateBayesianStats, quickBayesianWR } from './bayesian-engine';
import { quickEV, estimateExpectancyFromStats, type ExpectancyResult } from './expectancy-engine';
import { quickMTFScore, type MTFConfluence } from './mtf-analysis';

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
  analysisMode: 'FULL' | 'PARTIAL' | 'FALLBACK' | 'DEMO';
  reason: string;
  indicators: IndicatorSnapshot | null;
  dataAvailability: Record<string, boolean>;
  dataSource: 'BINANCE' | 'TWELVEDATA' | 'FALLBACK';
  skipped: boolean;
  skipReason?: string;
  // === NEW: Phase 4 fields ===
  regime: MarketRegime | null;
  regimeConfidence: number;
  features: SignalFeatures | null;
  qualityScore: number;
  qualityFlags: QualityFlag[];
  qualityBlocked: boolean;
  bayesianWR: number;
  expectancy: number;
  riskReward: number;
  adjustedWR: number;
  // === NEW: Phase 5 MTF fields ===
  mtfConfluence: MTFConfluence | null;
  mtfScore: number;
  mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  h1Filter: 'PASS' | 'FAIL' | 'NO_DATA';
  h4Filter: 'PASS' | 'FAIL' | 'NO_DATA';
  entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DANGEROUS';
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

// === GENERATE SIGNAL (CORE PIPELINE v3) ===
// Full pipeline: Market → Indicators → Patterns → Session → Regime → MTF → Features → Quality → Bayesian → Signal

export async function generateAutoSignal(
  asset: string,
  timeframe: string = 'M5'
): Promise<SignalGenerationResult> {
  const now = new Date();
  const session = detectSession(now);

  // Default new fields
  let regimeResult: RegimeResult | null = null;
  let features: SignalFeatures | null = null;
  let qualityResult: QualityResult | null = null;
  let bayesianWR = 50;
  let expectancy = 0;
  let riskReward = 1;
  let adjustedWR = 50;

  // === NEW Phase 5: MTF fields ===
  let mtfConfluence: MTFConfluence | null = null;
  let mtfScore = 0;
  let mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  let h1Filter: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
  let h4Filter: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
  let entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DANGEROUS' = 'FAIR';
  
  // Step 1: Get market data - try REAL market engine first, then fall back to DB
  let candles: any[] = [];
  let dataSource: 'BINANCE' | 'TWELVEDATA' | 'FALLBACK' = 'FALLBACK';
  
  // Try real market engine (Binance for crypto, TwelveData for forex)
  try {
    const engineResult = await getEngineCandles(asset, timeframe, 100);
    if (engineResult.candles.length >= 30) {
      candles = engineResult.candles;
      dataSource = engineResult.source as any;
    }
  } catch (err) {
    console.error('Market engine failed, falling back to DB:', err);
  }
  
  // If real data not available, use DB/simulated candles
  if (candles.length < 50) {
    const dbCandles = await getDBCandles(asset, timeframe, 100);
    if (dbCandles.length >= 30) {
      candles = dbCandles;
      dataSource = 'FALLBACK';
    } else {
      // Generate candles as last resort
      await generateHistoricalCandles(asset, timeframe, 200);
      candles = await getDBCandles(asset, timeframe, 100);
      dataSource = 'FALLBACK';
    }
  }
  
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
      dataAvailability: { candles: false, indicators: false, patterns: false, session: true, volume: false, realMarketData: false },
      dataSource,
      skipped: true,
      skipReason: 'INSUFFICIENT_DATA',
      regime: null, regimeConfidence: 0, features: null,
      qualityScore: 0, qualityFlags: ['INSUFFICIENT_DATA'], qualityBlocked: true,
      bayesianWR: 50, expectancy: 0, riskReward: 1, adjustedWR: 50,
    };
  }
  
  // Step 2: Compute indicators
  const indicators = computeAllIndicators(candles);
  
  // Step 3: Detect patterns
  const patterns = detectPatterns(candles, indicators);
  const bestPattern = patterns.length > 0 ? patterns.reduce((a, b) => a.confidence > b.confidence ? a : b) : null;
  
  // === NEW Step 3.5: Detect market regime ===
  regimeResult = detectRegime(candles, indicators);
  const regimeAdvice = shouldTradeInRegime(regimeResult.regime);
  
  // Check regime-pattern compatibility
  const patternCompat = getRegimePatternCompat(regimeResult.regime);
  const regimeMismatch = bestPattern && patternCompat.avoid.includes(bestPattern.type);
  
  // === NEW Step 3.6: Compute signal features (20+ variables) ===
  features = computeSignalFeatures(candles, indicators, regimeResult, session);

  // === NEW Step 3.7: Multi-Timeframe Analysis ===
  try {
    // Fetch higher timeframe candles from DB
    const m15Candles = await getDBCandles(asset, 'M15', 100);
    const h1Candles = await getDBCandles(asset, 'H1', 100);
    const h4Candles = await getDBCandles(asset, 'H4', 100);

    // Also try engine for higher timeframes if DB is empty
    let m15Final = m15Candles;
    let h1Final = h1Candles;
    let h4Final = h4Candles;

    if (m15Final.length < 50) {
      try {
        const engineM15 = await getEngineCandles(asset, 'M15', 100);
        if (engineM15.candles.length >= 30) m15Final = engineM15.candles;
      } catch { /* skip */ }
    }
    if (h1Final.length < 50) {
      try {
        const engineH1 = await getEngineCandles(asset, 'H1', 100);
        if (engineH1.candles.length >= 30) h1Final = engineH1.candles;
      } catch { /* skip */ }
    }
    if (h4Final.length < 50) {
      try {
        const engineH4 = await getEngineCandles(asset, 'H4', 100);
        if (engineH4.candles.length >= 30) h4Final = engineH4.candles;
      } catch { /* skip */ }
    }

    const mtfResult = quickMTFScore(candles, m15Final, h1Final, h4Final);
    mtfConfluence = mtfResult.confluence;
    mtfScore = mtfResult.score;
    mtfDirection = mtfResult.confluence.overallDirection;
    h1Filter = mtfResult.confluence.h1Filter;
    h4Filter = mtfResult.confluence.h4Filter;
    entryQuality = mtfResult.confluence.entryQuality;
  } catch (err: any) {
    // MTF analysis is best-effort — don't block signal generation
    console.error('MTF analysis failed:', err.message);
  }
  
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
  
  // === NEW Step 5.5: Bayesian adjustment ===
  if (sampleSize >= 5) {
    const bayes = calculateBayesianStats(
      Math.round(historicalWinRate / 100 * sampleSize),
      Math.round((100 - historicalWinRate) / 100 * sampleSize)
    );
    bayesianWR = bayes.bayesianWinRate;
    adjustedWR = bayes.bayesianWinRate;
  }
  
  // === NEW Step 5.6: Expectancy calculation ===
  const expectancyResult = estimateExpectancyFromStats(historicalWinRate, sampleSize, setupScore);
  expectancy = expectancyResult.expectancyPerTrade;
  riskReward = expectancyResult.riskRewardRatio;
  
  // === NEW Step 5.7: Quality filter ===
  const qualityFeatures = features ? toQualityFeatures(features, asset) : {
    relativeVolume: indicators.volumeAnalysis.relativeVolume,
    volumeSpike: indicators.volumeAnalysis.volumeSpike,
    atr: indicators.atr14,
    atrPercentile: 50,
    avgATR: indicators.atr14,
    candleRange: 0.001,
    spreadEstimate: 0.001,
    assetType: (asset.includes('BTC') || asset.includes('ETH') ? 'crypto' : 'forex') as 'forex' | 'crypto',
  };
  qualityResult = checkQuality({
    candles,
    indicators,
    regime: { regime: regimeResult.regime, confidence: regimeResult.confidence },
    sessionInfo: { session: session.session, shouldTrade: session.session !== 'OffHours' },
    setupStats: sampleSize >= 5 ? { winRate: historicalWinRate, sampleSize } : null,
    patternType: bestPattern?.type || null,
    features: qualityFeatures,
  });
  
  // Step 6: Session check
  const sessionCheck = shouldTradeSession(session, historicalWinRate, sampleSize);
  const isDataCollectionMode = sampleSize < 1000;
  
  if (!sessionCheck.shouldTrade && session.session === 'OffHours') {
    direction = 'NO_OPERAR';
    reason = sessionCheck.reason;
    confidence = 0;
  } else if (!sessionCheck.shouldTrade && !isDataCollectionMode) {
    direction = 'NO_OPERAR';
    reason = sessionCheck.reason;
    confidence = 0;
  } else if (!sessionCheck.shouldTrade && isDataCollectionMode) {
    reason += ' [MODO RECOLECCIÓN: Sesión subóptima]';
  }
  
  // === NEW Step 6.5: Quality block check ===
  // In data collection mode, we still generate signals even with quality issues
  // But we flag them. In production mode, quality blocks are enforced.
  if (qualityResult.isBlocked && !isDataCollectionMode) {
    direction = 'NO_OPERAR';
    reason = qualityResult.blockReason || 'Señal bloqueada por filtro de calidad';
    confidence = 0;
  } else if (qualityResult.isBlocked && isDataCollectionMode) {
    reason += ` [MODO RECOLECCIÓN: Calidad baja (${qualityResult.score}/100) pero generando para dataset]`;
  }
  
  // === NEW Step 6.6: Regime mismatch warning ===
  if (regimeMismatch && !isDataCollectionMode) {
    // In production mode, regime mismatch → NO_OPERAR
    direction = 'NO_OPERAR';
    reason = `Patrón ${bestPattern?.type} no compatible con régimen ${regimeResult.regime}. ${regimeAdvice.reason}`;
    confidence = Math.min(confidence, 20);
  } else if (regimeMismatch && isDataCollectionMode) {
    reason += ` [RÉGimen: ${regimeResult.regime} - Patrón no óptimo pero generando para dataset]`;
  }

  // === NEW Step 6.7: Multi-Timeframe filter ===
  if (mtfConfluence && direction !== 'NO_OPERAR') {
    // MTF direction conflict: signal direction opposes higher TF trend
    const mtfOpposesSignal = (
      (direction === 'HIGHER' && mtfDirection === 'BEARISH') ||
      (direction === 'LOWER' && mtfDirection === 'BULLISH')
    );

    if (mtfOpposesSignal && !isDataCollectionMode) {
      // Production: block if H4 or H1 strongly oppose
      if (h4Filter === 'FAIL' || (h1Filter === 'FAIL' && mtfScore < 30)) {
        direction = 'NO_OPERAR';
        reason = `MTF CONTRA: H4=${h4Filter}, H1=${h1Filter}, confluencia ${mtfScore}%. Señal ${direction} opuesta a tendencia multi-timeframe.`;
        confidence = Math.min(confidence, 15);
      }
    } else if (mtfOpposesSignal && isDataCollectionMode) {
      reason += ` [MTF: Confluencia ${mtfScore}% en contra pero generando para dataset]`;
      confidence = Math.max(0, confidence - 10);
    }

    // Boost confidence for strong MTF alignment
    if (!mtfOpposesSignal && mtfScore >= 70) {
      confidence = Math.min(100, confidence + 10);
      reason += ` [MTF: +10 confianza por alta confluencia ${mtfScore}%]`;
    } else if (!mtfOpposesSignal && mtfScore >= 50) {
      confidence = Math.min(100, confidence + 5);
    }

    // DANGEROUS entry quality → reduce confidence heavily
    if (entryQuality === 'DANGEROUS' && !isDataCollectionMode) {
      direction = 'NO_OPERAR';
      reason = `MTF: Entrada DANGEROUS. H4=${h4Filter}, H1=${h1Filter}, confluencia ${mtfScore}%. No operar contra timeframes superiores.`;
      confidence = Math.min(confidence, 10);
    } else if (entryQuality === 'POOR') {
      confidence = Math.max(0, confidence - 15);
      reason += ` [MTF: Entrada POOR, -15 confianza]`;
    }
  }
  
  // Step 7: Adjust confidence with session and setup score
  confidence = Math.min(100, Math.max(0, confidence + sessionCheck.adjustedConfidence));
  
  // Adjust confidence with regime
  if (regimeResult.regime === 'TRENDING' && bestPattern?.type === 'trend_continuation') {
    confidence = Math.min(100, confidence + 5);
  } else if (regimeResult.regime === 'RANGING' && (bestPattern?.type === 'reversal' || bestPattern?.type === 'fakeout')) {
    confidence = Math.min(100, confidence + 5);
  } else if (regimeResult.regime === 'LOW_VOL') {
    confidence = Math.max(0, confidence - 10);
  } else if (regimeResult.regime === 'NEWS') {
    confidence = Math.max(0, confidence - 5);
  }
  
  // Step 8: Final NO_OPERAR check
  if (isDataCollectionMode) {
    if (direction === 'NO_OPERAR' || (!bestPattern && confidence < 15)) {
      const noOperarReasons: string[] = [];
      if (!bestPattern) noOperarReasons.push('Sin patrón detectado');
      if (confidence < 15) noOperarReasons.push(`Sin dirección clara: ${confidence.toFixed(0)}%`);
      direction = 'NO_OPERAR';
      reason = `NO OPERAR [MODO RECOLECCIÓN]: ${noOperarReasons.join('. ')}. Sin suficiente señal para determinar dirección.`;
    }
    if (direction !== 'NO_OPERAR' && confidence < 40) {
      reason += ` [MODO RECOLECCIÓN: Confianza baja (${confidence.toFixed(0)}%) pero generando señal para construir dataset]`;
    }
  } else {
    // Production mode: stricter filtering using Bayesian WR + Expectancy
    if (confidence < 40 || setupScore < 25 || (bayesianWR < 48 && sampleSize >= 30) || (expectancy < 0 && sampleSize >= 50)) {
      const noOperarReasons: string[] = [];
      if (confidence < 40) noOperarReasons.push(`Confianza baja: ${confidence.toFixed(0)}%`);
      if (setupScore < 25) noOperarReasons.push(`Setup score bajo: ${setupScore.toFixed(0)}`);
      if (bayesianWR < 48 && sampleSize >= 30) noOperarReasons.push(`WR bayesiana baja: ${bayesianWR.toFixed(1)}%`);
      if (expectancy < 0 && sampleSize >= 50) noOperarReasons.push(`EV negativo: ${expectancy.toFixed(2)}R`);
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
    realMarketData: dataSource === 'BINANCE' || dataSource === 'TWELVEDATA',
    regime: regimeResult.regime !== 'RANGING' || regimeResult.confidence > 30,
    quality: qualityResult.score >= 50,
  };
  
  const availableCount = Object.values(dataAvailability).filter(Boolean).length;
  
  let analysisMode: 'FULL' | 'PARTIAL' | 'FALLBACK' | 'DEMO';
  if (dataSource === 'BINANCE' || dataSource === 'TWELVEDATA') {
    analysisMode = availableCount >= 6 ? 'FULL' : 'PARTIAL';
  } else if (dataSource === 'FALLBACK') {
    analysisMode = 'FALLBACK';
  } else {
    analysisMode = 'DEMO';
  }
  
  // Step 10: Statistical reliability
  const statisticalReliability = 
    sampleSize >= 500 ? 'HIGH' : 
    sampleSize >= 100 ? 'MEDIUM' : 
    sampleSize >= 30 ? 'LOW' : 'INSUFFICIENT';
  
  // Step 11: Get entry price
  const entryPrice = candles[candles.length - 1].close;
  
  // Step 12: Determine expiration
  const tfMinutes = { 'M1': 1, 'M5': 5, 'M15': 15, 'M30': 30, 'H1': 60 }[timeframe] || 5;
  const expirationMinutes = tfMinutes * 2;
  
  // === NEW Step 12.5: Calculate risk/reward from pattern key levels ===
  let calculatedRR = riskReward;
  if (bestPattern?.keyLevels) {
    const entry = bestPattern.keyLevels.entry;
    const sl = bestPattern.keyLevels.stopLoss;
    const tp = bestPattern.keyLevels.takeProfit;
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    if (risk > 0) calculatedRR = reward / risk;
  }
  
  // === NEW Step 12.6: Bayesian confidence interval ===
  let confidenceInterval: { lower: number; upper: number } | null = null;
  let pValue = 1;
  let sampleVariance = 0;
  if (sampleSize >= 5) {
    const bayes = calculateBayesianStats(
      Math.round(historicalWinRate / 100 * sampleSize),
      Math.round((100 - historicalWinRate) / 100 * sampleSize)
    );
    confidenceInterval = bayes.confidenceInterval;
    pValue = bayes.pValue;
    sampleVariance = bayes.sampleVariance;
  }
  
  // Step 13: Save signal to database with ALL new fields
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
    // === NEW Phase 4 fields ===
    marketRegime: regimeResult.regime,
    featuresJson: JSON.stringify(features),
    expectancy,
    riskReward: calculatedRR,
    adjustedWinRate: adjustedWR,
    confidenceInterval: confidenceInterval ? JSON.stringify(confidenceInterval) : null,
    pValue,
    sampleVariance,
    qualityScore: qualityResult.score,
    qualityFlags: JSON.stringify(qualityResult.flags),
    // === NEW Phase 5: MTF fields ===
    mtfConfluence: mtfScore,
    mtfDirection,
    h1Filter,
    h4Filter,
    entryQuality,
    mtfJson: mtfConfluence ? JSON.stringify({
      confluenceScore: mtfConfluence.confluenceScore,
      timeframeAlignments: mtfConfluence.timeframeAlignments,
      totalTimeframes: mtfConfluence.totalTimeframes,
      overallDirection: mtfConfluence.overallDirection,
      entryQuality: mtfConfluence.entryQuality,
      riskLevel: mtfConfluence.riskLevel,
      h4KeyLevel: mtfConfluence.h4KeyLevel,
      h1KeyLevel: mtfConfluence.h1KeyLevel,
      dominantRegime: mtfConfluence.dominantRegime,
      analyses: Object.fromEntries(
        Object.entries(mtfConfluence.analyses).map(([k, v]) => [k, v ? {
          trend: v.trend,
          trendStrength: v.trendStrength,
          momentum: v.momentum,
          structureType: v.structureType,
          volumeContext: v.volumeContext,
          regime: v.regime.regime,
          keyLevel: v.keyLevel,
        } : null])
      ),
    }) : null,
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
    dataSource,
    skipped: direction === 'NO_OPERAR',
    skipReason: direction === 'NO_OPERAR' ? reason : undefined,
    // New fields
    regime: regimeResult.regime,
    regimeConfidence: regimeResult.confidence,
    features,
    qualityScore: qualityResult.score,
    qualityFlags: qualityResult.flags,
    qualityBlocked: qualityResult.isBlocked,
    bayesianWR,
    expectancy,
    riskReward: calculatedRR,
    adjustedWR,
    // MTF fields
    mtfConfluence,
    mtfScore,
    mtfDirection,
    h1Filter,
    h4Filter,
    entryQuality,
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
  expectancy?: number | null;
  riskReward?: number | null;
  qualityScore?: number | null;
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
      
      // === NEW: Bayesian stats update ===
      const bayes = calculateBayesianStats(newWins, newLosses);
      
      // Running average for expectancy, risk/reward, quality
      const newAvgExpectancy = signal.expectancy != null
        ? (existing.avgExpectancy * existing.totalSignals + signal.expectancy) / newTotal
        : existing.avgExpectancy;
      const newAvgRR = signal.riskReward != null
        ? (existing.avgRiskReward * existing.totalSignals + signal.riskReward) / newTotal
        : existing.avgRiskReward;
      const newAvgQuality = signal.qualityScore != null
        ? (existing.avgQualityScore * existing.totalSignals + signal.qualityScore) / newTotal
        : existing.avgQualityScore;
      
      await db.setupStats.update({
        where: { id: existing.id },
        data: {
          totalSignals: newTotal,
          wins: newWins,
          losses: newLosses,
          winRate: newWinRate,
          avgConfidence: newAvgConf,
          avgSetupScore: newAvgSetup,
          // Bayesian fields
          bayesianWinRate: bayes.bayesianWinRate,
          confidenceIntervalLower: bayes.confidenceInterval.lower,
          confidenceIntervalUpper: bayes.confidenceInterval.upper,
          pValue: bayes.pValue,
          sampleVariance: bayes.sampleVariance,
          // Expectancy fields
          avgExpectancy: newAvgExpectancy,
          avgRiskReward: newAvgRR,
          avgQualityScore: newAvgQuality,
        },
      });
    } else {
      // Create new stats entry with Bayesian fields
      const bayes = calculateBayesianStats(
        signal.result === 'WIN' ? 1 : 0,
        signal.result === 'LOSS' ? 1 : 0
      );
      
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
          // Bayesian fields
          bayesianWinRate: bayes.bayesianWinRate,
          confidenceIntervalLower: bayes.confidenceInterval.lower,
          confidenceIntervalUpper: bayes.confidenceInterval.upper,
          pValue: bayes.pValue,
          sampleVariance: bayes.sampleVariance,
          // Expectancy fields
          avgExpectancy: signal.expectancy || 0,
          avgRiskReward: signal.riskReward || 0,
          avgQualityScore: signal.qualityScore || 0,
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
  // === NEW Phase 4 fields ===
  bayesianWinRate: number;
  confidenceIntervalLower: number;
  confidenceIntervalUpper: number;
  pValue: number;
  avgExpectancy: number;
  avgRiskReward: number;
  avgQualityScore: number;
}>> {
  const stats = await db.setupStats.findMany({
    orderBy: { winRate: 'desc' },
  });
  
  return stats.map(s => {
    const decisive = s.wins + s.losses;
    // Use Bayesian WR for edge determination when available
    const wrForEdge = s.bayesianWinRate > 0 ? s.bayesianWinRate : s.winRate;
    const edge: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNKNOWN' = 
      decisive < 10 ? 'UNKNOWN' :
      wrForEdge > 55 ? 'POSITIVE' :
      wrForEdge < 45 ? 'NEGATIVE' : 'NEUTRAL';
    
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
      // New fields
      bayesianWinRate: Math.round(s.bayesianWinRate * 10) / 10,
      confidenceIntervalLower: Math.round(s.confidenceIntervalLower * 10) / 10,
      confidenceIntervalUpper: Math.round(s.confidenceIntervalUpper * 10) / 10,
      pValue: Math.round(s.pValue * 10000) / 10000,
      avgExpectancy: Math.round(s.avgExpectancy * 1000) / 1000,
      avgRiskReward: Math.round(s.avgRiskReward * 10) / 10,
      avgQualityScore: Math.round(s.avgQualityScore * 10) / 10,
    };
  });
}
