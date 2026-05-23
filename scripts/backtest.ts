#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — BACKTESTER v2 (OPTIMIZED)
// Downloads historical data from Binance, simulates the pipeline on each
// M5 candle, verifies signals, and generates a comprehensive edge report.
//
// Usage: npx tsx scripts/backtest.ts
//        npx tsx scripts/backtest.ts --asset BTC/USD --months 3
//        npx tsx scripts/backtest.ts --save-db    (writes SetupStats to Turso)
// ══════════════════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
config({ path: '../.env' });
config({ path: '.env' });

import { computeAllIndicators, type IndicatorSnapshot } from '../src/lib/indicators';
import { detectPatterns, type DetectedPattern, type PatternType } from '../src/lib/patterns';
import { detectSession, shouldTradeSession, type SessionInfo, type SessionType } from '../src/lib/sessions';
import { evaluateSignal } from '../src/lib/signals';
import { calculateBayesianStats } from '../src/lib/bayesian-engine';

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
  index: number;
  timestamp: Date;
  asset: string;
  direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR';
  confidence: number;
  patternType: PatternType | null;
  sessionType: SessionType;
  setupScore: number;
  entryPrice: number;
  exitPrice: number | null;
  result: 'WIN' | 'LOSS' | 'DRAW' | null;
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
  byAsset: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  byDirection: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  topEdges: Array<{
    patternType: string; session: string; asset: string;
    total: number; wins: number; winRate: number; avgConfidence: number; avgSetupScore: number;
  }>;
  worstSetups: Array<{
    patternType: string; session: string; asset: string;
    total: number; losses: number; winRate: number;
  }>;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const ASSET_MAP: Record<string, { binanceSymbol: string; decimals: number }> = {
  'BTC/USD': { binanceSymbol: 'BTCUSDT', decimals: 2 },
  'ETH/USD': { binanceSymbol: 'ETHUSDT', decimals: 2 },
};

const DEFAULT_ASSETS = ['BTC/USD', 'ETH/USD'];
const DEFAULT_MONTHS = 3;
const MIN_CANDLES = 60;
const VERIFY_CANDLES = 2;        // 2 × M5 = 10 min ahead
const STEP = 6;                   // Process every 6th candle (30 min intervals)
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

function log(msg: string) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════════════════════
// BINANCE DATA DOWNLOADER
// ══════════════════════════════════════════════════════════════════════════════

async function fetchBinanceKlines(
  symbol: string, interval: string, startTimeMs: number, endTimeMs: number
): Promise<Candle[]> {
  const allCandles: Candle[] = [];
  let currentStart = startTimeMs;

  while (currentStart < endTimeMs) {
    const url = `${BINANCE_API}?symbol=${symbol}&interval=${interval}&startTime=${currentStart}&endTime=${endTimeMs}&limit=1000`;

    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as any[][];
        if (data.length === 0) return allCandles;

        for (const k of data) {
          allCandles.push({
            timestamp: new Date(k[0]),
            open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          });
        }
        currentStart = (data[data.length - 1][0] as number) + 1;
        break;
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        await sleep(2000);
      }
    }
  }
  return allCandles;
}

async function downloadHistoricalData(asset: string, months: number): Promise<Candle[]> {
  const cfg = ASSET_MAP[asset];
  if (!cfg?.binanceSymbol) throw new Error(`${asset} no disponible en Binance.`);

  const endMs = Date.now();
  const startMs = endMs - months * 30 * 24 * 60 * 60 * 1000;

  log(`📥 Descargando ${asset} M5 (${months} meses)...`);
  const candles = await fetchBinanceKlines(cfg.binanceSymbol, '5m', startMs, endMs);
  log(`  ✅ ${candles.length.toLocaleString()} velas M5 descargadas`);
  return candles;
}

// ══════════════════════════════════════════════════════════════════════════════
// FAST INDICATOR DIRECTION (simplified for speed)
// ══════════════════════════════════════════════════════════════════════════════

function getFastDirection(ind: IndicatorSnapshot): { direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR'; confidence: number } {
  let bull = 0, bear = 0;
  if (ind.rsi14 !== null) {
    if (ind.rsi14 > 55) bull += 1; else if (ind.rsi14 < 45) bear += 1;
  }
  if (ind.macdHistogram !== null) {
    if (ind.macdHistogram > 0) bull += 1.5; else bear += 1.5;
  }
  if (ind.ema12 !== null && ind.ema26 !== null) {
    if (ind.ema12 > ind.ema26) bull += 1; else bear += 1;
  }
  if (ind.trend === 'BULLISH') bull += 1; else if (ind.trend === 'BEARISH') bear += 1;
  if (ind.stochK !== null) {
    if (ind.stochK > 50) bull += 0.5; else bear += 0.5;
  }

  const diff = bull - bear;
  if (Math.abs(diff) < 1) return { direction: 'NO_OPERAR', confidence: 20 };
  const direction: 'HIGHER' | 'LOWER' = diff > 0 ? 'HIGHER' : 'LOWER';
  return { direction, confidence: Math.min(65, 20 + Math.abs(diff) * 12) };
}

function getFastSetupScore(pattern: PatternType | null, ind: IndicatorSnapshot, session: SessionInfo): number {
  let score = 30;
  if (pattern) score += 10;
  if (session.session === 'Overlap') score += 10;
  else if (session.session === 'London') score += 7;
  else if (session.session === 'NewYork') score += 5;
  else if (session.session === 'Asia') score -= 3;
  else if (session.session === 'OffHours') score -= 15;
  if (ind.volumeAnalysis.volumeSpike) score += 8;
  else if (ind.volumeAnalysis.relativeVolume > 1.3) score += 4;
  if (ind.rsi14 !== null) {
    if (ind.rsi14 > 50) score += 3; else score -= 3;
  }
  if (ind.macdHistogram !== null) {
    if (ind.macdHistogram > 0) score += 3; else score -= 3;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
}

// ══════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE — FAST VERSION
// Only runs: indicators + patterns + session (skips regime/MTF/quality)
// ══════════════════════════════════════════════════════════════════════════════

function runBacktest(
  asset: string, m5: Candle[]
): BacktestSignal[] {
  const signals: BacktestSignal[] = [];
  const total = m5.length;

  log(`🔄 Simulando ${asset}: ${total.toLocaleString()} velas (cada ${STEP})`);

  for (let i = MIN_CANDLES; i < total - VERIFY_CANDLES; i += STEP) {
    // Progress every 1000 iterations
    if ((i - MIN_CANDLES) % (STEP * 1000) === 0) {
      const pct = Math.floor((i / total) * 100);
      log(`   ${pct}% — ${signals.length} señales`);
    }

    try {
      // Slice last 100 candles (no look-ahead)
      const window = m5.slice(Math.max(0, i - 99), i + 1);
      if (window.length < 50) continue;

      // Step 1: Indicators
      const indicators = computeAllIndicators(window);
      if (indicators.rsi14 === null) continue;

      // Step 2: Patterns
      const patterns = detectPatterns(window, indicators);
      const bestPattern = patterns.length > 0
        ? patterns.reduce((a, b) => a.confidence > b.confidence ? a : b)
        : null;

      // Step 3: Session
      const session = detectSession(m5[i].timestamp);

      // Step 4: Direction
      let direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR';
      let confidence: number;
      let reason: string;

      if (bestPattern) {
        direction = bestPattern.direction === 'BULLISH' ? 'HIGHER' : 'LOWER';
        confidence = bestPattern.confidence;
        reason = bestPattern.description;
      } else {
        const indDir = getFastDirection(indicators);
        direction = indDir.direction;
        confidence = indDir.confidence;
        reason = 'Indicadores';
      }

      // Step 5: Setup score
      const setupScore = getFastSetupScore(bestPattern?.type || null, indicators, session);

      // Step 6: Session filter
      if (session.session === 'OffHours') {
        direction = 'NO_OPERAR';
        confidence = 0;
      }

      // Step 7: Low confidence filter
      if (confidence < 15 && !bestPattern) {
        direction = 'NO_OPERAR';
      }

      // Skip NO_OPERAR from stats (just count them)
      if (direction === 'NO_OPERAR') {
        signals.push({
          index: i, timestamp: m5[i].timestamp, asset,
          direction: 'NO_OPERAR', confidence: 0,
          patternType: bestPattern?.type || null, sessionType: session.session,
          setupScore, entryPrice: m5[i].close, exitPrice: null,
          result: null, reason: 'NO_OPERAR',
        });
        continue;
      }

      // ═══ VERIFY SIGNAL ═══
      const entryPrice = m5[i].close;
      const exitIdx = Math.min(i + VERIFY_CANDLES, total - 1);
      const exitPrice = m5[exitIdx].close;
      const result = evaluateSignal(direction, entryPrice, exitPrice);

      signals.push({
        index: i, timestamp: m5[i].timestamp, asset,
        direction, confidence,
        patternType: bestPattern?.type || null, sessionType: session.session,
        setupScore, entryPrice, exitPrice,
        result: result as 'WIN' | 'LOSS' | 'DRAW', reason,
      });

    } catch (err: any) {
      // Skip errors silently — keep moving
    }
  }

  return signals;
}

// ══════════════════════════════════════════════════════════════════════════════
// STATISTICS
// ══════════════════════════════════════════════════════════════════════════════

function computeStats(signals: BacktestSignal[]): BacktestStats {
  const active = signals.filter(s => s.direction !== 'NO_OPERAR' && s.result);
  const noOperar = signals.filter(s => s.direction === 'NO_OPERAR');
  const wins = active.filter(s => s.result === 'WIN').length;
  const losses = active.filter(s => s.result === 'LOSS').length;
  const draws = active.filter(s => s.result === 'DRAW').length;
  const wr = active.length > 0 ? (wins / active.length) * 100 : 0;

  const byPattern = makeGroups(active, s => s.patternType || 'none');
  const bySession = makeGroups(active, s => s.sessionType);
  const byAsset = makeGroups(active, s => s.asset);
  const byDirection = makeGroups(active, s => s.direction);

  // Top edges: pattern + session + asset combos
  const comboMap = new Map<string, { pt: string; ses: string; ast: string; t: number; w: number; tc: number; ts: number }>();
  for (const s of active) {
    const key = `${s.patternType || 'none'}|${s.sessionType}|${s.asset}`;
    const e = comboMap.get(key) || { pt: s.patternType || 'none', ses: s.sessionType, ast: s.asset, t: 0, w: 0, tc: 0, ts: 0 };
    e.t++; if (s.result === 'WIN') e.w++; e.tc += s.confidence; e.ts += s.setupScore;
    comboMap.set(key, e);
  }

  const topEdges = Array.from(comboMap.values())
    .filter(c => c.t >= 10)
    .map(c => ({ patternType: c.pt, session: c.ses, asset: c.ast, total: c.t, wins: c.w, winRate: (c.w / c.t) * 100, avgConfidence: c.tc / c.t, avgSetupScore: c.ts / c.t }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 10);

  const worstSetups = Array.from(comboMap.values())
    .filter(c => c.t >= 10)
    .map(c => ({ patternType: c.pt, session: c.ses, asset: c.ast, total: c.t, losses: c.t - c.w, winRate: (c.w / c.t) * 100 }))
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, 5);

  return {
    totalSignals: active.length, totalWins: wins, totalLosses: losses,
    totalDraws: draws, totalNoOperar: noOperar.length, winRate: wr,
    avgConfidence: active.length > 0 ? active.reduce((s, x) => s + x.confidence, 0) / active.length : 0,
    avgSetupScore: active.length > 0 ? active.reduce((s, x) => s + x.setupScore, 0) / active.length : 0,
    byPattern, bySession, byAsset, byDirection, topEdges, worstSetups,
  };
}

function makeGroups(arr: BacktestSignal[], keyFn: (s: BacktestSignal) => string): Record<string, { total: number; wins: number; losses: number; winRate: number }> {
  const result: Record<string, { total: number; wins: number; losses: number; winRate: number }> = {};
  for (const s of arr) {
    const key = keyFn(s);
    if (!result[key]) result[key] = { total: 0, wins: 0, losses: 0, winRate: 0 };
    result[key].total++;
    if (s.result === 'WIN') result[key].wins++;
    if (s.result === 'LOSS') result[key].losses++;
  }
  for (const k of Object.keys(result)) {
    result[k].winRate = result[k].total > 0 ? (result[k].wins / result[k].total) * 100 : 0;
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════════════════════════════════════

function generateReport(stats: BacktestStats, assets: string[], months: number): string {
  const L: string[] = [];

  const e = (wr: number) => wr >= 55 ? '✅' : wr >= 50 ? '🟡' : '❌';

  L.push('');
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║          SIGNALTRADER PRO — REPORTE DE BACKTEST v2                  ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');
  L.push(`📊 Período: ${months} meses | Assets: ${assets.join(', ')}`);
  L.push(`⏱️  Expiración: ${VERIFY_CANDLES * 5} min | Step: cada ${STEP} velas (${STEP * 5} min)`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  RESULTADOS GENERALES');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  const wrV = stats.winRate >= 55 ? 'EDGE POSITIVO ✅' : stats.winRate >= 50 ? 'SIN EDGE CLARO 🟡' : 'EDGE NEGATIVO ❌';
  L.push(`  Señales activas:  ${stats.totalSignals.toLocaleString()}`);
  L.push(`  NO OPERAR:        ${stats.totalNoOperar.toLocaleString()}`);
  L.push(`  Wins:             ${stats.totalWins.toLocaleString()}`);
  L.push(`  Losses:           ${stats.totalLosses.toLocaleString()}`);
  L.push(`  Draws:            ${stats.totalDraws.toLocaleString()}`);
  L.push(`  Win Rate:         ${e(stats.winRate)} ${stats.winRate.toFixed(1)}% — ${wrV}`);
  L.push('');

  // By Asset
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR ASSET');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [asset, d] of Object.entries(stats.byAsset).sort((a, b) => b[1].winRate - a[1].winRate)) {
    L.push(`  ${e(d.winRate)} ${asset.padEnd(10)} ${d.winRate.toFixed(1)}% WR (${d.wins}W/${d.losses}L de ${d.total})`);
  }
  L.push('');

  // By Pattern
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR PATRÓN');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [p, d] of Object.entries(stats.byPattern).sort((a, b) => b[1].winRate - a[1].winRate)) {
    L.push(`  ${e(d.winRate)} ${p.padEnd(25)} ${d.winRate.toFixed(1)}% WR (${d.wins}W/${d.losses}L de ${d.total})`);
  }
  L.push('');

  // By Session
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR SESIÓN');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const s of ['Overlap', 'London', 'NewYork', 'Asia', 'OffHours']) {
    const d = stats.bySession[s];
    if (d) L.push(`  ${e(d.winRate)} ${s.padEnd(10)} ${d.winRate.toFixed(1)}% WR (${d.wins}W/${d.losses}L de ${d.total})`);
  }
  L.push('');

  // By Direction
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR DIRECCIÓN');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [dir, d] of Object.entries(stats.byDirection)) {
    L.push(`  ${e(d.winRate)} ${dir.padEnd(10)} ${d.winRate.toFixed(1)}% WR (${d.wins}W/${d.losses}L de ${d.total})`);
  }
  L.push('');

  // TOP EDGES
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  🏆 TOP EDGES (patrón + sesión + asset, ≥10 muestras)              ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');
  if (stats.topEdges.length === 0) {
    L.push('  ❌ No se encontraron edges con ≥10 muestras.');
  } else {
    for (let i = 0; i < stats.topEdges.length; i++) {
      const t = stats.topEdges[i];
      L.push(`  ${e(t.winRate)} #${i + 1} ${t.patternType} + ${t.session} + ${t.asset}`);
      L.push(`     WR: ${t.winRate.toFixed(1)}% (${t.wins}W/${t.total - t.wins}L de ${t.total}) | Conf: ${t.avgConfidence.toFixed(0)}% | Setup: ${t.avgSetupScore.toFixed(0)}`);
      L.push('');
    }
  }

  // Worst
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  🚫 PEORES SETUPS (EVITAR)');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const w of stats.worstSetups) {
    L.push(`  ❌ ${w.patternType} + ${w.session} + ${w.asset}: ${w.winRate.toFixed(1)}% WR (${w.losses}L de ${w.total})`);
  }
  L.push('');

  // Verdict
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  🎯 VEREDICTO                                                       ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');
  if (stats.winRate >= 55) {
    L.push('  ✅ HAY EDGE. Operar SOLO los top edges encontrados.');
  } else if (stats.winRate >= 50) {
    L.push('  🟡 EDGE MARGINAL. Filtrar por combos específicos.');
    L.push('  → Subir minSetupScore a 30+ para ser más selectivo.');
  } else {
    L.push('  ❌ NO HAY EDGE en M5 con 10 min expiración.');
    L.push('  → Opciones: cambiar timeframe, agregar volumen, o cambiar estrategia.');
  }
  L.push('');

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVE TO DB
// ══════════════════════════════════════════════════════════════════════════════

async function saveStatsToDB(signals: BacktestSignal[]): Promise<void> {
  const { db } = await import('../src/lib/db');
  log('💾 Guardando en Turso DB (SetupStats)...');

  const comboMap = new Map<string, BacktestSignal[]>();
  for (const s of signals.filter(s => s.direction !== 'NO_OPERAR' && s.result && s.result !== 'DRAW')) {
    const key = `${s.patternType || 'none'}|${s.sessionType}|${s.asset}`;
    const g = comboMap.get(key) || [];
    g.push(s);
    comboMap.set(key, g);
  }

  let saved = 0;
  for (const [, group] of comboMap) {
    const patternType = group[0].patternType || 'none';
    const session = group[0].sessionType;
    const asset = group[0].asset;
    const wins = group.filter(s => s.result === 'WIN').length;
    const total = group.length;
    const winRate = (wins / total) * 100;
    const bayes = calculateBayesianStats(wins, total - wins);

    try {
      await db.setupStats.upsert({
        where: { patternType_asset_session_timeframe: { patternType, asset, session, timeframe: 'M5' } },
        create: {
          patternType, asset, session, timeframe: 'M5',
          totalSignals: total, wins, losses: total - wins, winRate,
          avgConfidence: group.reduce((s, x) => s + x.confidence, 0) / total,
          avgSetupScore: group.reduce((s, x) => s + x.setupScore, 0) / total,
          bayesianWinRate: bayes.bayesianWinRate,
          confidenceIntervalLower: bayes.confidenceInterval.lower,
          confidenceIntervalUpper: bayes.confidenceInterval.upper,
          pValue: bayes.pValue, sampleVariance: bayes.sampleVariance,
          avgExpectancy: winRate > 50 ? (winRate / 100 - (100 - winRate) / 100) : -(1 - winRate / 100),
          avgRiskReward: 1,
          avgQualityScore: group.reduce((s, x) => s + x.setupScore, 0) / total,
        },
        update: {
          totalSignals: total, wins, losses: total - wins, winRate,
          bayesianWinRate: bayes.bayesianWinRate,
          confidenceIntervalLower: bayes.confidenceInterval.lower,
          confidenceIntervalUpper: bayes.confidenceInterval.upper,
          pValue: bayes.pValue, sampleVariance: bayes.sampleVariance,
        },
      });
      saved++;
    } catch { /* skip */ }
  }
  log(`  ✅ ${saved} combinaciones guardadas en SetupStats`);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let assets = DEFAULT_ASSETS;
  let months = DEFAULT_MONTHS;
  let saveToDB = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asset' && args[i + 1]) { assets = [args[++i]]; }
    else if (args[i] === '--months' && args[i + 1]) { months = parseInt(args[++i]); }
    else if (args[i] === '--save-db') { saveToDB = true; }
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║          SIGNALTRADER PRO — BACKTESTER v2 (OPTIMIZED)               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Assets: ${assets.join(', ')} | Meses: ${months} | DB: ${saveToDB ? 'SÍ' : 'NO'}`);
  console.log('');

  const allSignals: BacktestSignal[] = [];

  for (const asset of assets) {
    try {
      const candles = await downloadHistoricalData(asset, months);
      const signals = runBacktest(asset, candles);
      allSignals.push(...signals);

      const active = signals.filter(s => s.direction !== 'NO_OPERAR');
      const wins = active.filter(s => s.result === 'WIN').length;
      log(`📊 ${asset}: ${active.length} activas, WR ${(active.length > 0 ? (wins / active.length) * 100 : 0).toFixed(1)}%, ${signals.filter(s => s.direction === 'NO_OPERAR').length} NO_OPERAR`);
    } catch (err: any) {
      console.error(`❌ ${asset}: ${err.message}`);
    }
  }

  if (allSignals.length === 0) {
    console.error('❌ Sin señales. Verifica conexión a Binance.');
    process.exit(1);
  }

  const stats = computeStats(allSignals);
  const report = generateReport(stats, assets, months);
  console.log(report);

  // Save files
  const fs = await import('fs');
  const path = await import('path');
  fs.writeFileSync(path.join(process.cwd(), 'backtest-report.txt'), report, 'utf-8');
  fs.writeFileSync(path.join(process.cwd(), 'backtest-results.json'), JSON.stringify({ stats, signalCount: allSignals.length }, null, 2), 'utf-8');
  console.log('📄 Reporte: backtest-report.txt | JSON: backtest-results.json');

  if (saveToDB) {
    await saveStatsToDB(allSignals);
  } else {
    console.log('');
    console.log('💡 Para alimentar los motores Bayesian/Expectancy con estos datos:');
    console.log('   npx tsx scripts/backtest.ts --save-db');
    console.log('');
  }

  console.log('═══ Backtest completado ═══');
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
