#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — MULTI-EXPIRY BACKTESTER
// Tests ALL expirations at once: 5, 10, 15, 20, 30, 40, 60 min
// Downloads data ONCE, generates signals ONCE, verifies against each expiry
//
// Usage: npx tsx scripts/backtest-expiry.ts
//        npx tsx scripts/backtest-expiry.ts --months 6
//        npx tsx scripts/backtest-expiry.ts --save-db --expiry 20
// ══════════════════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
config({ path: '../.env' });
config({ path: '.env' });

import { computeAllIndicators, type IndicatorSnapshot } from '../src/lib/indicators';
import { detectPatterns, type PatternType } from '../src/lib/patterns';
import { detectSession, type SessionType } from '../src/lib/sessions';
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

// Pre-generated signal (before verification)
interface RawSignal {
  index: number;
  timestamp: Date;
  asset: string;
  direction: 'HIGHER' | 'LOWER';
  confidence: number;
  patternType: PatternType | null;
  sessionType: SessionType;
  setupScore: number;
  entryPrice: number;
}

interface ExpiryResult {
  expiryMin: number;
  expiryCandles: number;
  totalSignals: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  byPattern: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  topEdges: Array<{
    patternType: string; session: string; asset: string;
    total: number; wins: number; winRate: number;
  }>;
  liquiditySweepWR: number;
  fakeoutWR: number;
  engulfingWR: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const ASSET_MAP: Record<string, { binanceSymbol: string }> = {
  'BTC/USD': { binanceSymbol: 'BTCUSDT' },
  'ETH/USD': { binanceSymbol: 'ETHUSDT' },
};

const DEFAULT_ASSETS = ['BTC/USD', 'ETH/USD'];
const DEFAULT_MONTHS = 6;
const MIN_CANDLES = 60;
const STEP = 6;
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

// Expirations to test (in M5 candles)
const EXPIRY_CANDLES = [1, 2, 3, 4, 6, 8, 12]; // 5, 10, 15, 20, 30, 40, 60 min

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
  if (!cfg) throw new Error(`${asset} no disponible en Binance.`);

  const endMs = Date.now();
  const startMs = endMs - months * 30 * 24 * 60 * 60 * 1000;

  log(`📥 Descargando ${asset} M5 (${months} meses)...`);
  const candles = await fetchBinanceKlines(cfg.binanceSymbol, '5m', startMs, endMs);
  log(`  ✅ ${candles.length.toLocaleString()} velas M5 descargadas`);
  return candles;
}

// ══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION (run once, verify multiple times)
// ══════════════════════════════════════════════════════════════════════════════

function getFastDirection(ind: IndicatorSnapshot): { direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR'; confidence: number } {
  let bull = 0, bear = 0;
  if (ind.rsi14 !== null) { if (ind.rsi14 > 55) bull += 1; else if (ind.rsi14 < 45) bear += 1; }
  if (ind.macdHistogram !== null) { if (ind.macdHistogram > 0) bull += 1.5; else bear += 1.5; }
  if (ind.ema12 !== null && ind.ema26 !== null) { if (ind.ema12 > ind.ema26) bull += 1; else bear += 1; }
  if (ind.trend === 'BULLISH') bull += 1; else if (ind.trend === 'BEARISH') bear += 1;
  if (ind.stochK !== null) { if (ind.stochK > 50) bull += 0.5; else bear += 0.5; }

  const diff = bull - bear;
  if (Math.abs(diff) < 1) return { direction: 'NO_OPERAR', confidence: 20 };
  return { direction: diff > 0 ? 'HIGHER' : 'LOWER', confidence: Math.min(65, 20 + Math.abs(diff) * 12) };
}

function getFastSetupScore(pattern: PatternType | null, ind: IndicatorSnapshot, session: { session: SessionType }): number {
  let score = 30;
  if (pattern) score += 10;
  if (session.session === 'Overlap') score += 10;
  else if (session.session === 'London') score += 7;
  else if (session.session === 'NewYork') score += 5;
  else if (session.session === 'Asia') score -= 3;
  else if (session.session === 'OffHours') score -= 15;
  if (ind.volumeAnalysis.volumeSpike) score += 8;
  else if (ind.volumeAnalysis.relativeVolume > 1.3) score += 4;
  if (ind.rsi14 !== null) { if (ind.rsi14 > 50) score += 3; else score -= 3; }
  if (ind.macdHistogram !== null) { if (ind.macdHistogram > 0) score += 3; else score -= 3; }
  return Math.min(100, Math.max(0, Math.round(score)));
}

function generateSignals(asset: string, m5: Candle[]): RawSignal[] {
  const signals: RawSignal[] = [];
  const total = m5.length;
  const maxExpiry = Math.max(...EXPIRY_CANDLES);

  log(`🔄 Generando señales ${asset}: ${total.toLocaleString()} velas (cada ${STEP})`);

  for (let i = MIN_CANDLES; i < total - maxExpiry; i += STEP) {
    if ((i - MIN_CANDLES) % (STEP * 2000) === 0) {
      const pct = Math.floor((i / total) * 100);
      log(`   ${pct}% — ${signals.length} señales`);
    }

    try {
      const window = m5.slice(Math.max(0, i - 99), i + 1);
      if (window.length < 50) continue;

      const indicators = computeAllIndicators(window);
      if (indicators.rsi14 === null) continue;

      const patterns = detectPatterns(window, indicators);
      const bestPattern = patterns.length > 0
        ? patterns.reduce((a, b) => a.confidence > b.confidence ? a : b)
        : null;

      const session = detectSession(m5[i].timestamp);
      if (session.session === 'OffHours') continue;

      let direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR';
      let confidence: number;

      if (bestPattern) {
        direction = bestPattern.direction === 'BULLISH' ? 'HIGHER' : 'LOWER';
        confidence = bestPattern.confidence;
      } else {
        const indDir = getFastDirection(indicators);
        direction = indDir.direction;
        confidence = indDir.confidence;
      }

      if (direction === 'NO_OPERAR') continue;
      if (confidence < 15 && !bestPattern) continue;

      const setupScore = getFastSetupScore(bestPattern?.type || null, indicators, session);

      signals.push({
        index: i,
        timestamp: m5[i].timestamp,
        asset,
        direction: direction as 'HIGHER' | 'LOWER',
        confidence,
        patternType: bestPattern?.type || null,
        sessionType: session.session,
        setupScore,
        entryPrice: m5[i].close,
      });
    } catch {
      // skip
    }
  }

  log(`  ✅ ${signals.length} señales generadas para ${asset}`);
  return signals;
}

// ══════════════════════════════════════════════════════════════════════════════
// VERIFY AT MULTIPLE EXPIRATIONS
// ══════════════════════════════════════════════════════════════════════════════

function verifyAtExpiry(
  signals: RawSignal[],
  candles: Candle[],
  asset: string,
  expiryCandles: number
): ExpiryResult {
  const total = candles.length;
  let wins = 0, losses = 0, draws = 0;

  const byPattern: Record<string, { total: number; wins: number; losses: number; winRate: number }> = {};
  const comboMap = new Map<string, { pt: string; ses: string; ast: string; t: number; w: number }>();

  for (const s of signals) {
    if (s.asset !== asset) continue;

    const exitIdx = Math.min(s.index + expiryCandles, total - 1);
    if (exitIdx <= s.index) continue;

    const exitPrice = candles[exitIdx].close;
    const result = evaluateSignal(s.direction, s.entryPrice, exitPrice);

    if (result === 'WIN') wins++;
    else if (result === 'LOSS') losses++;
    else draws++;

    // By pattern
    const pKey = s.patternType || 'none';
    if (!byPattern[pKey]) byPattern[pKey] = { total: 0, wins: 0, losses: 0, winRate: 0 };
    byPattern[pKey].total++;
    if (result === 'WIN') byPattern[pKey].wins++;
    if (result === 'LOSS') byPattern[pKey].losses++;

    // By combo
    const cKey = `${s.patternType || 'none'}|${s.sessionType}|${s.asset}`;
    const combo = comboMap.get(cKey) || { pt: s.patternType || 'none', ses: s.sessionType, ast: s.asset, t: 0, w: 0 };
    combo.t++; if (result === 'WIN') combo.w++;
    comboMap.set(cKey, combo);
  }

  // Calculate win rates
  for (const k of Object.keys(byPattern)) {
    byPattern[k].winRate = byPattern[k].total > 0 ? (byPattern[k].wins / byPattern[k].total) * 100 : 0;
  }

  const totalSignals = wins + losses + draws;
  const winRate = totalSignals > 0 ? (wins / totalSignals) * 100 : 0;

  const topEdges = Array.from(comboMap.values())
    .filter(c => c.t >= 10)
    .map(c => ({ patternType: c.pt, session: c.ses, asset: c.ast, total: c.t, wins: c.w, winRate: (c.w / c.t) * 100 }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 10);

  return {
    expiryMin: expiryCandles * 5,
    expiryCandles,
    totalSignals,
    wins,
    losses,
    draws,
    winRate,
    byPattern,
    topEdges,
    liquiditySweepWR: byPattern['liquidity_sweep']?.winRate || 0,
    fakeoutWR: byPattern['fakeout']?.winRate || 0,
    engulfingWR: byPattern['engulfing']?.winRate || 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════════════════════════════════════

function generateExpiryReport(results: ExpiryResult[], months: number): string {
  const L: string[] = [];
  const e = (wr: number) => wr >= 55 ? '✅' : wr >= 50 ? '🟡' : '❌';

  L.push('');
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║     SIGNALTRADER PRO — MULTI-EXPIRY BACKTEST                        ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');
  L.push(`📊 Período: ${months} meses | Assets: BTC/USD, ETH/USD`);
  L.push('');

  // ═══ COMPARISON TABLE ═══
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  COMPARACIÓN POR EXPIRACIÓN');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push('  Expiración   WR Total   liq_sweep  fakeout   engulfing  Señales');
  L.push('  ─────────── ────────── ────────── ──────── ────────── ────────');

  // Sort by liquidity_sweep WR (most promising pattern)
  const sorted = [...results].sort((a, b) => b.liquiditySweepWR - a.liquiditySweepWR);

  let bestExpiry: ExpiryResult | null = null;
  let bestLiqSweepWR = 0;

  for (const r of sorted) {
    const marker = r.liquiditySweepWR >= 55 ? ' 🏆' : '';
    L.push(`  ${r.expiryMin.toString().padStart(3)} min      ${e(r.winRate)} ${r.winRate.toFixed(1)}%    ${e(r.liquiditySweepWR)} ${r.liquiditySweepWR.toFixed(1)}%   ${e(r.fakeoutWR)} ${r.fakeoutWR.toFixed(1)}%   ${e(r.engulfingWR)} ${r.engulfingWR.toFixed(1)}%   ${r.totalSignals.toLocaleString()}${marker}`);

    if (r.liquiditySweepWR > bestLiqSweepWR) {
      bestLiqSweepWR = r.liquiditySweepWR;
      bestExpiry = r;
    }
  }
  L.push('');

  // ═══ BEST EXPIRY DETAILS ═══
  if (bestExpiry) {
    L.push('══════════════════════════════════════════════════════════════════════');
    L.push(`  🏆 MEJOR EXPIRACIÓN: ${bestExpiry.expiryMin} MIN (${bestExpiry.expiryCandles} velas M5)`);
    L.push('══════════════════════════════════════════════════════════════════════');
    L.push('');
    L.push(`  WR Total: ${e(bestExpiry.winRate)} ${bestExpiry.winRate.toFixed(1)}%`);
    L.push(`  Wins: ${bestExpiry.wins.toLocaleString()} | Losses: ${bestExpiry.losses.toLocaleString()} | Draws: ${bestExpiry.draws}`);
    L.push('');

    L.push('  Por patrón:');
    for (const [p, d] of Object.entries(bestExpiry.byPattern).sort((a, b) => b[1].winRate - a[1].winRate)) {
      L.push(`    ${e(d.winRate)} ${p.padEnd(25)} ${d.winRate.toFixed(1)}% WR (${d.wins}W/${d.losses}L de ${d.total})`);
    }
    L.push('');

    L.push('  🏆 Top Edges (≥10 muestras):');
    if (bestExpiry.topEdges.length === 0) {
      L.push('    ❌ No se encontraron edges con ≥10 muestras.');
    } else {
      for (let i = 0; i < Math.min(bestExpiry.topEdges.length, 10); i++) {
        const t = bestExpiry.topEdges[i];
        L.push(`    ${e(t.winRate)} #${i + 1} ${t.patternType} + ${t.session} + ${t.asset}`);
        L.push(`       WR: ${t.winRate.toFixed(1)}% (${t.wins}W/${t.total - t.wins}L de ${t.total})`);
      }
    }
    L.push('');
  }

  // ═══ EXPIRY CURVE FOR liquidity_sweep ═══
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  📈 CURVA DE EXPIRACIÓN — liquidity_sweep');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');

  for (const r of results.sort((a, b) => a.expiryMin - b.expiryMin)) {
    const wr = r.liquiditySweepWR;
    const bar = '█'.repeat(Math.round(wr / 2));
    const empty = '░'.repeat(Math.max(0, 50 - Math.round(wr / 2)));
    L.push(`  ${r.expiryMin.toString().padStart(3)} min  ${bar}${empty}  ${wr.toFixed(1)}%`);
  }
  L.push('');

  // ═══ ALL PATTERNS CURVE ═══
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  📈 CURVA DE EXPIRACIÓN — TODOS LOS PATRONES');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');

  // Header
  const headerPatterns = ['liquidity_sweep', 'fakeout', 'engulfing', 'reversal', 'breakout', 'trend_continuation', 'none'];
  L.push(`  Expiración  ${headerPatterns.map(p => p.substring(0, 8).padStart(8)).join('  ')}`);
  L.push(`  ──────────  ${headerPatterns.map(() => '────────').join('  ')}`);

  for (const r of results.sort((a, b) => a.expiryMin - b.expiryMin)) {
    const vals = headerPatterns.map(p => {
      const d = r.byPattern[p];
      return d ? `${d.winRate.toFixed(0)}%`.padStart(8) : '   -'.padStart(8);
    });
    L.push(`  ${r.expiryMin.toString().padStart(3)} min     ${vals.join('  ')}`);
  }
  L.push('');

  // ═══ VERDICT ═══
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  🎯 VEREDICTO                                                       ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');

  if (bestExpiry && bestExpiry.liquiditySweepWR >= 55) {
    L.push(`  ✅ EDGE ENCONTRADO con ${bestExpiry.expiryMin} min de expiración.`);
    L.push(`  → liquidity_sweep: ${bestExpiry.liquiditySweepWR.toFixed(1)}% WR`);
    L.push('');
    L.push(`  💡 Para guardar en DB con esta expiración:`);
    L.push(`     npx tsx scripts/backtest.ts --save-db --expiry ${bestExpiry.expiryMin}`);
  } else if (bestExpiry && bestExpiry.liquiditySweepWR >= 50) {
    L.push(`  🟡 EDGE MARGINAL con ${bestExpiry.expiryMin} min de expiración.`);
    L.push(`  → liquidity_sweep: ${bestExpiry.liquiditySweepWR.toFixed(1)}% WR`);
    L.push(`  → Se puede operar con cautela y gestión de riesgo estricta.`);
    L.push('');
    L.push(`  💡 Para guardar en DB con esta expiración:`);
    L.push(`     npx tsx scripts/backtest.ts --save-db --expiry ${bestExpiry.expiryMin}`);
  } else {
    L.push(`  ❌ No hay edge claro en ninguna expiración para M5.`);
    L.push(`  → liquidity_sweep alcanza máximo ${bestLiqSweepWR.toFixed(1)}% WR.`);
    L.push(`  → Opciones: cambiar timeframe a M15 o H1, o cambiar estrategia.`);
  }
  L.push('');

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVE TO DB WITH SPECIFIC EXPIRY
// ══════════════════════════════════════════════════════════════════════════════

async function saveExpiryToDB(
  allSignals: RawSignal[],
  allCandles: Map<string, Candle[]>,
  expiryCandles: number
): Promise<void> {
  const { db } = await import('../src/lib/db');
  log(`💾 Guardando en DB con expiración ${expiryCandles * 5} min...`);

  // Verify all signals at this expiry
  interface VerifiedSignal extends RawSignal {
    result: 'WIN' | 'LOSS' | 'DRAW';
  }

  const verified: VerifiedSignal[] = [];

  allCandles.forEach((candles, asset) => {
    const assetSignals = allSignals.filter(s => s.asset === asset);
    const total = candles.length;

    for (const s of assetSignals) {
      const exitIdx = Math.min(s.index + expiryCandles, total - 1);
      if (exitIdx <= s.index) continue;

      const exitPrice = candles[exitIdx].close;
      const result = evaluateSignal(s.direction, s.entryPrice, exitPrice);

      verified.push({ ...s, result: result as 'WIN' | 'LOSS' | 'DRAW' });
    }
  });

  // Group by combo
  const comboMap = new Map<string, VerifiedSignal[]>();
  for (const s of verified.filter(s => s.result !== 'DRAW')) {
    const key = `${s.patternType || 'none'}|${s.sessionType}|${s.asset}`;
    const g = comboMap.get(key) || [];
    g.push(s);
    comboMap.set(key, g);
  }

  let saved = 0;
  comboMap.forEach((group) => {
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
  });
  log(`  ✅ ${saved} combinaciones guardadas (expiración ${expiryCandles * 5} min)`);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let assets = DEFAULT_ASSETS;
  let months = DEFAULT_MONTHS;
  let saveDBExpiry = 0; // 0 = don't save, >0 = save with this expiry in minutes

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asset' && args[i + 1]) { assets = [args[++i]]; }
    else if (args[i] === '--months' && args[i + 1]) { months = parseInt(args[++i]); }
    else if (args[i] === '--save-db' && args[i + 1] && args[i + 1].startsWith('--')) { saveDBExpiry = -1; }
    else if (args[i] === '--save-db' && args[i + 1] && !args[i + 1].startsWith('--')) { saveDBExpiry = parseInt(args[++i]); }
    else if (args[i] === '--save-db') { saveDBExpiry = -1; }
    else if (args[i] === '--expiry' && args[i + 1]) { saveDBExpiry = parseInt(args[++i]); }
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     SIGNALTRADER PRO — MULTI-EXPIRY BACKTEST                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Assets: ${assets.join(', ')} | Meses: ${months}`);
  console.log(`  Expiraciones: ${EXPIRY_CANDLES.map(c => `${c * 5}min`).join(', ')}`);
  console.log('');

  // Step 1: Download data ONCE
  const allCandles = new Map<string, Candle[]>();
  for (const asset of assets) {
    const candles = await downloadHistoricalData(asset, months);
    allCandles.set(asset, candles);
  }

  // Step 2: Generate signals ONCE
  const allSignals: RawSignal[] = [];
  allCandles.forEach((candles, asset) => {
    const signals = generateSignals(asset, candles);
    allSignals.push(...signals);
  });

  log(`📊 Total: ${allSignals.length} señales activas generadas`);
  console.log('');

  // Step 3: Verify at EACH expiry
  const results: ExpiryResult[] = [];

  for (const expiryCandles of EXPIRY_CANDLES) {
    const expiryMin = expiryCandles * 5;
    log(`⏱️  Verificando expiración ${expiryMin} min...`);

    let combinedResult: ExpiryResult = {
      expiryMin, expiryCandles,
      totalSignals: 0, wins: 0, losses: 0, draws: 0, winRate: 0,
      byPattern: {}, topEdges: [],
      liquiditySweepWR: 0, fakeoutWR: 0, engulfingWR: 0,
    };

    allCandles.forEach((candles, asset) => {
      const assetResult = verifyAtExpiry(allSignals, candles, asset, expiryCandles);

      // Merge results
      combinedResult.totalSignals += assetResult.totalSignals;
      combinedResult.wins += assetResult.wins;
      combinedResult.losses += assetResult.losses;
      combinedResult.draws += assetResult.draws;

      // Merge byPattern
      for (const [p, d] of Object.entries(assetResult.byPattern)) {
        if (!combinedResult.byPattern[p]) {
          combinedResult.byPattern[p] = { total: 0, wins: 0, losses: 0, winRate: 0 };
        }
        combinedResult.byPattern[p].total += d.total;
        combinedResult.byPattern[p].wins += d.wins;
        combinedResult.byPattern[p].losses += d.losses;
      }

      // Merge top edges
      // We'll recompute from merged data below
    });

    // Calculate merged win rates
    combinedResult.winRate = combinedResult.totalSignals > 0
      ? (combinedResult.wins / combinedResult.totalSignals) * 100 : 0;

    for (const k of Object.keys(combinedResult.byPattern)) {
      const d = combinedResult.byPattern[k];
      d.winRate = d.total > 0 ? (d.wins / d.total) * 100 : 0;
    }

    combinedResult.liquiditySweepWR = combinedResult.byPattern['liquidity_sweep']?.winRate || 0;
    combinedResult.fakeoutWR = combinedResult.byPattern['fakeout']?.winRate || 0;
    combinedResult.engulfingWR = combinedResult.byPattern['engulfing']?.winRate || 0;

    // Recompute top edges from all signals at this expiry
    const comboMap = new Map<string, { pt: string; ses: string; ast: string; t: number; w: number }>();
    allCandles.forEach((candles, asset) => {
      for (const s of allSignals.filter(s => s.asset === asset)) {
        const exitIdx = Math.min(s.index + expiryCandles, candles.length - 1);
        if (exitIdx <= s.index) continue;
        const exitPrice = candles[exitIdx].close;
        const result = evaluateSignal(s.direction, s.entryPrice, exitPrice);
        if (result === 'DRAW') continue;

        const key = `${s.patternType || 'none'}|${s.sessionType}|${s.asset}`;
        const combo = comboMap.get(key) || { pt: s.patternType || 'none', ses: s.sessionType, ast: s.asset, t: 0, w: 0 };
        combo.t++; if (result === 'WIN') combo.w++;
        comboMap.set(key, combo);
      }
    });

    combinedResult.topEdges = Array.from(comboMap.values())
      .filter(c => c.t >= 10)
      .map(c => ({ patternType: c.pt, session: c.ses, asset: c.ast, total: c.t, wins: c.w, winRate: (c.w / c.t) * 100 }))
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 10);

    results.push(combinedResult);
  }

  // Step 4: Generate report
  const report = generateExpiryReport(results, months);
  console.log(report);

  // Save report
  const fs = await import('fs');
  const path = await import('path');
  fs.writeFileSync(path.join(process.cwd(), 'backtest-expiry-report.txt'), report, 'utf-8');
  fs.writeFileSync(path.join(process.cwd(), 'backtest-expiry-results.json'), JSON.stringify(results, null, 2), 'utf-8');
  console.log('📄 Reporte: backtest-expiry-report.txt | JSON: backtest-expiry-results.json');

  // Step 5: Save to DB if requested
  if (saveDBExpiry > 0) {
    const expiryCandles = Math.round(saveDBExpiry / 5);
    await saveExpiryToDB(allSignals, allCandles, expiryCandles);
  } else if (saveDBExpiry === -1) {
    // Auto-detect best expiry for liquidity_sweep
    const best = results.sort((a, b) => b.liquiditySweepWR - a.liquiditySweepWR)[0];
    if (best) {
      console.log('');
      console.log(`💡 Mejor expiración auto-detectada: ${best.expiryMin} min`);
      await saveExpiryToDB(allSignals, allCandles, best.expiryCandles);
    }
  } else {
    console.log('');
    console.log('💡 Para guardar en DB con la mejor expiración:');
    console.log('   npx tsx scripts/backtest-expiry.ts --save-db');
    console.log('');
    console.log('   O con expiración específica (ej: 30 min):');
    console.log('   npx tsx scripts/backtest-expiry.ts --save-db --expiry 30');
  }

  console.log('═══ Multi-Expiry Backtest completado ═══');
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
