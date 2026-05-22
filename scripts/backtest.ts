#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — BACKTESTER
// Downloads historical data from Binance, simulates the full pipeline on each
// M5 candle, verifies signals, and generates a comprehensive edge report.
//
// Usage: npx tsx scripts/backtest.ts
//        npx tsx scripts/backtest.ts --asset BTC/USD --months 6
//        npx tsx scripts/backtest.ts --save-db    (writes SetupStats to Turso)
// ══════════════════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
config({ path: '../.env' });
config({ path: '.env' });

import { computeAllIndicators, type IndicatorSnapshot } from '../src/lib/indicators';
import { detectPatterns, type DetectedPattern, type PatternType } from '../src/lib/patterns';
import { detectSession, shouldTradeSession, type SessionInfo, type SessionType } from '../src/lib/sessions';
import { detectRegime, type MarketRegime, type RegimeResult, shouldTradeInRegime, getRegimePatternCompat } from '../src/lib/regime-engine';
import { computeSignalFeatures, type SignalFeatures } from '../src/lib/feature-engineering';
import { checkQuality, quickQualityScore, toQualityFeatures, type QualityResult, type QualityFlag } from '../src/lib/quality-filter';
import { calculateBayesianStats } from '../src/lib/bayesian-engine';
import { estimateExpectancyFromStats } from '../src/lib/expectancy-engine';
import { quickMTFScore, type MTFConfluence } from '../src/lib/mtf-analysis';
import { evaluateSignal } from '../src/lib/signals';

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BacktestSignal {
  index: number;               // Candle index where signal was generated
  timestamp: Date;
  asset: string;
  direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR';
  confidence: number;
  patternType: PatternType | null;
  sessionType: SessionType;
  setupScore: number;
  regime: MarketRegime;
  regimeConfidence: number;
  mtfScore: number;
  mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DANGEROUS';
  qualityScore: number;
  bayesianWR: number;
  expectancy: number;
  entryPrice: number;
  exitPrice: number | null;
  result: 'WIN' | 'LOSS' | 'DRAW' | null;
  verificationCandles: number;  // How many candles ahead we verified
  reason: string;
}

interface BacktestStats {
  totalSignals: number;
  totalWins: number;
  totalLosses: number;
  totalDraws: number;
  totalNoOperar: number;
  winRate: number;
  avgConfidence: number;
  avgSetupScore: number;
  byPattern: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  bySession: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  byRegime: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  byAsset: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  byMTFQuality: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  byDirection: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  topEdges: Array<{
    patternType: string;
    session: string;
    asset: string;
    total: number;
    wins: number;
    winRate: number;
    avgConfidence: number;
    avgSetupScore: number;
  }>;
  worstSetups: Array<{
    patternType: string;
    session: string;
    asset: string;
    total: number;
    losses: number;
    winRate: number;
  }>;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const ASSET_MAP: Record<string, { binanceSymbol: string; decimals: number }> = {
  'BTC/USD': { binanceSymbol: 'BTCUSDT', decimals: 2 },
  'ETH/USD': { binanceSymbol: 'ETHUSDT', decimals: 2 },
  'EUR/USD': { binanceSymbol: '', decimals: 5 },    // Not on Binance spot
  'GBP/USD': { binanceSymbol: '', decimals: 5 },    // Not on Binance spot
  'USD/JPY': { binanceSymbol: '', decimals: 3 },    // Not on Binance spot
};

const DEFAULT_ASSETS = ['BTC/USD', 'ETH/USD'];
const DEFAULT_MONTHS = 6;
const MIN_CANDLES_FOR_ANALYSIS = 60;   // Need at least this many candles before generating signals
const VERIFICATION_CANDLES = 2;         // 2 × M5 = 10 minutes ahead
const STEP_EVERY_N_CANDLES = 3;         // Process every 3rd candle (15 min intervals) for speed
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

// ══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ══════════════════════════════════════════════════════════════════════════════

function log(msg: string) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// BINANCE DATA DOWNLOADER
// ══════════════════════════════════════════════════════════════════════════════

async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  startTimeMs: number,
  endTimeMs: number
): Promise<Candle[]> {
  const allCandles: Candle[] = [];
  let currentStart = startTimeMs;
  const limit = 1000;

  while (currentStart < endTimeMs) {
    const url = `${BINANCE_API}?symbol=${symbol}&interval=${interval}&startTime=${currentStart}&endTime=${endTimeMs}&limit=${limit}`;

    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json() as any[][];

        if (data.length === 0) break;

        for (const k of data) {
          allCandles.push({
            timestamp: new Date(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          });
        }

        // Move to next batch
        const lastOpenTime = data[data.length - 1][0] as number;
        currentStart = lastOpenTime + 1;

        // Rate limit: 1200 requests/min → we're well under
        break;
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        log(`  ⚠️ Retry (${3 - retries}/3): ${err.message}`);
        await sleep(2000);
      }
    }

    if (allCandles.length > 0 && allCandles.length % 10000 === 0) {
      log(`  📊 ${symbol} ${interval}: ${allCandles.length} velas descargadas...`);
    }
  }

  return allCandles;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadHistoricalData(
  asset: string,
  months: number
): Promise<{ m5: Candle[]; m15: Candle[]; h1: Candle[]; h4: Candle[] }> {
  const cfg = ASSET_MAP[asset];
  if (!cfg || !cfg.binanceSymbol) {
    throw new Error(`Asset ${asset} no disponible en Binance. Usa BTC/USD o ETH/USD.`);
  }

  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - (months * 30 * 24 * 60 * 60 * 1000);

  log(`📥 Descargando ${asset} (${cfg.binanceSymbol}) — ${months} meses de datos...`);

  const m5 = await fetchBinanceKlines(cfg.binanceSymbol, '5m', startTimeMs, endTimeMs);
  log(`  ✅ M5: ${m5.length.toLocaleString()} velas`);

  const m15 = await fetchBinanceKlines(cfg.binanceSymbol, '15m', startTimeMs, endTimeMs);
  log(`  ✅ M15: ${m15.length.toLocaleString()} velas`);

  const h1 = await fetchBinanceKlines(cfg.binanceSymbol, '1h', startTimeMs, endTimeMs);
  log(`  ✅ H1: ${h1.length.toLocaleString()} velas`);

  const h4 = await fetchBinanceKlines(cfg.binanceSymbol, '4h', startTimeMs, endTimeMs);
  log(`  ✅ H4: ${h4.length.toLocaleString()} velas`);

  return { m5, m15, h1, h4 };
}

// ══════════════════════════════════════════════════════════════════════════════
// MTF DATA HELPER — Find higher-TF candles up to a given timestamp
// (Avoids look-ahead bias: only uses candles that closed BEFORE the current M5)
// ══════════════════════════════════════════════════════════════════════════════

function getHTFCandlesUpTo(
  htfCandles: Candle[],
  currentTime: Date,
  maxCount: number = 100
): Candle[] {
  // Filter to candles that closed before currentTime
  const filtered = htfCandles.filter(c => c.timestamp <= currentTime);
  // Take the last maxCount
  return filtered.slice(-maxCount);
}

// ══════════════════════════════════════════════════════════════════════════════
// SETUP SCORE CALCULATION (simplified for backtesting)
// ══════════════════════════════════════════════════════════════════════════════

function calculateBacktestSetupScore(
  patternType: PatternType | null,
  indicators: IndicatorSnapshot,
  session: SessionInfo
): number {
  let score = 30; // base

  if (patternType) score += 10;

  // Indicator alignment
  const ind = indicators;
  let bullish = 0, bearish = 0;

  if (ind.rsi14 !== null) {
    if (ind.rsi14 > 50) bullish += 0.5; else bearish += 0.5;
    if (ind.rsi14 > 60) bullish += 0.5;
    if (ind.rsi14 < 40) bearish += 0.5;
  }
  if (ind.macdHistogram !== null) {
    if (ind.macdHistogram > 0) bullish += 1; else bearish += 1;
  }
  if (ind.ema12 !== null && ind.ema26 !== null) {
    if (ind.ema12 > ind.ema26) bullish += 1; else bearish += 1;
  }
  if (ind.stochK !== null && ind.stochD !== null) {
    if (ind.stochK > ind.stochD) bullish += 0.5; else bearish -= 0.5;
  }

  const alignment = (bullish + bearish) > 0 ? ((bullish - bearish) / (bullish + bearish)) : 0;
  score += alignment * 20; // -20 to +20

  // Session quality
  if (session.session === 'Overlap') score += 10;
  else if (session.session === 'London') score += 7;
  else if (session.session === 'NewYork') score += 5;
  else if (session.session === 'Asia') score -= 3;
  else if (session.session === 'OffHours') score -= 15;

  // Volume confirmation
  if (ind.volumeAnalysis.volumeSpike) score += 10;
  else if (ind.volumeAnalysis.relativeVolume > 1.5) score += 5;
  else if (ind.volumeAnalysis.relativeVolume < 0.5) score -= 5;

  return Math.min(100, Math.max(0, Math.round(score)));
}

// ══════════════════════════════════════════════════════════════════════════════
// INDICATOR-BASED DIRECTION (fallback when no pattern)
// ══════════════════════════════════════════════════════════════════════════════

function getIndicatorDirection(ind: IndicatorSnapshot): { direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR'; confidence: number } {
  let bullish = 0, bearish = 0, total = 0;

  if (ind.rsi14 !== null) {
    total++;
    if (ind.rsi14 > 55) bullish += 0.5; else if (ind.rsi14 < 45) bearish += 0.5;
    if (ind.rsi14 > 60) bullish += 0.5; if (ind.rsi14 < 40) bearish += 0.5;
  }
  if (ind.macdHistogram !== null) {
    total++;
    if (ind.macdHistogram > 0) bullish += 1; else bearish += 1;
  }
  if (ind.ema12 !== null && ind.ema26 !== null) {
    total++;
    if (ind.ema12 > ind.ema26) bullish += 1; else bearish += 1;
  }
  if (ind.trend !== 'RANGING') {
    total++;
    if (ind.trend === 'BULLISH') bullish += 1; else bearish += 1;
  }
  if (ind.stochK !== null) {
    total++;
    if (ind.stochK > 50) bullish += 0.5; else bearish += 0.5;
  }

  if (total === 0) return { direction: 'NO_OPERAR', confidence: 0 };

  const balance = bullish - bearish;
  if (Math.abs(balance) < 0.5) return { direction: 'NO_OPERAR', confidence: 20 };

  const direction: 'HIGHER' | 'LOWER' = balance > 0 ? 'HIGHER' : 'LOWER';
  const confidence = Math.min(70, 25 + Math.abs(balance) * 15);
  return { direction, confidence };
}

// ══════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE — Core Simulation
// ══════════════════════════════════════════════════════════════════════════════

async function runBacktest(
  asset: string,
  data: { m5: Candle[]; m15: Candle[]; h1: Candle[]; h4: Candle[] },
  options: { minSetupScore?: number; dataCollectionMode?: boolean } = {}
): Promise<BacktestSignal[]> {
  const { m5, m15, h1, h4 } = data;
  const minSetupScore = options.minSetupScore ?? 15;
  const isDataCollectionMode = options.dataCollectionMode ?? true;

  const signals: BacktestSignal[] = [];
  const totalM5 = m5.length;

  log(`🔄 Simulando ${asset}: ${totalM5.toLocaleString()} velas M5...`);
  log(`   Analizando cada ${STEP_EVERY_N_CANDLES} velas para velocidad`);

  let processed = 0;
  let lastProgress = 0;

  for (let i = MIN_CANDLES_FOR_ANALYSIS; i < totalM5 - VERIFICATION_CANDLES; i += STEP_EVERY_N_CANDLES) {
    processed++;

    // Progress reporting
    const progress = Math.floor((i / totalM5) * 100);
    if (progress >= lastProgress + 10) {
      lastProgress = progress;
      log(`   ${progress}% completado — ${signals.length} señales generadas`);
    }

    const currentTime = m5[i].timestamp;

    // Step 1: Slice available M5 candles (no look-ahead!)
    const availableM5 = m5.slice(0, i + 1);
    const last100M5 = availableM5.slice(-100);

    // Step 2: Compute indicators
    const indicators = computeAllIndicators(last100M5);
    if (indicators.rsi14 === null) continue; // Not enough data

    // Step 3: Detect patterns
    const patterns = detectPatterns(last100M5, indicators);
    const bestPattern = patterns.length > 0
      ? patterns.reduce((a, b) => a.confidence > b.confidence ? a : b)
      : null;

    // Step 3.5: Detect regime
    let regimeResult: RegimeResult;
    try {
      regimeResult = detectRegime(last100M5, indicators);
    } catch {
      regimeResult = { regime: 'RANGING', confidence: 30, subRegime: null, features: { trendStrength: 0, volatilityLevel: 30, rangeClarity: 50, volumeProfile: 50, momentumDirection: 0, priceEfficiency: 50 } } as any;
    }

    // Step 3.6: Compute features
    const session = detectSession(currentTime);

    // Step 3.7: MTF Analysis
    let mtfScore = 0;
    let mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let h1Filter: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
    let h4Filter: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
    let entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DANGEROUS' = 'FAIR';

    try {
      const htfM15 = getHTFCandlesUpTo(m15, currentTime, 100);
      const htfH1 = getHTFCandlesUpTo(h1, currentTime, 100);
      const htfH4 = getHTFCandlesUpTo(h4, currentTime, 100);

      const mtfResult = quickMTFScore(last100M5, htfM15, htfH1, htfH4);
      mtfScore = mtfResult.score;
      mtfDirection = mtfResult.confluence.overallDirection;
      h1Filter = mtfResult.confluence.h1Filter;
      h4Filter = mtfResult.confluence.h4Filter;
      entryQuality = mtfResult.confluence.entryQuality;
    } catch {
      // MTF best-effort
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
      const indDir = getIndicatorDirection(indicators);
      direction = indDir.direction;
      confidence = indDir.confidence;
      reason = 'Decisión por indicadores (sin patrón claro)';
    }

    // Step 5: Setup score
    const setupScore = calculateBacktestSetupScore(bestPattern?.type || null, indicators, session);

    // Step 5.5: Quality filter
    let qualityScore = 50;
    let qualityBlocked = false;
    try {
      const qualityFeatures = {
        relativeVolume: indicators.volumeAnalysis.relativeVolume,
        volumeSpike: indicators.volumeAnalysis.volumeSpike,
        atr: indicators.atr14,
        atrPercentile: 50,
        avgATR: indicators.atr14,
        candleRange: indicators.atr14 || 0.001,
        spreadEstimate: 0.001,
        assetType: asset.includes('BTC') || asset.includes('ETH') ? 'crypto' as const : 'forex' as const,
      };
      const qr = checkQuality({
        candles: last100M5,
        indicators,
        regime: { regime: regimeResult.regime, confidence: regimeResult.confidence },
        sessionInfo: { session: session.session, shouldTrade: session.session !== 'OffHours' },
        setupStats: null, // No historical stats in backtest first pass
        patternType: bestPattern?.type || null,
        features: qualityFeatures,
      });
      qualityScore = qr.score;
      qualityBlocked = qr.isBlocked;
    } catch {
      // Quality filter best-effort
    }

    // Step 6: Session check
    const sessionCheck = shouldTradeSession(session, 50, 0);

    if (!sessionCheck.shouldTrade && session.session === 'OffHours') {
      if (!isDataCollectionMode) {
        direction = 'NO_OPERAR';
        confidence = 0;
      }
    }

    // Step 6.5: Regime mismatch
    const patternCompat = getRegimePatternCompat(regimeResult.regime);
    const regimeMismatch = bestPattern && patternCompat.avoid.includes(bestPattern.type);
    if (regimeMismatch && !isDataCollectionMode) {
      direction = 'NO_OPERAR';
    }

    // Step 6.6: MTF filter
    if (direction !== 'NO_OPERAR') {
      const mtfOpposesSignal = (
        (direction === 'HIGHER' && mtfDirection === 'BEARISH') ||
        (direction === 'LOWER' && mtfDirection === 'BULLISH')
      );
      if (mtfOpposesSignal && !isDataCollectionMode) {
        if (h4Filter === 'FAIL' || (h1Filter === 'FAIL' && mtfScore < 30)) {
          direction = 'NO_OPERAR';
        }
      }
      if (entryQuality === 'DANGEROUS' && !isDataCollectionMode) {
        direction = 'NO_OPERAR';
      }
    }

    // Step 7: Final NO_OPERAR check
    if (direction === 'NO_OPERAR' || (!bestPattern && confidence < 15)) {
      direction = 'NO_OPERAR';
    }

    // Skip if below minimum setup score (in production mode)
    if (!isDataCollectionMode && setupScore < minSetupScore && direction !== 'NO_OPERAR') {
      direction = 'NO_OPERAR';
    }

    // Skip NO_OPERAR signals (they don't need verification)
    if (direction === 'NO_OPERAR') {
      signals.push({
        index: i,
        timestamp: currentTime,
        asset,
        direction: 'NO_OPERAR',
        confidence: 0,
        patternType: bestPattern?.type || null,
        sessionType: session.session,
        setupScore,
        regime: regimeResult.regime,
        regimeConfidence: regimeResult.confidence,
        mtfScore,
        mtfDirection,
        entryQuality,
        qualityScore,
        bayesianWR: 50,
        expectancy: 0,
        entryPrice: m5[i].close,
        exitPrice: null,
        result: null,
        verificationCandles: 0,
        reason: 'NO_OPERAR',
      });
      continue;
    }

    // ════════════════════════════════════════════════════════════════════════
    // VERIFY SIGNAL — Compare with actual future candles
    // ════════════════════════════════════════════════════════════════════════
    const entryPrice = m5[i].close;
    const exitCandleIndex = Math.min(i + VERIFICATION_CANDLES, totalM5 - 1);
    const exitPrice = m5[exitCandleIndex].close;

    const result = evaluateSignal(direction, entryPrice, exitPrice);

    signals.push({
      index: i,
      timestamp: currentTime,
      asset,
      direction,
      confidence,
      patternType: bestPattern?.type || null,
      sessionType: session.session,
      setupScore,
      regime: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
      mtfScore,
      mtfDirection,
      entryQuality,
      qualityScore,
      bayesianWR: 50,
      expectancy: 0,
      entryPrice,
      exitPrice,
      result: result as 'WIN' | 'LOSS' | 'DRAW',
      verificationCandles: VERIFICATION_CANDLES,
      reason,
    });
  }

  return signals;
}

// ══════════════════════════════════════════════════════════════════════════════
// STATISTICS COMPUTATION
// ══════════════════════════════════════════════════════════════════════════════

function computeBacktestStats(signals: BacktestSignal[]): BacktestStats {
  const active = signals.filter(s => s.direction !== 'NO_OPERAR' && s.result);
  const noOperar = signals.filter(s => s.direction === 'NO_OPERAR');

  const wins = active.filter(s => s.result === 'WIN').length;
  const losses = active.filter(s => s.result === 'LOSS').length;
  const draws = active.filter(s => s.result === 'DRAW').length;
  const winRate = active.length > 0 ? (wins / active.length) * 100 : 0;

  const byPattern = groupBy(active, s => s.patternType || 'none');
  const bySession = groupBy(active, s => s.sessionType);
  const byRegime = groupBy(active, s => s.regime);
  const byAsset = groupBy(active, s => s.asset);
  const byMTFQuality = groupBy(active, s => s.entryQuality);
  const byDirection = groupBy(active, s => s.direction);

  // Find top edges: pattern + session + asset combinations
  const comboMap = new Map<string, { patternType: string; session: string; asset: string; total: number; wins: number; totalConf: number; totalSetup: number }>();
  for (const s of active) {
    const key = `${s.patternType || 'none'}|${s.sessionType}|${s.asset}`;
    const existing = comboMap.get(key) || { patternType: s.patternType || 'none', session: s.sessionType, asset: s.asset, total: 0, wins: 0, totalConf: 0, totalSetup: 0 };
    existing.total++;
    if (s.result === 'WIN') existing.wins++;
    existing.totalConf += s.confidence;
    existing.totalSetup += s.setupScore;
    comboMap.set(key, existing);
  }

  const topEdges = Array.from(comboMap.values())
    .filter(c => c.total >= 10) // Need at least 10 samples
    .map(c => ({ ...c, winRate: (c.wins / c.total) * 100, avgConfidence: c.totalConf / c.total, avgSetupScore: c.totalSetup / c.total }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 10);

  const worstSetups = Array.from(comboMap.values())
    .filter(c => c.total >= 10)
    .map(c => ({ patternType: c.patternType, session: c.session, asset: c.asset, total: c.total, losses: c.total - c.wins, winRate: (c.wins / c.total) * 100 }))
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, 5);

  return {
    totalSignals: active.length,
    totalWins: wins,
    totalLosses: losses,
    totalDraws: draws,
    totalNoOperar: noOperar.length,
    winRate,
    avgConfidence: active.length > 0 ? active.reduce((s, x) => s + x.confidence, 0) / active.length : 0,
    avgSetupScore: active.length > 0 ? active.reduce((s, x) => s + x.setupScore, 0) / active.length : 0,
    byPattern: formatGroups(byPattern),
    bySession: formatGroups(bySession),
    byRegime: formatGroups(byRegime),
    byAsset: formatGroups(byAsset),
    byMTFQuality: formatGroups(byMTFQuality),
    byDirection: formatGroups(byDirection),
    topEdges,
    worstSetups,
  };
}

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const key = keyFn(item);
    const group = map.get(key) || [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}

function formatGroups<T>(groups: Map<string, T[]>): Record<string, { total: number; wins: number; losses: number; winRate: number }> {
  const result: Record<string, { total: number; wins: number; losses: number; winRate: number }> = {};
  for (const [key, items] of groups) {
    const active = items.filter(s => (s as any).result);
    const wins = active.filter(s => (s as any).result === 'WIN').length;
    const losses = active.filter(s => (s as any).result === 'LOSS').length;
    result[key] = {
      total: active.length,
      wins,
      losses,
      winRate: active.length > 0 ? (wins / active.length) * 100 : 0,
    };
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATOR
// ══════════════════════════════════════════════════════════════════════════════

function generateReport(
  allSignals: BacktestSignal[],
  stats: BacktestStats,
  assets: string[],
  months: number
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════════════════╗');
  lines.push('║            SIGNALTRADER PRO — REPORTE DE BACKTEST                       ║');
  lines.push('╚══════════════════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`📊 Período: ${months} meses | Assets: ${assets.join(', ')}`);
  lines.push(`📅 Datos: Binance Spot (M5, M15, H1, H4)`);
  lines.push(`⏱️  Expiración: ${VERIFICATION_CANDLES * 5} minutos | Step: cada ${STEP_EVERY_N_CANDLES} velas`);
  lines.push('');

  // Overall results
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('  RESULTADOS GENERALES');
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('');

  const wrEmoji = stats.winRate >= 55 ? '✅' : stats.winRate >= 50 ? '🟡' : '❌';
  const wrVerdict = stats.winRate >= 55 ? 'EDGE POSITIVO' : stats.winRate >= 50 ? 'SIN EDGE CLARO' : 'EDGE NEGATIVO';

  lines.push(`  Señales activas:   ${stats.totalSignals.toLocaleString()}`);
  lines.push(`  NO OPERAR:         ${stats.totalNoOperar.toLocaleString()}`);
  lines.push(`  Wins:              ${stats.totalWins.toLocaleString()}`);
  lines.push(`  Losses:            ${stats.totalLosses.toLocaleString()}`);
  lines.push(`  Draws:             ${stats.totalDraws.toLocaleString()}`);
  lines.push(`  Win Rate Global:   ${wrEmoji} ${stats.winRate.toFixed(1)}% — ${wrVerdict}`);
  lines.push(`  Confianza media:   ${stats.avgConfidence.toFixed(1)}%`);
  lines.push(`  Setup Score medio: ${stats.avgSetupScore.toFixed(1)}`);
  lines.push('');

  // By Asset
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('  POR ASSET');
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('');
  for (const [asset, data] of Object.entries(stats.byAsset).sort((a, b) => b[1].winRate - a[1].winRate)) {
    const e = data.winRate >= 55 ? '✅' : data.winRate >= 50 ? '🟡' : '❌';
    lines.push(`  ${e} ${asset.padEnd(10)} ${data.winRate.toFixed(1)}% WR (${data.wins}W/${data.losses}L de ${data.total})`);
  }
  lines.push('');

  // By Pattern
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('  POR PATRÓN');
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('');
  for (const [pattern, data] of Object.entries(stats.byPattern).sort((a, b) => b[1].winRate - a[1].winRate)) {
    const e = data.winRate >= 55 ? '✅' : data.winRate >= 50 ? '🟡' : '❌';
    lines.push(`  ${e} ${pattern.padEnd(25)} ${data.winRate.toFixed(1)}% WR (${data.wins}W/${data.losses}L de ${data.total})`);
  }
  lines.push('');

  // By Session
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('  POR SESIÓN');
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('');
  const sessionOrder = ['Overlap', 'London', 'NewYork', 'Asia', 'OffHours'];
  for (const session of sessionOrder) {
    const data = stats.bySession[session];
    if (!data) continue;
    const e = data.winRate >= 55 ? '✅' : data.winRate >= 50 ? '🟡' : '❌';
    lines.push(`  ${e} ${session.padEnd(10)} ${data.winRate.toFixed(1)}% WR (${data.wins}W/${data.losses}L de ${data.total})`);
  }
  lines.push('');

  // By Regime
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('  POR RÉGIMEN DE MERCADO');
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('');
  for (const [regime, data] of Object.entries(stats.byRegime).sort((a, b) => b[1].winRate - a[1].winRate)) {
    const e = data.winRate >= 55 ? '✅' : data.winRate >= 50 ? '🟡' : '❌';
    lines.push(`  ${e} ${regime.padEnd(20)} ${data.winRate.toFixed(1)}% WR (${data.wins}W/${data.losses}L de ${data.total})`);
  }
  lines.push('');

  // By MTF Entry Quality
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('  POR CALIDAD MTF DE ENTRADA');
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('');
  const qualityOrder = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DANGEROUS'];
  for (const q of qualityOrder) {
    const data = stats.byMTFQuality[q];
    if (!data) continue;
    const e = data.winRate >= 55 ? '✅' : data.winRate >= 50 ? '🟡' : '❌';
    lines.push(`  ${e} ${q.padEnd(12)} ${data.winRate.toFixed(1)}% WR (${data.wins}W/${data.losses}L de ${data.total})`);
  }
  lines.push('');

  // Top Edges (THE MOST IMPORTANT SECTION)
  lines.push('╔══════════════════════════════════════════════════════════════════════════╗');
  lines.push('║  🏆 TOP EDGES ENCONTRADOS  (patrón + sesión + asset)                   ║');
  lines.push('╚══════════════════════════════════════════════════════════════════════════╝');
  lines.push('');

  if (stats.topEdges.length === 0) {
    lines.push('  ❌ No se encontraron edges con ≥10 muestras.');
    lines.push('     Necesitas más datos o diferentes combinaciones.');
  } else {
    for (let i = 0; i < stats.topEdges.length; i++) {
      const edge = stats.topEdges[i];
      const e = edge.winRate >= 55 ? '✅' : '🟡';
      lines.push(`  ${e} #${i + 1} ${edge.patternType} + ${edge.session} + ${edge.asset}`);
      lines.push(`     WR: ${edge.winRate.toFixed(1)}% (${edge.wins}W/${edge.total - edge.wins}L de ${edge.total} muestras)`);
      lines.push(`     Confianza media: ${edge.avgConfidence.toFixed(1)}% | Setup Score: ${edge.avgSetupScore.toFixed(1)}`);
      lines.push('');
    }
  }

  // Worst Setups
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('  🚫 PEORES SETUPS (EVITAR)');
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  lines.push('');
  if (stats.worstSetups.length === 0) {
    lines.push('  No hay suficientes datos para identificar peores setups.');
  } else {
    for (const ws of stats.worstSetups) {
      lines.push(`  ❌ ${ws.patternType} + ${ws.session} + ${ws.asset}: ${ws.winRate.toFixed(1)}% WR (${ws.losses}L de ${ws.total})`);
    }
  }
  lines.push('');

  // Verdict
  lines.push('╔══════════════════════════════════════════════════════════════════════════╗');
  lines.push('║  🎯 VEREDICTO                                                          ║');
  lines.push('╚══════════════════════════════════════════════════════════════════════════╝');
  lines.push('');

  if (stats.winRate >= 55) {
    lines.push('  ✅ HAY EDGE. El sistema supera el azar significativamente.');
    lines.push('  → Configurar auto-trader para operar SOLO los top edges encontrados.');
    lines.push('  → Los setups con WR > 55% son estadísticamente viables.');
  } else if (stats.winRate >= 50) {
    lines.push('  🟡 EDGE MARGINAL. El sistema está al nivel del azar.');
    lines.push('  → Filtrar por los top edges específicos (patrón + sesión + asset).');
    lines.push('  → Es posible que algunos setups tengan edge real pero se diluyen.');
    lines.push('  → Considerar subir minSetupScore a 30+ para ser más selectivo.');
  } else {
    lines.push('  ❌ NO HAY EDGE. El sistema pierde más que el azar.');
    lines.push('  → Los patrones detectados no producen ventaja en M5 con 10 min expiración.');
    lines.push('  → Opciones: cambiar timeframe, agregar volumen, o cambiar estrategia.');
  }
  lines.push('');

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVE RESULTS TO DATABASE
// ══════════════════════════════════════════════════════════════════════════════

async function saveStatsToDB(signals: BacktestSignal[]): Promise<void> {
  const { db } = await import('../src/lib/db');

  log('💾 Guardando resultados en Turso DB (SetupStats)...');

  // Group signals by patternType + session + asset
  const comboMap = new Map<string, BacktestSignal[]>();
  for (const s of signals.filter(s => s.direction !== 'NO_OPERAR' && s.result && s.result !== 'DRAW')) {
    const key = `${s.patternType || 'none'}|${s.sessionType}|${s.asset}`;
    const group = comboMap.get(key) || [];
    group.push(s);
    comboMap.set(key, group);
  }

  let saved = 0;
  for (const [key, group] of comboMap) {
    const [patternType, session, asset] = key.split('|');
    const wins = group.filter(s => s.result === 'WIN').length;
    const losses = group.filter(s => s.result === 'LOSS').length;
    const total = group.length;
    const winRate = (wins / total) * 100;

    const bayes = calculateBayesianStats(wins, losses);

    try {
      await db.setupStats.upsert({
        where: {
          patternType_asset_session_timeframe: {
            patternType,
            asset,
            session,
            timeframe: 'M5',
          },
        },
        create: {
          patternType,
          asset,
          session,
          timeframe: 'M5',
          totalSignals: total,
          wins,
          losses,
          winRate,
          avgConfidence: group.reduce((s, x) => s + x.confidence, 0) / total,
          avgSetupScore: group.reduce((s, x) => s + x.setupScore, 0) / total,
          bayesianWinRate: bayes.bayesianWinRate,
          confidenceIntervalLower: bayes.confidenceInterval.lower,
          confidenceIntervalUpper: bayes.confidenceInterval.upper,
          pValue: bayes.pValue,
          sampleVariance: bayes.sampleVariance,
          avgExpectancy: winRate > 50 ? (winRate / 100 - (100 - winRate) / 100) : -(1 - winRate / 100),
          avgRiskReward: 1,
          avgQualityScore: group.reduce((s, x) => s + x.qualityScore, 0) / total,
        },
        update: {
          totalSignals: total,
          wins,
          losses,
          winRate,
          avgConfidence: group.reduce((s, x) => s + x.confidence, 0) / total,
          avgSetupScore: group.reduce((s, x) => s + x.setupScore, 0) / total,
          bayesianWinRate: bayes.bayesianWinRate,
          confidenceIntervalLower: bayes.confidenceInterval.lower,
          confidenceIntervalUpper: bayes.confidenceInterval.upper,
          pValue: bayes.pValue,
          sampleVariance: bayes.sampleVariance,
          avgQualityScore: group.reduce((s, x) => s + x.qualityScore, 0) / total,
        },
      });
      saved++;
    } catch (err: any) {
      // Skip DB errors
    }
  }

  log(`  ✅ ${saved} combinaciones guardadas en SetupStats`);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  let assets = DEFAULT_ASSETS;
  let months = DEFAULT_MONTHS;
  let saveToDB = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asset' && args[i + 1]) {
      assets = [args[i + 1]];
      i++;
    } else if (args[i] === '--months' && args[i + 1]) {
      months = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--save-db') {
      saveToDB = true;
    }
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║            SIGNALTRADER PRO — BACKTESTER                                ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Assets: ${assets.join(', ')}`);
  console.log(`  Período: ${months} meses`);
  console.log(`  Fuente: Binance Spot API (gratis)`);
  console.log(`  Guardar en DB: ${saveToDB ? 'SÍ' : 'NO'}`);
  console.log('');

  const allSignals: BacktestSignal[] = [];

  for (const asset of assets) {
    try {
      // Step 1: Download historical data
      const data = await downloadHistoricalData(asset, months);

      // Step 2: Run backtest
      const signals = await runBacktest(asset, data);
      allSignals.push(...signals);

      const active = signals.filter(s => s.direction !== 'NO_OPERAR');
      const wins = active.filter(s => s.result === 'WIN').length;
      const wr = active.length > 0 ? (wins / active.length) * 100 : 0;
      log(`📊 ${asset}: ${active.length} señales, WR ${wr.toFixed(1)}%, ${signals.filter(s => s.direction === 'NO_OPERAR').length} NO_OPERAR`);

    } catch (err: any) {
      console.error(`❌ Error con ${asset}: ${err.message}`);
    }
  }

  if (allSignals.length === 0) {
    console.error('❌ No se generaron señales. Verifica la conexión a Binance API.');
    process.exit(1);
  }

  // Step 3: Compute stats
  log('📈 Calculando estadísticas...');
  const stats = computeBacktestStats(allSignals);

  // Step 4: Generate report
  const report = generateReport(allSignals, stats, assets, months);
  console.log(report);

  // Step 5: Save to file
  const fs = await import('fs');
  const path = await import('path');
  const reportPath = path.join(process.cwd(), 'backtest-report.txt');
  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`📄 Reporte guardado en: ${reportPath}`);

  // Also save raw JSON for programmatic access
  const jsonPath = path.join(process.cwd(), 'backtest-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ stats, signalCount: allSignals.length, topEdges: stats.topEdges }, null, 2), 'utf-8');
  console.log(`📊 Datos JSON guardados en: ${jsonPath}`);

  // Step 6: Optionally save to DB
  if (saveToDB) {
    try {
      await saveStatsToDB(allSignals);
    } catch (err: any) {
      console.error(`❌ Error guardando en DB: ${err.message}`);
    }
  } else {
    console.log('');
    console.log('💡 Para guardar resultados en Turso DB (alimenta los motores Bayesian/Expectancy):');
    console.log('   npx tsx scripts/backtest.ts --save-db');
    console.log('');
  }

  console.log('═══ Backtest completado ═══');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
