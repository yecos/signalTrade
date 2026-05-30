// MARKET DATA FEEDER — Alimenta la app con datos avanzados de mercado de Bybit
// Datos que provee:
// 1. Velas (klines) de Bybit → DB marketCandle (mejor que CoinGecko/Binance)
// 2. Open Interest → DB MarketData (para detectar squeezes)
// 3. Funding Rate → DB MarketData (para carry cost)
// 4. Order Book depth → Cache en memoria (liquidez/spread)
// 5. Instrumentos → Cache (tick size, lot size para órdenes)
//
// Estos datos mejoran la generación de señales:
// - OI creciente + funding positivo = presión compradora (confirma HIGHER)
// - OI decreciente + funding negativo = presión vendedora (confirma LOWER)
// - Spread estrecho = buena liquidez (mejor fill)
// - Spread ancho = liquidez baja (evitar entrada)

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
  // Derived signals
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  liquidityQuality: 'HIGH' | 'MEDIUM' | 'LOW';
}

// === CACHE ===

let sentimentCache: Map<string, MarketSentiment> = new Map();
let instrumentsCache: Map<string, { tickSize: number; minOrderQty: number; qtyStep: number }> = new Map();
let lastCacheUpdate = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

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

  // ═══ 1. FEED CANDLES FROM BYBIT ═══
  for (const asset of cryptoAssets) {
    const symbol = assetToSymbol(asset);
    for (const [tf, bybitInterval] of Object.entries(intervals)) {
      try {
        const klines = await bybitClient.getKlines(symbol, bybitInterval, 200);
        if (klines.length === 0) continue;

        let upserted = 0;
        for (const k of klines) {
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
            upserted++;
          } catch { /* skip duplicate errors */ }
        }
        if (upserted > 0) candlesUpdated += upserted;
      } catch (err: any) {
        errors.push(`Candles ${asset} ${tf}: ${err.message}`);
      }
    }
  }

  // ═══ 2. FEED MARKET SENTIMENT (funding, OI, orderbook) ═══
  for (const asset of cryptoAssets) {
    try {
      const sentiment = await computeSentiment(bybitClient, asset);
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
  }

  // ═══ 3. CACHE INSTRUMENT SPECS ═══
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
  }

  lastCacheUpdate = Date.now();
  return { candlesUpdated, sentimentsUpdated, errors };
}

// === COMPUTE SENTIMENT FOR ASSET ===

async function computeSentiment(client: BybitClient, asset: string): Promise<MarketSentiment | null> {
  const symbol = assetToSymbol(asset);

  // Fetch all data in parallel
  const [tickerResult, oiResult, fundingResult, obResult] = await Promise.allSettled([
    client.getTicker(symbol),
    client.getOpenInterest(symbol, '1h', 30),
    client.getFundingHistory(symbol, 10),
    client.getOrderBook(symbol, 25),
  ]);

  // Extract ticker
  const ticker = tickerResult.status === 'fulfilled' ? tickerResult.value : null;
  if (!ticker) return null; // No price = no sentiment

  // Extract OI
  const oiData = oiResult.status === 'fulfilled' ? oiResult.value : [];
  const currentOI = oiData.length > 0 ? oiData[0].openInterest : 0;
  const oi1hAgo = oiData.length > 1 ? oiData[1].openInterest : currentOI;
  const oi24hAgo = oiData.length > 24 ? oiData[24].openInterest : (oiData.length > 0 ? oiData[oiData.length - 1].openInterest : currentOI);
  const oiChange1h = currentOI > 0 && oi1hAgo > 0 ? ((currentOI - oi1hAgo) / oi1hAgo) * 100 : 0;
  const oiChange24h = currentOI > 0 && oi24hAgo > 0 ? ((currentOI - oi24hAgo) / oi24hAgo) * 100 : 0;

  // Extract funding
  const fundingData = fundingResult.status === 'fulfilled' ? fundingResult.value : [];
  const currentFunding = fundingData.length > 0 ? fundingData[0].fundingRate : (ticker.fundingRate || 0);
  const fundingAvg = fundingData.length > 0
    ? fundingData.slice(0, 3).reduce((s, f) => s + f.fundingRate, 0) / Math.min(fundingData.length, 3)
    : currentFunding;

  // Extract orderbook
  const ob = obResult.status === 'fulfilled' ? obResult.value : null;
  const bidDepth = ob ? ob.bids.reduce((s, b) => s + b.size, 0) : 0;
  const askDepth = ob ? ob.asks.reduce((s, a) => s + a.size, 0) : 0;
  const totalDepth = bidDepth + askDepth;
  const depthImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  // ═══ DERIVED SIGNALS ═══

  // Sentiment: combines funding + OI direction + depth imbalance
  let sentimentScore = 0;
  // Funding: positive = longs paying shorts = bullish sentiment
  if (currentFunding > 0.0001) sentimentScore += 1;
  else if (currentFunding < -0.0001) sentimentScore -= 1;
  // OI growth: rising OI = new positions opening
  if (oiChange1h > 2) sentimentScore += 1;
  else if (oiChange1h < -2) sentimentScore -= 1;
  // Depth imbalance: more bids = buying pressure
  if (depthImbalance > 0.15) sentimentScore += 1;
  else if (depthImbalance < -0.15) sentimentScore -= 1;

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
    fundingRate: currentFunding,
    fundingRateAvg: fundingAvg,
    openInterest: currentOI,
    oiChange1h,
    oiChange24h,
    bidDepth,
    askDepth,
    depthImbalance,
    sentiment,
    liquidityQuality,
  };
}

// === GET CACHED SENTIMENT ===

export function getSentiment(asset: string): MarketSentiment | null {
  return sentimentCache.get(asset) || null;
}

// === GET ALL CACHED SENTIMENTS ===

export function getAllSentiments(): Map<string, MarketSentiment> {
  return sentimentCache;
}

// === GET INSTRUMENT SPECS ===

export function getInstrumentSpecs(asset: string): { tickSize: number; minOrderQty: number; qtyStep: number } | null {
  return instrumentsCache.get(asset) || null;
}

// === GET SENTIMENT FROM DB (for signal generation) ===

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

// === SENTIMENT-BASED CONFIDENCE ADJUSTMENT ===
// Called by auto-trader to adjust signal confidence based on market sentiment

export function getSentimentConfidenceAdjustment(asset: string, direction: 'HIGHER' | 'LOWER'): number {
  const sentiment = sentimentCache.get(asset);
  if (!sentiment) return 0; // No data, no adjustment

  let adjustment = 0;

  // Sentiment alignment: BULLISH + HIGHER = +5, BULLISH + LOWER = -5
  if (sentiment.sentiment === 'BULLISH' && direction === 'HIGHER') adjustment += 5;
  else if (sentiment.sentiment === 'BULLISH' && direction === 'LOWER') adjustment -= 5;
  else if (sentiment.sentiment === 'BEARISH' && direction === 'LOWER') adjustment += 5;
  else if (sentiment.sentiment === 'BEARISH' && direction === 'HIGHER') adjustment -= 5;

  // Funding rate alignment
  if (direction === 'HIGHER' && sentiment.fundingRate > 0.0001) adjustment += 2;
  if (direction === 'LOWER' && sentiment.fundingRate < -0.0001) adjustment += 2;

  // OI trend alignment
  if (direction === 'HIGHER' && sentiment.oiChange1h > 2) adjustment += 3;
  if (direction === 'LOWER' && sentiment.oiChange1h < -2) adjustment += 3;

  // Liquidity quality penalty
  if (sentiment.liquidityQuality === 'LOW') adjustment -= 10; // Avoid illiquid markets
  else if (sentiment.liquidityQuality === 'MEDIUM') adjustment -= 3;

  return adjustment;
}
