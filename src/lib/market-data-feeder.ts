// MARKET DATA FEEDER v5 — Alimenta la app con datos avanzados de mercado
// Fuentes de datos:
// 1. Binance API (público, sin API key): Velas — PRIMARIO porque funciona desde cualquier red
// 2. Bybit API (público, sin API key): Ticker, OI, Funding, Orderbook — solo para datos que Binance no tiene
// 3. CoinGecko API (público): Fear & Greed Index, BTC Dominance, Market Cap Global
// 4. Datos derivados: Sentimiento compuesto, calidad de liquidez, presión direccional
//
// v5 CHANGES (from v4):
// - ALL DB operations wrapped with withRetry() — no more raw upserts that fail on Turso
// - Delays between DB batches to prevent Turso HTTP connection saturation
// - Candle upsert batch size reduced from 10 → 5 (fewer concurrent HTTP connections to Turso)
// - 200ms delay between DB batches to give Turso breathing room
// - Prisma error logging suppressed for transient errors (reduces noise)

import { db, withRetry } from './db';
import { BybitClient, getBrokerClientFromDB, assetToSymbol, isCryptoAsset } from './broker-client';

// === TYPES ===

export interface MarketSentiment {
  asset: string;
  timestamp: Date;
  // Ticker
  lastPrice: number;
  bid: number;
  ask: number;
  spread: number;
  spreadPct: number;
  volume24h: number;
  priceChange1h: number;
  priceChange24h: number;
  // Funding
  fundingRate: number;
  fundingRateAvg: number;
  // Open Interest
  openInterest: number;
  oiChange1h: number;
  oiChange24h: number;
  // Order Book
  bidDepth: number;
  askDepth: number;
  depthImbalance: number;
  // Macro
  fearGreedIndex: number;
  fearGreedLabel: string;
  btcDominance: number;
  totalMarketCap: number;
  totalVolume24h: number;
  // Derived signals
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  liquidityQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  pressureScore: number;
  // Data source tracking
  dataSource: 'BYBIT' | 'BINANCE' | 'MIXED';
}

export interface MacroData {
  fearGreedIndex: number;
  fearGreedLabel: string;
  btcDominance: number;
  totalMarketCap: number;
  totalVolume24h: number;
  timestamp: Date;
}

// === CACHE ===

let sentimentCache: Map<string, MarketSentiment> = new Map();
let macroCache: MacroData | null = null;
let instrumentsCache: Map<string, { tickSize: number; minOrderQty: number; qtyStep: number }> = new Map();
let lastCacheUpdate = 0;
let lastMacroUpdate = 0;
const CACHE_TTL_MS = 60_000;
const MACRO_CACHE_TTL_MS = 300_000;

// === BINANCE KLINES (PRIMARY SOURCE — reliable from any network) ===

const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision/api/v3',
  'https://api.binance.us/api/v3',
  'https://api1.binance.com/api/v3',
  'https://api2.binance.com/api/v3',
  'https://api3.binance.com/api/v3',
];

const BINANCE_SYMBOLS: Record<string, string> = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT',
};

const BINANCE_INTERVALS: Record<string, string> = {
  'M5': '5m', 'M15': '15m', 'H1': '1h', 'H4': '4h',
};

interface BinanceKline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchBinanceKlines(symbol: string, interval: string, limit: number = 200): Promise<BinanceKline[]> {
  for (const baseUrl of BINANCE_ENDPOINTS) {
    try {
      const url = `${baseUrl}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;

      return data.map((k: any[]) => ({
        timestamp: Number(k[0]),
        open: parseFloat(String(k[1])),
        high: parseFloat(String(k[2])),
        low: parseFloat(String(k[3])),
        close: parseFloat(String(k[4])),
        volume: parseFloat(String(k[5])),
      }));
    } catch { continue; }
  }
  return [];
}

async function fetchBinancePrice(symbol: string): Promise<number | null> {
  for (const baseUrl of BINANCE_ENDPOINTS) {
    try {
      const url = `${baseUrl}/ticker/price?symbol=${symbol}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.price) return parseFloat(data.price);
    } catch { continue; }
  }
  return null;
}

async function fetchBinanceBookTicker(symbol: string): Promise<{ bid: number; ask: number; spread: number } | null> {
  for (const baseUrl of BINANCE_ENDPOINTS) {
    try {
      const url = `${baseUrl}/ticker/bookTicker?symbol=${symbol}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const bid = parseFloat(data.bidPrice);
      const ask = parseFloat(data.askPrice);
      if (bid > 0 && ask > 0) return { bid, ask, spread: ask - bid };
    } catch { continue; }
  }
  return null;
}

async function fetchBinance24hTicker(symbol: string): Promise<{
  lastPrice: number; volume: number; priceChangePercent: number;
  bidPrice: number; askPrice: number;
} | null> {
  for (const baseUrl of BINANCE_ENDPOINTS) {
    try {
      const url = `${baseUrl}/ticker/24hr?symbol=${symbol}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      return {
        lastPrice: parseFloat(data.lastPrice),
        volume: parseFloat(data.volume),
        priceChangePercent: parseFloat(data.priceChangePercent),
        bidPrice: parseFloat(data.bidPrice),
        askPrice: parseFloat(data.askPrice),
      };
    } catch { continue; }
  }
  return null;
}

// Delay helper
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === MAIN: FEED ALL MARKET DATA ===

export async function feedMarketData(): Promise<{
  candlesUpdated: number;
  sentimentsUpdated: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let candlesUpdated = 0;
  let sentimentsUpdated = 0;

  // Get Bybit client for OI/funding/orderbook (optional — graceful degradation)
  let bybitClient: BybitClient | null = null;
  try {
    const broker = await getBrokerClientFromDB();
    if (broker instanceof BybitClient) {
      bybitClient = broker;
    }
  } catch { /* Will try without Bybit */ }

  if (!bybitClient) {
    bybitClient = new BybitClient({
      broker: 'BYBIT',
      apiKey: 'public',
      apiSecret: 'public',
      testnet: false,
    });
  }

  const cryptoAssets = ['BTC/USD', 'ETH/USD'];
  const intervals: Record<string, string> = { 'M5': '5m', 'M15': '15m', 'H1': '1h', 'H4': '4h' };

  // ═══ 0. FEED MACRO DATA (Fear & Greed, BTC Dominance, Market Cap) ═══
  try {
    const macro = await fetchMacroData();
    if (macro) {
      macroCache = macro;
      lastMacroUpdate = Date.now();

      await withRetry(
        () => db.appSettings.upsert({
          where: { key: 'macro_market_data' },
          create: {
            key: 'macro_market_data',
            value: JSON.stringify(macro),
            description: 'Macro market data (Fear&Greed, BTC Dominance, Market Cap)',
          },
          update: { value: JSON.stringify(macro) },
        }),
        2, 500, 'macro-market-data'
      );
    }
  } catch (err: any) {
    errors.push(`Macro data: ${err.message}`);
  }

  // ═══ 1. FEED CANDLES FROM BINANCE (PRIMARY — proven reliable) ═══
  // Binance klines work from the user's network, Bybit doesn't always work
  let binanceCandleErrors = 0;
  for (const asset of cryptoAssets) {
    const binanceSymbol = BINANCE_SYMBOLS[asset];
    if (!binanceSymbol) continue;

    for (const [tf, binanceInterval] of Object.entries(intervals)) {
      try {
        const klines = await fetchBinanceKlines(binanceSymbol, binanceInterval, 200);
        if (klines.length === 0) {
          binanceCandleErrors++;
          continue;
        }

        // Batch upsert candles to DB — v5: smaller batches + delays + withRetry
        const BATCH_SIZE = 5; // Reduced from 10 → fewer concurrent Turso HTTP connections
        for (let i = 0; i < klines.length; i += BATCH_SIZE) {
          const batch = klines.slice(i, i + BATCH_SIZE);
          const upsertPromises = batch.map(async (k) => {
            const timestamp = new Date(k.timestamp);
            try {
              await withRetry(
                () => db.marketCandle.upsert({
                  where: { asset_timeframe_timestamp: { asset, timeframe: tf, timestamp } },
                  create: {
                    asset, timeframe: tf, timestamp,
                    open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
                  },
                  update: {
                    open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
                  },
                }),
                2, 500, `candle-${asset}-${tf}`
              );
              return true;
            } catch {
              return false;
            }
          });
          const batchResults = await Promise.allSettled(upsertPromises);
          candlesUpdated += batchResults.filter(r => r.status === 'fulfilled' && r.value).length;

          // Delay between batches to prevent Turso HTTP connection saturation
          if (i + BATCH_SIZE < klines.length) {
            await delay(200);
          }
        }
      } catch (err: any) {
        errors.push(`Candles ${asset} ${tf}: ${err.message}`);
      }

      // Small delay between timeframes to reduce Turso pressure
      await delay(300);
    }

    // Small delay between assets to reduce Turso pressure
    await delay(500);
  }

  if (binanceCandleErrors > 0) {
    console.log(`[FEEDER] ⚠️ ${binanceCandleErrors} candle fetches returned empty from Binance`);
  }

  // ═══ 2. FEED MARKET SENTIMENT (Binance for price, Bybit for OI/funding/orderbook) ═══
  for (const asset of cryptoAssets) {
    try {
      const sentiment = await computeSentiment(bybitClient!, asset);
      if (sentiment) {
        sentimentCache.set(asset, sentiment);
        sentimentsUpdated++;

        await withRetry(
          () => db.appSettings.upsert({
            where: { key: `sentiment_${asset.replace('/', '_')}` },
            create: {
              key: `sentiment_${asset.replace('/', '_')}`,
              value: JSON.stringify(sentiment),
              description: `Market sentiment for ${asset}`,
            },
            update: { value: JSON.stringify(sentiment) },
          }),
          2, 500, `sentiment-${asset}`
        );
      }
    } catch (err: any) {
      errors.push(`Sentiment ${asset}: ${err.message}`);
    }

    // 1 second delay between assets for Bybit rate limiting
    await delay(1000);
  }

  // ═══ 3. CACHE INSTRUMENT SPECS (Bybit — sequential with delay) ═══
  for (const asset of cryptoAssets) {
    try {
      const symbol = assetToSymbol(asset);
      const instruments = await bybitClient.getInstruments(symbol);
      if (instruments.length > 0) {
        const inst = instruments[0];
        instrumentsCache.set(asset, {
          tickSize: inst.tickSize,
          minOrderQty: inst.minOrderQty,
          qtyStep: inst.qtyStep,
        });
      }
    } catch { /* non-critical */ }
    await delay(500);
  }

  lastCacheUpdate = Date.now();

  // Log summary
  const bybitUsed = sentimentsUpdated > 0 || instrumentsCache.size > 0;
  console.log(`[FEEDER] v5: ${candlesUpdated} candles (Binance), ${sentimentsUpdated} sentiments (${bybitUsed ? 'Bybit+Bin' : 'Binance-only'}), ${errors.length} errors`);

  return { candlesUpdated, sentimentsUpdated, errors };
}

// === FETCH MACRO DATA ===

async function fetchMacroData(): Promise<MacroData | null> {
  if (macroCache && Date.now() - lastMacroUpdate < MACRO_CACHE_TTL_MS) {
    return macroCache;
  }

  try {
    const [fgiResult, globalResult] = await Promise.allSettled([
      fetch('https://api.alternative.me/fng/?limit=1', {
        signal: AbortSignal.timeout(8000),
      }),
      fetch('https://api.coingecko.com/api/v3/global', {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json' },
      }),
    ]);

    let fearGreedIndex = 50;
    let fearGreedLabel = 'Neutral';
    let btcDominance = 0;
    let totalMarketCap = 0;
    let totalVolume24h = 0;

    if (fgiResult.status === 'fulfilled' && fgiResult.value.ok) {
      try {
        const fgiData = await fgiResult.value.json();
        if (fgiData?.data?.[0]) {
          fearGreedIndex = parseInt(fgiData.data[0].value) || 50;
          fearGreedLabel = fgiData.data[0].value_classification || 'Neutral';
        }
      } catch { /* use defaults */ }
    }

    if (globalResult.status === 'fulfilled' && globalResult.value.ok) {
      try {
        const globalData = await globalResult.value.json();
        if (globalData?.data) {
          btcDominance = globalData.data.market_cap_percentage?.btc || 0;
          totalMarketCap = globalData.data.total_market_cap?.usd || 0;
          totalVolume24h = globalData.data.total_volume?.usd || 0;
        }
      } catch { /* use defaults */ }
    }

    return { fearGreedIndex, fearGreedLabel, btcDominance, totalMarketCap, totalVolume24h, timestamp: new Date() };
  } catch {
    return macroCache;
  }
}

// === COMPUTE SENTIMENT (Binance primary, Bybit for extras) ===
// v4: Uses Binance for price/ticker (always works), Bybit only for OI/funding/orderbook (optional)

async function computeSentiment(bybitClient: BybitClient, asset: string): Promise<MarketSentiment | null> {
  const binanceSymbol = BINANCE_SYMBOLS[asset];
  const bybitSymbol = assetToSymbol(asset);

  // ═══ STEP 1: Get price data from Binance (RELIABLE) ═══
  let lastPrice = 0;
  let bid = 0;
  let ask = 0;
  let spread = 0;
  let volume24h = 0;
  let priceChange24h = 0;
  let priceChange1h = 0;
  let dataSource: 'BYBIT' | 'BINANCE' | 'MIXED' = 'BINANCE';

  // Try Binance 24h ticker first (gives price + volume + 24h change)
  const ticker24h = await fetchBinance24hTicker(binanceSymbol);
  if (ticker24h) {
    lastPrice = ticker24h.lastPrice;
    bid = ticker24h.bidPrice;
    ask = ticker24h.askPrice;
    spread = ask - bid;
    volume24h = ticker24h.volume;
    priceChange24h = ticker24h.priceChangePercent;
  } else {
    // Fallback to simple price
    const price = await fetchBinancePrice(binanceSymbol);
    if (price) {
      lastPrice = price;
    } else {
      return null; // No price from ANY source = no sentiment
    }
  }

  // Get 1h price change from Binance klines
  try {
    const klines = await fetchBinanceKlines(binanceSymbol, '1h', 3);
    if (klines.length >= 2) {
      const prevClose = klines[klines.length - 2].close;
      const currentClose = klines[klines.length - 1].close;
      if (prevClose > 0) priceChange1h = ((currentClose - prevClose) / prevClose) * 100;
    }
  } catch { /* non-critical */ }

  // ═══ STEP 2: Get Bybit-specific data (OI, funding, orderbook) — OPTIONAL ═══
  // These are Bybit-specific features that Binance doesn't provide easily.
  // If Bybit fails, we gracefully degrade — the sentiment still works with just price data.
  let oiData: any[] = [];
  let fundingData: any[] = [];
  let ob: any = null;
  let bybitAvailable = false;

  // Try Bybit ticker (for funding rate which Binance doesn't provide in 24hr ticker)
  let bybitFundingRate = 0;
  try {
    const bybitTicker = await bybitClient.getTicker(bybitSymbol);
    if (bybitTicker) {
      bybitFundingRate = bybitTicker.fundingRate || 0;
      bybitAvailable = true;
      dataSource = 'MIXED';
    }
  } catch { /* Bybit unavailable — use Binance-only data */ }

  // Only make more Bybit calls if the first one worked
  if (bybitAvailable) {
    await delay(1000);

    // Open Interest
    try {
      oiData = await bybitClient.getOpenInterest(bybitSymbol, '1h', 30);
    } catch { /* non-critical */ }

    await delay(1000);

    // Funding History
    try {
      fundingData = await bybitClient.getFundingHistory(bybitSymbol, 10);
    } catch { /* non-critical */ }

    await delay(1000);

    // Order Book
    try {
      ob = await bybitClient.getOrderBook(bybitSymbol, 25);
    } catch { /* non-critical */ }
  }

  // ═══ EXTRACT DERIVED DATA ═══
  const currentOI = oiData.length > 0 ? oiData[0].openInterest : 0;
  const oi1hAgo = oiData.length > 1 ? oiData[1].openInterest : currentOI;
  const oi24hAgo = oiData.length > 24 ? oiData[24].openInterest : (oiData.length > 0 ? oiData[oiData.length - 1].openInterest : currentOI);
  const oiChange1h = currentOI > 0 && oi1hAgo > 0 ? ((currentOI - oi1hAgo) / oi1hAgo) * 100 : 0;
  const oiChange24h = currentOI > 0 && oi24hAgo > 0 ? ((currentOI - oi24hAgo) / oi24hAgo) * 100 : 0;

  const currentFunding = fundingData.length > 0 ? fundingData[0].fundingRate : bybitFundingRate;
  const fundingAvg = fundingData.length > 0
    ? fundingData.slice(0, 3).reduce((s: number, f: any) => s + f.fundingRate, 0) / Math.min(fundingData.length, 3)
    : currentFunding;

  const bidDepth = ob ? ob.bids.reduce((s: number, b: any) => s + b.size, 0) : 0;
  const askDepth = ob ? ob.asks.reduce((s: number, a: any) => s + a.size, 0) : 0;
  const totalDepth = bidDepth + askDepth;
  const depthImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  // Get macro data
  const macro = macroCache;

  // ═══ COMPOSITE PRESSURE SCORE (-100 to +100) ═══
  let pressureScore = 0;

  if (currentFunding > 0.0005) pressureScore += 15;
  else if (currentFunding > 0.0001) pressureScore += 8;
  else if (currentFunding < -0.0005) pressureScore -= 15;
  else if (currentFunding < -0.0001) pressureScore -= 8;

  if (oiChange1h > 5) pressureScore += 15;
  else if (oiChange1h > 2) pressureScore += 8;
  else if (oiChange1h < -5) pressureScore -= 15;
  else if (oiChange1h < -2) pressureScore -= 8;

  if (depthImbalance > 0.3) pressureScore += 20;
  else if (depthImbalance > 0.15) pressureScore += 10;
  else if (depthImbalance < -0.3) pressureScore -= 20;
  else if (depthImbalance < -0.15) pressureScore -= 10;

  if (priceChange1h > 1) pressureScore += 15;
  else if (priceChange1h > 0.3) pressureScore += 8;
  else if (priceChange1h < -1) pressureScore -= 15;
  else if (priceChange1h < -0.3) pressureScore -= 8;

  if (macro) {
    if (macro.fearGreedIndex <= 20) pressureScore += 15;
    else if (macro.fearGreedIndex <= 35) pressureScore += 8;
    else if (macro.fearGreedIndex >= 80) pressureScore -= 15;
    else if (macro.fearGreedIndex >= 65) pressureScore -= 8;

    if (asset === 'ETH/USD' && macro.btcDominance > 55) pressureScore -= 10;
    if (asset === 'ETH/USD' && macro.btcDominance < 40) pressureScore += 10;

    if (macro.totalVolume24h > 0 && macro.totalMarketCap > 0) {
      const volumeRatio = macro.totalVolume24h / macro.totalMarketCap;
      if (volumeRatio > 0.1) pressureScore += 5;
      if (volumeRatio < 0.02) pressureScore -= 5;
    }
  }

  pressureScore = Math.max(-100, Math.min(100, pressureScore));

  // ═══ DERIVED SIGNALS ═══
  let sentimentScore = 0;
  if (currentFunding > 0.0001) sentimentScore += 1;
  else if (currentFunding < -0.0001) sentimentScore -= 1;
  if (oiChange1h > 2) sentimentScore += 1;
  else if (oiChange1h < -2) sentimentScore -= 1;
  if (depthImbalance > 0.15) sentimentScore += 1;
  else if (depthImbalance < -0.15) sentimentScore -= 1;
  if (macro) {
    if (macro.fearGreedIndex <= 25) sentimentScore += 1;
    else if (macro.fearGreedIndex >= 75) sentimentScore -= 1;
  }
  if (priceChange1h > 0.5) sentimentScore += 1;
  else if (priceChange1h < -0.5) sentimentScore -= 1;

  const sentiment: MarketSentiment['sentiment'] =
    sentimentScore >= 2 ? 'BULLISH' : sentimentScore <= -2 ? 'BEARISH' : 'NEUTRAL';

  const spreadPct = ask > 0 ? (spread / ask) * 100 : 100;
  const liquidityQuality: MarketSentiment['liquidityQuality'] =
    spreadPct < 0.02 && totalDepth > 10 ? 'HIGH' :
    spreadPct < 0.05 && totalDepth > 5 ? 'MEDIUM' : 'LOW';

  return {
    asset,
    timestamp: new Date(),
    lastPrice,
    bid,
    ask,
    spread,
    spreadPct,
    volume24h,
    priceChange1h,
    priceChange24h,
    fundingRate: currentFunding,
    fundingRateAvg: fundingAvg,
    openInterest: currentOI,
    oiChange1h,
    oiChange24h,
    bidDepth,
    askDepth,
    depthImbalance,
    fearGreedIndex: macro?.fearGreedIndex || 50,
    fearGreedLabel: macro?.fearGreedLabel || 'Neutral',
    btcDominance: macro?.btcDominance || 0,
    totalMarketCap: macro?.totalMarketCap || 0,
    totalVolume24h: macro?.totalVolume24h || 0,
    sentiment,
    liquidityQuality,
    pressureScore,
    dataSource,
  };
}

// === FAST: REFRESH ONLY PRICES (for mid-cycle monitoring) ===
// v4: Uses Binance (reliable) instead of Bybit

export async function refreshPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();

  // Try cached sentiment first (fast, no API call)
  for (const [asset, s] of sentimentCache) {
    if (Date.now() - new Date(s.timestamp).getTime() < CACHE_TTL_MS) {
      prices.set(asset, s.lastPrice);
    }
  }

  if (prices.size >= 2) return prices;

  // Fetch fresh prices from Binance (proven reliable from user's network)
  for (const asset of ['BTC/USD', 'ETH/USD']) {
    const binanceSymbol = BINANCE_SYMBOLS[asset];
    if (!binanceSymbol) continue;

    try {
      const price = await fetchBinancePrice(binanceSymbol);
      if (price) {
        prices.set(asset, price);

        const existing = sentimentCache.get(asset);
        if (existing) {
          existing.lastPrice = price;
          existing.timestamp = new Date();
        }
      }
    } catch { /* use stale prices */ }
  }

  return prices;
}

// === GET CACHED SENTIMENT ===

export function getSentiment(asset: string): MarketSentiment | null {
  return sentimentCache.get(asset) || null;
}

// === GET ALL CACHED SENTIMENTS ===

export function getAllSentiments(): Map<string, MarketSentiment> {
  return sentimentCache;
}

// === GET MACRO DATA ===

export function getMacroData(): MacroData | null {
  return macroCache;
}

// === GET INSTRUMENT SPECS ===

export function getInstrumentSpecs(asset: string): { tickSize: number; minOrderQty: number; qtyStep: number } | null {
  return instrumentsCache.get(asset) || null;
}

// === GET SENTIMENT FROM DB (for signal generation on Vercel) ===

export async function getSentimentFromDB(asset: string): Promise<MarketSentiment | null> {
  const cached = sentimentCache.get(asset);
  if (cached && Date.now() - lastCacheUpdate < CACHE_TTL_MS) return cached;

  try {
    const setting = await withRetry(
      () => db.appSettings.findUnique({
        where: { key: `sentiment_${asset.replace('/', '_')}` },
      }),
      2, 500, `getSentiment-${asset}`
    );
    if (setting) {
      const parsed = JSON.parse(setting.value);
      sentimentCache.set(asset, parsed);
      return parsed;
    }
  } catch { /* ignore */ }

  return null;
}

// === SENTIMENT-BASED CONFIDENCE ADJUSTMENT ===

export function getSentimentConfidenceAdjustment(asset: string, direction: 'HIGHER' | 'LOWER'): number {
  const sentiment = sentimentCache.get(asset);
  if (!sentiment) return 0;

  let adjustment = 0;

  if (direction === 'HIGHER' && sentiment.pressureScore > 20) adjustment += 8;
  else if (direction === 'HIGHER' && sentiment.pressureScore > 5) adjustment += 4;
  else if (direction === 'HIGHER' && sentiment.pressureScore < -20) adjustment -= 8;
  else if (direction === 'HIGHER' && sentiment.pressureScore < -5) adjustment -= 4;

  if (direction === 'LOWER' && sentiment.pressureScore < -20) adjustment += 8;
  else if (direction === 'LOWER' && sentiment.pressureScore < -5) adjustment += 4;
  else if (direction === 'LOWER' && sentiment.pressureScore > 20) adjustment -= 8;
  else if (direction === 'LOWER' && sentiment.pressureScore > 5) adjustment -= 4;

  if (sentiment.sentiment === 'BULLISH' && direction === 'HIGHER') adjustment += 5;
  else if (sentiment.sentiment === 'BULLISH' && direction === 'LOWER') adjustment -= 5;
  else if (sentiment.sentiment === 'BEARISH' && direction === 'LOWER') adjustment += 5;
  else if (sentiment.sentiment === 'BEARISH' && direction === 'HIGHER') adjustment -= 5;

  if (direction === 'HIGHER' && sentiment.fearGreedIndex <= 25) adjustment += 3;
  if (direction === 'HIGHER' && sentiment.fearGreedIndex >= 75) adjustment -= 3;
  if (direction === 'LOWER' && sentiment.fearGreedIndex >= 75) adjustment += 3;
  if (direction === 'LOWER' && sentiment.fearGreedIndex <= 25) adjustment -= 3;

  if (sentiment.liquidityQuality === 'LOW') adjustment -= 10;
  else if (sentiment.liquidityQuality === 'MEDIUM') adjustment -= 3;

  if (sentiment.fundingRate > 0.0005 && direction === 'HIGHER') adjustment -= 2;
  if (sentiment.fundingRate > 0.0005 && direction === 'LOWER') adjustment += 2;
  if (sentiment.fundingRate < -0.0005 && direction === 'LOWER') adjustment -= 2;
  if (sentiment.fundingRate < -0.0005 && direction === 'HIGHER') adjustment += 2;

  return Math.max(-15, Math.min(15, adjustment));
}

// === MARKET CONTEXT SUMMARY ===

export function getMarketSummary(): string {
  const parts: string[] = [];

  if (macroCache) {
    parts.push(`FGI:${macroCache.fearGreedIndex}(${macroCache.fearGreedLabel})`);
    if (macroCache.btcDominance > 0) {
      parts.push(`BTCDom:${macroCache.btcDominance.toFixed(1)}%`);
    }
  }

  for (const [asset, s] of sentimentCache) {
    const assetShort = asset.split('/')[0];
    parts.push(`${assetShort}:${s.sentiment}(P:${s.pressureScore >= 0 ? '+' : ''}${s.pressureScore} FR:${(s.fundingRate * 100).toFixed(4)}% OI:${s.oiChange1h >= 0 ? '+' : ''}${s.oiChange1h.toFixed(1)}% [${s.dataSource}])`);
  }

  return parts.join(' | ') || 'No market data available';
}
