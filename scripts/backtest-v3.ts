#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — BACKTESTER v3 (REALISTIC)
// Downloads historical data from Bybit/Binance, simulates the FULL pipeline
// with SL/TP, fees, slippage, equity curve, and multi-timeframe analysis.
//
// Key improvements over v2:
// - ATR-based SL/TP simulation (like the real auto-trader)
// - Fee tracking: 0.06% taker fee per side = 0.12% round trip
// - Slippage simulation: 0.01-0.05% per trade
// - Equity curve and max drawdown tracking
// - Multi-timeframe analysis (M5, M15, H1)
// - Multiple expiration windows (10min, 30min, 1h, 2h)
// - Expected Value calculation with realistic costs
//
// Usage: npx tsx scripts/backtest-v3.ts
//        npx tsx scripts/backtest-v3.ts --asset BTC/USD --months 6
//        npx tsx scripts/backtest-v3.ts --save-db --timeframe 15m
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

interface BacktestTrade {
  index: number;
  timestamp: Date;
  asset: string;
  direction: 'HIGHER' | 'LOWER';
  entryPrice: number;
  exitPrice: number;
  exitReason: 'SL_HIT' | 'TP_HIT' | 'EXPIRATION' | 'TRAILING_STOP';
  pnl: number;         // After fees
  pnlPct: number;      // After fees
  fees: number;        // Total fees (entry + exit)
  slippage: number;    // Total slippage
  stopLoss: number;
  takeProfit: number;
  patternType: PatternType | null;
  sessionType: SessionType;
  setupScore: number;
  confidence: number;
  holdingBars: number; // How many bars the trade was open
}

interface EquityPoint {
  timestamp: Date;
  equity: number;
  drawdownPct: number;
}

interface BacktestConfig {
  asset: string;
  timeframe: string;     // '5m', '15m', '1h'
  months: number;
  initialBalance: number;
  riskPerTrade: number;  // % of account
  takerFeePct: number;   // 0.06% per side
  slippagePct: number;   // 0.01-0.05% per trade
  atrMultiplierSL: number; // 1.5x ATR for SL
  riskRewardRatio: number;  // 1.5:1
  expirationBars: number;   // How many bars until forced exit
  minCandles: number;     // Minimum candle window
  step: number;           // Process every Nth candle
}

interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  finalBalance: number;
  totalReturn: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  totalWins: number;
  totalLosses: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  expectedValue: number;
  avgHoldingBars: number;
  totalFees: number;
  totalSlippage: number;
  byPattern: Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnlPct: number }>;
  bySession: Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnlPct: number }>;
  byExitReason: Record<string, { total: number; pnl: number }>;
  topEdges: Array<{
    patternType: string; session: string; asset: string;
    total: number; wins: number; winRate: number; avgPnlPct: number; ev: number;
  }>;
  worstSetups: Array<{
    patternType: string; session: string; asset: string;
    total: number; losses: number; winRate: number; avgPnlPct: number;
  }>;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const ASSET_MAP: Record<string, { symbol: string; decimals: number }> = {
  'BTC/USD': { symbol: 'BTCUSDT', decimals: 2 },
  'ETH/USD': { symbol: 'ETHUSDT', decimals: 2 },
};

const BINANCE_API = 'https://api.binance.com/api/v3/klines';
const BYBIT_API = 'https://api.bybit.com/v5/market/kline';

const TIMEFRAME_MAP: Record<string, { binance: string; bybit: string; minutes: number }> = {
  '5m':  { binance: '5m',  bybit: '5',  minutes: 5 },
  '15m': { binance: '15m', bybit: '15', minutes: 15 },
  '1h':  { binance: '1h',  bybit: '60', minutes: 60 },
};

function log(msg: string) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA DOWNLOADERS (Binance + Bybit fallback)
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
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as any[][];
        if (data.length === 0) return allCandles;
        for (const k of data) {
          allCandles.push({
            timestamp: new Date(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
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

async function fetchBybitKlines(
  symbol: string, interval: string, startTimeMs: number, endTimeMs: number
): Promise<Candle[]> {
  const allCandles: Candle[] = [];
  let currentEnd = endTimeMs;

  while (currentEnd > startTimeMs) {
    const url = `${BYBIT_API}?category=linear&symbol=${symbol}&interval=${interval}&end=${currentEnd}&limit=200`;
    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as any;
        if (data.retCode !== 0 || !data.result?.list?.length) return allCandles;
        for (const k of data.result.list) {
          const ts = parseInt(k[0]);
          if (ts < startTimeMs) return allCandles;
          allCandles.push({
            timestamp: new Date(ts), open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
          });
        }
        const oldestTs = parseInt(data.result.list[data.result.list.length - 1][0]);
        currentEnd = oldestTs - 1;
        break;
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        await sleep(2000);
      }
    }
    await sleep(200); // Rate limit
  }
  return allCandles;
}

async function downloadHistoricalData(asset: string, timeframe: string, months: number): Promise<Candle[]> {
  const cfg = ASSET_MAP[asset];
  if (!cfg) throw new Error(`${asset} not supported.`);
  const tf = TIMEFRAME_MAP[timeframe];
  if (!tf) throw new Error(`Timeframe ${timeframe} not supported.`);

  const endMs = Date.now();
  const startMs = endMs - months * 30 * 24 * 60 * 60 * 1000;

  // Try Binance first, then Bybit
  let candles: Candle[] = [];
  try {
    log(`📥 Downloading ${asset} ${timeframe} (${months} months) from Binance...`);
    candles = await fetchBinanceKlines(cfg.symbol, tf.binance, startMs, endMs);
    if (candles.length > 100) {
      log(`  ✅ ${candles.length.toLocaleString()} candles from Binance`);
      return candles;
    }
  } catch (err: any) {
    log(`  ⚠️ Binance failed: ${err.message}, trying Bybit...`);
  }

  try {
    log(`📥 Downloading ${asset} ${timeframe} (${months} months) from Bybit...`);
    candles = await fetchBybitKlines(cfg.symbol, tf.bybit, startMs, endMs);
    log(`  ✅ ${candles.length.toLocaleString()} candles from Bybit`);
  } catch (err: any) {
    log(`  ❌ Bybit also failed: ${err.message}`);
  }

  return candles;
}

// ══════════════════════════════════════════════════════════════════════════════
// ATR CALCULATION
// ══════════════════════════════════════════════════════════════════════════════

function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || low;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}

// ══════════════════════════════════════════════════════════════════════════════
// FAST INDICATOR DIRECTION
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

// ══════════════════════════════════════════════════════════════════════════════
// REALISTIC BACKTEST ENGINE v3
// ══════════════════════════════════════════════════════════════════════════════

function runBacktest(candles: Candle[], cfg: BacktestConfig): BacktestResult {
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let balance = cfg.initialBalance;
  let peakEquity = balance;
  const total = candles.length;

  const tfMinutes = TIMEFRAME_MAP[cfg.timeframe]?.minutes || 5;

  log(`🔄 Simulating ${cfg.asset} ${cfg.timeframe}: ${total.toLocaleString()} candles (every ${cfg.step}th)`);

  for (let i = cfg.minCandles; i < total - cfg.expirationBars; i += cfg.step) {
    // Progress
    if ((i - cfg.minCandles) % (cfg.step * 500) === 0) {
      const pct = Math.floor((i / total) * 100);
      log(`   ${pct}% — ${trades.length} trades | Balance: $${balance.toFixed(2)}`);
    }

    try {
      // Slice window (no look-ahead)
      const window = candles.slice(Math.max(0, i - 99), i + 1);
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
      const session = detectSession(candles[i].timestamp);
      if (session.session === 'OffHours') continue;

      // Step 4: Direction
      let direction: 'HIGHER' | 'LOWER';
      let confidence: number;
      if (bestPattern) {
        direction = bestPattern.direction === 'BULLISH' ? 'HIGHER' : 'LOWER';
        confidence = bestPattern.confidence;
      } else {
        const indDir = getFastDirection(indicators);
        if (indDir.direction === 'NO_OPERAR' || indDir.confidence < 20) continue;
        direction = indDir.direction;
        confidence = indDir.confidence;
      }

      // Step 5: Setup score
      const setupScore = getFastSetupScore(bestPattern?.type || null, indicators, session);
      if (setupScore < 20) continue;

      // Step 6: ATR for SL/TP
      const atr = calculateATR(window, 14);
      if (atr <= 0) continue;

      // ═══ CALCULATE SL/TP (like the real auto-trader) ═══
      const entryPrice = candles[i].close;
      const isCrypto = entryPrice > 1000;
      const maxSlPercent = isCrypto ? 0.008 : 0.005; // 0.8% for crypto, 0.5% for forex
      const minSlPercent = isCrypto ? 0.002 : 0.001;

      let stopDistance = atr * cfg.atrMultiplierSL;
      const maxDistance = entryPrice * maxSlPercent;
      const minDistance = entryPrice * minSlPercent;
      stopDistance = Math.max(minDistance, Math.min(stopDistance, maxDistance));

      let stopLoss: number;
      let takeProfit: number;
      if (direction === 'HIGHER') {
        stopLoss = entryPrice - stopDistance;
        takeProfit = entryPrice + (stopDistance * cfg.riskRewardRatio);
      } else {
        stopLoss = entryPrice + stopDistance;
        takeProfit = entryPrice - (stopDistance * cfg.riskRewardRatio);
      }

      // ═══ POSITION SIZING ═══
      const riskAmount = balance * (cfg.riskPerTrade / 100);
      const positionSize = riskAmount / stopDistance;

      // ═══ SIMULATE TRADE ═══
      // Apply entry slippage
      const entrySlip = entryPrice * (Math.random() * 0.04 + 0.01) / 100;
      const actualEntry = direction === 'HIGHER'
        ? entryPrice + entrySlip  // Buy at slightly higher
        : entryPrice - entrySlip; // Sell at slightly lower

      // Entry fee
      const entryFee = positionSize * actualEntry * (cfg.takerFeePct / 100);

      // ═══ Check each future bar for SL/TP/expiration ═══
      let exitPrice = 0;
      let exitReason: BacktestTrade['exitReason'] = 'EXPIRATION';
      let holdingBars = 0;

      for (let j = i + 1; j <= Math.min(i + cfg.expirationBars, total - 1); j++) {
        holdingBars++;
        const bar = candles[j];
        const isBuy = direction === 'HIGHER';

        // Check SL hit (high/low wicks)
        if (isBuy && bar.low <= stopLoss) {
          exitPrice = stopLoss;
          exitReason = 'SL_HIT';
          break;
        }
        if (!isBuy && bar.high >= stopLoss) {
          exitPrice = stopLoss;
          exitReason = 'SL_HIT';
          break;
        }

        // Check TP hit
        if (isBuy && bar.high >= takeProfit) {
          exitPrice = takeProfit;
          exitReason = 'TP_HIT';
          break;
        }
        if (!isBuy && bar.low <= takeProfit) {
          exitPrice = takeProfit;
          exitReason = 'TP_HIT';
          break;
        }

        // Expiration
        if (j === i + cfg.expirationBars) {
          exitPrice = bar.close;
          exitReason = 'EXPIRATION';
        }
      }

      if (exitPrice === 0) continue;

      // Apply exit slippage
      const exitSlip = exitPrice * (Math.random() * 0.04 + 0.01) / 100;
      const actualExit = direction === 'HIGHER'
        ? exitPrice - exitSlip  // Sell at slightly lower
        : exitPrice + exitSlip; // Buy at slightly higher

      // Exit fee
      const exitFee = positionSize * actualExit * (cfg.takerFeePct / 100);
      const totalFees = entryFee + exitFee;
      const totalSlippage = entrySlip * positionSize + exitSlip * positionSize;

      // P&L
      let rawPnl: number;
      if (direction === 'HIGHER') {
        rawPnl = (actualExit - actualEntry) * positionSize;
      } else {
        rawPnl = (actualEntry - actualExit) * positionSize;
      }
      const netPnl = rawPnl - totalFees;
      const pnlPct = positionSize > 0 && actualEntry > 0
        ? (netPnl / (actualEntry * positionSize)) * 100
        : 0;

      // Update balance
      balance += netPnl;
      peakEquity = Math.max(peakEquity, balance);
      const drawdownPct = peakEquity > 0 ? ((peakEquity - balance) / peakEquity) * 100 : 0;

      // Record equity point
      equityCurve.push({
        timestamp: candles[i].timestamp,
        equity: balance,
        drawdownPct,
      });

      trades.push({
        index: i,
        timestamp: candles[i].timestamp,
        asset: cfg.asset,
        direction,
        entryPrice: actualEntry,
        exitPrice: actualExit,
        exitReason,
        pnl: netPnl,
        pnlPct,
        fees: totalFees,
        slippage: totalSlippage,
        stopLoss,
        takeProfit,
        patternType: bestPattern?.type || null,
        sessionType: session.session,
        setupScore,
        confidence,
        holdingBars,
      });

    } catch (err: any) {
      // Skip errors silently
    }
  }

  // ═══ COMPUTE STATISTICS ═══
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const totalSlippage = trades.reduce((s, t) => s + t.slippage, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const expectedValue = trades.length > 0 ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;

  // Max drawdown
  let maxDrawdown = 0;
  for (const ep of equityCurve) {
    maxDrawdown = Math.max(maxDrawdown, ep.drawdownPct);
  }

  // Sharpe ratio (simplified)
  const returns = trades.map(t => t.pnlPct);
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1)
    : 0;
  const sharpeRatio = variance > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  // By pattern
  const byPattern = makeGroups(trades, t => t.patternType || 'none');
  // By session
  const bySession = makeGroups(trades, t => t.sessionType);
  // By exit reason
  const byExitReason: Record<string, { total: number; pnl: number }> = {};
  for (const t of trades) {
    if (!byExitReason[t.exitReason]) byExitReason[t.exitReason] = { total: 0, pnl: 0 };
    byExitReason[t.exitReason].total++;
    byExitReason[t.exitReason].pnl += t.pnl;
  }

  // Top edges
  const comboMap = new Map<string, { pt: string; ses: string; ast: string; t: number; w: number; pnl: number }>();
  for (const t of trades) {
    const key = `${t.patternType || 'none'}|${t.sessionType}|${t.asset}`;
    const e = comboMap.get(key) || { pt: t.patternType || 'none', ses: t.sessionType, ast: t.asset, t: 0, w: 0, pnl: 0 };
    e.t++; if (t.pnl > 0) e.w++; e.pnl += t.pnl;
    comboMap.set(key, e);
  }

  const topEdges = Array.from(comboMap.values())
    .filter(c => c.t >= 10)
    .map(c => ({
      patternType: c.pt, session: c.ses, asset: c.ast,
      total: c.t, wins: c.w, winRate: (c.w / c.t) * 100,
      avgPnlPct: trades.filter(t => (t.patternType || 'none') === c.pt && t.sessionType === c.ses && t.asset === c.ast)
        .reduce((s, t) => s + t.pnlPct, 0) / c.t,
      ev: c.pnl / c.t,
    }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 10);

  const worstSetups = Array.from(comboMap.values())
    .filter(c => c.t >= 10)
    .map(c => ({
      patternType: c.pt, session: c.ses, asset: c.ast,
      total: c.t, losses: c.t - c.w, winRate: (c.w / c.t) * 100,
      avgPnlPct: trades.filter(t => (t.patternType || 'none') === c.pt && t.sessionType === c.ses && t.asset === c.ast)
        .reduce((s, t) => s + t.pnlPct, 0) / c.t,
    }))
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, 5);

  return {
    trades, equityCurve, finalBalance: balance,
    totalReturn: balance - cfg.initialBalance,
    totalReturnPct: ((balance - cfg.initialBalance) / cfg.initialBalance) * 100,
    maxDrawdownPct: maxDrawdown,
    sharpeRatio,
    winRate,
    totalWins: wins.length,
    totalLosses: losses.length,
    avgWinPct,
    avgLossPct,
    profitFactor,
    expectedValue,
    avgHoldingBars: trades.length > 0 ? trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length : 0,
    totalFees,
    totalSlippage,
    byPattern,
    bySession,
    byExitReason,
    topEdges,
    worstSetups,
  };
}

function makeGroups(arr: BacktestTrade[], keyFn: (t: BacktestTrade) => string): Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnlPct: number }> {
  const result: Record<string, { total: number; wins: number; losses: number; pnlSum: number }> = {};
  for (const t of arr) {
    const key = keyFn(t);
    if (!result[key]) result[key] = { total: 0, wins: 0, losses: 0, pnlSum: 0 };
    result[key].total++;
    if (t.pnl > 0) result[key].wins++;
    else result[key].losses++;
    result[key].pnlSum += t.pnlPct;
  }
  const out: Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnlPct: number }> = {};
  for (const [k, v] of Object.entries(result)) {
    out[k] = { total: v.total, wins: v.wins, losses: v.losses, winRate: (v.wins / v.total) * 100, avgPnlPct: v.pnlSum / v.total };
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATOR
// ══════════════════════════════════════════════════════════════════════════════

function generateReport(result: BacktestResult, cfg: BacktestConfig): string {
  const L: string[] = [];
  const e = (wr: number) => wr >= 55 ? '✅' : wr >= 50 ? '🟡' : '❌';

  L.push('');
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║     SIGNALTRADER PRO — BACKTEST v3 (REALISTIC)                      ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');
  L.push(`📊 Asset: ${cfg.asset} | TF: ${cfg.timeframe} | Months: ${cfg.months}`);
  L.push(`💰 Initial: $${cfg.initialBalance.toLocaleString()} | Risk: ${cfg.riskPerTrade}% | R:R: ${cfg.riskRewardRatio}:1`);
  L.push(`💸 Fee: ${cfg.takerFeePct * 2}% round trip | Slippage: ${cfg.slippagePct}% | ATR SL: ${cfg.atrMultiplierSL}x`);
  L.push(`⏱️  Expiration: ${cfg.expirationBars * (TIMEFRAME_MAP[cfg.timeframe]?.minutes || 5)} min`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  RESULTADOS FINANCIEROS');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Balance Final:    $${result.finalBalance.toFixed(2)}`);
  L.push(`  Retorno Total:    ${result.totalReturnPct >= 0 ? '+' : ''}${result.totalReturnPct.toFixed(2)}% ($${result.totalReturn.toFixed(2)})`);
  L.push(`  Max Drawdown:     ${result.maxDrawdownPct.toFixed(2)}%`);
  L.push(`  Sharpe Ratio:     ${result.sharpeRatio.toFixed(2)}`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  ESTADÍSTICAS DE TRADING');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Total Trades:     ${result.trades.length}`);
  L.push(`  Wins:             ${result.totalWins}`);
  L.push(`  Losses:           ${result.totalLosses}`);
  L.push(`  Win Rate:         ${e(result.winRate)} ${result.winRate.toFixed(1)}%`);
  L.push(`  Avg Win:          +${result.avgWinPct.toFixed(3)}%`);
  L.push(`  Avg Loss:         ${result.avgLossPct.toFixed(3)}%`);
  L.push(`  Profit Factor:    ${result.profitFactor.toFixed(2)}`);
  L.push(`  Expected Value:   $${result.expectedValue.toFixed(2)} per trade`);
  L.push(`  Avg Hold:         ${result.avgHoldingBars.toFixed(1)} bars`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  IMPACTO DE COSTOS (FEES + SLIPPAGE)');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Total Fees:       $${result.totalFees.toFixed(2)}`);
  L.push(`  Total Slippage:   $${result.totalSlippage.toFixed(2)}`);
  L.push(`  Cost % of Capital: ${((result.totalFees + result.totalSlippage) / cfg.initialBalance * 100).toFixed(2)}%`);
  const grossBeforeFees = result.trades.reduce((s, t) => s + t.pnl + t.fees + t.slippage, 0);
  L.push(`  P&L sin fees:     $${grossBeforeFees.toFixed(2)}`);
  L.push(`  P&L con fees:     $${result.totalReturn.toFixed(2)}`);
  L.push(`  Fee drag:         $${(grossBeforeFees - result.totalReturn).toFixed(2)}`);
  L.push('');

  // By Pattern
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR PATRÓN');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [p, d] of Object.entries(result.byPattern).sort((a, b) => b[1].winRate - a[1].winRate)) {
    L.push(`  ${e(d.winRate)} ${p.padEnd(25)} ${d.winRate.toFixed(1)}% WR | ${d.avgPnlPct >= 0 ? '+' : ''}${d.avgPnlPct.toFixed(3)}% avg (${d.wins}W/${d.losses}L)`);
  }
  L.push('');

  // By Session
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR SESIÓN');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const s of ['Overlap', 'London', 'NewYork', 'Asia']) {
    const d = result.bySession[s];
    if (d) L.push(`  ${e(d.winRate)} ${s.padEnd(10)} ${d.winRate.toFixed(1)}% WR | ${d.avgPnlPct >= 0 ? '+' : ''}${d.avgPnlPct.toFixed(3)}% avg (${d.wins}W/${d.losses}L)`);
  }
  L.push('');

  // By Exit Reason
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR RAZÓN DE SALIDA');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [reason, d] of Object.entries(result.byExitReason).sort((a, b) => b[1].total - a[1].total)) {
    L.push(`  ${reason.padEnd(15)} ${d.total} trades | $${d.pnl.toFixed(2)} total P&L`);
  }
  L.push('');

  // TOP EDGES
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  🏆 TOP EDGES (≥10 trades, AFTER FEES)                              ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');
  if (result.topEdges.length === 0) {
    L.push('  ❌ No edges with ≥10 trades found.');
  } else {
    for (let i = 0; i < result.topEdges.length; i++) {
      const t = result.topEdges[i];
      L.push(`  ${e(t.winRate)} #${i + 1} ${t.patternType} + ${t.session} + ${t.asset}`);
      L.push(`     WR: ${t.winRate.toFixed(1)}% | Avg: ${t.avgPnlPct >= 0 ? '+' : ''}${t.avgPnlPct.toFixed(3)}% | EV: $${t.ev.toFixed(2)}/trade (${t.total} trades)`);
      L.push('');
    }
  }

  // Worst
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  🚫 PEORES SETUPS (EVITAR)');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const w of result.worstSetups) {
    L.push(`  ❌ ${w.patternType} + ${w.session} + ${w.asset}: ${w.winRate.toFixed(1)}% WR | ${w.avgPnlPct.toFixed(3)}% avg (${w.losses}L de ${w.total})`);
  }
  L.push('');

  // VERDICT
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  🎯 VEREDICTO                                                       ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');

  if (result.totalReturnPct > 0 && result.winRate >= 55 && result.profitFactor >= 1.3) {
    L.push('  ✅ EDGE REAL POSITIVO después de fees y slippage.');
    L.push(`  → Operar SOLO los top edges. EV = $${result.expectedValue.toFixed(2)}/trade.`);
    L.push(`  → Profit Factor ${result.profitFactor.toFixed(2)} > 1.3 es sólido.`);
  } else if (result.totalReturnPct > 0 && result.winRate >= 50) {
    L.push('  🟡 EDGE MARGINAL después de costs.');
    L.push('  → Filtrar por top edges específicos podría funcionar.');
    L.push('  → Aumentar R:R a 2:1 o timeframe a 15M/1H.');
  } else if (result.winRate >= 50 && result.totalReturnPct <= 0) {
    L.push('  ⚠️ WIN RATE POSITIVO PERO FEES SE COMEN LA GANANCIA.');
    L.push(`  → Fees: $${result.totalFees.toFixed(2)} | Slippage: $${result.totalSlippage.toFixed(2)}`);
    L.push('  → Necesitas: más R:R, menos trades, o timeframe más largo.');
  } else {
    L.push('  ❌ NO HAY EDGE en esta configuración.');
    L.push('  → Cambiar: timeframe (probar 15M/1H), estrategia, o assets.');
    L.push('  → El M5 es muy difícil para retail — fees y slippage dominan.');
  }
  L.push('');

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVE TO DB
// ══════════════════════════════════════════════════════════════════════════════

async function saveStatsToDB(trades: BacktestTrade[], timeframe: string): Promise<void> {
  const { db } = await import('../src/lib/db');
  log('💾 Saving to Turso DB (SetupStats)...');

  const comboMap = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    const key = `${t.patternType || 'none'}|${t.sessionType}|${t.asset}`;
    const g = comboMap.get(key) || [];
    g.push(t);
    comboMap.set(key, g);
  }

  let saved = 0;
  for (const [, group] of comboMap) {
    const patternType = group[0].patternType || 'none';
    const session = group[0].sessionType;
    const asset = group[0].asset;
    const wins = group.filter(t => t.pnl > 0).length;
    const total = group.length;
    const winRate = (wins / total) * 100;
    const bayes = calculateBayesianStats(wins, total - wins);

    try {
      await db.setupStats.upsert({
        where: { patternType_asset_session_timeframe: { patternType, asset, session, timeframe } },
        create: {
          patternType, asset, session, timeframe,
          totalSignals: total, wins, losses: total - wins, winRate,
          avgConfidence: group.reduce((s, x) => s + x.confidence, 0) / total,
          avgSetupScore: group.reduce((s, x) => s + x.setupScore, 0) / total,
          bayesianWinRate: bayes.bayesianWinRate,
          confidenceIntervalLower: bayes.confidenceInterval.lower,
          confidenceIntervalUpper: bayes.confidenceInterval.upper,
          pValue: bayes.pValue, sampleVariance: bayes.sampleVariance,
          avgExpectancy: winRate > 50 ? (winRate / 100 - (100 - winRate) / 100) : -(1 - winRate / 100),
          avgRiskReward: 1.5,
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
  log(`  ✅ ${saved} combos saved to SetupStats`);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let assets = ['BTC/USD', 'ETH/USD'];
  let months = 6;
  let saveToDB = false;
  let timeframe = '5m';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asset' && args[i + 1]) { assets = [args[++i]]; }
    else if (args[i] === '--months' && args[i + 1]) { months = parseInt(args[++i]); }
    else if (args[i] === '--save-db') { saveToDB = true; }
    else if (args[i] === '--timeframe' && args[i + 1]) { timeframe = args[++i]; }
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     SIGNALTRADER PRO — BACKTESTER v3 (REALISTIC)                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Assets: ${assets.join(', ')} | TF: ${timeframe} | Months: ${months} | DB: ${saveToDB ? 'YES' : 'NO'}`);
  console.log('  Features: SL/TP simulation, Fee tracking, Slippage, Equity curve');
  console.log('');

  const tfInfo = TIMEFRAME_MAP[timeframe];
  const tfMinutes = tfInfo?.minutes || 5;

  // Test multiple configurations
  const configs: BacktestConfig[] = [
    // M5 with different expirations
    { asset: '', timeframe, months, initialBalance: 10000, riskPerTrade: 1, takerFeePct: 0.06, slippagePct: 0.03,
      atrMultiplierSL: 1.5, riskRewardRatio: 1.5, expirationBars: Math.round(40 / tfMinutes), minCandles: 60, step: 6 },
    // Try higher R:R
    { asset: '', timeframe, months, initialBalance: 10000, riskPerTrade: 1, takerFeePct: 0.06, slippagePct: 0.03,
      atrMultiplierSL: 1.5, riskRewardRatio: 2.0, expirationBars: Math.round(120 / tfMinutes), minCandles: 60, step: 6 },
  ];

  const allTrades: BacktestTrade[] = [];

  for (const asset of assets) {
    const candles = await downloadHistoricalData(asset, timeframe, months);
    if (candles.length < 200) {
      console.error(`❌ ${asset}: Not enough data (${candles.length} candles)`);
      continue;
    }

    for (let ci = 0; ci < configs.length; ci++) {
      const cfg = { ...configs[ci], asset };
      log(`📊 Running ${asset} ${timeframe} config #${ci + 1} (R:R ${cfg.riskRewardRatio}, exp ${cfg.expirationBars * tfMinutes}min)...`);

      const result = runBacktest(candles, cfg);
      const report = generateReport(result, cfg);
      console.log(report);

      // Save report
      const fs = await import('fs');
      const path = await import('path');
      const suffix = ci === 0 ? '' : `-rr${cfg.riskRewardRatio}`;
      fs.writeFileSync(
        path.join(process.cwd(), `backtest-v3-${asset.replace('/', '-')}-${timeframe}${suffix}-report.txt`),
        report, 'utf-8'
      );

      allTrades.push(...result.trades);
    }
  }

  // Also test 15M and 1H if we have enough data
  for (const tf of ['15m', '1h']) {
    if (tf === timeframe) continue; // Already tested
    log(`📊 Testing ${tf} timeframe for comparison...`);
    for (const asset of assets) {
      try {
        const candles = await downloadHistoricalData(asset, tf, months);
        if (candles.length < 200) continue;

        const tfMins = TIMEFRAME_MAP[tf]?.minutes || 15;
        const cfg: BacktestConfig = {
          asset, timeframe: tf, months, initialBalance: 10000, riskPerTrade: 1,
          takerFeePct: 0.06, slippagePct: 0.03, atrMultiplierSL: 1.5,
          riskRewardRatio: 1.5, expirationBars: Math.round(120 / tfMins), minCandles: 40, step: 4,
        };

        const result = runBacktest(candles, cfg);
        const report = generateReport(result, cfg);
        console.log(report);

        const fs = await import('fs');
        const path = await import('path');
        fs.writeFileSync(
          path.join(process.cwd(), `backtest-v3-${asset.replace('/', '-')}-${tf}-report.txt`),
          report, 'utf-8'
        );

        allTrades.push(...result.trades);
      } catch (err: any) {
        log(`  ⚠️ ${asset} ${tf} failed: ${err.message}`);
      }
    }
  }

  if (saveToDB && allTrades.length > 0) {
    await saveStatsToDB(allTrades, timeframe);
  } else if (!saveToDB) {
    console.log('');
    console.log('💡 Para alimentar los motores Bayesian/Expectancy con estos datos:');
    console.log('   npx tsx scripts/backtest-v3.ts --save-db');
    console.log('');
  }

  // Save JSON
  const fs = await import('fs');
  const path = await import('path');
  fs.writeFileSync(
    path.join(process.cwd(), 'backtest-v3-results.json'),
    JSON.stringify({ totalTrades: allTrades.length, timestamp: new Date().toISOString() }, null, 2),
    'utf-8'
  );

  console.log('═══ Backtest v3 completed ═══');
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
