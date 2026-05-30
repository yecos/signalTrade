#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — BACKTESTER v5 (TREND FOLLOWING PULLBACK)
//
// v3 (patterns): 7,000 trades, 25% WR → -100%
// v4 (S/R reversal): 1,700 trades, 25% WR → -100%
// v5 strategy: RIDE THE TREND — only trade pullbacks in strong trends
//
// Why trend following?
// - Crypto TRENDs hard — when BTC moves, it MOVES
// - Mean reversion doesn't work because levels get sliced through
// - Trend following + pullback is the most proven crypto strategy
// - Higher TF = less noise = more reliable signals
// - Fewer trades = less fees = more profit per trade
//
// Signal Logic:
// 1. Strong trend confirmed (EMA20 > EMA50 > EMA100 for longs, inverse for shorts)
// 2. ADX > 25 (strong directional movement)
// 3. Price pulls back to EMA20 or 38.2% Fibonacci of recent swing
// 4. Bullish candle at the pullback level (rejection of deeper pullback)
// 5. Volume decreasing on pullback (healthy pullback)
// 6. Enter in trend direction with SL below pullback low/high
// 7. TP at previous swing high/low OR 2:1 R:R
//
// Key insight from v4: P&L sin fees was nearly break-even.
// With fewer trades on higher TF, fees impact drops dramatically.
// ══════════════════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
config({ path: '../.env' });
config({ path: '.env' });

interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const ASSET_MAP: Record<string, string> = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT',
};

const BINANCE_API = 'https://api.binance.com/api/v3/klines';
const TF_MAP: Record<string, { binance: string; minutes: number }> = {
  '15m': { binance: '15m', minutes: 15 },
  '1h':  { binance: '1h',  minutes: 60 },
  '4h':  { binance: '4h',  minutes: 240 },
};

function log(msg: string) { console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`); }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function downloadData(asset: string, tf: string, months: number): Promise<Candle[]> {
  const symbol = ASSET_MAP[asset]; if (!symbol) return [];
  const tfInfo = TF_MAP[tf]; if (!tfInfo) return [];
  const endMs = Date.now(), startMs = endMs - months * 30 * 24 * 60 * 60 * 1000;
  const all: Candle[] = [];
  let cur = startMs;
  log(`📥 Downloading ${asset} ${tf} (${months}mo)...`);
  while (cur < endMs) {
    const url = `${BINANCE_API}?symbol=${symbol}&interval=${tfInfo.binance}&startTime=${cur}&endTime=${endMs}&limit=1000`;
    for (let r = 3; r > 0; r--) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const data = await resp.json() as any[][];
        if (!data.length) { log(`  ✅ ${all.length} candles`); return all; }
        for (const k of data) all.push({ timestamp: new Date(k[0]), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
        cur = (data[data.length - 1][0] as number) + 1;
        break;
      } catch { if (r === 1) throw new Error('Download failed'); await sleep(2000); }
    }
  }
  log(`  ✅ ${all.length} candles`);
  return all;
}

// ═══ CALCULATIONS ═══

function ema(values: number[], period: number): number[] {
  const result: number[] = []; const k = 2 / (period + 1);
  let e = values[0]; result.push(e);
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); result.push(e); }
  return result;
}

function sma(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function atr(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
  }
  return sum / period;
}

function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period * 2) return 0;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i-1].high;
    const downMove = candles[i-1].low - candles[i].low;
    plusDM += (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM += (downMove > upMove && downMove > 0) ? downMove : 0;
    tr += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
  }
  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI + 0.0001) * 100;
  return dx;
}

function rsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + (gains/period) / (losses/period)));
}

function findSwingHigh(candles: Candle[], lookback: number = 5): number {
  let max = 0;
  for (let i = candles.length - 1 - lookback; i >= Math.max(0, candles.length - 50); i--) {
    let isHigh = true;
    for (let j = 1; j <= lookback && i + j < candles.length; j++) {
      if (candles[i].high < candles[i-j].high || (i+j < candles.length && candles[i].high < candles[i+j].high)) { isHigh = false; break; }
    }
    if (isHigh && candles[i].high > max) max = candles[i].high;
  }
  return max;
}

function findSwingLow(candles: Candle[], lookback: number = 5): number {
  let min = Infinity;
  for (let i = candles.length - 1 - lookback; i >= Math.max(0, candles.length - 50); i--) {
    let isLow = true;
    for (let j = 1; j <= lookback && i - j >= 0; j++) {
      if (candles[i].low > candles[i-j].low || (i+j < candles.length && candles[i].low > candles[i+j].low)) { isLow = false; break; }
    }
    if (isLow && candles[i].low < min) min = candles[i].low;
  }
  return min === Infinity ? 0 : min;
}

// ═══ TREND FOLLOWING BACKTEST ENGINE ═══

interface Trade {
  timestamp: Date; asset: string; direction: 'HIGHER' | 'LOWER';
  entryPrice: number; exitPrice: number; exitReason: string;
  pnl: number; pnlPct: number; fees: number; holdingBars: number;
  trendStrength: number; pullbackPct: number;
}

function runBacktest(candles: Candle[], asset: string, tf: string, cfg: {
  initialBalance: number; riskPct: number; rr: number;
  expirationBars: number; takerFee: number;
  minADX: number; pullbackMaxATR: number;
}): { trades: Trade[]; balance: number; stats: any } {

  const trades: Trade[] = [];
  let balance = cfg.initialBalance, peak = balance, maxDD = 0;
  const COOLDOWN = Math.max(2, Math.round(60 / (TF_MAP[tf]?.minutes || 60)));
  let lastTradeBar = -COOLDOWN;

  const closes = candles.map(c => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema100 = ema(closes, 100);

  log(`🔄 ${asset} ${tf}: ${candles.length} candles, R:R ${cfg.rr}, minADX ${cfg.minADX}`);

  for (let i = 150; i < candles.length - cfg.expirationBars; i++) {
    if (i - lastTradeBar < COOLDOWN) continue;
    if (i % 500 === 0) {
      const pct = Math.floor(i / candles.length * 100);
      log(`   ${pct}% — ${trades.length} trades | $${balance.toFixed(2)}`);
    }

    const c = candles[i], prev = candles[i-1];
    const window = candles.slice(Math.max(0, i - 100), i + 1);
    const a = atr(window), adxVal = adx(window);
    if (a <= 0 || adxVal < cfg.minADX) continue;

    const e20 = ema20[i], e50 = ema50[i], e100 = ema100[i];
    if (!e20 || !e50 || !e100) continue;

    // ═══ TREND DETECTION ═══
    const bullishTrend = e20 > e50 && e50 > e100 && c.close > e20;
    const bearishTrend = e20 < e50 && e50 < e100 && c.close < e20;
    if (!bullishTrend && !bearishTrend) continue;

    // ═══ PULLBACK DETECTION ═══
    // Price must have pulled back toward EMA20 recently
    const recentLow = Math.min(...window.slice(-10).map(x => x.low));
    const recentHigh = Math.max(...window.slice(-10).map(x => x.high));

    let pullbackOk = false;
    let direction: 'HIGHER' | 'LOWER' = 'HIGHER';
    let pullbackPct = 0;

    if (bullishTrend) {
      // For longs: recent low should be near EMA20 (pullback to support)
      const distToEma = (e20 - recentLow) / e20;
      pullbackPct = distToEma * 100;
      if (recentLow <= e20 * (1 + cfg.pullbackMaxATR * a / e20) && recentLow >= e20 * (1 - cfg.pullbackMaxATR * a / e20)) {
        // Pullback touched EMA20 zone
        if (c.close > c.open && c.close > prev.close) { // Bullish candle bouncing off EMA
          pullbackOk = true;
          direction = 'HIGHER';
        }
      }
      // Also accept pullback to EMA50 if trend is very strong
      if (!pullbackOk && adxVal > 30 && recentLow <= e50 * 1.005 && c.close > c.open) {
        pullbackOk = true;
        direction = 'HIGHER';
      }
    } else {
      // For shorts: recent high should be near EMA20 (pullback to resistance)
      const distToEma = (recentHigh - e20) / e20;
      pullbackPct = distToEma * 100;
      if (recentHigh >= e20 * (1 - cfg.pullbackMaxATR * a / e20) && recentHigh <= e20 * (1 + cfg.pullbackMaxATR * a / e20)) {
        if (c.close < c.open && c.close < prev.close) {
          pullbackOk = true;
          direction = 'LOWER';
        }
      }
      if (!pullbackOk && adxVal > 30 && recentHigh >= e50 * 0.995 && c.close < c.open) {
        pullbackOk = true;
        direction = 'LOWER';
      }
    }

    if (!pullbackOk) continue;

    // ═══ VOLUME CHECK (optional but helpful) ═══
    const avgVol = window.slice(-20).reduce((s, x) => s + x.volume, 0) / 20;
    const volOk = c.volume > avgVol * 0.8; // Not requiring spike, just normal volume

    // ═══ SL/TP CALCULATION ═══
    const entryPrice = c.close;
    let stopDist: number;

    if (direction === 'HIGHER') {
      stopDist = entryPrice - recentLow + a * 0.3; // SL below recent low + buffer
    } else {
      stopDist = recentHigh - entryPrice + a * 0.3; // SL above recent high + buffer
    }

    // Clamp stop distance
    const maxStop = entryPrice * 0.03; // 3% max
    const minStop = entryPrice * 0.003; // 0.3% min
    stopDist = Math.max(minStop, Math.min(maxStop, stopDist));

    const stopLoss = direction === 'HIGHER' ? entryPrice - stopDist : entryPrice + stopDist;
    const takeProfit = direction === 'HIGHER'
      ? Math.max(entryPrice + stopDist * cfg.rr, findSwingHigh(window) || entryPrice + stopDist * cfg.rr)
      : Math.min(entryPrice - stopDist * cfg.rr, findSwingLow(window) || entryPrice - stopDist * cfg.rr);

    // ═══ POSITION SIZING ═══
    const riskAmt = balance * (cfg.riskPct / 100);
    const posSize = stopDist > 0 ? riskAmt / stopDist : 0;
    if (posSize <= 0 || balance < 100) continue;

    // ═══ SIMULATE ═══
    const entrySlip = entryPrice * 0.0002;
    const actualEntry = direction === 'HIGHER' ? entryPrice + entrySlip : entryPrice - entrySlip;
    const entryFee = posSize * actualEntry * (cfg.takerFee / 100);

    let exitPrice = 0, exitReason = 'EXPIRATION', holdBars = 0;

    for (let j = i + 1; j <= Math.min(i + cfg.expirationBars, candles.length - 1); j++) {
      holdBars++;
      const bar = candles[j];
      if (direction === 'HIGHER' && bar.low <= stopLoss) { exitPrice = stopLoss; exitReason = 'SL_HIT'; break; }
      if (direction === 'LOWER' && bar.high >= stopLoss) { exitPrice = stopLoss; exitReason = 'SL_HIT'; break; }
      if (direction === 'HIGHER' && bar.high >= takeProfit) { exitPrice = takeProfit; exitReason = 'TP_HIT'; break; }
      if (direction === 'LOWER' && bar.low <= takeProfit) { exitPrice = takeProfit; exitReason = 'TP_HIT'; break; }
      if (j === i + cfg.expirationBars) { exitPrice = bar.close; exitReason = 'EXPIRATION'; }
    }
    if (exitPrice === 0) continue;

    const exitSlip = exitPrice * 0.0002;
    const actualExit = direction === 'HIGHER' ? exitPrice - exitSlip : exitPrice + exitSlip;
    const exitFee = posSize * actualExit * (cfg.takerFee / 100);
    const totalFees = entryFee + exitFee;

    const rawPnl = direction === 'HIGHER'
      ? (actualExit - actualEntry) * posSize
      : (actualEntry - actualExit) * posSize;
    const netPnl = rawPnl - totalFees;
    const pnlPct = posSize > 0 && actualEntry > 0 ? (netPnl / (actualEntry * posSize)) * 100 : 0;

    balance += netPnl;
    peak = Math.max(peak, balance);
    maxDD = Math.max(maxDD, peak > 0 ? ((peak - balance) / peak) * 100 : 0);

    trades.push({
      timestamp: c.timestamp, asset, direction,
      entryPrice: actualEntry, exitPrice: actualExit, exitReason,
      pnl: netPnl, pnlPct, fees: totalFees, holdingBars: holdBars,
      trendStrength: adxVal, pullbackPct,
    });
    lastTradeBar = i;
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const wr = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const ev = trades.length > 0 ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;
  const pnlNoFees = trades.reduce((s, t) => s + t.pnl + t.fees, 0);
  const byExit: Record<string, { total: number; pnl: number }> = {};
  for (const t of trades) {
    if (!byExit[t.exitReason]) byExit[t.exitReason] = { total: 0, pnl: 0 };
    byExit[t.exitReason].total++; byExit[t.exitReason].pnl += t.pnl;
  }

  return {
    trades, balance,
    stats: { wr, wins: wins.length, losses: losses.length, totalFees, pf, ev, maxDD, pnlNoFees, byExit,
      avgHold: trades.length > 0 ? trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length : 0,
      avgWinPct: wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0,
      avgLossPct: losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0,
    }
  };
}

function printReport(asset: string, tf: string, rr: number, result: ReturnType<typeof runBacktest>, cfg: any) {
  const s = result.stats;
  const icon = s.wr >= 45 ? '✅' : s.wr >= 35 ? '🟡' : '❌';
  const profitable = result.balance > cfg.initialBalance;
  console.log(`
══════════════════════════════════════════════════════════════════════
  ${asset} ${tf} — R:R ${rr}:1 | Trend Following Pullback
══════════════════════════════════════════════════════════════════════

  Balance: $${result.balance.toFixed(2)} (${((result.balance - cfg.initialBalance) / cfg.initialBalance * 100).toFixed(1)}%)
  Trades: ${result.trades.length} | ${icon} WR: ${s.wr.toFixed(1)}% | PF: ${s.pf.toFixed(2)} | EV: $${s.ev.toFixed(2)}
  Avg Win: +${s.avgWinPct.toFixed(3)}% | Avg Loss: ${s.avgLossPct.toFixed(3)}%
  Max DD: ${s.maxDD.toFixed(1)}% | Fees: $${s.totalFees.toFixed(2)}
  P&L sin fees: $${s.pnlNoFees.toFixed(2)} | P&L con fees: $${(result.balance - cfg.initialBalance).toFixed(2)}
  Avg Hold: ${s.avgHold.toFixed(1)} bars

  Exit Reasons:
${Object.entries(s.byExit).map(([r, d]) => `  ${r.padEnd(12)} ${d.total} trades | $${d.pnl.toFixed(2)}`).join('\n')}

  ${profitable ? '✅ PROFITABLE' : '❌ NOT PROFITABLE'}
`);
}

async function main() {
  const args = process.argv.slice(2);
  let months = 6;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--months' && args[i+1]) months = +args[++i];
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  SIGNALTRADER PRO — BACKTEST v5 (TREND FOLLOWING PULLBACK)         ║
║  Strategy: Ride strong trends, enter on pullbacks to EMA            ║
╚══════════════════════════════════════════════════════════════════════╝
`);

  const assets = ['BTC/USD', 'ETH/USD'];

  // Test on 4H (primary) and 1H (comparison)
  for (const tf of ['4h', '1h']) {
    for (const asset of assets) {
      const candles = await downloadData(asset, tf, months);
      if (candles.length < 300) continue;

      const tfMins = TF_MAP[tf]?.minutes || 60;
      const cfg = {
        initialBalance: 10000, riskPct: 1, takerFee: 0.06,
        expirationBars: Math.round(72 * 60 / tfMins), // 3 days
        minADX: 20, pullbackMaxATR: 1.5,
      };

      // Test multiple R:R ratios
      for (const rr of [2.0, 2.5, 3.0]) {
        const result = runBacktest(candles, asset, tf, { ...cfg, rr });
        printReport(asset, tf, rr, result, cfg);
      }
    }
  }

  console.log('\n═══ Backtest v5 completed ═══');
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
