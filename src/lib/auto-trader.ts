// AUTO-TRADER ENGINE v6 — 3-System Architecture: NoTrade → Confluence → TradeManagement
// Pipeline: Market Data → Indicators → Patterns → Session → NoTrade Filter → Regime → MTF →
//           Confluence Score → Setup Contextualizado → Trade Management → Signal
// The goal is to ONLY TRADE when ALL conditions are favorable.
// "La ventaja NO sale de usar IA. Sale de datos buenos + patrones medibles + muchas muestras + estadística real."
// v6: 3-System Architecture:
//     1. NO-TRADE SYSTEM: Filtros de riesgo sistémico, regímenes, noticias, liquidez
//     2. CONFLUENCE ENGINE: Score multi-factor + setup contextualizado
//     3. TRADE MANAGER: Sizing automático ATR, gestión dinámica, alertas de cierre
//     Previous systems (Proven Edge, Edge Profile, Bayesian) are still used as inputs.

import { db, withRetry } from './db';
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
import { getEdgeDecision, type EdgeClassification, type EdgeDecision, invalidateEdgeProfileCache } from './edge-profile';
import { checkProvenEdge, type EdgeTier, type ProvenEdge, getBlockedPatterns } from './proven-edges';
import { assessNoTrade, type NoTradeAssessment } from './no-trade-system';
import { assessConfluence, type ConfluenceResult, type ContextualizedSetup } from './confluence-engine';
import { calculateATRBasedSize, createTradeManagementPlan, type TradeManagementPlan, type ExitAlert } from './trade-manager';
import { getOrCreateAccount } from './risk-manager';

// === TYPES ===

// Blocked patterns lookup (from proven-edges module)
const BLOCKED_PATTERNS = getBlockedPatterns();

export interface AutoTraderConfig {
  enabled: boolean;
  assets: string[];
  timeframe: string;
  intervalMinutes: number;   // how often to check
  minSetupScore: number;     // minimum setup score to generate signal (0-100)
  maxConcurrentSignals: number; // max pending signals at once
  confidenceBoost: number;   // extra confidence from historical edge
  noOperarThreshold: number; // below this confidence → NO_OPERAR
  strictMode: boolean;       // true = only proven edges, false = data collection mode
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
  // === Phase 4 fields ===
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
  // === Phase 5 MTF fields ===
  mtfConfluence: MTFConfluence | null;
  mtfScore: number;
  mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  h1Filter: 'PASS' | 'FAIL' | 'NO_DATA';
  h4Filter: 'PASS' | 'FAIL' | 'NO_DATA';
  entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DANGEROUS';
  // === Phase 6 Edge Profile fields ===
  edgeClassification: EdgeClassification;
  edgeReason: string;
  // === Phase 7 Proven Edge fields ===
  provenEdgeTier: EdgeTier;
  provenEdgeAllowed: boolean;
  provenEdge: ProvenEdge | null;
  // === Phase 8: 3-System Architecture fields ===
  noTradeAssessment: NoTradeAssessment | null;
  confluenceResult: ConfluenceResult | null;
  tradeManagementPlan: TradeManagementPlan | null;
}

// === DEFAULT CONFIG ===

export const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false,
  assets: ['BTC/USD', 'ETH/USD'],
  timeframe: 'M5',
  intervalMinutes: 5,
  minSetupScore: 30,
  maxConcurrentSignals: 10,
  confidenceBoost: 0,
  noOperarThreshold: 40,
  strictMode: true, // Only trade proven edges — BLOCKED patterns never pass
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
  const exactMatch = await withRetry(
    () => db.setupStats.findUnique({
      where: {
        patternType_asset_session_timeframe: {
          patternType: patternType || 'none',
          asset,
          session,
          timeframe: 'M5',
        },
      },
    }),
    2, 500, 'setupScore-exact'
  );
  
  // Query broader stats (pattern + session, any asset)
  const broaderMatch = await withRetry(
    () => db.setupStats.findMany({
      where: {
        patternType: patternType || 'none',
        session,
      },
    }),
    2, 500, 'setupScore-broader'
  );
  
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

  // === Phase 5: MTF fields ===
  let mtfConfluence: MTFConfluence | null = null;
  let mtfScore = 0;
  let mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  let h1Filter: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
  let h4Filter: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
  let entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DANGEROUS' = 'FAIR';

  // === Phase 6: Edge Profile fields ===
  let edgeClassification: EdgeClassification = 'GREY';
  let edgeDecision: EdgeDecision | null = null;
  let edgeReason = '';

  // === Phase 7: Proven Edge fields ===
  let provenEdgeTier: EdgeTier = 'UNKNOWN';
  let provenEdgeAllowed = false;
  let provenEdge: ProvenEdge | null = null;

  // === Phase 8: 3-System Architecture fields ===
  let noTradeAssessment: NoTradeAssessment | null = null;
  let confluenceResult: ConfluenceResult | null = null;
  let tradeManagementPlan: TradeManagementPlan | null = null;
  let calculatedRR = riskReward; // Pre-declare for use in confluence
  
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
      // MTF fields
      mtfConfluence: null, mtfScore: 0, mtfDirection: 'NEUTRAL',
      h1Filter: 'NO_DATA', h4Filter: 'NO_DATA', entryQuality: 'FAIR',
      // Edge Profile fields
      edgeClassification: 'GREY', edgeReason: 'Datos insuficientes para clasificar edge',
      // Proven Edge fields
      provenEdgeTier: 'UNKNOWN', provenEdgeAllowed: false, provenEdge: null,
      // Phase 8: 3-System Architecture fields
      noTradeAssessment: null, confluenceResult: null, tradeManagementPlan: null,
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
    // Note: engine returns timestamp as number, Candle expects Date — cast is safe
    // because MTF analysis only uses OHLCV values, not timestamps
    let m15Final = m15Candles;
    let h1Final = h1Candles;
    let h4Final = h4Candles;

    if (m15Final.length < 50) {
      try {
        const engineM15 = await getEngineCandles(asset, 'M15', 100);
        if (engineM15.candles.length >= 30) m15Final = engineM15.candles as any;
      } catch { /* skip */ }
    }
    if (h1Final.length < 50) {
      try {
        const engineH1 = await getEngineCandles(asset, 'H1', 100);
        if (engineH1.candles.length >= 30) h1Final = engineH1.candles as any;
      } catch { /* skip */ }
    }
    if (h4Final.length < 50) {
      try {
        const engineH4 = await getEngineCandles(asset, 'H4', 100);
        if (engineH4.candles.length >= 30) h4Final = engineH4.candles as any;
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
  
  // ═══ NEW Step 4.1: NO-TRADE SYSTEM ASSESSMENT (Phase 8) ═══
  // Evaluate all "don't trade" filters: systemic risk, news, liquidity, etc.
  noTradeAssessment = assessNoTrade({
    asset,
    candles,
    indicators,
    regimeResult,
    patternType: bestPattern?.type || null,
    sessionType: session.session,
  });

  // If NoTrade system BLOCKS trading, override to NO_OPERAR
  // Need to determine data collection mode early for this check
  const earlySampleSize = await db.signal.count({ where: { asset, status: { not: 'PENDING' } } });
  const earlyIsDataCollectionMode = earlySampleSize < 1000;
  
  if (!noTradeAssessment.canTrade) {
    const blockReason = noTradeAssessment.summary;
    if (!earlyIsDataCollectionMode) {
      direction = 'NO_OPERAR';
      confidence = 0;
      reason = blockReason;
    }
  }

  // ═══ Step 4.5: PROVEN EDGE FILTER (Phase 7) ═══
  // THE MOST IMPORTANT FILTER IN THE PIPELINE.
  // Hard allowlist from 6-month backtest: only trade combos with proven positive edge.
  // BLOCKED patterns (breakout, trend_continuation, none) → NEVER trade.
  // In data collection mode: allow unproven combos with positive pattern WR to build dataset.
  // Determine sample size for strict mode decision
  const currentSampleSize = await withRetry(
    () => db.signal.count({ where: { asset, status: { not: 'PENDING' } } }),
    2, 500, 'provenEdge-sampleSize'
  );
  const currentIsDataCollectionMode = currentSampleSize < 1000;
  const currentStrictMode = !currentIsDataCollectionMode; // strict only when we have enough data
  const provenEdgeResult = checkProvenEdge(
    bestPattern?.type || null,
    session.session,
    asset,
    currentStrictMode // strict mode when we have enough data, lenient during data collection
  );
  provenEdgeTier = provenEdgeResult.tier;
  provenEdgeAllowed = provenEdgeResult.allowed;
  provenEdge = provenEdgeResult.edge;

  if (!provenEdgeAllowed) {
    // HARD BLOCK for confirmed losers (breakout, trend_continuation, none)
    if (provenEdgeResult.tier === 'BLOCKED') {
      direction = 'NO_OPERAR';
      reason = provenEdgeResult.reason;
      confidence = 0;
    } else {
      // UNKNOWN combo — not in proven list but not a confirmed loser
      // In data collection mode: allow but reduce confidence (we need data!)
      // In production mode: block
      if (currentIsDataCollectionMode && bestPattern && direction !== 'NO_OPERAR') {
        // Keep the direction but reduce confidence — we need this data
        confidence = Math.max(0, confidence + provenEdgeResult.confidenceBoost);
        reason += ` [MODO RECOLECCIÓN: Combo no probado pero generando señal para dataset]`;
      } else {
        direction = 'NO_OPERAR';
        reason = provenEdgeResult.reason;
        confidence = 0;
      }
    }
  } else {
    // Apply confidence boost based on tier
    confidence = Math.min(100, confidence + provenEdgeResult.confidenceBoost);
    reason += ` [${provenEdgeResult.reason}]`;
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
  const isDataCollectionMode = currentIsDataCollectionMode; // Reuse the value computed earlier
  
  if (!sessionCheck.shouldTrade && session.session === 'OffHours') {
    // OffHours: only skip if in production mode
    if (!isDataCollectionMode) {
      direction = 'NO_OPERAR';
      reason = sessionCheck.reason;
      confidence = 0;
    } else {
      // Data collection: still generate but flag it
      confidence = Math.max(0, confidence - 15);
      reason += ` [MODO RECOLECCIÓN: Fuera de horas óptimas, -15 confianza pero generando para dataset]`;
    }
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
  
  // ═══ Step 6.8: EDGE PROFILE CHECK (Phase 6) ═══
  // This is the MOST IMPORTANT filter in the pipeline.
  // It checks if the pattern+session+asset combo has a PROVEN EDGE from backtest data.
  // RED combos → hard NO OPERAR (confirmed losers, even in data collection mode)
  // GREEN combos → confidence boost
  // YELLOW combos → cautious, only with high confidence
  // GREY combos → depends on mode

  try {
    edgeDecision = await getEdgeDecision(
      bestPattern?.type || null,
      session.session,
      asset,
      confidence,
      isDataCollectionMode
    );
    edgeClassification = edgeDecision.classification;
    edgeReason = edgeDecision.reason;

    if (edgeClassification === 'RED') {
      // HARD BLOCK: This combo is a confirmed loser from backtest data.
      // Even in data collection mode, we don't want to trade confirmed losers.
      // EXCEPT: if it's a non-blocked pattern (liquidity_sweep, fakeout, etc.)
      // we still generate for dataset even with RED edge — we need the data.
      const isBlockedPattern = BLOCKED_PATTERNS.hasOwnProperty(bestPattern?.type || 'none');
      if (isBlockedPattern || !isDataCollectionMode) {
        direction = 'NO_OPERAR';
        reason = edgeDecision.reason;
        confidence = Math.max(0, Math.min(confidence + edgeDecision.confidenceAdjustment, 15));
      } else {
        // Data collection: generate signal even with RED edge for non-blocked patterns
        confidence = Math.max(0, confidence + edgeDecision.confidenceAdjustment);
        reason += ` [MODO RECOLECCIÓN: Edge rojo pero patrón no bloqueado, generando para dataset]`;
      }
    } else if (edgeClassification === 'GREEN') {
      // CONFIRMED EDGE: Boost confidence and setup score
      confidence = Math.min(100, confidence + edgeDecision.confidenceAdjustment);
      reason += ` [EDGE: ${edgeDecision.reason}]`;
    } else if (edgeClassification === 'YELLOW') {
      // MARGINAL EDGE: Apply if confidence is high enough
      confidence = Math.max(0, confidence + edgeDecision.confidenceAdjustment);
      if (!edgeDecision.shouldTrade && !isDataCollectionMode) {
        direction = 'NO_OPERAR';
        reason = edgeDecision.reason;
      } else if (!edgeDecision.shouldTrade && isDataCollectionMode) {
        reason += ` [EDGE AMARILLO: Confianza baja pero generando para dataset]`;
      } else {
        reason += ` [EDGE: ${edgeDecision.reason}]`;
      }
    }
    // GREY: no edge data, continue with normal pipeline
  } catch (err: any) {
    // Edge profile check is best-effort — don't block signal generation
    console.error('Edge profile check failed:', err.message);
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
  
  // ═══ NEW Step 7.5: CONFLUENCE ENGINE ASSESSMENT (Phase 8) ═══
  // When all NoTrade filters are green, evaluate confluence of multiple factors
  if (direction !== 'NO_OPERAR' || (isDataCollectionMode && bestPattern)) {
    confluenceResult = assessConfluence({
      asset,
      pattern: bestPattern,
      indicators,
      regimeResult,
      mtfScore,
      mtfDirection,
      sessionType: session.session,
      historicalWinRate,
      historicalSampleSize: sampleSize,
      historicalExpectancy: expectancy,
      edgeClassification: edgeClassification || 'GREY',
      noTradeAssessment,
      entryPrice: candles[candles.length - 1].close,
      atr: indicators.atr14 || candles[candles.length - 1].close * 0.005,
    });

    // Confluence score overrides simple confidence
    if (confluenceResult.shouldTrade && confluenceResult.setup) {
      // Confluence says TRADE — use its direction and confidence
      direction = confluenceResult.setup.direction;
      confidence = Math.max(confidence, confluenceResult.confluenceScore * 0.8);
      reason = confluenceResult.reason;

      // ═══ NEW Step 7.6: TRADE MANAGEMENT PLAN (Phase 8) ═══
      // Calculate position sizing, dynamic stops, exit alerts
      try {
        const account = await getOrCreateAccount();
        const openPositions = await db.position.findMany({ where: { status: 'OPEN' } });
        const consecutiveLosses = await getConsecutiveLosses();

        tradeManagementPlan = createTradeManagementPlan({
          setup: confluenceResult.setup,
          accountBalance: account.balance,
          atr: indicators.atr14 || candles[candles.length - 1].close * 0.005,
          regimeResult,
          noTradeAssessment,
          consecutiveLosses,
          openPositions: openPositions.map(p => ({
            asset: p.asset,
            direction: p.direction,
            entryPrice: p.entryPrice,
            quantity: p.quantity,
            unrealizedPnl: p.unrealizedPnl || 0,
          })),
          timeframe,
        });

        // Update risk/reward from trade management plan
        if (tradeManagementPlan.riskRewardRatio > 0) {
          calculatedRR = tradeManagementPlan.riskRewardRatio;
        }
      } catch (err: any) {
        console.error('Trade management plan failed:', err.message);
      }
    } else if (!confluenceResult.shouldTrade && !isDataCollectionMode) {
      // Confluence says NO TRADE in production mode
      direction = 'NO_OPERAR';
      reason = confluenceResult.reason;
      confidence = Math.min(confidence, confluenceResult.confluenceScore * 0.5);
    }
    // In data collection mode, we still generate signals even with low confluence
  }

  // Step 8: Final NO_OPERAR check
  if (isDataCollectionMode) {
    if (direction === 'NO_OPERAR' || (!bestPattern && confidence < 10)) {
      const noOperarReasons: string[] = [];
      if (!bestPattern) noOperarReasons.push('Sin patrón detectado');
      if (confidence < 10) noOperarReasons.push(`Sin dirección clara: ${confidence.toFixed(0)}%`);
      direction = 'NO_OPERAR';
      reason = `NO OPERAR [MODO RECOLECCIÓN]: ${noOperarReasons.join('. ')}. Sin suficiente señal para determinar dirección.`;
    }
    // In data collection: allow signals with confidence >= 10 if they have a pattern
    // We need WIN/LOSS data, so we generate signals even at lower confidence
    if (direction !== 'NO_OPERAR' && confidence < 30) {
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
  // Backtest-proven optimal: 40 min for M5 (56.8% WR on liquidity_sweep vs 56.0% at 10 min)
  // For other timeframes, keep 2x multiplier as default
  const tfMinutes = { 'M1': 1, 'M5': 5, 'M15': 15, 'M30': 30, 'H1': 60 }[timeframe] || 5;
  const expirationMinutes = timeframe === 'M5' ? 40 : tfMinutes * 2;
  
  // === NEW Step 12.5: Calculate risk/reward from pattern key levels ===
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
  // NO_OPERAR signals are saved as CLOSED immediately (they don't need verification)
  const isNoOperar = direction === 'NO_OPERAR';
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
    status: isNoOperar ? 'CLOSED' : 'PENDING',
    result: isNoOperar ? 'NO_OPERAR' : null,
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
    // === PROVEN EDGE (Phase 7) ===
    provenEdgeTier: provenEdgeTier || null,
    provenEdgeAllowed: provenEdgeAllowed ?? null,
    edgeClassification: edgeClassification || null,
  };
  
  // ─── 3-LEVEL FALLBACK for signal creation ───
  // Turso "fetch failed" or "Unknown argument" errors are common.
  // We try 3 levels: full data → base+fullAnalysisJson → minimum fields.
  let signal: any;
  
  try {
    // Level 1: Try full signal data with all columns (including provenEdgeTier etc.)
    signal = await withRetry(
      () => db.signal.create({ data: signalData }),
      2, 500, 'signal-create-full'
    );
  } catch (err1: any) {
    const msg1 = err1?.message || String(err1);
    console.error(`[AUTO-TRADER] Signal create Level 1 failed: ${msg1}`);
    
    // Level 2: Try with base fields + fullAnalysisJson backup (skip columns that might not exist)
    try {
      const baseSignalData = {
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
        status: isNoOperar ? 'CLOSED' : 'PENDING',
        result: isNoOperar ? 'NO_OPERAR' : null,
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
        // Phase 4 fields (base ones that definitely exist in schema)
        marketRegime: regimeResult.regime,
        featuresJson: JSON.stringify(features),
        expectancy,
        riskReward: calculatedRR,
        adjustedWinRate: adjustedWR,
        qualityScore: qualityResult.score,
        qualityFlags: JSON.stringify(qualityResult.flags),
        // Store MTF + Proven Edge data in fullAnalysisJson as backup
        fullAnalysisJson: JSON.stringify({
          mtfConfluence: mtfScore,
          mtfDirection,
          h1Filter,
          h4Filter,
          entryQuality,
          provenEdgeTier: provenEdgeTier || null,
          provenEdgeAllowed: provenEdgeAllowed ?? null,
          edgeClassification: edgeClassification || null,
          confluenceResult: confluenceResult ? {
            confluenceScore: confluenceResult.confluenceScore,
            shouldTrade: confluenceResult.shouldTrade,
            reason: confluenceResult.reason,
          } : null,
          noTradeAssessment: noTradeAssessment ? {
            overallScore: noTradeAssessment.overallScore,
            canTrade: noTradeAssessment.canTrade,
            tradeQuality: noTradeAssessment.tradeQuality,
          } : null,
          pValue,
          sampleVariance,
          confidenceInterval,
        }),
      };
      
      signal = await withRetry(
        () => db.signal.create({ data: baseSignalData }),
        2, 500, 'signal-create-base'
      );
      console.log('[AUTO-TRADER] ✅ Signal saved with Level 2 (base + fullAnalysisJson)');
    } catch (err2: any) {
      const msg2 = err2?.message || String(err2);
      console.error(`[AUTO-TRADER] Signal create Level 2 failed: ${msg2}`);
      
      // Level 3: Absolute minimum fields — this MUST work
      try {
        const minimumSignalData = {
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
          status: isNoOperar ? 'CLOSED' : 'PENDING',
          result: isNoOperar ? 'NO_OPERAR' : null,
          analysisMode,
          verificationMethod: 'SIMULATED',
        };
        
        signal = await withRetry(
          () => db.signal.create({ data: minimumSignalData }),
          2, 500, 'signal-create-minimum'
        );
        console.log('[AUTO-TRADER] ✅ Signal saved with Level 3 (minimum fields only)');
      } catch (err3: any) {
        const msg3 = err3?.message || String(err3);
        console.error(`[AUTO-TRADER] ❌ Signal create Level 3 (minimum) ALSO failed: ${msg3}`);
        // Return the result anyway without a signal ID — the pipeline completed but DB save failed
        signal = { id: `failed-${Date.now()}` };
      }
    }
  }
  
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
    // Edge Profile fields
    edgeClassification,
    edgeReason,
    // Proven Edge fields
    provenEdgeTier,
    provenEdgeAllowed,
    provenEdge,
    // Phase 8: 3-System Architecture fields
    noTradeAssessment,
    confluenceResult,
    tradeManagementPlan,
  };
}

// === HELPER: GET CONSECUTIVE LOSSES ===

async function getConsecutiveLosses(): Promise<number> {
  const recentTrades = await db.signal.findMany({
    where: { status: 'CLOSED', result: { in: ['WIN', 'LOSS'] } },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });

  let consecutive = 0;
  for (const t of recentTrades) {
    if (t.result === 'LOSS') consecutive++;
    else break;
  }
  return consecutive;
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

  // Invalidate edge profile cache so it picks up the new data
  invalidateEdgeProfileCache();
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
  tradesExecuted: number;
  tradesRejected: number;
}> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const results: SignalGenerationResult[] = [];
  let signalsGenerated = 0;
  let signalsSkipped = 0;
  let tradesExecuted = 0;
  let tradesRejected = 0;
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
      tradesExecuted: 0,
      tradesRejected: 0,
    };
  }
  
  // === Phase 8: Check if auto-execution is enabled ===
  const executionSetting = await db.appSettings.findUnique({
    where: { key: 'autoExecution' },
  });
  const autoExecution = executionSetting ? JSON.parse(executionSetting.value) : { enabled: false, mode: 'PAPER' };

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

      // ═══ Phase 8: AUTO-EXECUTE TRADE if signal passed all filters ═══
      // Only execute if: auto-execution is enabled AND signal is tradeable (not NO_OPERAR)
      if (autoExecution.enabled && result.signalId && result.direction !== 'NO_OPERAR' && !result.skipped) {
        try {
          const { getExecutionEngine } = await import('./execution-engine');
          const engine = getExecutionEngine(autoExecution.mode);

          // Get ATR from indicators
          const atr = result.indicators?.atr14 || (result.indicators?.sma20 || 0) * 0.005;

          const execResult = await engine.executeSignal({
            signalId: result.signalId,
            asset: result.asset,
            direction: result.direction as 'HIGHER' | 'LOWER',
            entryPrice: result.indicators?.sma20 || 0, // Will be overridden by live price
            confidence: result.confidence,
            patternType: result.pattern,
            sessionType: result.session,
            edgeClassification: result.edgeClassification,
            provenEdgeTier: result.provenEdgeTier,
            winRate: result.adjustedWR,
            riskRewardRatio: result.riskReward,
            expectancy: result.expectancy,
            setupScore: result.setupScore,
            qualityScore: result.qualityScore,
            atr: atr || result.indicators?.atr14 || 0,
          });

          if (execResult.success) {
            tradesExecuted++;
            console.log(`[AUTO-EXEC] ✅ Trade executed: ${result.asset} ${result.direction} | Mode: ${autoExecution.mode}`);
          } else {
            tradesRejected++;
            console.log(`[AUTO-EXEC] ❌ Trade rejected: ${execResult.reason} | Mode: ${autoExecution.mode}`);
          }
        } catch (execErr: any) {
          tradesRejected++;
          errors.push(`Execution error ${asset}: ${execErr.message}`);
          console.error(`[AUTO-EXEC] Error executing trade:`, execErr.message);
        }
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
  
  return { signalsGenerated, signalsSkipped, errors, results, tradesExecuted, tradesRejected };
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
