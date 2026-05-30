#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — BACKTESTER v7 (ASYMMETRIC EDGE HUNTER)
//
// KEY FINDINGS FROM v6:
// - TRAILING_STOP is PROFITABLE (+$2,731 to +$5,116)
// - INITIAL_SL is the KILLER (-$2,810 to -$6,169)
// - LONGS work: 47-58% WR on ETH, 42-49% on BTC
// - SHORTS fail: 35-41% WR across all assets
// - When trades survive initial SL, trailing stop captures big moves
//
// v7 FUNDAMENTAL CHANGES:
// 1. LONGS-ONLY (or 3:1 long:bias) — shorts destroy the edge
// 2. WIDER INITIAL SL (1.5 ATR buffer) — give trades room to breathe
// 3. DAILY TREND FILTER — 1D EMA must confirm direction
// 4. BETTER ENTRY — wait for BOUNCE CONFIRMATION (2 bars above EMA20)
// 5. PARTIAL PROFIT at 1:1 R:R — lock in some profit early
// 6. REDUCED POSITION — 0.75% risk to survive more SL hits
// 7. LONGER COOLDOWN — 24h between trades
//
// The math: If trailing stop trades average +3% and SL trades average -1.5%,
// we need WR > 33% to break even. With 45% WR on longs, that's:
// EV = 0.45 * 3% - 0.55 * 1.5% = 1.35% - 0.825% = +0.525% per trade
// With fees of 0.12%, net EV = +0.405% per trade. VIABLE.
//
// Usage: npx tsx scripts/backtest-v7.ts
//        npx tsx scripts/backtest-v7.ts --months 12
// ══════════════════════════════════════════════════════════════════════════════

interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  timestamp: Date;
  asset: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  exitReason: 'INITIAL_SL' | 'TRAILING_STOP' | 'PARTIAL_TP' | 'TREND_BREAK' | 'END_OF_DATA';
  pnl: number;
  pnlPct: number;
  fees: number;
  holdingBars: number;
  maxFavorable: number;
  maxAdverse: number;
  confluenceScore: number;
  trendStrength: number;
  dailyTrend: string;
}

interface BacktestConfig {
  asset: string;
  timeframe: string;
  months: number;
  initialBalance: number;
  riskPct: number;
  takerFeePct: number;
  trailingATR: number;
  trailingTightATR: number;
  initialSLATR: number;       // ATR buffer for initial SL (wider in v7)
  minADX: number;
  pullbackATR: number;
  minConfluence: number;
  cooldownBars: number;
  maxHoldingBars: number;
  longOnly: boolean;
  partialTPRatio: number;     // Take partial profit at this R:R (0 = disabled)
  partialTPPercent: number;   // What % of position to close at partial TP
  dailyTrendFilter: boolean;  // Require daily EMA alignment
  bounceConfirmBars: number;  // Wait N bars above EMA20 before entering
}

const ASSET_MAP: Record<string, string> = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT',
  'SOL/USD': 'SOLUSDT',
};

const BINANCE_API = 'https://api.binance.com/api/v3/klines';
const TF_MAP: Record<string, { binance: string; minutes: number }> = {
  '1h': { binance: '1h', minutes: 60 },
  '4h': { binance: '4h', minutes: 240 },
  '1d': { binance: '1d', minutes: 1440 },
};

function log(msg: string) { console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`); }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function downloadData(asset: string, tf: string, months: number): Promise<Candle[]> {
  const symbol = ASSET_MAP[asset];
  if (!symbol) throw new Error(`Unknown: ${asset}`);
  const tfInfo = TF_MAP[tf];
  if (!tfInfo) throw new Error(`Unknown TF: ${tf}`);
  const endMs = Date.now(), startMs = endMs - months * 30 * 24 * 60 * 60 * 1000;
  const all: Candle[] = [];
  let cur = startMs;
  log(`📥 ${asset} ${tf} (${months}mo)...`);
  while (cur < endMs) {
    const url = `${BINANCE_API}?symbol=${symbol}&interval=${tfInfo.binance}&startTime=${cur}&endTime=${endMs}&limit=1000`;
    for (let retries = 3; retries > 0; retries--) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json() as any[][];
        if (!data.length) { log(`  ✅ ${all.length} candles`); return all; }
        for (const k of data) all.push({ timestamp: new Date(k[0]), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
        cur = (data[data.length - 1][0] as number) + 1;
        break;
      } catch (err: any) { if (retries === 1) throw err; await sleep(2000); }
    }
    await sleep(100);
  }
  log(`  ✅ ${all.length} candles`);
  return all;
}

// ═══ CALCULATIONS ═══

function calcEMA(values: number[], period: number): number[] {
  const r: number[] = []; const k = 2 / (period + 1);
  let e = values[0]; r.push(e);
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); r.push(e); }
  return r;
}

function calcATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
  }
  return sum / period;
}

function calcADX(candles: Candle[], period: number = 14): { adx: number; plusDI: number; minusDI: number } {
  if (candles.length < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };
  let plusDM = 0, minusDM = 0, trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const up = candles[i].high - candles[i-1].high;
    const down = candles[i-1].low - candles[i].low;
    plusDM += (up > down && up > 0) ? up : 0;
    minusDM += (down > up && down > 0) ? down : 0;
    trSum += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
  }
  if (trSum === 0) return { adx: 0, plusDI: 0, minusDI: 0 };
  const plusDI = (plusDM / trSum) * 100;
  const minusDI = (minusDM / trSum) * 100;
  return { adx: Math.abs(plusDI - minusDI) / (plusDI + minusDI + 0.0001) * 100, plusDI, minusDI };
}

function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + (gains/period) / (losses/period)));
}

function getSession(ts: Date): string {
  const h = ts.getUTCHours();
  if (h >= 12 && h < 16) return 'Overlap';
  if (h >= 7 && h < 16) return 'London';
  if (h >= 12 && h < 21) return 'NewYork';
  if (h >= 23 || h < 8) return 'Asia';
  return 'OffHours';
}

// ═══ DAILY TREND LOOKUP ═══
// Build a map from daily candles: timestamp -> daily EMA10/20/50

function buildDailyTrendMap(dailyCandles: Candle[]): Map<number, { ema10: number; ema20: number; ema50: number; bullish: boolean }> {
  const map = new Map<number, { ema10: number; ema20: number; ema50: number; bullish: boolean }>();
  if (dailyCandles.length < 50) return map;

  const closes = dailyCandles.map(c => c.close);
  const ema10 = calcEMA(closes, 10);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  for (let i = 0; i < dailyCandles.length; i++) {
    const dayStart = dailyCandles[i].timestamp.getTime();
    const bullish = ema10[i] > ema20[i] && ema20[i] > ema50[i];
    map.set(dayStart, { ema10: ema10[i], ema20: ema20[i], ema50: ema50[i], bullish });
  }

  return map;
}

function getDailyTrend(ts: Date, dailyMap: Map<number, { ema10: number; ema20: number; ema50: number; bullish: boolean }>): { bullish: boolean; bearish: boolean } | null {
  // Find the most recent daily candle before this timestamp
  const tsMs = ts.getTime();
  let bestKey = 0;
  for (const key of dailyMap.keys()) {
    if (key <= tsMs && key > bestKey) bestKey = key;
  }
  if (bestKey === 0) return null;
  const data = dailyMap.get(bestKey);
  if (!data) return null;
  return { bullish: data.bullish, bearish: !data.bullish && data.ema10 < data.ema20 && data.ema20 < data.ema50 };
}

// ═══ CONFLUENCE SCORING v7 ═══

interface ConfluenceFactors {
  emaStack: boolean;
  adxStrong: boolean;
  pullbackToEMA: boolean;
  bounceCandle: boolean;      // Stronger than "confirmation" — must be a clear bounce
  volumeConfirm: boolean;
  rsiHealthy: boolean;
  sessionGood: boolean;
  diAligned: boolean;
  dailyTrendAligned: boolean; // NEW in v7
  total: number;
}

function scoreConfluence(
  candle: Candle, prevCandle: Candle, window: Candle[],
  ema10: number, ema20: number, ema50: number,
  adxInfo: { adx: number; plusDI: number; minusDI: number },
  atrVal: number, rsiVal: number,
  direction: 'LONG' | 'SHORT',
  minADX: number, pullbackATR: number,
  dailyTrend: { bullish: boolean; bearish: boolean } | null,
): ConfluenceFactors {
  const result: ConfluenceFactors = {
    emaStack: false, adxStrong: false, pullbackToEMA: false,
    bounceCandle: false, volumeConfirm: false, rsiHealthy: false,
    sessionGood: false, diAligned: false, dailyTrendAligned: false,
    total: 0,
  };

  // 1. EMA STACK (4H)
  if (direction === 'LONG' && ema10 > ema20 && ema20 > ema50) result.emaStack = true;
  if (direction === 'SHORT' && ema10 < ema20 && ema20 < ema50) result.emaStack = true;

  // 2. ADX STRONG
  if (adxInfo.adx >= minADX) result.adxStrong = true;

  // 3. PULLBACK TO EMA20
  const recentBars = window.slice(-10);
  const recentLow = Math.min(...recentBars.map(b => b.low));
  const recentHigh = Math.max(...recentBars.map(b => b.high));
  if (direction === 'LONG' && recentLow <= ema20 + atrVal * pullbackATR && recentLow >= ema20 - atrVal * pullbackATR) result.pullbackToEMA = true;
  if (direction === 'SHORT' && recentHigh >= ema20 - atrVal * pullbackATR && recentHigh <= ema20 + atrVal * pullbackATR) result.pullbackToEMA = true;

  // 4. BOUNCE CANDLE — strong confirmation (stronger than v6)
  const bodySize = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;

  if (direction === 'LONG' && totalRange > 0) {
    // Strong bullish candle closing above EMA20
    if (candle.close > candle.open && candle.close > ema20 && bodySize > atrVal * 0.4) result.bounceCandle = true;
    // Bullish engulfing
    if (candle.close > candle.open && prevCandle.close < prevCandle.open && candle.close > prevCandle.open && candle.open < prevCandle.close) result.bounceCandle = true;
    // Pin bar / hammer
    if (lowerWick > bodySize * 2 && (totalRange > 0 && bodySize / totalRange < 0.4)) result.bounceCandle = true;
  }
  if (direction === 'SHORT' && totalRange > 0) {
    if (candle.close < candle.open && candle.close < ema20 && bodySize > atrVal * 0.4) result.bounceCandle = true;
    if (candle.close < candle.open && prevCandle.close > prevCandle.open && candle.close < prevCandle.open && candle.open > prevCandle.close) result.bounceCandle = true;
    if (upperWick > bodySize * 2 && (totalRange > 0 && bodySize / totalRange < 0.4)) result.bounceCandle = true;
  }

  // 5. VOLUME
  const avgVol = window.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  if (candle.volume > avgVol * 1.2) result.volumeConfirm = true;

  // 6. RSI HEALTHY
  if (direction === 'LONG' && rsiVal >= 35 && rsiVal <= 60) result.rsiHealthy = true;
  if (direction === 'SHORT' && rsiVal >= 40 && rsiVal <= 65) result.rsiHealthy = true;

  // 7. SESSION
  const session = getSession(candle.timestamp);
  if (['London', 'NewYork', 'Overlap'].includes(session)) result.sessionGood = true;

  // 8. DI ALIGNED
  if (direction === 'LONG' && adxInfo.plusDI > adxInfo.minusDI) result.diAligned = true;
  if (direction === 'SHORT' && adxInfo.minusDI > adxInfo.plusDI) result.diAligned = true;

  // 9. DAILY TREND ALIGNED (NEW)
  if (dailyTrend) {
    if (direction === 'LONG' && dailyTrend.bullish) result.dailyTrendAligned = true;
    if (direction === 'SHORT' && dailyTrend.bearish) result.dailyTrendAligned = true;
  }

  // Calculate total (weighted)
  result.total = [
    result.emaStack ? 1.5 : 0,
    result.adxStrong ? 1 : 0,
    result.pullbackToEMA ? 1.5 : 0,
    result.bounceCandle ? 1.5 : 0,
    result.volumeConfirm ? 0.5 : 0,
    result.rsiHealthy ? 0.5 : 0,
    result.sessionGood ? 0.5 : 0,
    result.diAligned ? 0.5 : 0,
    result.dailyTrendAligned ? 1.5 : 0,  // Important in v7
  ].reduce((a, b) => a + b, 0);

  return result;
}

// ═══ BACKTEST ENGINE v7 ═══

function runBacktest(
  candles4H: Candle[],
  dailyMap: Map<number, { ema10: number; ema20: number; ema50: number; bullish: boolean }>,
  cfg: BacktestConfig
): {
  trades: Trade[];
  finalBalance: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRate: number;
  totalWins: number;
  totalLosses: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  expectedValue: number;
  avgHoldingBars: number;
  totalFees: number;
  byExitReason: Record<string, { total: number; pnl: number }>;
  byDirection: Record<string, { total: number; wins: number; winRate: number }>;
  byDailyTrend: Record<string, { total: number; wins: number; winRate: number }>;
  signalsRejected: number;
  totalScanned: number;
} {
  const trades: Trade[] = [];
  let balance = cfg.initialBalance;
  let peakEquity = balance;
  let maxDrawdown = 0;
  let signalsRejected = 0;
  let totalScanned = 0;

  const closes = candles4H.map(c => c.close);
  const ema10All = calcEMA(closes, 10);
  const ema20All = calcEMA(closes, 20);
  const ema50All = calcEMA(closes, 50);

  let lastTradeBar = -cfg.cooldownBars;

  log(`🔄 ${cfg.asset} ${cfg.timeframe}: ${candles4H.length} candles | Long-only: ${cfg.longOnly} | Daily filter: ${cfg.dailyTrendFilter}`);

  for (let i = 100; i < candles4H.length - 1; i++) {
    totalScanned++;
    if (totalScanned % 500 === 0) {
      log(`   ${Math.floor(i / candles4H.length * 100)}% — ${trades.length} trades | $${balance.toFixed(2)} | Rejected: ${signalsRejected}`);
    }

    if (i - lastTradeBar < cfg.cooldownBars) continue;

    const candle = candles4H[i];
    const prevCandle = candles4H[i - 1];
    const window = candles4H.slice(Math.max(0, i - 99), i + 1);
    if (window.length < 50) continue;

    const atrVal = calcATR(window);
    if (atrVal <= 0) continue;

    const windowCloses = window.map(c => c.close);
    const adxInfo = calcADX(window);
    const rsiVal = calcRSI(windowCloses);
    const ema10 = ema10All[i], ema20 = ema20All[i], ema50 = ema50All[i];
    if (!ema10 || !ema20 || !ema50) continue;

    // ═══ DAILY TREND CHECK ═══
    const dailyTrend = getDailyTrend(candle.timestamp, dailyMap);

    // ═══ DETERMINE DIRECTION ═══
    const bullishTrend = ema10 > ema20 && ema20 > ema50 && candle.close > ema10;
    const bearishTrend = ema10 < ema20 && ema20 < ema50 && candle.close < ema10;

    // v7: Optionally skip shorts entirely
    if (cfg.longOnly && !bullishTrend) { signalsRejected++; continue; }
    if (!bullishTrend && !bearishTrend) { signalsRejected++; continue; }

    const direction: 'LONG' | 'SHORT' = bullishTrend ? 'LONG' : 'SHORT';

    // ═══ DAILY TREND FILTER ═══
    if (cfg.dailyTrendFilter && dailyTrend) {
      if (direction === 'LONG' && !dailyTrend.bullish) { signalsRejected++; continue; }
      if (direction === 'SHORT' && !dailyTrend.bearish) { signalsRejected++; continue; }
    }

    // ═══ BOUNCE CONFIRMATION (v7: wait for N bars above EMA20) ═══
    if (cfg.bounceConfirmBars > 0) {
      let bounceBars = 0;
      for (let b = 0; b < cfg.bounceConfirmBars; b++) {
        const idx = i - b;
        if (idx < 0) break;
        if (direction === 'LONG' && candles4H[idx].close > ema20All[idx]) bounceBars++;
        if (direction === 'SHORT' && candles4H[idx].close < ema20All[idx]) bounceBars++;
      }
      if (bounceBars < cfg.bounceConfirmBars) { signalsRejected++; continue; }
    }

    // ═══ CONFLUENCE ═══
    const confluence = scoreConfluence(
      candle, prevCandle, window, ema10, ema20, ema50,
      adxInfo, atrVal, rsiVal, direction, cfg.minADX, cfg.pullbackATR, dailyTrend
    );

    if (!confluence.emaStack) { signalsRejected++; continue; }
    if (!confluence.pullbackToEMA) { signalsRejected++; continue; }
    if (!confluence.adxStrong) { signalsRejected++; continue; }
    if (confluence.total < cfg.minConfluence) { signalsRejected++; continue; }

    // ═══ ENTRY ═══
    const entryPrice = candle.close;
    const recentLow = Math.min(...window.slice(-10).map(b => b.low));
    const recentHigh = Math.max(...window.slice(-10).map(b => b.high));

    // WIDER INITIAL SL (v7 key change)
    let stopDistance: number;
    if (direction === 'LONG') {
      stopDistance = entryPrice - recentLow + atrVal * cfg.initialSLATR;
    } else {
      stopDistance = recentHigh - entryPrice + atrVal * cfg.initialSLATR;
    }

    // Clamp
    const maxStop = entryPrice * 0.05; // 5% max on 4H
    const minStop = entryPrice * 0.003;
    stopDistance = Math.max(minStop, Math.min(maxStop, stopDistance));

    const initialSL = direction === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;

    // Partial TP level
    const partialTP = cfg.partialTPRatio > 0
      ? (direction === 'LONG' ? entryPrice + stopDistance * cfg.partialTPRatio : entryPrice - stopDistance * cfg.partialTPRatio)
      : 0;

    // ═══ POSITION SIZING ═══
    const riskAmount = balance * (cfg.riskPct / 100);
    const positionSize = stopDistance > 0 ? riskAmount / stopDistance : 0;
    if (positionSize <= 0 || balance < 100) continue;

    // ═══ ENTRY SIMULATION ═══
    const entrySlip = entryPrice * 0.0002;
    const actualEntry = direction === 'LONG' ? entryPrice + entrySlip : entryPrice - entrySlip;
    const entryFee = positionSize * actualEntry * (cfg.takerFeePct / 100);

    // ═══ TRADE MANAGEMENT ═══
    let currentSL = initialSL;
    let highestFavorable = direction === 'LONG' ? entryPrice : entryPrice;
    let trailingActive = false;
    let partialTaken = false;
    let remainingPosition = positionSize;
    let exitPrice = 0;
    let exitReason: Trade['exitReason'] = 'END_OF_DATA';
    let holdingBars = 0;
    let maxFavorable = 0;
    let maxAdverse = 0;
    let realizedPnl = 0;

    for (let j = i + 1; j < candles4H.length; j++) {
      holdingBars++;
      const bar = candles4H[j];

      if (direction === 'LONG') {
        maxFavorable = Math.max(maxFavorable, ((bar.high - actualEntry) / actualEntry) * 100);
        maxAdverse = Math.max(maxAdverse, ((actualEntry - bar.low) / actualEntry) * 100);

        if (bar.high > highestFavorable) highestFavorable = bar.high;

        // Activate trailing after 1 ATR profit
        const profit = highestFavorable - actualEntry;
        if (profit > atrVal && !trailingActive) trailingActive = true;

        // Update trailing
        if (trailingActive) {
          const trailMult = profit > atrVal * 2 ? cfg.trailingTightATR : cfg.trailingATR;
          const newTrail = highestFavorable - atrVal * trailMult;
          if (newTrail > currentSL) currentSL = newTrail;
        }

        // Partial TP
        if (partialTP > 0 && !partialTaken && bar.high >= partialTP && cfg.partialTPPercent > 0) {
          partialTaken = true;
          const closeSize = positionSize * (cfg.partialTPPercent / 100);
          const partialExit = partialTP;
          const partialFee = closeSize * partialExit * (cfg.takerFeePct / 100);
          realizedPnl += (partialExit - actualEntry) * closeSize - partialFee;
          remainingPosition = positionSize * (1 - cfg.partialTPPercent / 100);
          // Move SL to breakeven after partial
          currentSL = Math.max(currentSL, actualEntry);
        }

        // SL check
        if (bar.low <= currentSL) {
          exitPrice = currentSL;
          exitReason = trailingActive ? 'TRAILING_STOP' : 'INITIAL_SL';
          break;
        }

      } else { // SHORT
        maxFavorable = Math.max(maxFavorable, ((actualEntry - bar.low) / actualEntry) * 100);
        maxAdverse = Math.max(maxAdverse, ((bar.high - actualEntry) / actualEntry) * 100);

        if (bar.low < highestFavorable || highestFavorable === entryPrice) highestFavorable = bar.low;

        const profit = actualEntry - highestFavorable;
        if (profit > atrVal && !trailingActive) trailingActive = true;

        if (trailingActive) {
          const trailMult = profit > atrVal * 2 ? cfg.trailingTightATR : cfg.trailingATR;
          const newTrail = highestFavorable + atrVal * trailMult;
          if (newTrail < currentSL) currentSL = newTrail;
        }

        if (partialTP > 0 && !partialTaken && bar.low <= partialTP && cfg.partialTPPercent > 0) {
          partialTaken = true;
          const closeSize = positionSize * (cfg.partialTPPercent / 100);
          const partialFee = closeSize * partialTP * (cfg.takerFeePct / 100);
          realizedPnl += (actualEntry - partialTP) * closeSize - partialFee;
          remainingPosition = positionSize * (1 - cfg.partialTPPercent / 100);
          currentSL = Math.min(currentSL, actualEntry);
        }

        if (bar.high >= currentSL) {
          exitPrice = currentSL;
          exitReason = trailingActive ? 'TRAILING_STOP' : 'INITIAL_SL';
          break;
        }
      }

      // TREND BREAK EXIT
      if (j < ema10All.length && j < ema20All.length) {
        if (direction === 'LONG' && ema10All[j-1] >= ema20All[j-1] && ema10All[j] < ema20All[j]) {
          exitPrice = candles4H[j].close;
          exitReason = 'TREND_BREAK';
          break;
        }
        if (direction === 'SHORT' && ema10All[j-1] <= ema20All[j-1] && ema10All[j] > ema20All[j]) {
          exitPrice = candles4H[j].close;
          exitReason = 'TREND_BREAK';
          break;
        }
      }

      if (holdingBars >= cfg.maxHoldingBars) {
        exitPrice = bar.close;
        exitReason = 'END_OF_DATA';
        break;
      }
    }

    if (exitPrice === 0) {
      exitPrice = candles4H[candles4H.length - 1].close;
      exitReason = 'END_OF_DATA';
    }

    // ═══ EXIT SIMULATION ═══
    const exitSlip = exitPrice * 0.0002;
    const actualExit = direction === 'LONG' ? exitPrice - exitSlip : exitPrice + exitSlip;
    const exitFee = remainingPosition * actualExit * (cfg.takerFeePct / 100);
    const totalFees = entryFee + exitFee;

    // Remaining position P&L
    const remainingPnl = direction === 'LONG'
      ? (actualExit - actualEntry) * remainingPosition
      : (actualEntry - actualExit) * remainingPosition;
    const netPnl = remainingPnl + realizedPnl - totalFees;
    const pnlPct = positionSize > 0 && actualEntry > 0 ? (netPnl / (actualEntry * positionSize)) * 100 : 0;

    balance += netPnl;
    peakEquity = Math.max(peakEquity, balance);
    maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? ((peakEquity - balance) / peakEquity) * 100 : 0);

    const dailyTrendStr = dailyTrend ? (dailyTrend.bullish ? 'BULL' : dailyTrend.bearish ? 'BEAR' : 'NEUTRAL') : 'NO_DATA';

    trades.push({
      timestamp: candle.timestamp, asset: cfg.asset, direction,
      entryPrice: actualEntry, exitPrice: actualExit, exitReason,
      pnl: netPnl, pnlPct, fees: totalFees, holdingBars,
      maxFavorable, maxAdverse, confluenceScore: confluence.total,
      trendStrength: adxInfo.adx, dailyTrend: dailyTrendStr,
    });

    lastTradeBar = i;
  }

  // ═══ STATS ═══
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const expectedValue = trades.length > 0 ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;

  const byExitReason: Record<string, { total: number; pnl: number }> = {};
  for (const t of trades) {
    if (!byExitReason[t.exitReason]) byExitReason[t.exitReason] = { total: 0, pnl: 0 };
    byExitReason[t.exitReason].total++; byExitReason[t.exitReason].pnl += t.pnl;
  }
  const byDirection: Record<string, { total: number; wins: number; winRate: number }> = {};
  for (const t of trades) {
    if (!byDirection[t.direction]) byDirection[t.direction] = { total: 0, wins: 0, winRate: 0 };
    byDirection[t.direction].total++; if (t.pnl > 0) byDirection[t.direction].wins++;
  }
  for (const k of Object.keys(byDirection)) byDirection[k].winRate = (byDirection[k].wins / byDirection[k].total) * 100;

  const byDailyTrend: Record<string, { total: number; wins: number; winRate: number }> = {};
  for (const t of trades) {
    if (!byDailyTrend[t.dailyTrend]) byDailyTrend[t.dailyTrend] = { total: 0, wins: 0, winRate: 0 };
    byDailyTrend[t.dailyTrend].total++; if (t.pnl > 0) byDailyTrend[t.dailyTrend].wins++;
  }
  for (const k of Object.keys(byDailyTrend)) byDailyTrend[k].winRate = (byDailyTrend[k].wins / byDailyTrend[k].total) * 100;

  return {
    trades, finalBalance: balance,
    totalReturnPct: ((balance - cfg.initialBalance) / cfg.initialBalance) * 100,
    maxDrawdownPct: maxDrawdown, winRate,
    totalWins: wins.length, totalLosses: losses.length,
    avgWinPct, avgLossPct, profitFactor, expectedValue,
    avgHoldingBars: trades.length > 0 ? trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length : 0,
    totalFees, byExitReason, byDirection, byDailyTrend,
    signalsRejected, totalScanned,
  };
}

// ═══ REPORT ═══

function generateReport(result: ReturnType<typeof runBacktest>, cfg: BacktestConfig): string {
  const L: string[] = [];
  const wrI = (wr: number) => wr >= 45 ? '✅' : wr >= 35 ? '🟡' : '❌';
  const profitable = result.finalBalance > cfg.initialBalance;
  const pnlNoFees = result.trades.reduce((s, t) => s + t.pnl + t.fees, 0);

  L.push('');
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  SIGNALTRADER PRO — BACKTEST v7 (ASYMMETRIC EDGE HUNTER)           ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');
  L.push(`📊 ${cfg.asset} ${cfg.timeframe} | ${cfg.months} months | Long-only: ${cfg.longOnly ? 'YES' : 'NO'}`);
  L.push(`💰 $${cfg.initialBalance.toLocaleString()} | Risk: ${cfg.riskPct}% | Fee: ${(cfg.takerFeePct * 2).toFixed(2)}% round trip`);
  L.push(`📈 Trail: ${cfg.trailingATR}x → ${cfg.trailingTightATR}x ATR | SL: ${cfg.initialSLATR}x ATR buffer | Partial: ${cfg.partialTPPercent}%@${cfg.partialTPRatio}:1`);
  L.push(`🎯 Confluence: ${cfg.minConfluence}/9 | ADX: ${cfg.minADX} | Daily: ${cfg.dailyTrendFilter ? 'ON' : 'OFF'} | Bounce: ${cfg.bounceConfirmBars} bars`);
  L.push('');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  RESULTADOS');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Balance:     $${result.finalBalance.toFixed(2)} (${result.totalReturnPct >= 0 ? '+' : ''}${result.totalReturnPct.toFixed(2)}%)`);
  L.push(`  Max DD:      ${result.maxDrawdownPct.toFixed(2)}%`);
  L.push(`  Trades:      ${result.trades.length} | ${wrI(result.winRate)} WR: ${result.winRate.toFixed(1)}%`);
  L.push(`  PF:          ${result.profitFactor.toFixed(2)} | EV: $${result.expectedValue.toFixed(2)}/trade`);
  L.push(`  Avg Win:     +${result.avgWinPct.toFixed(3)}% | Avg Loss: ${result.avgLossPct.toFixed(3)}%`);
  L.push(`  Avg Hold:    ${result.avgHoldingBars.toFixed(1)} bars (${(result.avgHoldingBars * 4).toFixed(0)}h)`);
  L.push(`  Fees:        $${result.totalFees.toFixed(2)} (${((result.totalFees / cfg.initialBalance) * 100).toFixed(2)}% of capital)`);
  L.push(`  P&L sin fees: $${pnlNoFees.toFixed(2)} | Con fees: $${(result.finalBalance - cfg.initialBalance).toFixed(2)}`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR RAZÓN DE SALIDA');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [reason, data] of Object.entries(result.byExitReason).sort((a, b) => b[1].total - a[1].total)) {
    L.push(`  ${data.pnl > 0 ? '💰' : '💸'} ${reason.padEnd(16)} ${data.total} trades | $${data.pnl.toFixed(2)}`);
  }
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR DIRECCIÓN');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [dir, data] of Object.entries(result.byDirection)) {
    L.push(`  ${wrI(data.winRate)} ${dir.padEnd(6)} ${data.winRate.toFixed(1)}% WR (${data.wins}W/${data.total - data.wins}L)`);
  }
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR DAILY TREND');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [trend, data] of Object.entries(result.byDailyTrend).sort((a, b) => b[1].winRate - a[1].winRate)) {
    L.push(`  ${wrI(data.winRate)} ${trend.padEnd(8)} ${data.winRate.toFixed(1)}% WR (${data.wins}W/${data.total - data.wins}L)`);
  }
  L.push('');

  // VERDICT
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  🎯 VEREDICTO                                                       ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');

  if (profitable && result.profitFactor >= 1.3 && result.winRate >= 35) {
    L.push(`  ✅ EDGE REAL ENCONTRADO! PF: ${result.profitFactor.toFixed(2)} | WR: ${result.winRate.toFixed(1)}%`);
    L.push(`  → EV = $${result.expectedValue.toFixed(2)}/trade es positivo.`);
    L.push(`  → Max DD ${result.maxDrawdownPct.toFixed(1)}%. Implementar en auto-trader.`);
  } else if (profitable && result.profitFactor >= 1.0) {
    L.push(`  🟡 EDGE MARGINAL. PF: ${result.profitFactor.toFixed(2)} | WR: ${result.winRate.toFixed(1)}%`);
    L.push(`  → Necesita más datos o ajustes finos.`);
  } else {
    L.push(`  ❌ Sin edge. PF: ${result.profitFactor.toFixed(2)} | WR: ${result.winRate.toFixed(1)}%`);
    L.push(`  → P&L sin fees: $${pnlNoFees.toFixed(2)}`);
  }
  L.push('');

  return L.join('\n');
}

// ═══ MAIN ═══

async function main() {
  const args = process.argv.slice(2);
  let months = 12;  // Use 12 months for more data
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--months' && args[i+1]) months = +args[++i];
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  SIGNALTRADER PRO — BACKTEST v7 (ASYMMETRIC EDGE HUNTER)           ║');
  console.log('║  Key changes: Longs-only, wider SL, daily trend, partial TP        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');

  for (const asset of ['BTC/USD', 'ETH/USD']) {
    // Download 4H and daily data
    const candles4H = await downloadData(asset, '4h', months);
    const dailyCandles = await downloadData(asset, '1d', months);
    if (candles4H.length < 300 || dailyCandles.length < 50) continue;

    const dailyMap = buildDailyTrendMap(dailyCandles);

    // Test configurations
    const configs: Array<{ name: string; cfg: Partial<BacktestConfig> }> = [
      {
        name: 'Longs-Only + Daily + Wide SL',
        cfg: {
          longOnly: true, dailyTrendFilter: true, initialSLATR: 1.5,
          riskPct: 0.75, trailingATR: 2.0, trailingTightATR: 1.5,
          minADX: 20, minConfluence: 5, cooldownBars: 6, // 24h on 4H
          partialTPRatio: 1.0, partialTPPercent: 30,
          bounceConfirmBars: 1,
        },
      },
      {
        name: 'Longs-Only + Daily + Ultra-Wide SL',
        cfg: {
          longOnly: true, dailyTrendFilter: true, initialSLATR: 2.0,
          riskPct: 0.75, trailingATR: 2.5, trailingTightATR: 1.5,
          minADX: 20, minConfluence: 5, cooldownBars: 6,
          partialTPRatio: 1.5, partialTPPercent: 25,
          bounceConfirmBars: 1,
        },
      },
      {
        name: 'Longs-Only + Daily + Conservative',
        cfg: {
          longOnly: true, dailyTrendFilter: true, initialSLATR: 1.0,
          riskPct: 0.5, trailingATR: 2.0, trailingTightATR: 1.5,
          minADX: 25, minConfluence: 6, cooldownBars: 6,
          partialTPRatio: 0, partialTPPercent: 0,
          bounceConfirmBars: 2,
        },
      },
      {
        name: 'Both Dir + Daily (Control)',
        cfg: {
          longOnly: false, dailyTrendFilter: true, initialSLATR: 1.5,
          riskPct: 0.75, trailingATR: 2.0, trailingTightATR: 1.5,
          minADX: 20, minConfluence: 5, cooldownBars: 6,
          partialTPRatio: 1.0, partialTPPercent: 30,
          bounceConfirmBars: 1,
        },
      },
      {
        name: 'Longs-Only NO Daily (Control)',
        cfg: {
          longOnly: true, dailyTrendFilter: false, initialSLATR: 1.5,
          riskPct: 0.75, trailingATR: 2.0, trailingTightATR: 1.5,
          minADX: 20, minConfluence: 5, cooldownBars: 6,
          partialTPRatio: 1.0, partialTPPercent: 30,
          bounceConfirmBars: 1,
        },
      },
    ];

    for (const { name, cfg: preset } of configs) {
      const cfg: BacktestConfig = {
        asset, timeframe: '4h', months,
        initialBalance: 10000, takerFeePct: 0.06,
        pullbackATR: 1.5,
        maxHoldingBars: 84, // 14 days
        ...preset,
      } as BacktestConfig;

      log(`📊 ${asset} 4H — ${name}...`);
      const result = runBacktest(candles4H, dailyMap, cfg);
      const report = generateReport(result, cfg);
      console.log(report);

      const fs = await import('fs');
      const path = await import('path');
      const filename = `backtest-v7-${asset.replace('/', '-')}-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-report.txt`;
      fs.writeFileSync(path.join(process.cwd(), filename), report, 'utf-8');
    }
  }

  console.log('\n═══ Backtest v7 completed ═══');
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
