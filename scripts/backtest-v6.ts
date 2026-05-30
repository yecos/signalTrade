#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — BACKTESTER v6 (INSTITUTIONAL TREND FOLLOWING)
//
// v3 (patterns):     7,000 trades, 25% WR → -100%  (fees dominate)
// v4 (S/R reversal): 1,700 trades, 25% WR → -100%  (levels get sliced)
// v5 (trend pullback): Fixed TP caps winners, expiration kills trades
//
// v6 FUNDAMENTAL CHANGES:
// 1. TRAILING STOP instead of fixed TP — let winners run
// 2. NO EXPIRATION — exit only on trailing stop or trend break
// 3. TREND BREAK EXIT — EMA20 crosses EMA50 = get out
// 4. ULTRA-STRICT ENTRY — need 4+ confluences, not just trend+pullback
// 5. 4H TIMEFRAME ONLY — less noise, less fees, bigger moves
// 6. COOLDOWN 12h between trades — quality over quantity
// 7. RISK 1.5% per trade — slightly higher to capitalize on edge
//
// Target: 30-100 trades/year, 35-45% WR, 3:1+ avg R:R, positive EV
//
// Entry Pipeline:
// ┌─────────────────────────────────────────────────────────────┐
// │ STEP 1: TREND FILTER (4H)                                   │
// │   EMA10 > EMA20 > EMA50 AND close > all 3 (bullish)        │
// │   OR inverse for bearish                                     │
// │   ADX(14) > 22                                               │
// ├─────────────────────────────────────────────────────────────┤
// │ STEP 2: PULLBACK DETECTION (4H)                             │
// │   Recent low/high touched EMA20 zone (within 1.5 ATR)       │
// │   Pullback lasted 3+ bars (not a spike)                     │
// │   RSI(14) between 35-55 (longs) or 45-65 (shorts)          │
// ├─────────────────────────────────────────────────────────────┤
// │ STEP 3: ENTRY CONFIRMATION (4H)                             │
// │   Need 2+ of:                                                │
// │   • Bullish/bearish engulfing at EMA20                       │
// │   • Pin bar / hammer at EMA20                                │
// │   • Volume > 1.2x avg on bounce candle                      │
// │   • Previous bar closed in pullback direction (lower low)    │
// ├─────────────────────────────────────────────────────────────┤
// │ STEP 4: SESSION FILTER                                       │
// │   Only London, NY, or Overlap                                │
// └─────────────────────────────────────────────────────────────┘
//
// Exit Pipeline:
// ┌─────────────────────────────────────────────────────────────┐
// │ INITIAL SL: Below pullback low + 0.5 ATR (longs)           │
// │ TRAILING STOP: 2.0 ATR from highest high (longs)           │
// │   - Activates after price moves 1 ATR in our direction      │
// │   - Tightens to 1.5 ATR after 2 ATR profit                 │
// │ TREND BREAK: EMA10 crosses below EMA20 → exit on next bar  │
// │ NO TIME EXPIRATION — let trades breathe                     │
// └─────────────────────────────────────────────────────────────┘
//
// Usage: npx tsx scripts/backtest-v6.ts
//        npx tsx scripts/backtest-v6.ts --asset BTC/USD --months 12
//        npx tsx scripts/backtest-v6.ts --trailing 1.5 --risk 2
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
  exitReason: 'INITIAL_SL' | 'TRAILING_STOP' | 'TREND_BREAK' | 'END_OF_DATA';
  pnl: number;
  pnlPct: number;
  fees: number;
  holdingBars: number;
  maxFavorable: number;  // Max excursion in our direction (%)
  maxAdverse: number;    // Max excursion against us (%)
  confluenceScore: number;
  trendStrength: number; // ADX at entry
  rsiAtEntry: number;
}

interface BacktestConfig {
  asset: string;
  timeframe: string;
  months: number;
  initialBalance: number;
  riskPct: number;
  takerFeePct: number;
  trailingATR: number;        // ATR multiplier for trailing stop
  trailingTightATR: number;   // Tighter trail after 2 ATR profit
  initialSLATR: number;       // ATR buffer for initial SL
  minADX: number;
  pullbackATR: number;        // How close to EMA20 is a valid pullback
  minConfluence: number;
  cooldownBars: number;       // Min bars between trades
  maxHoldingBars: number;     // Safety: max holding time (e.g., 60 bars = 10 days on 4H)
}

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const ASSET_MAP: Record<string, string> = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT',
  'SOL/USD': 'SOLUSDT',
};

const BINANCE_API = 'https://api.binance.com/api/v3/klines';

const TF_MAP: Record<string, { binance: string; minutes: number }> = {
  '1h':  { binance: '1h',  minutes: 60 },
  '4h':  { binance: '4h',  minutes: 240 },
  '1d':  { binance: '1d',  minutes: 1440 },
};

function log(msg: string) { console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`); }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════════
// DATA DOWNLOADER
// ══════════════════════════════════════════════════════════════════════════════

async function downloadData(asset: string, tf: string, months: number): Promise<Candle[]> {
  const symbol = ASSET_MAP[asset];
  if (!symbol) throw new Error(`Unknown asset: ${asset}`);
  const tfInfo = TF_MAP[tf];
  if (!tfInfo) throw new Error(`Unknown timeframe: ${tf}`);

  const endMs = Date.now();
  const startMs = endMs - months * 30 * 24 * 60 * 60 * 1000;
  const all: Candle[] = [];
  let cur = startMs;

  log(`📥 Downloading ${asset} ${tf} (${months} months) from Binance...`);

  while (cur < endMs) {
    const url = `${BINANCE_API}?symbol=${symbol}&interval=${tfInfo.binance}&startTime=${cur}&endTime=${endMs}&limit=1000`;
    for (let retries = 3; retries > 0; retries--) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json() as any[][];
        if (!data.length) {
          log(`  ✅ ${all.length.toLocaleString()} candles downloaded`);
          return all;
        }
        for (const k of data) {
          all.push({
            timestamp: new Date(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          });
        }
        cur = (data[data.length - 1][0] as number) + 1;
        break;
      } catch (err: any) {
        if (retries === 1) throw new Error(`Download failed: ${err.message}`);
        await sleep(2000);
      }
    }
    await sleep(100); // Rate limit
  }

  log(`  ✅ ${all.length.toLocaleString()} candles downloaded`);
  return all;
}

// ══════════════════════════════════════════════════════════════════════════════
// TECHNICAL CALCULATIONS
// ══════════════════════════════════════════════════════════════════════════════

function calcEMA(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let e = values[0];
  result.push(e);
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    result.push(e);
  }
  return result;
}

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

function calcADX(candles: Candle[], period: number = 14): { adx: number; plusDI: number; minusDI: number } {
  if (candles.length < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };

  let plusDM = 0, minusDM = 0, trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM += (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM += (downMove > upMove && downMove > 0) ? downMove : 0;
    trSum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }

  if (trSum === 0) return { adx: 0, plusDI: 0, minusDI: 0 };
  const plusDI = (plusDM / trSum) * 100;
  const minusDI = (minusDM / trSum) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI + 0.0001) * 100;

  return { adx: dx, plusDI, minusDI };
}

function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + (gains / period) / (losses / period)));
}

// ══════════════════════════════════════════════════════════════════════════════
// SESSION DETECTION (UTC-based)
// ══════════════════════════════════════════════════════════════════════════════

function getSession(timestamp: Date): string {
  const hour = timestamp.getUTCHours();
  if (hour >= 12 && hour < 16) return 'Overlap';     // London+NY overlap
  if (hour >= 7 && hour < 16) return 'London';       // London session
  if (hour >= 12 && hour < 21) return 'NewYork';     // NY session
  if (hour >= 23 || hour < 8) return 'Asia';         // Asia session
  return 'OffHours';
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFLUENCE SCORING
// ══════════════════════════════════════════════════════════════════════════════

interface ConfluenceFactors {
  emaStack: boolean;        // EMA10 > EMA20 > EMA50 alignment
  adxStrong: boolean;       // ADX > minADX
  pullbackToEMA: boolean;   // Price pulled back to EMA20 zone
  pullbackBars: boolean;    // Pullback lasted 3+ bars
  confirmationCandle: boolean; // Engulfing/pin bar at EMA20
  volumeConfirm: boolean;   // Volume > 1.2x average on bounce
  rsiHealthy: boolean;      // RSI in pullback range (not extreme)
  sessionGood: boolean;     // London/NY/Overlap session
  diAligned: boolean;       // +DI > -DI for longs, inverse for shorts
  total: number;            // 0-9
}

function scoreConfluence(
  candle: Candle,
  prevCandle: Candle,
  window: Candle[],
  ema10: number,
  ema20: number,
  ema50: number,
  adxInfo: { adx: number; plusDI: number; minusDI: number },
  atrVal: number,
  rsiVal: number,
  direction: 'LONG' | 'SHORT',
  minADX: number,
  pullbackATR: number,
): ConfluenceFactors {
  const result: ConfluenceFactors = {
    emaStack: false,
    adxStrong: false,
    pullbackToEMA: false,
    pullbackBars: false,
    confirmationCandle: false,
    volumeConfirm: false,
    rsiHealthy: false,
    sessionGood: false,
    diAligned: false,
    total: 0,
  };

  // 1. EMA STACK
  if (direction === 'LONG' && ema10 > ema20 && ema20 > ema50) result.emaStack = true;
  if (direction === 'SHORT' && ema10 < ema20 && ema20 < ema50) result.emaStack = true;

  // 2. ADX STRONG
  if (adxInfo.adx >= minADX) result.adxStrong = true;

  // 3. PULLBACK TO EMA20 ZONE
  // Recent low/high should have touched EMA20 zone
  const recentBars = window.slice(-10);
  const recentLow = Math.min(...recentBars.map(b => b.low));
  const recentHigh = Math.max(...recentBars.map(b => b.high));

  if (direction === 'LONG') {
    // For longs: recent low should be near or below EMA20
    if (recentLow <= ema20 + atrVal * pullbackATR && recentLow >= ema20 - atrVal * pullbackATR) {
      result.pullbackToEMA = true;
    }
  } else {
    // For shorts: recent high should be near or above EMA20
    if (recentHigh >= ema20 - atrVal * pullbackATR && recentHigh <= ema20 + atrVal * pullbackATR) {
      result.pullbackToEMA = true;
    }
  }

  // 4. PULLBACK BARS (3+ bars of pullback)
  let pullbackCount = 0;
  for (let i = window.length - 1; i >= Math.max(0, window.length - 8); i--) {
    if (direction === 'LONG' && window[i].close < window[i].open) pullbackCount++;
    else if (direction === 'SHORT' && window[i].close > window[i].open) pullbackCount++;
    else break; // Break the streak
  }
  if (pullbackCount >= 2) result.pullbackBars = true;

  // 5. CONFIRMATION CANDLE (engulfing or pin bar at EMA20)
  const bodySize = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;

  if (totalRange > 0) {
    const bodyRatio = bodySize / totalRange;

    if (direction === 'LONG') {
      // Bullish engulfing
      if (candle.close > candle.open && prevCandle.close < prevCandle.open &&
          candle.close > prevCandle.open && candle.open < prevCandle.close) {
        result.confirmationCandle = true;
      }
      // Bullish pin bar / hammer
      if (lowerWick > bodySize * 1.5 && bodyRatio < 0.5) {
        result.confirmationCandle = true;
      }
      // Simply a strong bullish candle closing above EMA20
      if (candle.close > candle.open && candle.close > ema20 && bodySize > atrVal * 0.3) {
        result.confirmationCandle = true;
      }
    } else {
      // Bearish engulfing
      if (candle.close < candle.open && prevCandle.close > prevCandle.open &&
          candle.close < prevCandle.open && candle.open > prevCandle.close) {
        result.confirmationCandle = true;
      }
      // Bearish pin bar / shooting star
      if (upperWick > bodySize * 1.5 && bodyRatio < 0.5) {
        result.confirmationCandle = true;
      }
      // Strong bearish candle closing below EMA20
      if (candle.close < candle.open && candle.close < ema20 && bodySize > atrVal * 0.3) {
        result.confirmationCandle = true;
      }
    }
  }

  // 6. VOLUME CONFIRMATION
  const avgVolume = window.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  if (candle.volume > avgVolume * 1.2) result.volumeConfirm = true;

  // 7. RSI HEALTHY (in pullback range)
  if (direction === 'LONG' && rsiVal >= 35 && rsiVal <= 60) result.rsiHealthy = true;
  if (direction === 'SHORT' && rsiVal >= 40 && rsiVal <= 65) result.rsiHealthy = true;

  // 8. SESSION GOOD
  const session = getSession(candle.timestamp);
  if (['London', 'NewYork', 'Overlap'].includes(session)) result.sessionGood = true;

  // 9. DI ALIGNED
  if (direction === 'LONG' && adxInfo.plusDI > adxInfo.minusDI) result.diAligned = true;
  if (direction === 'SHORT' && adxInfo.minusDI > adxInfo.plusDI) result.diAligned = true;

  // Calculate total
  result.total = [
    result.emaStack ? 1.5 : 0,
    result.adxStrong ? 1 : 0,
    result.pullbackToEMA ? 1.5 : 0,
    result.pullbackBars ? 0.5 : 0,
    result.confirmationCandle ? 1.5 : 0,
    result.volumeConfirm ? 0.5 : 0,
    result.rsiHealthy ? 0.5 : 0,
    result.sessionGood ? 0.5 : 0,
    result.diAligned ? 0.5 : 0,
  ].reduce((a, b) => a + b, 0);

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE v6 — WITH TRAILING STOP
// ══════════════════════════════════════════════════════════════════════════════

function runBacktest(candles: Candle[], cfg: BacktestConfig): {
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
  avgMaxFavorable: number;
  avgMaxAdverse: number;
  byExitReason: Record<string, { total: number; pnl: number }>;
  byDirection: Record<string, { total: number; wins: number; winRate: number }>;
  signalsRejected: number;
  totalScanned: number;
} {
  const trades: Trade[] = [];
  let balance = cfg.initialBalance;
  let peakEquity = balance;
  let maxDrawdown = 0;
  let signalsRejected = 0;
  let totalScanned = 0;

  // Pre-compute EMAs for the entire dataset
  const closes = candles.map(c => c.close);
  const ema10All = calcEMA(closes, 10);
  const ema20All = calcEMA(closes, 20);
  const ema50All = calcEMA(closes, 50);

  let lastTradeBar = -cfg.cooldownBars;

  log(`🔄 ${cfg.asset} ${cfg.timeframe}: ${candles.length.toLocaleString()} candles`);
  log(`   Risk: ${cfg.riskPct}% | Trailing: ${cfg.trailingATR}x ATR | Min Confluence: ${cfg.minConfluence}/8`);

  const tfMinutes = TF_MAP[cfg.timeframe]?.minutes || 240;

  for (let i = 100; i < candles.length - 1; i++) {
    totalScanned++;

    // Progress logging
    if (totalScanned % 500 === 0) {
      const pct = Math.floor((i / candles.length) * 100);
      log(`   ${pct}% — ${trades.length} trades | Balance: $${balance.toFixed(2)} | Rejected: ${signalsRejected}`);
    }

    // Cooldown check
    if (i - lastTradeBar < cfg.cooldownBars) continue;

    const candle = candles[i];
    const prevCandle = candles[i - 1];
    const window = candles.slice(Math.max(0, i - 99), i + 1);
    if (window.length < 50) continue;

    // ═══ INDICATORS ═══
    const atrVal = calcATR(window);
    if (atrVal <= 0) continue;

    const windowCloses = window.map(c => c.close);
    const adxInfo = calcADX(window);
    const rsiVal = calcRSI(windowCloses);

    const ema10 = ema10All[i];
    const ema20 = ema20All[i];
    const ema50 = ema50All[i];

    if (!ema10 || !ema20 || !ema50) continue;

    // ═══ STEP 1: DETERMINE DIRECTION ═══
    const bullishTrend = ema10 > ema20 && ema20 > ema50 && candle.close > ema10;
    const bearishTrend = ema10 < ema20 && ema20 < ema50 && candle.close < ema10;

    if (!bullishTrend && !bearishTrend) { signalsRejected++; continue; }

    const direction: 'LONG' | 'SHORT' = bullishTrend ? 'LONG' : 'SHORT';

    // ═══ STEP 2: CONFLUENCE SCORING ═══
    const confluence = scoreConfluence(
      candle, prevCandle, window,
      ema10, ema20, ema50, adxInfo, atrVal, rsiVal,
      direction, cfg.minADX, cfg.pullbackATR
    );

    // Must have trend + pullback to EMA as minimum
    if (!confluence.emaStack) { signalsRejected++; continue; }
    if (!confluence.pullbackToEMA) { signalsRejected++; continue; }
    if (!confluence.adxStrong) { signalsRejected++; continue; }

    // Must meet minimum confluence
    if (confluence.total < cfg.minConfluence) { signalsRejected++; continue; }

    // ═══ STEP 3: ENTRY ═══
    const entryPrice = candle.close;

    // Initial SL: below pullback low (for longs) + buffer
    const recentLow = Math.min(...window.slice(-10).map(b => b.low));
    const recentHigh = Math.max(...window.slice(-10).map(b => b.high));

    let stopDistance: number;
    if (direction === 'LONG') {
      stopDistance = entryPrice - recentLow + atrVal * cfg.initialSLATR;
    } else {
      stopDistance = recentHigh - entryPrice + atrVal * cfg.initialSLATR;
    }

    // Clamp stop distance
    const maxStop = entryPrice * 0.04; // 4% max SL on 4H
    const minStop = entryPrice * 0.003; // 0.3% min SL
    stopDistance = Math.max(minStop, Math.min(maxStop, stopDistance));

    const initialSL = direction === 'LONG'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

    // ═══ POSITION SIZING ═══
    const riskAmount = balance * (cfg.riskPct / 100);
    const positionSize = stopDistance > 0 ? riskAmount / stopDistance : 0;
    if (positionSize <= 0 || balance < 100) continue;

    // ═══ ENTRY SIMULATION ═══
    const entrySlip = entryPrice * 0.0002;
    const actualEntry = direction === 'LONG' ? entryPrice + entrySlip : entryPrice - entrySlip;
    const entryFee = positionSize * actualEntry * (cfg.takerFeePct / 100);

    // ═══ TRADE MANAGEMENT WITH TRAILING STOP ═══
    let currentSL = initialSL;
    let highestFavorable = direction === 'LONG' ? entryPrice : entryPrice;
    let trailingActive = false;
    let exitPrice = 0;
    let exitReason: Trade['exitReason'] = 'END_OF_DATA';
    let holdingBars = 0;
    let maxFavorable = 0;
    let maxAdverse = 0;

    for (let j = i + 1; j < candles.length; j++) {
      holdingBars++;
      const bar = candles[j];

      // Track max favorable/adverse excursion
      if (direction === 'LONG') {
        const favorablePct = ((bar.high - actualEntry) / actualEntry) * 100;
        const adversePct = ((actualEntry - bar.low) / actualEntry) * 100;
        maxFavorable = Math.max(maxFavorable, favorablePct);
        maxAdverse = Math.max(maxAdverse, adversePct);

        // Update highest point for trailing
        if (bar.high > highestFavorable) {
          highestFavorable = bar.high;
        }

        // Activate trailing after 1 ATR profit
        const profitFromEntry = highestFavorable - actualEntry;
        if (profitFromEntry > atrVal && !trailingActive) {
          trailingActive = true;
        }

        // Update trailing stop
        if (trailingActive) {
          // Use tighter trail after 2 ATR profit
          const trailMult = profitFromEntry > atrVal * 2 ? cfg.trailingTightATR : cfg.trailingATR;
          const newTrail = highestFavorable - atrVal * trailMult;
          if (newTrail > currentSL) {
            currentSL = newTrail;
          }
        }

        // Check SL hit
        if (bar.low <= currentSL) {
          exitPrice = currentSL;
          exitReason = trailingActive ? 'TRAILING_STOP' : 'INITIAL_SL';
          break;
        }

      } else { // SHORT
        const favorablePct = ((actualEntry - bar.low) / actualEntry) * 100;
        const adversePct = ((bar.high - actualEntry) / actualEntry) * 100;
        maxFavorable = Math.max(maxFavorable, favorablePct);
        maxAdverse = Math.max(maxAdverse, adversePct);

        // Update lowest point for trailing
        if (bar.low < highestFavorable || highestFavorable === entryPrice) {
          highestFavorable = bar.low;
        }

        // Activate trailing after 1 ATR profit
        const profitFromEntry = actualEntry - highestFavorable;
        if (profitFromEntry > atrVal && !trailingActive) {
          trailingActive = true;
        }

        // Update trailing stop
        if (trailingActive) {
          const trailMult = profitFromEntry > atrVal * 2 ? cfg.trailingTightATR : cfg.trailingATR;
          const newTrail = highestFavorable + atrVal * trailMult;
          if (newTrail < currentSL) {
            currentSL = newTrail;
          }
        }

        // Check SL hit
        if (bar.high >= currentSL) {
          exitPrice = currentSL;
          exitReason = trailingActive ? 'TRAILING_STOP' : 'INITIAL_SL';
          break;
        }
      }

      // ═══ TREND BREAK EXIT ═══
      // EMA10 crosses EMA20 = trend is weakening, get out
      if (j < ema10All.length && j < ema20All.length) {
        const ema10Now = ema10All[j];
        const ema20Now = ema20All[j];
        const ema10Prev = ema10All[j - 1];
        const ema20Prev = ema20All[j - 1];

        if (direction === 'LONG' && ema10Prev >= ema20Prev && ema10Now < ema20Now) {
          // EMA10 crossed below EMA20 — trend breaking
          exitPrice = bar.close;
          exitReason = 'TREND_BREAK';
          break;
        }
        if (direction === 'SHORT' && ema10Prev <= ema20Prev && ema10Now > ema20Now) {
          exitPrice = bar.close;
          exitReason = 'TREND_BREAK';
          break;
        }
      }

      // Safety: max holding time
      if (holdingBars >= cfg.maxHoldingBars) {
        exitPrice = bar.close;
        exitReason = 'END_OF_DATA';
        break;
      }
    }

    if (exitPrice === 0) {
      // End of data
      exitPrice = candles[candles.length - 1].close;
      exitReason = 'END_OF_DATA';
    }

    // ═══ EXIT SIMULATION ═══
    const exitSlip = exitPrice * 0.0002;
    const actualExit = direction === 'LONG' ? exitPrice - exitSlip : exitPrice + exitSlip;
    const exitFee = positionSize * actualExit * (cfg.takerFeePct / 100);
    const totalFees = entryFee + exitFee;

    // P&L
    const rawPnl = direction === 'LONG'
      ? (actualExit - actualEntry) * positionSize
      : (actualEntry - actualExit) * positionSize;
    const netPnl = rawPnl - totalFees;
    const pnlPct = positionSize > 0 && actualEntry > 0
      ? (netPnl / (actualEntry * positionSize)) * 100 : 0;

    // Update balance
    balance += netPnl;
    peakEquity = Math.max(peakEquity, balance);
    const drawdownPct = peakEquity > 0 ? ((peakEquity - balance) / peakEquity) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdownPct);

    trades.push({
      timestamp: candle.timestamp,
      asset: cfg.asset,
      direction,
      entryPrice: actualEntry,
      exitPrice: actualExit,
      exitReason,
      pnl: netPnl,
      pnlPct,
      fees: totalFees,
      holdingBars,
      maxFavorable,
      maxAdverse,
      confluenceScore: confluence.total,
      trendStrength: adxInfo.adx,
      rsiAtEntry: rsiVal,
    });

    lastTradeBar = i;
  }

  // ═══ COMPUTE STATISTICS ═══
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
  const avgMaxFavorable = trades.length > 0 ? trades.reduce((s, t) => s + t.maxFavorable, 0) / trades.length : 0;
  const avgMaxAdverse = trades.length > 0 ? trades.reduce((s, t) => s + t.maxAdverse, 0) / trades.length : 0;

  // By exit reason
  const byExitReason: Record<string, { total: number; pnl: number }> = {};
  for (const t of trades) {
    if (!byExitReason[t.exitReason]) byExitReason[t.exitReason] = { total: 0, pnl: 0 };
    byExitReason[t.exitReason].total++;
    byExitReason[t.exitReason].pnl += t.pnl;
  }

  // By direction
  const byDirection: Record<string, { total: number; wins: number; winRate: number }> = {};
  for (const t of trades) {
    if (!byDirection[t.direction]) byDirection[t.direction] = { total: 0, wins: 0, winRate: 0 };
    byDirection[t.direction].total++;
    if (t.pnl > 0) byDirection[t.direction].wins++;
  }
  for (const k of Object.keys(byDirection)) {
    byDirection[k].winRate = (byDirection[k].wins / byDirection[k].total) * 100;
  }

  return {
    trades, finalBalance: balance,
    totalReturnPct: ((balance - cfg.initialBalance) / cfg.initialBalance) * 100,
    maxDrawdownPct: maxDrawdown, winRate,
    totalWins: wins.length, totalLosses: losses.length,
    avgWinPct, avgLossPct, profitFactor, expectedValue,
    avgHoldingBars: trades.length > 0 ? trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length : 0,
    totalFees, avgMaxFavorable, avgMaxAdverse,
    byExitReason, byDirection,
    signalsRejected, totalScanned,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATOR
// ══════════════════════════════════════════════════════════════════════════════

function generateReport(result: ReturnType<typeof runBacktest>, cfg: BacktestConfig): string {
  const L: string[] = [];
  const wrIcon = (wr: number) => wr >= 45 ? '✅' : wr >= 35 ? '🟡' : '❌';
  const isProfitable = result.finalBalance > cfg.initialBalance;

  L.push('');
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  SIGNALTRADER PRO — BACKTEST v6 (INSTITUTIONAL TREND FOLLOWING)     ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');
  L.push(`📊 Asset: ${cfg.asset} | TF: ${cfg.timeframe} | Months: ${cfg.months}`);
  L.push(`💰 Initial: $${cfg.initialBalance.toLocaleString()} | Risk: ${cfg.riskPct}% | Fee: ${(cfg.takerFeePct * 2).toFixed(2)}% round trip`);
  L.push(`📈 Trailing: ${cfg.trailingATR}x ATR → ${cfg.trailingTightATR}x ATR | SL: ${cfg.initialSLATR}x ATR buffer`);
  L.push(`🎯 Min Confluence: ${cfg.minConfluence}/8 | Min ADX: ${cfg.minADX} | Cooldown: ${cfg.cooldownBars} bars`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  RESULTADOS FINANCIEROS');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Balance Final:    $${result.finalBalance.toFixed(2)}`);
  L.push(`  Retorno Total:    ${result.totalReturnPct >= 0 ? '+' : ''}${result.totalReturnPct.toFixed(2)}% ($${(result.finalBalance - cfg.initialBalance).toFixed(2)})`);
  L.push(`  Max Drawdown:     ${result.maxDrawdownPct.toFixed(2)}%`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  ESTADÍSTICAS DE TRADING');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Total Trades:     ${result.trades.length}`);
  L.push(`  Wins:             ${result.totalWins} | Losses: ${result.totalLosses}`);
  L.push(`  Win Rate:         ${wrIcon(result.winRate)} ${result.winRate.toFixed(1)}%`);
  L.push(`  Avg Win:          +${result.avgWinPct.toFixed(3)}%`);
  L.push(`  Avg Loss:         ${result.avgLossPct.toFixed(3)}%`);
  L.push(`  Profit Factor:    ${result.profitFactor.toFixed(2)}`);
  L.push(`  Expected Value:   $${result.expectedValue.toFixed(2)} per trade`);
  L.push(`  Avg Hold:         ${result.avgHoldingBars.toFixed(1)} bars (${(result.avgHoldingBars * (TF_MAP[cfg.timeframe]?.minutes || 240) / 60).toFixed(1)} hours)`);
  L.push(`  Avg Max Favorable:${result.avgMaxFavorable.toFixed(2)}%`);
  L.push(`  Avg Max Adverse:  ${result.avgMaxAdverse.toFixed(2)}%`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  IMPACTO DE COSTOS');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Total Fees:       $${result.totalFees.toFixed(2)}`);
  const pnlNoFees = result.trades.reduce((s, t) => s + t.pnl + t.fees, 0);
  L.push(`  P&L sin fees:     $${pnlNoFees.toFixed(2)}`);
  L.push(`  P&L con fees:     $${(result.finalBalance - cfg.initialBalance).toFixed(2)}`);
  L.push(`  Fee % of Capital: ${((result.totalFees / cfg.initialBalance) * 100).toFixed(2)}%`);
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR RAZÓN DE SALIDA');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [reason, data] of Object.entries(result.byExitReason).sort((a, b) => b[1].total - a[1].total)) {
    const icon = data.pnl > 0 ? '💰' : '💸';
    L.push(`  ${icon} ${reason.padEnd(16)} ${data.total} trades | $${data.pnl.toFixed(2)} total P&L`);
  }
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  POR DIRECCIÓN');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  for (const [dir, data] of Object.entries(result.byDirection)) {
    L.push(`  ${wrIcon(data.winRate)} ${dir.padEnd(6)} ${data.winRate.toFixed(1)}% WR (${data.wins}W/${data.total - data.wins}L)`);
  }
  L.push('');

  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('  FILTROS');
  L.push('══════════════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Velas escaneadas:  ${result.totalScanned.toLocaleString()}`);
  L.push(`  Señales rechazadas: ${result.signalsRejected.toLocaleString()}`);
  L.push(`  Trades ejecutados:  ${result.trades.length}`);
  const acceptanceRate = result.totalScanned > 0
    ? ((result.trades.length / result.totalScanned) * 100).toFixed(2)
    : '0';
  L.push(`  Ratio aceptación:   ${acceptanceRate}%`);
  L.push('');

  // Show top 5 best and worst trades
  if (result.trades.length > 0) {
    const sorted = [...result.trades].sort((a, b) => b.pnl - a.pnl);
    L.push('══════════════════════════════════════════════════════════════════════');
    L.push('  TOP 5 MEJORES TRADES');
    L.push('══════════════════════════════════════════════════════════════════════');
    L.push('');
    for (let i = 0; i < Math.min(5, sorted.length); i++) {
      const t = sorted[i];
      L.push(`  #${i + 1} ${t.direction} | ${t.exitReason} | +${t.pnlPct.toFixed(2)}% | $${t.pnl.toFixed(2)}`);
      L.push(`     Max Favorable: ${t.maxFavorable.toFixed(1)}% | Hold: ${t.holdingBars} bars | ADX: ${t.trendStrength.toFixed(0)}`);
    }
    L.push('');

    const worst = [...result.trades].sort((a, b) => a.pnl - b.pnl);
    L.push('══════════════════════════════════════════════════════════════════════');
    L.push('  TOP 5 PEORES TRADES');
    L.push('══════════════════════════════════════════════════════════════════════');
    L.push('');
    for (let i = 0; i < Math.min(5, worst.length); i++) {
      const t = worst[i];
      L.push(`  #${i + 1} ${t.direction} | ${t.exitReason} | ${t.pnlPct.toFixed(2)}% | $${t.pnl.toFixed(2)}`);
      L.push(`     Max Adverse: ${t.maxAdverse.toFixed(1)}% | Max Favorable: ${t.maxFavorable.toFixed(1)}% | Hold: ${t.holdingBars} bars`);
    }
    L.push('');
  }

  // VERDICT
  L.push('╔══════════════════════════════════════════════════════════════════════╗');
  L.push('║  🎯 VEREDICTO                                                       ║');
  L.push('╚══════════════════════════════════════════════════════════════════════╝');
  L.push('');

  if (isProfitable && result.profitFactor >= 1.3 && result.winRate >= 35) {
    L.push('  ✅ EDGE REAL ENCONTRADO después de fees y slippage.');
    L.push(`  → Profit Factor ${result.profitFactor.toFixed(2)} > 1.3 es sólido.`);
    L.push(`  → WR ${result.winRate.toFixed(1)}% con trailing stop = sistema viable.`);
    L.push(`  → EV = $${result.expectedValue.toFixed(2)}/trade es positivo.`);
    L.push(`  → Max DD ${result.maxDrawdownPct.toFixed(1)}% es aceptable.`);
    L.push(`  → IMPLEMENTAR en auto-trader.`);
  } else if (isProfitable && result.profitFactor >= 1.1) {
    L.push('  🟡 EDGE MARGINAL detectado.');
    L.push(`  → Profit Factor ${result.profitFactor.toFixed(2)} es apenas positivo.`);
    L.push(`  → WR ${result.winRate.toFixed(1)}% necesita mejorar.`);
    L.push(`  → Ajustar: subir minConfluence, ajustar trailing, o filtrar más.`);
  } else if (pnlNoFees > 0 && (result.finalBalance - cfg.initialBalance) < 0) {
    L.push('  ⚠️ EDGE ANTES DE FEES PERO FEES SE COMEN LA GANANCIA.');
    L.push(`  → Sin fees: $${pnlNoFees.toFixed(2)} | Con fees: $${(result.finalBalance - cfg.initialBalance).toFixed(2)}`);
    L.push(`  → Necesitas: menos trades o más ganancia por trade.`);
    L.push(`  → Probar: trailing más amplio o riesgo más bajo.`);
  } else {
    L.push('  ❌ NO HAY EDGE en esta configuración.');
    L.push(`  → Balance: $${result.finalBalance.toFixed(2)} | PF: ${result.profitFactor.toFixed(2)}`);
    L.push(`  → Probar: cambiar trailing (${cfg.trailingATR}x), riesgo (${cfg.riskPct}%), o confluencia (${cfg.minConfluence}).`);
    L.push('  → Considerar: diferentes assets o timeframe diario.');
  }
  L.push('');

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  let assets = ['BTC/USD', 'ETH/USD'];
  let months = 6;
  let timeframe = '4h';
  let trailingATR = 2.0;
  let trailingTightATR = 1.5;
  let riskPct = 1.5;
  let minConfluence = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asset' && args[i + 1]) { assets = [args[++i]]; }
    else if (args[i] === '--months' && args[i + 1]) { months = parseInt(args[++i]); }
    else if (args[i] === '--timeframe' && args[i + 1]) { timeframe = args[++i]; }
    else if (args[i] === '--trailing' && args[i + 1]) { trailingATR = parseFloat(args[++i]); }
    else if (args[i] === '--risk' && args[i + 1]) { riskPct = parseFloat(args[++i]); }
    else if (args[i] === '--confluence' && args[i + 1]) { minConfluence = parseFloat(args[++i]); }
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  SIGNALTRADER PRO — BACKTEST v6 (INSTITUTIONAL TREND FOLLOWING)     ║');
  console.log('║  Strategy: Strong trend + EMA pullback + Trailing stop              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Assets: ${assets.join(', ')} | TF: ${timeframe} | Months: ${months}`);
  console.log(`  Trailing: ${trailingATR}x → ${trailingTightATR}x ATR | Risk: ${riskPct}% | Min Confluence: ${minConfluence}`);
  console.log('');

  const tfMinutes = TF_MAP[timeframe]?.minutes || 240;

  // Test multiple configurations
  const configs: Array<{ name: string; trailing: number; trailingTight: number; risk: number; confluence: number; minADX: number }> = [
    { name: 'Conservative',  trailing: 2.0, trailingTight: 1.5, risk: 1.0, confluence: 5, minADX: 22 },
    { name: 'Moderate',      trailing: 2.5, trailingTight: 1.5, risk: 1.5, confluence: 5, minADX: 20 },
    { name: 'Aggressive',    trailing: 3.0, trailingTight: 2.0, risk: 2.0, confluence: 4, minADX: 18 },
    { name: 'Ultra-Select',  trailing: 2.0, trailingTight: 1.5, risk: 1.5, confluence: 6, minADX: 25 },
  ];

  for (const asset of assets) {
    const candles = await downloadData(asset, timeframe, months);
    if (candles.length < 300) {
      console.error(`❌ ${asset}: Not enough data (${candles.length} candles)`);
      continue;
    }

    for (const preset of configs) {
      const cfg: BacktestConfig = {
        asset,
        timeframe,
        months,
        initialBalance: 10000,
        riskPct: preset.risk,
        takerFeePct: 0.06,
        trailingATR: preset.trailing,
        trailingTightATR: preset.trailingTight,
        initialSLATR: 0.5,
        minADX: preset.minADX,
        pullbackATR: 1.5,
        minConfluence: preset.confluence,
        cooldownBars: Math.max(3, Math.round(12 * 60 / tfMinutes)), // 12 hours cooldown
        maxHoldingBars: Math.round(14 * 24 * 60 / tfMinutes), // 14 days max hold
      };

      log(`📊 Running ${asset} ${timeframe} — ${preset.name} config...`);
      const result = runBacktest(candles, cfg);
      const report = generateReport(result, cfg);
      console.log(report);

      // Save report to file
      const fs = await import('fs');
      const path = await import('path');
      const filename = `backtest-v6-${asset.replace('/', '-')}-${timeframe}-${preset.name.toLowerCase()}-report.txt`;
      fs.writeFileSync(
        path.join(process.cwd(), filename),
        report,
        'utf-8'
      );
      log(`💾 Report saved to ${filename}`);
    }
  }

  console.log('\n═══ Backtest v6 completed ═══');
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
