#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — BACKTESTER v4 (MEAN REVERSION AT STRUCTURE)
//
// PHILOSOPHY CHANGE from v3:
// v3 failed because: 7,000+ trades, 25% WR, chasing with lagging indicators
// v4 strategy: ONLY trade reversals at key Support/Resistance levels with
//              confluence of rejection + volume + RSI extreme + HTF alignment
//
// Target: 200-500 trades/year, 40-50% WR, 3:1 R:R, positive EV after fees
//
// New Signal Logic:
// 1. Detect S/R levels from swing highs/lows (market structure)
// 2. Price must be AT a key S/R level (within 1 ATR)
// 3. Rejection candle at the level (pin bar, doji, engulfing reversal)
// 4. RSI must be extreme (oversold for longs, overbought for shorts)
// 5. Volume must be elevated (>1.5x average)
// 6. HTF trend alignment (EMA20 slope on higher TF)
// 7. Confluence score >= 6/10 required
// 8. SL just beyond the level, TP at 3x risk
//
// Usage: npx tsx scripts/backtest-v4.ts
//        npx tsx scripts/backtest-v4.ts --asset BTC/USD --months 6
//        npx tsx scripts/backtest-v4.ts --timeframe 15m --months 3
// ══════════════════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
config({ path: '../.env' });
config({ path: '.env' });

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

interface SRLevel {
  price: number;
  strength: number;       // How many times price reacted here (1-5)
  type: 'SUPPORT' | 'RESISTANCE';
  lastTouch: number;      // Index of last touch
  touches: number;        // How many times price bounced off this level
}

interface ConfluenceScore {
  atLevel: boolean;        // Price at S/R level
  rejectionCandle: boolean; // Pin bar / doji / engulfing reversal
  rsiExtreme: boolean;     // RSI oversold/overbought
  volumeConfirm: boolean;  // Volume > 1.5x average
  htfAligned: boolean;     // Higher TF EMA slope agrees
  trendExhaustion: boolean; // Consecutive candles in one direction
  bbExtreme: boolean;      // Price at BB extreme
  momentumDivergence: boolean; // RSI diverging from price
  sessionQuality: boolean; // London/NY/Overlap
  noRecentLoss: boolean;   // Haven't lost at this level recently
  total: number;           // 0-10
}

interface BacktestTrade {
  index: number;
  timestamp: Date;
  asset: string;
  direction: 'HIGHER' | 'LOWER';
  entryPrice: number;
  exitPrice: number;
  exitReason: 'SL_HIT' | 'TP_HIT' | 'EXPIRATION';
  pnl: number;
  pnlPct: number;
  fees: number;
  slippage: number;
  stopLoss: number;
  takeProfit: number;
  confluence: ConfluenceScore;
  levelPrice: number;      // The S/R level that triggered the trade
  holdingBars: number;
}

interface BacktestConfig {
  asset: string;
  timeframe: string;
  months: number;
  initialBalance: number;
  riskPerTrade: number;    // % of account
  takerFeePct: number;    // 0.06% per side = 0.12% round trip
  slippagePct: number;
  riskRewardRatio: number; // 3:1 default
  expirationHours: number; // 4-8 hours
  minConfluence: number;   // Minimum confluence score (0-10)
  srLookback: number;      // How many bars to look back for S/R
  srTouchMin: number;      // Minimum touches to be a valid level
  srProximityATR: number;  // How close to level (in ATR multiples)
}

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const ASSET_MAP: Record<string, { symbol: string; decimals: number }> = {
  'BTC/USD': { symbol: 'BTCUSDT', decimals: 2 },
  'ETH/USD': { symbol: 'ETHUSDT', decimals: 2 },
};

const BINANCE_API = 'https://api.binance.com/api/v3/klines';

const TIMEFRAME_MAP: Record<string, { binance: string; minutes: number }> = {
  '5m':  { binance: '5m',  minutes: 5 },
  '15m': { binance: '15m', minutes: 15 },
  '1h':  { binance: '1h',  minutes: 60 },
  '4h':  { binance: '4h',  minutes: 240 },
};

function log(msg: string) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA DOWNLOADER
// ══════════════════════════════════════════════════════════════════════════════

async function downloadHistoricalData(asset: string, timeframe: string, months: number): Promise<Candle[]> {
  const cfg = ASSET_MAP[asset];
  if (!cfg) throw new Error(`${asset} not supported.`);
  const tf = TIMEFRAME_MAP[timeframe];
  if (!tf) throw new Error(`Timeframe ${timeframe} not supported.`);

  const endMs = Date.now();
  const startMs = endMs - months * 30 * 24 * 60 * 60 * 1000;
  const allCandles: Candle[] = [];
  let currentStart = startMs;

  log(`📥 Downloading ${asset} ${timeframe} (${months} months) from Binance...`);

  while (currentStart < endMs) {
    const url = `${BINANCE_API}?symbol=${cfg.symbol}&interval=${tf.binance}&startTime=${currentStart}&endTime=${endMs}&limit=1000`;
    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as any[][];
        if (data.length === 0) { log(`  ✅ ${allCandles.length.toLocaleString()} candles`); return allCandles; }
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
  log(`  ✅ ${allCandles.length.toLocaleString()} candles`);
  return allCandles;
}

// ══════════════════════════════════════════════════════════════════════════════
// TECHNICAL CALCULATIONS (self-contained, no external deps)
// ══════════════════════════════════════════════════════════════════════════════

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

function calcEMA(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let ema = values[0];
  result.push(ema);
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcBollingerBands(closes: number[], period: number = 20, mult: number = 2): { upper: number; middle: number; lower: number } {
  const middle = calcSMA(closes, period);
  const slice = closes.slice(-period);
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + mult * std, middle, lower: middle - mult * std };
}

function calcAverageVolume(candles: Candle[], period: number = 20): number {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  return slice.reduce((sum, c) => sum + c.volume, 0) / period;
}

// ══════════════════════════════════════════════════════════════════════════════
// SUPPORT/RESISTANCE LEVEL DETECTION
// This is the CORE of the v4 strategy — find real price structure
// ══════════════════════════════════════════════════════════════════════════════

function detectSwingPoints(candles: Candle[], lookback: number = 5): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) {
        isSwingHigh = false;
      }
      if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) highs.push(candles[i].high);
    if (isSwingLow) lows.push(candles[i].low);
  }

  return { highs, lows };
}

function clusterLevels(prices: number[], atr: number): SRLevel[] {
  if (prices.length === 0 || atr <= 0) return [];

  // Cluster nearby prices (within 0.5 ATR)
  const sorted = [...prices].sort((a, b) => a - b);
  const clusters: number[][] = [];
  let currentCluster: number[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < atr * 0.5) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [sorted[i]];
    }
  }
  clusters.push(currentCluster);

  // Convert clusters to levels
  return clusters
    .filter(c => c.length >= 2) // Must have at least 2 touches
    .map(c => ({
      price: c.reduce((a, b) => a + b, 0) / c.length, // Average price
      strength: Math.min(5, c.length),                   // More touches = stronger
      type: 'SUPPORT' as const,                          // Will be determined by context
      lastTouch: 0,
      touches: c.length,
    }));
}

function detectSRLevels(candles: Candle[], lookback: number = 200, swingLookback: number = 5): SRLevel[] {
  const window = candles.slice(-lookback);
  if (window.length < 30) return [];

  const atr = calcATR(window);
  const { highs, lows } = detectSwingPoints(window, swingLookback);

  const supportLevels = clusterLevels(lows, atr).map(l => ({ ...l, type: 'SUPPORT' as const }));
  const resistanceLevels = clusterLevels(highs, atr).map(l => ({ ...l, type: 'RESISTANCE' as const }));

  // Merge nearby S/R levels (a level can be both support and resistance)
  const allLevels = [...supportLevels, ...resistanceLevels];
  const merged: SRLevel[] = [];

  for (const level of allLevels) {
    const existing = merged.find(m => Math.abs(m.price - level.price) < atr * 0.3);
    if (existing) {
      existing.touches += level.touches;
      existing.strength = Math.min(5, existing.touches);
      // Keep the stronger type
      if (level.touches > existing.touches / 2) {
        existing.type = level.type;
      }
    } else {
      merged.push({ ...level });
    }
  }

  return merged.filter(l => l.strength >= 2); // Only levels with 2+ touches
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFLUENCE SCORING ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function scoreConfluence(
  candle: Candle,
  prevCandle: Candle,
  candles: Candle[],
  srLevels: SRLevel[],
  direction: 'HIGHER' | 'LOWER',
  atr: number,
  rsi: number,
  avgVolume: number,
  bb: { upper: number; middle: number; lower: number },
  ema20Slope: number,
  session: string
): { score: ConfluenceScore; nearestLevel: SRLevel | null } {

  const result: ConfluenceScore = {
    atLevel: false,
    rejectionCandle: false,
    rsiExtreme: false,
    volumeConfirm: false,
    htfAligned: false,
    trendExhaustion: false,
    bbExtreme: false,
    momentumDivergence: false,
    sessionQuality: false,
    noRecentLoss: true, // Always true in backtest (no memory)
    total: 0,
  };

  // 1. PRICE AT S/R LEVEL — the most important filter
  let nearestLevel: SRLevel | null = null;
  let nearestDist = Infinity;

  for (const level of srLevels) {
    const dist = Math.abs(candle.close - level.price);
    if (dist < atr * 1.0 && dist < nearestDist) { // Within 1 ATR of level
      nearestDist = dist;
      nearestLevel = level;

      // For LONGS: price should be at SUPPORT (below or at level)
      // For SHORTS: price should be at RESISTANCE (above or at level)
      if (direction === 'HIGHER' && level.type === 'SUPPORT') {
        result.atLevel = true;
      } else if (direction === 'LOWER' && level.type === 'RESISTANCE') {
        result.atLevel = true;
      } else if (level.strength >= 3) {
        // Strong levels work as both S and R
        result.atLevel = true;
      }
    }
  }

  // 2. REJECTION CANDLE — pin bar, doji, or engulfing reversal
  const bodySize = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;

  if (totalRange > 0) {
    const bodyRatio = bodySize / totalRange;

    if (direction === 'HIGHER') {
      // Bullish pin bar: long lower wick, small body at top
      if (lowerWick > bodySize * 2 && bodyRatio < 0.4) result.rejectionCandle = true;
      // Bullish engulfing: current bullish engulfs previous bearish
      if (candle.close > candle.open && prevCandle.close < prevCandle.open &&
          candle.close > prevCandle.open && candle.open < prevCandle.close) result.rejectionCandle = true;
      // Hammer: long lower wick at bottom of move
      if (lowerWick > upperWick * 3 && bodyRatio < 0.35) result.rejectionCandle = true;
    } else {
      // Bearish pin bar: long upper wick, small body at bottom
      if (upperWick > bodySize * 2 && bodyRatio < 0.4) result.rejectionCandle = true;
      // Bearish engulfing
      if (candle.close < candle.open && prevCandle.close > prevCandle.open &&
          candle.close < prevCandle.open && candle.open > prevCandle.close) result.rejectionCandle = true;
      // Shooting star
      if (upperWick > lowerWick * 3 && bodyRatio < 0.35) result.rejectionCandle = true;
    }
  }

  // 3. RSI EXTREME — oversold for longs, overbought for shorts
  if (direction === 'HIGHER' && rsi < 35) result.rsiExtreme = true;
  if (direction === 'LOWER' && rsi > 65) result.rsiExtreme = true;
  // Extra point for extreme RSI
  if (direction === 'HIGHER' && rsi < 25) result.rsiExtreme = true;
  if (direction === 'LOWER' && rsi > 75) result.rsiExtreme = true;

  // 4. VOLUME CONFIRMATION — above average volume
  if (avgVolume > 0 && candle.volume > avgVolume * 1.5) result.volumeConfirm = true;

  // 5. HTF TREND ALIGNMENT — EMA20 slope agrees with direction
  if (direction === 'HIGHER' && ema20Slope > 0) result.htfAligned = true;
  if (direction === 'LOWER' && ema20Slope < 0) result.htfAligned = true;

  // 6. TREND EXHAUSTION — 5+ consecutive candles in one direction before reversal
  if (candles.length >= 6) {
    let consecutive = 0;
    const dir = direction === 'HIGHER' ? 'down' : 'up'; // Looking for exhaustion in OPPOSITE direction
    for (let i = candles.length - 2; i >= Math.max(0, candles.length - 8); i--) {
      if (dir === 'down' && candles[i].close < candles[i].open) consecutive++;
      else if (dir === 'up' && candles[i].close > candles[i].open) consecutive++;
      else break;
    }
    if (consecutive >= 4) result.trendExhaustion = true;
  }

  // 7. BOLLINGER BAND EXTREME
  if (direction === 'HIGHER' && candle.close < bb.lower) result.bbExtreme = true;
  if (direction === 'LOWER' && candle.close > bb.upper) result.bbExtreme = true;
  if (direction === 'HIGHER' && candle.low < bb.lower) result.bbExtreme = true;
  if (direction === 'LOWER' && candle.high > bb.upper) result.bbExtreme = true;

  // 8. MOMENTUM DIVERGENCE — RSI not making new low/high while price does
  if (candles.length >= 20) {
    const recentCloses = candles.slice(-20).map(c => c.close);
    const prevLow = Math.min(...recentCloses.slice(0, 10));
    const currLow = Math.min(...recentCloses.slice(10));
    const prevHigh = Math.max(...recentCloses.slice(0, 10));
    const currHigh = Math.max(...recentCloses.slice(10));

    if (direction === 'HIGHER' && currLow < prevLow && rsi > 30) {
      // Price making lower low but RSI not oversold = potential divergence
      result.momentumDivergence = true;
    }
    if (direction === 'LOWER' && currHigh > prevHigh && rsi < 70) {
      result.momentumDivergence = true;
    }
  }

  // 9. SESSION QUALITY
  if (session === 'Overlap' || session === 'London' || session === 'NewYork') {
    result.sessionQuality = true;
  }

  // Calculate total score
  result.total = [
    result.atLevel ? 2 : 0,        // Most important: 2 points
    result.rejectionCandle ? 2 : 0, // Very important: 2 points
    result.rsiExtreme ? 1 : 0,
    result.volumeConfirm ? 1 : 0,
    result.htfAligned ? 1 : 0,
    result.trendExhaustion ? 1 : 0,
    result.bbExtreme ? 1 : 0,
    result.momentumDivergence ? 0.5 : 0,
    result.sessionQuality ? 0.5 : 0,
  ].reduce((a, b) => a + b, 0);

  return { score: result, nearestLevel };
}

// ══════════════════════════════════════════════════════════════════════════════
// SESSION DETECTION
// ══════════════════════════════════════════════════════════════════════════════

function getSession(timestamp: Date): string {
  const hour = timestamp.getUTCHours();
  // London: 07:00-16:00 UTC
  // New York: 12:00-21:00 UTC
  // Overlap: 12:00-16:00 UTC
  // Asia: 23:00-08:00 UTC
  if (hour >= 12 && hour < 16) return 'Overlap';
  if (hour >= 7 && hour < 16) return 'London';
  if (hour >= 12 && hour < 21) return 'NewYork';
  if (hour >= 23 || hour < 8) return 'Asia';
  return 'OffHours';
}

// ══════════════════════════════════════════════════════════════════════════════
// DIRECTION DETERMINATION (Mean Reversion, not Trend Following)
// ══════════════════════════════════════════════════════════════════════════════

function determineDirection(
  candle: Candle,
  prevCandle: Candle,
  rsi: number,
  bb: { upper: number; middle: number; lower: number },
  nearestLevel: SRLevel | null
): 'HIGHER' | 'LOWER' | 'NO_TRADE' {

  // PRIMARY: Level-based direction
  if (nearestLevel) {
    if (nearestLevel.type === 'SUPPORT') return 'HIGHER';  // Buy at support
    if (nearestLevel.type === 'RESISTANCE') return 'LOWER'; // Sell at resistance
    // Strong levels: check if price is below or above
    if (nearestLevel.strength >= 3) {
      return candle.close < nearestLevel.price ? 'HIGHER' : 'LOWER';
    }
  }

  // SECONDARY: Mean reversion at extremes
  // RSI oversold + price below BB lower = buy
  if (rsi < 30 && candle.close < bb.lower) return 'HIGHER';
  // RSI overbought + price above BB upper = sell
  if (rsi > 70 && candle.close > bb.upper) return 'LOWER';

  // TERTIARY: Rejection candle direction
  const bodySize = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  const upperWick = candle.high - Math.max(candle.close, candle.open);

  if (lowerWick > bodySize * 2 && lowerWick > upperWick) return 'HIGHER'; // Bullish rejection
  if (upperWick > bodySize * 2 && upperWick > lowerWick) return 'LOWER';  // Bearish rejection

  return 'NO_TRADE';
}

// ══════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE v4
// ══════════════════════════════════════════════════════════════════════════════

function runBacktest(candles: Candle[], cfg: BacktestConfig): {
  trades: BacktestTrade[];
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
  totalSlippage: number;
  byConfluence: Record<number, { total: number; wins: number; winRate: number; avgPnlPct: number }>;
  bySession: Record<string, { total: number; wins: number; winRate: number; avgPnlPct: number }>;
  byExitReason: Record<string, { total: number; pnl: number }>;
  signalsFiltered: number;
  totalScanned: number;
} {
  const trades: BacktestTrade[] = [];
  let balance = cfg.initialBalance;
  let peakEquity = balance;
  let maxDrawdown = 0;
  let signalsFiltered = 0;
  let totalScanned = 0;

  const tfMinutes = TIMEFRAME_MAP[cfg.timeframe]?.minutes || 15;
  const expirationBars = Math.round((cfg.expirationHours * 60) / tfMinutes);

  // Cooldown: minimum bars between trades
  const COOLDOWN_BARS = Math.round(30 / tfMinutes); // 30 min cooldown
  let lastTradeBar = -COOLDOWN_BARS;

  log(`🔄 Simulating ${cfg.asset} ${cfg.timeframe}: ${candles.length.toLocaleString()} candles`);

  for (let i = Math.max(200, cfg.srLookback); i < candles.length - expirationBars; i++) {
    totalScanned++;

    // Progress
    if (totalScanned % 2000 === 0) {
      const pct = Math.floor((i / candles.length) * 100);
      log(`   ${pct}% — ${trades.length} trades | Balance: $${balance.toFixed(2)} | Filtered: ${signalsFiltered}`);
    }

    // Cooldown check
    if (i - lastTradeBar < COOLDOWN_BARS) continue;

    // Session filter
    const session = getSession(candles[i].timestamp);
    if (session === 'OffHours') continue;

    // Compute indicators from available data
    const window = candles.slice(Math.max(0, i - 199), i + 1);
    const closes = window.map(c => c.close);

    const atr = calcATR(window);
    if (atr <= 0) continue;

    const rsi = calcRSI(closes);
    const bb = calcBollingerBands(closes);
    const avgVolume = calcAverageVolume(window);

    // EMA20 slope for HTF alignment
    const ema20 = calcEMA(closes, 20);
    const emaSlope = ema20.length >= 5
      ? (ema20[ema20.length - 1] - ema20[ema20.length - 5]) / ema20[ema20.length - 5]
      : 0;

    // Detect S/R levels
    const srLevels = detectSRLevels(candles.slice(0, i + 1), cfg.srLookback);
    if (srLevels.length === 0) continue; // No structure = no trade

    const candle = candles[i];
    const prevCandle = candles[i - 1];

    // Determine direction (mean reversion)
    // First find nearest level to check if we're at one
    let nearestLevel: SRLevel | null = null;
    let nearestDist = Infinity;
    for (const level of srLevels) {
      const dist = Math.abs(candle.close - level.price);
      if (dist < atr * cfg.srProximityATR && dist < nearestDist) {
        nearestDist = dist;
        nearestLevel = level;
      }
    }

    // If not near a level, skip (UNLESS extreme RSI + BB)
    if (!nearestLevel && rsi > 25 && rsi < 75) continue;

    const direction = determineDirection(candle, prevCandle, rsi, bb, nearestLevel);
    if (direction === 'NO_TRADE') continue;

    // Calculate confluence score
    const { score, nearestLevel: scoredLevel } = scoreConfluence(
      candle, prevCandle, window, srLevels, direction, atr, rsi, avgVolume, bb, emaSlope, session
    );

    // Filter by minimum confluence
    if (score.total < cfg.minConfluence) {
      signalsFiltered++;
      continue;
    }

    // MUST have at least: atLevel OR (rsiExtreme + bbExtreme)
    // This is the hard filter - without price structure or extreme conditions, don't trade
    if (!score.atLevel && !(score.rsiExtreme && score.bbExtreme)) {
      signalsFiltered++;
      continue;
    }

    // ═══ CALCULATE SL/TP ═══
    const entryPrice = candle.close;

    // SL: just beyond the S/R level (or 1.5 ATR if no level)
    let stopDistance: number;
    if (scoredLevel) {
      if (direction === 'HIGHER') {
        stopDistance = entryPrice - (scoredLevel.price - atr * 0.3); // SL just below the support
      } else {
        stopDistance = (scoredLevel.price + atr * 0.3) - entryPrice; // SL just above resistance
      }
    } else {
      stopDistance = atr * 1.5;
    }

    // Clamp stop distance to reasonable range
    const maxStop = entryPrice * 0.015; // Max 1.5% stop
    const minStop = entryPrice * 0.002; // Min 0.2% stop
    stopDistance = Math.max(minStop, Math.min(maxStop, stopDistance));

    const stopLoss = direction === 'HIGHER' ? entryPrice - stopDistance : entryPrice + stopDistance;
    const takeProfit = direction === 'HIGHER'
      ? entryPrice + (stopDistance * cfg.riskRewardRatio)
      : entryPrice - (stopDistance * cfg.riskRewardRatio);

    // ═══ POSITION SIZING ═══
    const riskAmount = balance * (cfg.riskPerTrade / 100);
    const positionSize = stopDistance > 0 ? riskAmount / stopDistance : 0;
    if (positionSize <= 0) continue;

    // ═══ SIMULATE TRADE ═══
    // Entry slippage
    const entrySlip = entryPrice * (Math.random() * 0.03 + 0.01) / 100;
    const actualEntry = direction === 'HIGHER' ? entryPrice + entrySlip : entryPrice - entrySlip;

    // Entry fee
    const entryFee = positionSize * actualEntry * (cfg.takerFeePct / 100);

    // Walk through future bars
    let exitPrice = 0;
    let exitReason: BacktestTrade['exitReason'] = 'EXPIRATION';
    let holdingBars = 0;

    for (let j = i + 1; j <= Math.min(i + expirationBars, candles.length - 1); j++) {
      holdingBars++;
      const bar = candles[j];

      // Check SL hit
      if (direction === 'HIGHER' && bar.low <= stopLoss) {
        exitPrice = stopLoss;
        exitReason = 'SL_HIT';
        break;
      }
      if (direction === 'LOWER' && bar.high >= stopLoss) {
        exitPrice = stopLoss;
        exitReason = 'SL_HIT';
        break;
      }

      // Check TP hit
      if (direction === 'HIGHER' && bar.high >= takeProfit) {
        exitPrice = takeProfit;
        exitReason = 'TP_HIT';
        break;
      }
      if (direction === 'LOWER' && bar.low <= takeProfit) {
        exitPrice = takeProfit;
        exitReason = 'TP_HIT';
        break;
      }

      // Expiration
      if (j === i + expirationBars) {
        exitPrice = bar.close;
        exitReason = 'EXPIRATION';
      }
    }

    if (exitPrice === 0) continue;

    // Exit slippage
    const exitSlip = exitPrice * (Math.random() * 0.03 + 0.01) / 100;
    const actualExit = direction === 'HIGHER' ? exitPrice - exitSlip : exitPrice + exitSlip;

    // Exit fee
    const exitFee = positionSize * actualExit * (cfg.takerFeePct / 100);
    const totalFees = entryFee + exitFee;
    const totalSlippage = (entrySlip + exitSlip) * positionSize;

    // P&L
    const rawPnl = direction === 'HIGHER'
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

    // Record trade
    trades.push({
      index: i,
      timestamp: candle.timestamp,
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
      confluence: score,
      levelPrice: scoredLevel?.price || 0,
      holdingBars,
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
  const totalSlippage = trades.reduce((s, t) => s + t.slippage, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const expectedValue = trades.length > 0 ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;

  // By confluence score
  const byConfluence: Record<number, { total: number; wins: number; winRate: number; avgPnlPct: number }> = {};
  for (const t of trades) {
    const key = Math.floor(t.confluence.total);
    if (!byConfluence[key]) byConfluence[key] = { total: 0, wins: 0, winRate: 0, avgPnlPct: 0 };
    byConfluence[key].total++;
    if (t.pnl > 0) byConfluence[key].wins++;
    byConfluence[key].avgPnlPct += t.pnlPct;
  }
  for (const k of Object.keys(byConfluence)) {
    const v = byConfluence[Number(k)];
    v.winRate = (v.wins / v.total) * 100;
    v.avgPnlPct /= v.total;
  }

  // By session
  const bySession: Record<string, { total: number; wins: number; winRate: number; avgPnlPct: number }> = {};
  for (const t of trades) {
    const key = getSession(t.timestamp);
    if (!bySession[key]) bySession[key] = { total: 0, wins: 0, winRate: 0, avgPnlPct: 0 };
    bySession[key].total++;
    if (t.pnl > 0) bySession[key].wins++;
    bySession[key].avgPnlPct += t.pnlPct;
  }
  for (const k of Object.keys(bySession)) {
    const v = bySession[k];
    v.winRate = (v.wins / v.total) * 100;
    v.avgPnlPct /= v.total;
  }

  // By exit reason
  const byExitReason: Record<string, { total: number; pnl: number }> = {};
  for (const t of trades) {
    if (!byExitReason[t.exitReason]) byExitReason[t.exitReason] = { total: 0, pnl: 0 };
    byExitReason[t.exitReason].total++;
    byExitReason[t.exitReason].pnl += t.pnl;
  }

  return {
    trades, finalBalance: balance,
    totalReturnPct: ((balance - cfg.initialBalance) / cfg.initialBalance) * 100,
    maxDrawdownPct: maxDrawdown, winRate,
    totalWins: wins.length, totalLosses: losses.length,
    avgWinPct, avgLossPct, profitFactor, expectedValue,
    avgHoldingBars: trades.length > 0 ? trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length : 0,
    totalFees, totalSlippage, byConfluence, bySession, byExitReason,
    signalsFiltered, totalScanned,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATOR
// ══════════════════════════════════════════════════════════════════════════════

function generateReport(result: ReturnType<typeof runBacktest>, cfg: BacktestConfig): string {
  const wr = result.winRate;
  const wrIcon = wr >= 50 ? '✅' : wr >= 40 ? '🟡' : '❌';
  const isProfitable = result.finalBalance > cfg.initialBalance;
  const verdictIcon = isProfitable ? '✅' : '❌';

  let report = `
╔══════════════════════════════════════════════════════════════════════╗
║     SIGNALTRADER PRO — BACKTEST v4 (MEAN REVERSION AT STRUCTURE)    ║
╚══════════════════════════════════════════════════════════════════════╝

📊 Asset: ${cfg.asset} | TF: ${cfg.timeframe} | Months: ${cfg.months}
💰 Initial: $${cfg.initialBalance.toLocaleString()} | Risk: ${cfg.riskPerTrade}% | R:R: ${cfg.riskRewardRatio}:1
💸 Fee: ${(cfg.takerFeePct * 2).toFixed(2)}% round trip | Slippage: ${cfg.slippagePct}%
⏱️  Expiration: ${cfg.expirationHours}h | Min Confluence: ${cfg.minConfluence}/10
🔍 S/R Lookback: ${cfg.srLookback} bars | Proximity: ${cfg.srProximityATR}x ATR

══════════════════════════════════════════════════════════════════════
  RESULTADOS FINANCIEROS
══════════════════════════════════════════════════════════════════════

  Balance Final:    $${result.finalBalance.toFixed(2)}
  Retorno Total:    ${result.totalReturnPct.toFixed(2)}% ($${(result.finalBalance - cfg.initialBalance).toFixed(2)})
  Max Drawdown:     ${result.maxDrawdownPct.toFixed(2)}%

══════════════════════════════════════════════════════════════════════
  ESTADÍSTICAS DE TRADING
══════════════════════════════════════════════════════════════════════

  Total Trades:     ${result.trades.length}
  Wins:             ${result.totalWins}
  Losses:           ${result.totalLosses}
  Win Rate:         ${wrIcon} ${wr.toFixed(1)}%
  Avg Win:          +${result.avgWinPct.toFixed(3)}%
  Avg Loss:         ${result.avgLossPct.toFixed(3)}%
  Profit Factor:    ${result.profitFactor.toFixed(2)}
  Expected Value:   $${result.expectedValue.toFixed(2)} per trade
  Avg Hold:         ${result.avgHoldingBars.toFixed(1)} bars

══════════════════════════════════════════════════════════════════════
  IMPACTO DE COSTOS (FEES + SLIPPAGE)
══════════════════════════════════════════════════════════════════════

  Total Fees:       $${result.totalFees.toFixed(2)}
  Total Slippage:   $${result.totalSlippage.toFixed(2)}
  P&L sin fees:     $${(result.finalBalance - cfg.initialBalance + result.totalFees + result.totalSlippage).toFixed(2)}
  P&L con fees:     $${(result.finalBalance - cfg.initialBalance).toFixed(2)}

══════════════════════════════════════════════════════════════════════
  FILTROS
══════════════════════════════════════════════════════════════════════

  Velas escaneadas:     ${result.totalScanned.toLocaleString()}
  Señales filtradas:    ${result.signalsFiltered.toLocaleString()}
  Trades ejecutados:    ${result.trades.length}
  Ratio filtro:         ${result.totalScanned > 0 ? ((result.signalsFiltered / result.totalScanned) * 100).toFixed(1) : 0}%

══════════════════════════════════════════════════════════════════════
  POR CONFLUENCE SCORE
══════════════════════════════════════════════════════════════════════
`;

  for (const [score, data] of Object.entries(result.byConfluence).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const icon = data.winRate >= 50 ? '✅' : data.winRate >= 40 ? '🟡' : '❌';
    report += `  ${icon} Score ${score}: ${data.winRate.toFixed(1)}% WR | ${data.avgPnlPct.toFixed(3)}% avg (${data.wins}W/${data.total - data.wins}L)\n`;
  }

  report += `
══════════════════════════════════════════════════════════════════════
  POR SESIÓN
══════════════════════════════════════════════════════════════════════
`;

  for (const [session, data] of Object.entries(result.bySession).sort((a, b) => b[1].winRate - a[1].winRate)) {
    const icon = data.winRate >= 50 ? '✅' : data.winRate >= 40 ? '🟡' : '❌';
    report += `  ${icon} ${session.padEnd(12)} ${data.winRate.toFixed(1)}% WR | ${data.avgPnlPct.toFixed(3)}% avg (${data.wins}W/${data.total - data.wins}L)\n`;
  }

  report += `
══════════════════════════════════════════════════════════════════════
  POR RAZÓN DE SALIDA
══════════════════════════════════════════════════════════════════════
`;

  for (const [reason, data] of Object.entries(result.byExitReason)) {
    report += `  ${reason.padEnd(14)} ${data.total} trades | $${data.pnl.toFixed(2)} total P&L\n`;
  }

  // Breakdown by confluence components
  const atLevelTrades = result.trades.filter(t => t.confluence.atLevel);
  const rejectionTrades = result.trades.filter(t => t.confluence.rejectionCandle);
  const rsiTrades = result.trades.filter(t => t.confluence.rsiExtreme);
  const volTrades = result.trades.filter(t => t.confluence.volumeConfirm);
  const htfTrades = result.trades.filter(t => t.confluence.htfAligned);

  report += `
══════════════════════════════════════════════════════════════════════
  POR COMPONENTE DE CONFLUENCIA
══════════════════════════════════════════════════════════════════════

  At S/R Level:    ${atLevelTrades.length} trades | WR: ${atLevelTrades.length > 0 ? (atLevelTrades.filter(t => t.pnl > 0).length / atLevelTrades.length * 100).toFixed(1) : 'N/A'}%
  Rejection Candle: ${rejectionTrades.length} trades | WR: ${rejectionTrades.length > 0 ? (rejectionTrades.filter(t => t.pnl > 0).length / rejectionTrades.length * 100).toFixed(1) : 'N/A'}%
  RSI Extreme:     ${rsiTrades.length} trades | WR: ${rsiTrades.length > 0 ? (rsiTrades.filter(t => t.pnl > 0).length / rsiTrades.length * 100).toFixed(1) : 'N/A'}%
  Volume Confirm:  ${volTrades.length} trades | WR: ${volTrades.length > 0 ? (volTrades.filter(t => t.pnl > 0).length / volTrades.length * 100).toFixed(1) : 'N/A'}%
  HTF Aligned:     ${htfTrades.length} trades | WR: ${htfTrades.length > 0 ? (htfTrades.filter(t => t.pnl > 0).length / htfTrades.length * 100).toFixed(1) : 'N/A'}%
`;

  report += `
╔══════════════════════════════════════════════════════════════════════╗
║  🎯 VEREDICTO                                                       ║
╚══════════════════════════════════════════════════════════════════════╝

  ${verdictIcon} ${isProfitable ? 'HAY EDGE positivo en esta configuración.' : 'NO HAY EDGE en esta configuración.'}
  ${isProfitable
    ? `→ EV por trade: $${result.expectedValue.toFixed(2)} | Profit Factor: ${result.profitFactor.toFixed(2)}`
    : `→ Cambiar: confluencia mínima, R:R, expiración, o timeframe.`
  }
  📊 v3 generaba 7,000+ trades (25% WR) → v4 genera ${result.trades.length} trades (${wr.toFixed(1)}% WR)
`;

  return report;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let assets = ['BTC/USD', 'ETH/USD'];
  let months = 6;
  let timeframe = '15m';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asset' && args[i + 1]) { assets = [args[++i]]; }
    else if (args[i] === '--months' && args[i + 1]) { months = parseInt(args[++i]); }
    else if (args[i] === '--timeframe' && args[i + 1]) { timeframe = args[++i]; }
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║     SIGNALTRADER PRO — BACKTESTER v4 (MEAN REVERSION AT STRUCTURE)  ║
╚══════════════════════════════════════════════════════════════════════╝

  Assets: ${assets.join(', ')} | TF: ${timeframe} | Months: ${months}
  Strategy: S/R Levels + Rejection + RSI Extreme + Volume + HTF Alignment
  Target: 200-500 trades, 40-50% WR, 3:1 R:R, positive EV after fees
`);

  // Test multiple configurations
  const configs: Array<{ name: string; rr: number; expHours: number; minConf: number; srLookback: number }> = [
    { name: 'Conservative', rr: 3.0, expHours: 6,  minConf: 5, srLookback: 200 },
    { name: 'Aggressive',   rr: 2.5, expHours: 4,  minConf: 4, srLookback: 150 },
    { name: 'Sniper',       rr: 4.0, expHours: 8,  minConf: 6, srLookback: 300 },
  ];

  for (const asset of assets) {
    const candles = await downloadHistoricalData(asset, timeframe, months);
    if (candles.length < 200) {
      console.error(`❌ ${asset}: Not enough data (${candles.length} candles)`);
      continue;
    }

    for (const preset of configs) {
      const cfg: BacktestConfig = {
        asset,
        timeframe,
        months,
        initialBalance: 10000,
        riskPerTrade: 1,
        takerFeePct: 0.06,
        slippagePct: 0.03,
        riskRewardRatio: preset.rr,
        expirationHours: preset.expHours,
        minConfluence: preset.minConf,
        srLookback: preset.srLookback,
        srTouchMin: 2,
        srProximityATR: 1.0,
      };

      log(`📊 Running ${asset} ${timeframe} — ${preset.name} (R:R ${preset.rr}, exp ${preset.expHours}h, min conf ${preset.minConf})...`);
      const result = runBacktest(candles, cfg);
      const report = generateReport(result, cfg);
      console.log(report);
    }
  }

  // Also test on 1H for comparison
  if (timeframe !== '1h') {
    log(`📊 Testing 1h timeframe for comparison...`);
    for (const asset of assets) {
      try {
        const candles = await downloadHistoricalData(asset, '1h', months);
        if (candles.length < 200) continue;

        const cfg: BacktestConfig = {
          asset,
          timeframe: '1h',
          months,
          initialBalance: 10000,
          riskPerTrade: 1,
          takerFeePct: 0.06,
          slippagePct: 0.03,
          riskRewardRatio: 3.0,
          expirationHours: 24,
          minConfluence: 5,
          srLookback: 200,
          srTouchMin: 2,
          srProximityATR: 1.0,
        };

        log(`📊 Running ${asset} 1h — Conservative...`);
        const result = runBacktest(candles, cfg);
        const report = generateReport(result, cfg);
        console.log(report);
      } catch (err: any) {
        log(`  ⚠️ ${asset} 1h failed: ${err.message}`);
      }
    }
  }

  console.log('\n═══ Backtest v4 completed ═══');
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
