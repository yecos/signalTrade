// MARKET DATA FEEDER v3 — Alimenta la app con datos avanzados de mercado
// Fuentes de datos:
// 1. Bybit API (público, sin API key): Velas, Ticker, OI, Funding, Orderbook, Instrumentos
// 2. CoinGecko API (público): Fear & Greed Index, BTC Dominance, Market Cap Global
// 3. Datos derivados: Sentimiento compuesto, calidad de liquidez, presión direccional
//
// Cómo mejoran las señales:
// - Fear & Greed < 25 (miedo extremo) → posible reversión alcista
// - Fear & Greed > 75 (codicia extrema) → posible reversión bajista
// - BTC Dominance subiendo + alts bajando → risk-off, evitar ETH
// - OI creciente + funding positivo = presión compradora (confirma HIGHER)
// - OI decreciente + funding negativo = presión vendedora (confirma LOWER)
// - Spread estrecho = buena liquidez (mejor fill)
// - Spread ancho = liquidez baja (evitar entrada)
//
// v3 CHANGES:
// - Rate-limited Bybit API calls (max 3 concurrent) to prevent fetch failed
// - Batched DB upserts (chunks of 10) to avoid Turso overload
// - Sequential Bybit request groups with delays between groups
// - Improved error recovery with fallback data

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
  priceChange1h: number;     // % change in last hour (from klines)
  priceChange24h: number;    // % change from ticker
  // Funding
  fundingRate: number;         // Current funding rate
  fundingRateAvg: number;      // Average last 8h (3 periods)
  // Open Interest
  openInterest: number;        // Current OI
  oiChange1h: number;          // OI change % in last hour
  oiChange24h: number;         // OI change % in last 24h
  // Order Book
  bidDepth: number;            // Total bid volume (top 25 levels)
  askDepth: number;            // Total ask volume (top 25 levels)
  depthImbalance: number;      // (bidDepth - askDepth) / (bidDepth + askDepth) — -1 to +1
  // Macro (shared across all assets)
  fearGreedIndex: number;      // 0-100 (0=Extreme Fear, 100=Extreme Greed)
  fearGreedLabel: string;      // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  btcDominance: number;        // BTC market cap dominance %
  totalMarketCap: number;      // Total crypto market cap in USD
  totalVolume24h: number;      // Total 24h volume in USD
  // Derived signals
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  liquidityQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  pressureScore: number;       // -100 to +100 composite directional pressure
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
const CACHE_TTL_MS = 60_000; // 1 minute
const MACRO_CACHE_TTL_MS = 300_000; // 5 minutes (macro data changes slowly)

// === RATE LIMITER ===
// Prevents overwhelming Bybit API with too many concurrent requests
// Max 3 concurrent, 500ms delay between request groups

const MAX_CONCURRENT_BYBIT = 3;
const INTER_GROUP_DELAY_MS = 500;

async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent: number = MAX_CONCURRENT_BYBIT
): Promise<Array<T | { __error: string }>> {
  const results: Array<T | { __error: string }> = [];
  let taskIndex = 0;

  async function worker(): Promise<void> {
    while (taskIndex < tasks.length) {
      const index = taskIndex++;
      try {
        results[index] = await tasks[index]();
      } catch (err: any) {
        results[index] = { __error: err.message || 'Unknown error' };
      }
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrent, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
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

  // Get Bybit client (public endpoints work without API keys too)
  let bybitClient: BybitClient | null = null;
  try {
    const broker = await getBrokerClientFromDB();
    if (broker instanceof BybitClient) {
      bybitClient = broker;
    }
  } catch { /* Will use direct API calls */ }

  // If no Bybit client, create one for public data (no auth needed)
  if (!bybitClient) {
    bybitClient = new BybitClient({
      broker: 'BYBIT',
      apiKey: 'public',
      apiSecret: 'public',
      testnet: false,
    });
  }

  const cryptoAssets = ['BTC/USD', 'ETH/USD'];
  const intervals: Record<string, string> = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240' };

  // ═══ 0. FEED MACRO DATA (Fear & Greed, BTC Dominance, Market Cap) ═══
  try {
    const macro = await fetchMacroData();
    if (macro) {
      macroCache = macro;
      lastMacroUpdate = Date.now();

      // Persist to DB for dashboard
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

  // ═══ 1. FEED CANDLES FROM BYBIT (rate-limited, 3 concurrent) ═══
  // Fetch kline data with concurrency control to prevent fetch failed
  const klineTasks = cryptoAssets.flatMap(asset => {
    const symbol = assetToSymbol(asset);
    return Object.entries(intervals).map(([tf, bybitInterval]) => {
      return async () => {
        try {
          const klines = await bybitClient!.getKlines(symbol, bybitInterval, 200);
          return { asset, tf, klines };
        } catch (err: any) {
          return { asset, tf, klines: [], __klineError: `Candles ${asset} ${tf}: ${err.message}` };
        }
      };
    });
  });

  // Run kline tasks with concurrency limit
  const klineResults = await runWithConcurrencyLimit(klineTasks, MAX_CONCURRENT_BYBIT);

  // Collect errors and successful results
  const successfulKlines: Array<{ asset: string; tf: string; klines: any[] }> = [];
  for (const result of klineResults) {
    if ('__error' in result) {
      errors.push(result.__error);
    } else if ('__klineError' in (result as any)) {
      errors.push((result as any).__klineError);
    } else {
      successfulKlines.push(result as { asset: string; tf: string; klines: any[] });
    }
  }

  // Upsert candles to DB in BATCHED chunks (10 at a time) to avoid Turso overload
  const BATCH_SIZE = 10;
  for (const { asset, tf, klines } of successfulKlines) {
    if (klines.length === 0) continue;

    // Process in batches
    for (let i = 0; i < klines.length; i += BATCH_SIZE) {
      const batch = klines.slice(i, i + BATCH_SIZE);
      const upsertPromises = batch.map(async (k: any) => {
        const timestamp = new Date(k.timestamp);
        try {
          await db.marketCandle.upsert({
            where: { asset_timeframe_timestamp: { asset, timeframe: tf, timestamp } },
            create: {
              asset, timeframe: tf, timestamp,
              open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
            },
            update: {
              open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
            },
          });
          return true;
        } catch {
          return false;
        }
      });

      const batchResults = await Promise.allSettled(upsertPromises);
      const upserted = batchResults.filter(r => r.status === 'fulfilled' && r.value).length;
      candlesUpdated += upserted;
    }
  }

  // Small delay between kline and sentiment phases to let network recover
  await delay(INTER_GROUP_DELAY_MS);

  // ═══ 2. FEED MARKET SENTIMENT (sequential per asset, rate-limited internally) ═══
  // Process one asset at a time to avoid overwhelming Bybit
  for (const asset of cryptoAssets) {
    try {
      const sentiment = await computeSentiment(bybitClient!, asset);
      if (sentiment) {
        sentimentCache.set(asset, sentiment);
        sentimentsUpdated++;

        // Persist to DB as AppSettings for dashboard / signal generation
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

    // Small delay between assets to avoid rate limiting
    await delay(INTER_GROUP_DELAY_MS);
  }

  // ═══ 3. CACHE INSTRUMENT SPECS (sequential with delay) ═══
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
    } catch (err: any) {
      errors.push(`Instruments ${asset}: ${err.message}`);
    }
    // Small delay to avoid rate limiting
    await delay(300);
  }

  lastCacheUpdate = Date.now();
  return { candlesUpdated, sentimentsUpdated, errors };
}

// === FETCH MACRO DATA (Fear & Greed, BTC Dominance, Market Cap) ===

async function fetchMacroData(): Promise<MacroData | null> {
  // Use cached macro data if still fresh
  if (macroCache && Date.now() - lastMacroUpdate < MACRO_CACHE_TTL_MS) {
    return macroCache;
  }

  try {
    // Fetch Fear & Greed Index + Global Market Data from CoinGecko alternative APIs
    const [fgiResult, globalResult] = await Promise.allSettled([
      fetch('https://api.alternative.me/fng/?limit=1', {
        signal: AbortSignal.timeout(8000),
      }),
      fetch('https://api.coingecko.com/api/v3/global', {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json' },
      }),
    ]);

    let fearGreedIndex = 50; // Default: Neutral
    let fearGreedLabel = 'Neutral';
    let btcDominance = 0;
    let totalMarketCap = 0;
    let totalVolume24h = 0;

    // Parse Fear & Greed
    if (fgiResult.status === 'fulfilled' && fgiResult.value.ok) {
      try {
        const fgiData = await fgiResult.value.json();
        if (fgiData?.data?.[0]) {
          fearGreedIndex = parseInt(fgiData.data[0].value) || 50;
          fearGreedLabel = fgiData.data[0].value_classification || 'Neutral';
        }
      } catch { /* parse error, use defaults */ }
    }

    // Parse Global Market Data
    if (globalResult.status === 'fulfilled' && globalResult.value.ok) {
      try {
        const globalData = await globalResult.value.json();
        if (globalData?.data) {
          btcDominance = globalData.data.market_cap_percentage?.btc || 0;
          totalMarketCap = globalData.data.total_market_cap?.usd || 0;
          totalVolume24h = globalData.data.total_volume?.usd || 0;
        }
      } catch { /* parse error, use defaults */ }
    }

    return {
      fearGreedIndex,
      fearGreedLabel,
      btcDominance,
      totalMarketCap,
      totalVolume24h,
      timestamp: new Date(),
    };
  } catch {
    return macroCache; // Return stale cache on error
  }
}

// === COMPUTE SENTIMENT FOR ASSET (with macro data) ===
// v3: Uses sequential Bybit calls instead of Promise.allSettled to avoid fetch failed

async function computeSentiment(client: BybitClient, asset: string): Promise<MarketSentiment | null> {
  const symbol = assetToSymbol(asset);

  // Fetch data SEQUENTIALLY (not in parallel) to avoid overwhelming Bybit
  // This prevents the "fetch failed" errors we saw when 5+ requests fire at once
  let ticker: any = null;
  let oiData: any[] = [];
  let fundingData: any[] = [];
  let ob: any = null;
  let klines: any[] = [];

  // 1. Ticker (most important — if this fails, return null)
  try {
    ticker = await client.getTicker(symbol);
  } catch {
    // Try one more time with a delay
    await delay(1000);
    try {
      ticker = await client.getTicker(symbol);
    } catch {
      return null; // No price = no sentiment
    }
  }
  if (!ticker) return null;

  // 2. Open Interest (with delay after ticker)
  await delay(300);
  try {
    oiData = await client.getOpenInterest(symbol, '1h', 30);
  } catch { /* non-critical, use defaults */ }

  // 3. Funding History (with delay)
  await delay(300);
  try {
    fundingData = await client.getFundingHistory(symbol, 10);
  } catch { /* non-critical */ }

  // 4. Order Book (with delay)
  await delay(300);
  try {
    ob = await client.getOrderBook(symbol, 25);
  } catch { /* non-critical */ }

  // 5. Klines for price change (with delay)
  await delay(300);
  try {
    klines = await client.getKlines(symbol, '60', 2);
  } catch { /* non-critical */ }

  // Extract OI
  const currentOI = oiData.length > 0 ? oiData[0].openInterest : 0;
  const oi1hAgo = oiData.length > 1 ? oiData[1].openInterest : currentOI;
  const oi24hAgo = oiData.length > 24 ? oiData[24].openInterest : (oiData.length > 0 ? oiData[oiData.length - 1].openInterest : currentOI);
  const oiChange1h = currentOI > 0 && oi1hAgo > 0 ? ((currentOI - oi1hAgo) / oi1hAgo) * 100 : 0;
  const oiChange24h = currentOI > 0 && oi24hAgo > 0 ? ((currentOI - oi24hAgo) / oi24hAgo) * 100 : 0;

  // Extract funding
  const currentFunding = fundingData.length > 0 ? fundingData[0].fundingRate : (ticker.fundingRate || 0);
  const fundingAvg = fundingData.length > 0
    ? fundingData.slice(0, 3).reduce((s: number, f: any) => s + f.fundingRate, 0) / Math.min(fundingData.length, 3)
    : currentFunding;

  // Extract orderbook
  const bidDepth = ob ? ob.bids.reduce((s: number, b: any) => s + b.size, 0) : 0;
  const askDepth = ob ? ob.asks.reduce((s: number, a: any) => s + a.size, 0) : 0;
  const totalDepth = bidDepth + askDepth;
  const depthImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  // Extract 1h price change from klines
  let priceChange1h = 0;
  if (klines.length >= 2) {
    const prevClose = klines[klines.length - 2].close;
    const currentClose = klines[klines.length - 1].close;
    if (prevClose > 0) priceChange1h = ((currentClose - prevClose) / prevClose) * 100;
  }

  // Get macro data
  const macro = macroCache;

  // ═══ COMPOSITE PRESSURE SCORE (-100 to +100) ═══
  let pressureScore = 0;

  // 1. Funding rate direction (±15 points)
  if (currentFunding > 0.0005) pressureScore += 15;
  else if (currentFunding > 0.0001) pressureScore += 8;
  else if (currentFunding < -0.0005) pressureScore -= 15;
  else if (currentFunding < -0.0001) pressureScore -= 8;

  // 2. OI trend (±15 points)
  if (oiChange1h > 5) pressureScore += 15;
  else if (oiChange1h > 2) pressureScore += 8;
  else if (oiChange1h < -5) pressureScore -= 15;
  else if (oiChange1h < -2) pressureScore -= 8;

  // 3. Order book depth imbalance (±20 points)
  if (depthImbalance > 0.3) pressureScore += 20;
  else if (depthImbalance > 0.15) pressureScore += 10;
  else if (depthImbalance < -0.3) pressureScore -= 20;
  else if (depthImbalance < -0.15) pressureScore -= 10;

  // 4. Price momentum (±15 points)
  if (priceChange1h > 1) pressureScore += 15;
  else if (priceChange1h > 0.3) pressureScore += 8;
  else if (priceChange1h < -1) pressureScore -= 15;
  else if (priceChange1h < -0.3) pressureScore -= 8;

  // 5. Fear & Greed contrarian signal (±15 points)
  if (macro) {
    if (macro.fearGreedIndex <= 20) pressureScore += 15;
    else if (macro.fearGreedIndex <= 35) pressureScore += 8;
    else if (macro.fearGreedIndex >= 80) pressureScore -= 15;
    else if (macro.fearGreedIndex >= 65) pressureScore -= 8;

    // 6. BTC Dominance effect on ETH (±10 points)
    if (asset === 'ETH/USD' && macro.btcDominance > 55) pressureScore -= 10;
    if (asset === 'ETH/USD' && macro.btcDominance < 40) pressureScore += 10;

    // 7. Volume surge (±10 points)
    if (macro.totalVolume24h > 0 && macro.totalMarketCap > 0) {
      const volumeRatio = macro.totalVolume24h / macro.totalMarketCap;
      if (volumeRatio > 0.1) pressureScore += 5;
      if (volumeRatio < 0.02) pressureScore -= 5;
    }
  }

  // Clamp to -100..+100
  pressureScore = Math.max(-100, Math.min(100, pressureScore));

  // ═══ DERIVED SIGNALS ═══

  // Sentiment: combines all factors
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

  // Liquidity quality: based on spread and depth
  const spreadPct = ticker.ask > 0 ? (ticker.spread / ticker.ask) * 100 : 100;
  const liquidityQuality: MarketSentiment['liquidityQuality'] =
    spreadPct < 0.02 && totalDepth > 10 ? 'HIGH' :
    spreadPct < 0.05 && totalDepth > 5 ? 'MEDIUM' : 'LOW';

  return {
    asset,
    timestamp: new Date(),
    lastPrice: ticker.lastPrice,
    bid: ticker.bid,
    ask: ticker.ask,
    spread: ticker.spread,
    spreadPct,
    volume24h: ticker.volume24h,
    priceChange1h,
    priceChange24h: ticker.lastPrice > 0 ? 0 : 0,
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
  };
}

// === FAST: REFRESH ONLY PRICES (for mid-cycle monitoring) ===
// Called every 60s by the SL/TP monitor to get fresh prices without full feed

export async function refreshPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();

  // Try to use cached sentiment first (fast, no API call)
  for (const [asset, s] of sentimentCache) {
    if (Date.now() - new Date(s.timestamp).getTime() < CACHE_TTL_MS) {
      prices.set(asset, s.lastPrice);
    }
  }

  // If we have fresh prices from cache, return them
  if (prices.size >= 2) return prices;

  // Otherwise, fetch fresh prices from Bybit (fast - single endpoint per asset)
  let bybitClient: BybitClient | null = null;
  try {
    const broker = await getBrokerClientFromDB();
    if (broker instanceof BybitClient) bybitClient = broker;
  } catch { /* ignore */ }

  if (!bybitClient) {
    bybitClient = new BybitClient({
      broker: 'BYBIT',
      apiKey: 'public',
      apiSecret: 'public',
      testnet: false,
    });
  }

  for (const asset of ['BTC/USD', 'ETH/USD']) {
    try {
      const symbol = assetToSymbol(asset);
      const price = await bybitClient.getLastPrice(symbol);
      if (price) {
        prices.set(asset, price);

        // Update sentiment cache price too (for SL/TP checking)
        const existing = sentimentCache.get(asset);
        if (existing) {
          existing.lastPrice = price;
          existing.timestamp = new Date();
        }
      }
    } catch { /* ignore — will use stale prices */ }
    // Small delay between assets
    await delay(300);
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
  // First check memory cache
  const cached = sentimentCache.get(asset);
  if (cached && Date.now() - lastCacheUpdate < CACHE_TTL_MS) return cached;

  // Then check DB
  try {
    const setting = await db.appSettings.findUnique({
      where: { key: `sentiment_${asset.replace('/', '_')}` },
    });
    if (setting) {
      const parsed = JSON.parse(setting.value);
      sentimentCache.set(asset, parsed);
      return parsed;
    }
  } catch { /* ignore */ }

  return null;
}

// === SENTIMENT-BASED CONFIDENCE ADJUSTMENT (v2 — more granular) ===
// Called by auto-trader to adjust signal confidence based on market sentiment
// Returns ±0-15 confidence adjustment

export function getSentimentConfidenceAdjustment(asset: string, direction: 'HIGHER' | 'LOWER'): number {
  const sentiment = sentimentCache.get(asset);
  if (!sentiment) return 0; // No data, no adjustment

  let adjustment = 0;

  // ═══ 1. PRESSURE SCORE ALIGNMENT (strongest signal, ±8) ═══
  if (direction === 'HIGHER' && sentiment.pressureScore > 20) adjustment += 8;
  else if (direction === 'HIGHER' && sentiment.pressureScore > 5) adjustment += 4;
  else if (direction === 'HIGHER' && sentiment.pressureScore < -20) adjustment -= 8;
  else if (direction === 'HIGHER' && sentiment.pressureScore < -5) adjustment -= 4;

  if (direction === 'LOWER' && sentiment.pressureScore < -20) adjustment += 8;
  else if (direction === 'LOWER' && sentiment.pressureScore < -5) adjustment += 4;
  else if (direction === 'LOWER' && sentiment.pressureScore > 20) adjustment -= 8;
  else if (direction === 'LOWER' && sentiment.pressureScore > 5) adjustment -= 4;

  // ═══ 2. SENTIMENT LABEL ALIGNMENT (±5) ═══
  if (sentiment.sentiment === 'BULLISH' && direction === 'HIGHER') adjustment += 5;
  else if (sentiment.sentiment === 'BULLISH' && direction === 'LOWER') adjustment -= 5;
  else if (sentiment.sentiment === 'BEARISH' && direction === 'LOWER') adjustment += 5;
  else if (sentiment.sentiment === 'BEARISH' && direction === 'HIGHER') adjustment -= 5;

  // ═══ 3. FEAR & GREED CONTRARIAN (±3) ═══
  if (direction === 'HIGHER' && sentiment.fearGreedIndex <= 25) adjustment += 3;
  if (direction === 'HIGHER' && sentiment.fearGreedIndex >= 75) adjustment -= 3;
  if (direction === 'LOWER' && sentiment.fearGreedIndex >= 75) adjustment += 3;
  if (direction === 'LOWER' && sentiment.fearGreedIndex <= 25) adjustment -= 3;

  // ═══ 4. LIQUIDITY QUALITY (penalty only) ═══
  if (sentiment.liquidityQuality === 'LOW') adjustment -= 10;
  else if (sentiment.liquidityQuality === 'MEDIUM') adjustment -= 3;

  // ═══ 5. FUNDING RATE EXTREME (contrarian for extreme values) ═══
  if (sentiment.fundingRate > 0.0005 && direction === 'HIGHER') adjustment -= 2;
  if (sentiment.fundingRate > 0.0005 && direction === 'LOWER') adjustment += 2;
  if (sentiment.fundingRate < -0.0005 && direction === 'LOWER') adjustment -= 2;
  if (sentiment.fundingRate < -0.0005 && direction === 'HIGHER') adjustment += 2;

  // Clamp to ±15
  return Math.max(-15, Math.min(15, adjustment));
}

// === MARKET CONTEXT SUMMARY (for dashboard / logging) ===

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
    parts.push(`${assetShort}:${s.sentiment}(P:${s.pressureScore >= 0 ? '+' : ''}${s.pressureScore} FR:${(s.fundingRate * 100).toFixed(4)}% OI:${s.oiChange1h >= 0 ? '+' : ''}${s.oiChange1h.toFixed(1)}%)`);
  }

  return parts.join(' | ') || 'No market data available';
}
