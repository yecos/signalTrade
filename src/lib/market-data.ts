// MARKET DATA ENGINE
// Generates realistic OHLCV candle data for backtesting and auto-trading
// Architecture is designed to be swapped with real API data (Binance, Twelve Data, etc.)

import { db } from './db';

// === TYPES ===
export interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketConfig {
  asset: string;
  basePrice: number;
  volatility: number;    // annualized volatility (0.10 = 10%)
  drift: number;         // annualized drift (0.02 = 2%)
  spreadBps: number;     // spread in basis points
  volumeMean: number;    // average volume per candle
  volumeStd: number;     // volume standard deviation
}

// === ASSET CONFIGURATIONS ===
export const ASSET_CONFIGS: Record<string, MarketConfig> = {
  'EUR/USD': {
    asset: 'EUR/USD',
    basePrice: 1.0850,
    volatility: 0.08,      // 8% annual
    drift: 0.0,
    spreadBps: 1.5,
    volumeMean: 50000,
    volumeStd: 15000,
  },
  'GBP/USD': {
    asset: 'GBP/USD',
    basePrice: 1.2650,
    volatility: 0.10,
    drift: 0.0,
    spreadBps: 2.0,
    volumeMean: 35000,
    volumeStd: 12000,
  },
  'USD/JPY': {
    asset: 'USD/JPY',
    basePrice: 149.50,
    volatility: 0.09,
    drift: 0.0,
    spreadBps: 1.8,
    volumeMean: 40000,
    volumeStd: 13000,
  },
  'BTC/USD': {
    asset: 'BTC/USD',
    basePrice: 67500,
    volatility: 0.65,     // 65% annual - crypto is much more volatile
    drift: 0.15,          // positive drift over time
    spreadBps: 5.0,
    volumeMean: 2000,
    volumeStd: 800,
  },
  'ETH/USD': {
    asset: 'ETH/USD',
    basePrice: 3450,
    volatility: 0.70,
    drift: 0.20,
    spreadBps: 6.0,
    volumeMean: 5000,
    volumeStd: 2000,
  },
};

// === TIMEFRAME CONFIG ===
export const TIMEFRAME_MINUTES: Record<string, number> = {
  'M1': 1,
  'M5': 5,
  'M15': 15,
  'M30': 30,
  'H1': 60,
  'H4': 240,
  'D1': 1440,
};

// === VOLATILITY BY SESSION (UTC hours) ===
function getSessionVolatilityMultiplier(hourUtc: number): number {
  // Asian session: 00-08 UTC → low volatility
  if (hourUtc >= 0 && hourUtc < 7) return 0.5;
  // London open: 07-09 UTC → high volatility
  if (hourUtc >= 7 && hourUtc < 9) return 1.8;
  // London active: 09-12 UTC → normal volatility
  if (hourUtc >= 9 && hourUtc < 12) return 1.0;
  // NY overlap: 12-16 UTC → high volatility (highest)
  if (hourUtc >= 12 && hourUtc < 16) return 1.5;
  // NY afternoon: 16-20 UTC → normal-low
  if (hourUtc >= 16 && hourUtc < 20) return 0.8;
  // Quiet: 20-24 UTC → low
  return 0.4;
}

// === CANDLE GENERATOR (Geometric Brownian Motion) ===
function generateCandle(
  prevClose: number,
  config: MarketConfig,
  minutesInCandle: number,
  timestamp: Date
): Candle {
  const yearFraction = minutesInCandle / (365.25 * 24 * 60);
  const sessionMult = getSessionVolatilityMultiplier(timestamp.getUTCHours());
  
  // Local volatility scaled by time and session
  const localVol = config.volatility * Math.sqrt(yearFraction) * sessionMult;
  const localDrift = (config.drift - 0.5 * config.volatility * config.volatility) * yearFraction;
  
  // Random walk
  const z = boxMullerRandom();
  const logReturn = localDrift + localVol * z;
  
  const open = prevClose;
  const close = open * Math.exp(logReturn);
  
  // Generate high/low with realistic wicks
  const range = Math.abs(close - open);
  const wickUp = Math.random() * range * (0.5 + Math.random());
  const wickDown = Math.random() * range * (0.5 + Math.random());
  
  const high = Math.max(open, close) + wickUp;
  const low = Math.min(open, close) - wickDown;
  
  // Volume with session variation
  const sessionVolMult = getSessionVolatilityMultiplier(timestamp.getUTCHours());
  const volume = Math.max(100, 
    config.volumeMean * sessionVolMult + config.volumeStd * boxMullerRandom()
  );
  
  return {
    timestamp,
    open: roundPrice(open, config.asset),
    high: roundPrice(high, config.asset),
    low: roundPrice(low, config.asset),
    close: roundPrice(close, config.asset),
    volume: Math.round(volume),
  };
}

// === UTILITY FUNCTIONS ===
function boxMullerRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function roundPrice(price: number, asset: string): number {
  if (asset.includes('JPY')) return Math.round(price * 100) / 100;
  if (asset.includes('BTC')) return Math.round(price * 100) / 100;
  if (asset.includes('ETH')) return Math.round(price * 100) / 100;
  return Math.round(price * 100000) / 100000; // 5 decimal for forex
}

// === GENERATE HISTORICAL CANDLES ===
export async function generateHistoricalCandles(
  asset: string,
  timeframe: string,
  count: number = 500,
  endAt: Date = new Date()
): Promise<Candle[]> {
  const config = ASSET_CONFIGS[asset] || ASSET_CONFIGS['EUR/USD'];
  const minutesPerCandle = TIMEFRAME_MINUTES[timeframe] || 5;
  
  // Check if we already have enough candles in DB
  const existing = await db.marketCandle.findMany({
    where: { asset, timeframe },
    orderBy: { timestamp: 'desc' },
    take: count,
  });
  
  if (existing.length >= count) {
    return existing.map(c => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }
  
  // Generate new candles
  const candles: Candle[] = [];
  let prevClose = config.basePrice;
  const startTime = new Date(endAt.getTime() - count * minutesPerCandle * 60 * 1000);
  
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(startTime.getTime() + i * minutesPerCandle * 60 * 1000);
    const candle = generateCandle(prevClose, config, minutesPerCandle, timestamp);
    candles.push(candle);
    prevClose = candle.close;
  }
  
  // Save to database (batch upsert)
  const operations = candles.map(c =>
    db.marketCandle.upsert({
      where: {
        asset_timeframe_timestamp: {
          asset,
          timeframe,
          timestamp: c.timestamp,
        },
      },
      create: {
        asset,
        timeframe,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      },
      update: {
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      },
    })
  );
  
  // Batch in chunks of 50 to avoid SQLite limits
  for (let i = 0; i < operations.length; i += 50) {
    const chunk = operations.slice(i, i + 50);
    await Promise.all(chunk);
  }
  
  return candles;
}

// === GET LATEST PRICE ===
export async function getLatestPrice(asset: string): Promise<number> {
  const latest = await db.marketCandle.findFirst({
    where: { asset },
    orderBy: { timestamp: 'desc' },
  });
  
  if (latest) return latest.close;
  
  const config = ASSET_CONFIGS[asset] || ASSET_CONFIGS['EUR/USD'];
  return config.basePrice;
}

// === GET CANDLES FROM DB ===
export async function getCandles(
  asset: string,
  timeframe: string,
  count: number = 100
): Promise<Candle[]> {
  const rows = await db.marketCandle.findMany({
    where: { asset, timeframe },
    orderBy: { timestamp: 'desc' },
    take: count,
  });
  
  // Return in chronological order (oldest first)
  return rows.reverse().map(c => ({
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

// === GENERATE NEXT CANDLE (for auto-trader tick) ===
export async function generateNextCandle(
  asset: string,
  timeframe: string
): Promise<Candle> {
  const config = ASSET_CONFIGS[asset] || ASSET_CONFIGS['EUR/USD'];
  const minutesPerCandle = TIMEFRAME_MINUTES[timeframe] || 5;
  
  const latest = await db.marketCandle.findFirst({
    where: { asset, timeframe },
    orderBy: { timestamp: 'desc' },
  });
  
  const prevClose = latest?.close || config.basePrice;
  const lastTimestamp = latest?.timestamp || new Date(Date.now() - minutesPerCandle * 60 * 1000);
  const nextTimestamp = new Date(lastTimestamp.getTime() + minutesPerCandle * 60 * 1000);
  
  const candle = generateCandle(prevClose, config, minutesPerCandle, nextTimestamp);
  
  await db.marketCandle.upsert({
    where: {
      asset_timeframe_timestamp: {
        asset,
        timeframe,
        timestamp: candle.timestamp,
      },
    },
    create: {
      asset,
      timeframe,
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    },
    update: {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    },
  });
  
  return candle;
}

// === BULK GENERATE FOR SEEDING ===
export async function seedMarketData(): Promise<void> {
  const assets = Object.keys(ASSET_CONFIGS);
  const timeframes = ['M5', 'M15', 'H1'];
  
  for (const asset of assets) {
    for (const tf of timeframes) {
      console.log(`Seeding ${asset} ${tf}...`);
      await generateHistoricalCandles(asset, tf, 500);
    }
  }
  
  console.log('Market data seeding complete!');
}

// === GET SPREAD ===
export function getSpread(asset: string): number {
  const config = ASSET_CONFIGS[asset] || ASSET_CONFIGS['EUR/USD'];
  return config.basePrice * (config.spreadBps / 10000);
}
