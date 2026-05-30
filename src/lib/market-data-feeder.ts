// MARKET DATA FEEDER v2 — Alimenta la app con datos avanzados de mercado
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

  // ═══ 2. FEED MARKET SENTIMENT (funding, OI, orderbook + macro) ═══
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

async function computeSentiment(client: BybitClient, asset: string): Promise<MarketSentiment | null> {
  const symbol = assetToSymbol(asset);

  // Fetch all data in parallel
  const [tickerResult, oiResult, fundingResult, obResult, klinesResult] = await Promise.allSettled([
    client.getTicker(symbol),
    client.getOpenInterest(symbol, '1h', 30),
    client.getFundingHistory(symbol, 10),
    client.getOrderBook(symbol, 25),
    client.getKlines(symbol, '60', 2), // Last 2 H1 candles for 1h price change
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

  // Extract 1h price change from klines
  let priceChange1h = 0;
  const klines = klinesResult.status === 'fulfilled' ? klinesResult.value : [];
  if (klines.length >= 2) {
    const prevClose = klines[klines.length - 2].close;
    const currentClose = klines[klines.length - 1].close;
    if (prevClose > 0) priceChange1h = ((currentClose - prevClose) / prevClose) * 100;
  } else if (ticker.lastPrice > 0) {
    // Fallback: use ticker's price change percentage if available
    priceChange1h = ticker.volume24h > 0 ? 0 : 0; // Can't determine from ticker alone
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
  //    Extreme fear → contrarian bullish (buy the fear)
  //    Extreme greed → contrarian bearish (sell the news)
  if (macro) {
    if (macro.fearGreedIndex <= 20) pressureScore += 15;      // Extreme Fear = bullish contrarian
    else if (macro.fearGreedIndex <= 35) pressureScore += 8;  // Fear = mildly bullish
    else if (macro.fearGreedIndex >= 80) pressureScore -= 15; // Extreme Greed = bearish contrarian
    else if (macro.fearGreedIndex >= 65) pressureScore -= 8;  // Greed = mildly bearish

    // 6. BTC Dominance effect on ETH (±10 points)
    //    BTC dominance rising → money flowing out of alts → bearish for ETH
    if (asset === 'ETH/USD' && macro.btcDominance > 55) pressureScore -= 10;
    if (asset === 'ETH/USD' && macro.btcDominance < 40) pressureScore += 10;

    // 7. Volume surge (±10 points)
    if (macro.totalVolume24h > 0 && macro.totalMarketCap > 0) {
      const volumeRatio = macro.totalVolume24h / macro.totalMarketCap;
      if (volumeRatio > 0.1) pressureScore += 5;  // High volume = strong conviction
      if (volumeRatio < 0.02) pressureScore -= 5; // Low volume = uncertain
    }
  }

  // Clamp to -100..+100
  pressureScore = Math.max(-100, Math.min(100, pressureScore));

  // ═══ DERIVED SIGNALS ═══

  // Sentiment: combines all factors
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
  // Macro: Fear & Greed contrarian
  if (macro) {
    if (macro.fearGreedIndex <= 25) sentimentScore += 1;     // Extreme fear = bullish contrarian
    else if (macro.fearGreedIndex >= 75) sentimentScore -= 1; // Extreme greed = bearish contrarian
  }
  // Price momentum
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
    priceChange24h: ticker.lastPrice > 0 ? 0 : 0, // Fallback; Bybit ticker doesn't directly provide this
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
  // pressureScore ranges from -100 to +100
  // Positive pressure → HIGHER favorable; Negative pressure → LOWER favorable
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
  // Extreme fear → support HIGHER (contrarian bounce)
  // Extreme greed → support LOWER (contrarian reversal)
  if (direction === 'HIGHER' && sentiment.fearGreedIndex <= 25) adjustment += 3;
  if (direction === 'HIGHER' && sentiment.fearGreedIndex >= 75) adjustment -= 3;
  if (direction === 'LOWER' && sentiment.fearGreedIndex >= 75) adjustment += 3;
  if (direction === 'LOWER' && sentiment.fearGreedIndex <= 25) adjustment -= 3;

  // ═══ 4. LIQUIDITY QUALITY (penalty only) ═══
  if (sentiment.liquidityQuality === 'LOW') adjustment -= 10; // Avoid illiquid markets
  else if (sentiment.liquidityQuality === 'MEDIUM') adjustment -= 3;

  // ═══ 5. FUNDING RATE EXTREME (contrarian for extreme values) ═══
  // Very high funding (>0.05%) = overleveraged longs → bearish reversal risk
  // Very low funding (<-0.05%) = overleveraged shorts → bullish squeeze risk
  if (sentiment.fundingRate > 0.0005 && direction === 'HIGHER') adjustment -= 2; // Long squeeze risk
  if (sentiment.fundingRate > 0.0005 && direction === 'LOWER') adjustment += 2;  // Long squeeze = bearish
  if (sentiment.fundingRate < -0.0005 && direction === 'LOWER') adjustment -= 2; // Short squeeze risk
  if (sentiment.fundingRate < -0.0005 && direction === 'HIGHER') adjustment += 2; // Short squeeze = bullish

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
