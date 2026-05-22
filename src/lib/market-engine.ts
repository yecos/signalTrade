// REAL MARKET DATA ENGINE - Multi-source with free APIs
// Architecture: CoinGecko (crypto, free, no key) → TwelveData (all, needs key) → Binance (crypto, often blocked) → GBM Fallback
//
// IMPORTANT: In Vercel serverless, module-level state is lost between requests.
// All API keys are read from environment variables on each request.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'COINGECKO' | 'BINANCE' | 'TWELVEDATA' | 'FALLBACK';
}

export interface MarketEngineStatus {
  connected: boolean;
  sources: Record<string, 'COINGECKO' | 'BINANCE' | 'TWELVEDATA' | 'FALLBACK' | 'OFFLINE'>;
  lastPrice: Record<string, number>;
  lastUpdate: Record<string, string>;
  latency: Record<string, number>;
  dataQuality: 'HIGH' | 'MEDIUM' | 'LOW' | 'OFFLINE';
  errors: string[];
  binanceAvailable: boolean;
  twelveDataAvailable: boolean;
  coinGeckoAvailable: boolean;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const TWELVEDATA_BASE = 'https://api.twelvedata.com';

// Binance API alternatives - direct API is often blocked from cloud providers (AWS/Vercel)
const BINANCE_ENDPOINTS = [
  'https://api.binance.us/api/v3',
  'https://api1.binance.com/api/v3',
  'https://api2.binance.com/api/v3',
  'https://api3.binance.com/api/v3',
  'https://data-api.binance.vision/api/v3',
];

// CoinGecko coin IDs
const COINGECKO_IDS: Record<string, string> = {
  'BTC/USD': 'bitcoin',
  'ETH/USD': 'ethereum',
};

// Free forex rates API (no key needed) - ECB daily rates
const FRANKFURTER_BASE = 'https://api.frankfurter.app';

// Map our asset names to Binance symbols
const BINANCE_SYMBOLS: Record<string, string> = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT',
  'EUR/USD': 'EURUSDT',
  'GBP/USD': 'GBPUSDT',
  'USD/JPY': 'USDJPY',
};

const TWELVEDATA_SYMBOLS: Record<string, { symbol: string; market: string }> = {
  'EUR/USD': { symbol: 'EUR/USD', market: 'forex' },
  'GBP/USD': { symbol: 'GBP/USD', market: 'forex' },
  'USD/JPY': { symbol: 'USD/JPY', market: 'forex' },
  'BTC/USD': { symbol: 'BTC/USD', market: 'crypto' },
  'ETH/USD': { symbol: 'ETH/USD', market: 'crypto' },
};

// Timeframe mapping
const BINANCE_INTERVALS: Record<string, string> = {
  'M1': '1m', 'M5': '5m', 'M15': '15m', 'M30': '30m', 'H1': '1h',
};

const TWELVEDATA_INTERVALS: Record<string, string> = {
  'M1': '1min', 'M5': '5min', 'M15': '15min', 'M30': '30min', 'H1': '1h',
};

// Asset configs for fallback GBM generation
const ASSET_CONFIGS: Record<string, { basePrice: number; volatility: number; drift: number }> = {
  'EUR/USD': { basePrice: 1.0850, volatility: 0.0008, drift: 0.00001 },
  'GBP/USD': { basePrice: 1.2650, volatility: 0.001, drift: 0.00001 },
  'USD/JPY': { basePrice: 149.50, volatility: 0.08, drift: 0.0001 },
  'BTC/USD': { basePrice: 67500, volatility: 500, drift: 5 },
  'ETH/USD': { basePrice: 3500, volatility: 50, drift: 0.5 },
};

// ─── Engine State (per-request, rebuilt each time in serverless) ──────────────

interface PriceCache {
  price: number;
  source: string;
  timestamp: number;
}

const priceCache: Record<string, PriceCache> = {};
const CACHE_TTL = 30_000; // 30 seconds

let engineStatus: MarketEngineStatus = {
  connected: false,
  sources: {},
  lastPrice: {},
  lastUpdate: {},
  latency: {},
  dataQuality: 'OFFLINE',
  errors: [],
  binanceAvailable: false,
  twelveDataAvailable: false,
  coinGeckoAvailable: false,
};

// ─── API Key Helpers (reads from env vars each time for serverless) ───────────

function getTwelveDataApiKey(): string | null {
  return process.env.TWELVEDATA_API_KEY || null;
}

export function setTwelveDataApiKey(key: string) {
  process.env.TWELVEDATA_API_KEY = key;
}

export function getTwelveDataApiKeyStatus(): boolean {
  return !!getTwelveDataApiKey();
}

// ─── CoinGecko API (FREE, no API key needed, works from Vercel) ──────────────

async function fetchCoinGeckoPrice(asset: string): Promise<number | null> {
  const coinId = COINGECKO_IDS[asset];
  if (!coinId) return null;

  try {
    const url = `${COINGECKO_BASE}/simple/price?ids=${coinId}&vs_currencies=usd`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const price = data?.[coinId]?.usd;
    if (price && typeof price === 'number') {
      engineStatus.coinGeckoAvailable = true;
      return price;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchCoinGeckoCandles(
  asset: string,
  days: number = 1
): Promise<MarketCandle[] | null> {
  const coinId = COINGECKO_IDS[asset];
  if (!coinId) return null;

  try {
    // CoinGecko OHLC endpoint: /coins/{id}/ohlc
    const url = `${COINGECKO_BASE}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    engineStatus.coinGeckoAvailable = true;

    // CoinGecko OHLC format: [timestamp, open, high, low, close]
    return data.map((k: number[]) => ({
      timestamp: k[0],
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: 0, // CoinGecko OHLC doesn't include volume
      source: 'COINGECKO' as const,
    }));
  } catch {
    return null;
  }
}

// ─── Frankfurter API (FREE forex rates, no key needed) ────────────────────────

async function fetchFrankfurterRate(asset: string): Promise<number | null> {
  // Frankfurter provides rates against EUR
  // EUR/USD = 1 / USD_EUR_RATE
  // GBP/USD = GBP_USD_RATE / GBP_EUR_RATE * USD_EUR_RATE
  try {
    const pair = asset.split('/');
    if (pair.length !== 2) return null;
    const [base, quote] = pair;

    const url = `${FRANKFURTER_BASE}/latest?from=${base}&to=${quote}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const rate = data?.rates?.[quote];
    if (rate && typeof rate === 'number') {
      return rate;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Binance API (with multiple endpoint fallback) ───────────────────────────

async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  limit: number = 100
): Promise<MarketCandle[] | null> {
  for (const baseUrl of BINANCE_ENDPOINTS) {
    const start = Date.now();
    try {
      const url = `${baseUrl}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;

      const latency = Date.now() - start;
      engineStatus.latency[symbol] = latency;
      engineStatus.binanceAvailable = true;

      return data.map((k: number[]) => ({
        timestamp: k[0],
        open: parseFloat(String(k[1])),
        high: parseFloat(String(k[2])),
        low: parseFloat(String(k[3])),
        close: parseFloat(String(k[4])),
        volume: parseFloat(String(k[5])),
        source: 'BINANCE' as const,
      }));
    } catch {
      continue;
    }
  }

  engineStatus.binanceAvailable = false;
  return null;
}

async function fetchBinancePrice(symbol: string): Promise<number | null> {
  for (const baseUrl of BINANCE_ENDPOINTS) {
    try {
      const url = `${baseUrl}/ticker/price?symbol=${symbol}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) continue;

      const data = await res.json();
      if (data.price) {
        engineStatus.binanceAvailable = true;
        return parseFloat(data.price);
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ─── TwelveData API ──────────────────────────────────────────────────────────

async function fetchTwelveDataCandles(
  asset: string,
  interval: string,
  outputsize: number = 100
): Promise<MarketCandle[] | null> {
  const apiKey = getTwelveDataApiKey();
  if (!apiKey) return null;

  const config = TWELVEDATA_SYMBOLS[asset];
  if (!config) return null;

  const start = Date.now();
  try {
    const params = new URLSearchParams({
      symbol: config.symbol,
      interval: TWELVEDATA_INTERVALS[interval] || '5min',
      outputsize: outputsize.toString(),
      apikey: apiKey,
    });

    if (config.market === 'forex') params.set('market', 'forex');

    const url = `${TWELVEDATA_BASE}/time_series?${params}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (data.status === 'error') return null;

    const values = data.values;
    if (!Array.isArray(values) || values.length === 0) return null;

    const latency = Date.now() - start;
    const symbolKey = config.symbol.replace('/', '');
    engineStatus.latency[symbolKey] = latency;
    engineStatus.twelveDataAvailable = true;

    return values.map((v: Record<string, string>) => ({
      timestamp: new Date(v.datetime).getTime(),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseInt(v.volume || '0'),
      source: 'TWELVEDATA' as const,
    }));
  } catch {
    engineStatus.twelveDataAvailable = false;
    return null;
  }
}

async function fetchTwelveDataPrice(asset: string): Promise<number | null> {
  const apiKey = getTwelveDataApiKey();
  if (!apiKey) return null;

  const config = TWELVEDATA_SYMBOLS[asset];
  if (!config) return null;

  try {
    const params = new URLSearchParams({
      symbol: config.symbol,
      apikey: apiKey,
    });
    if (config.market === 'forex') params.set('market', 'forex');

    const url = `${TWELVEDATA_BASE}/price?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) return null;

    const data = await res.json();
    if (data.price) {
      engineStatus.twelveDataAvailable = true;
      return parseFloat(data.price);
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Fallback GBM Generator ──────────────────────────────────────────────────

function generateGBMCandles(
  asset: string,
  count: number,
  timeframe: string
): MarketCandle[] {
  const config = ASSET_CONFIGS[asset];
  if (!config) return [];

  const candles: MarketCandle[] = [];
  const tfMinutes: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
  const tfMs = (tfMinutes[timeframe] || 5) * 60 * 1000;

  const cachedPrice = priceCache[asset]?.price;
  let price = cachedPrice || config.basePrice;
  const now = Date.now();

  const hourUtc = new Date().getUTCHours();
  let volMultiplier = 1.0;
  if (hourUtc >= 12 && hourUtc < 16) volMultiplier = 1.8;
  else if (hourUtc >= 7 && hourUtc < 12) volMultiplier = 1.2;
  else if (hourUtc >= 16 && hourUtc < 21) volMultiplier = 1.0;
  else volMultiplier = 0.5;

  for (let i = count - 1; i >= 0; i--) {
    const timestamp = now - i * tfMs;
    const dt = tfMs / (365.25 * 24 * 60 * 60 * 1000);
    const random = () =>
      (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

    const drift = config.drift * dt;
    const diffusion = config.volatility * volMultiplier * Math.sqrt(dt) * random();
    const open = price;
    const close = price * (1 + drift + diffusion);
    const highExtra = Math.abs(close - open) * (0.2 + Math.random() * 0.8);
    const lowExtra = Math.abs(close - open) * (0.2 + Math.random() * 0.8);
    const high = Math.max(open, close) + highExtra;
    const low = Math.min(open, close) - lowExtra;
    const volume = Math.floor(1000 + Math.random() * 5000);

    candles.push({ timestamp, open, high, low, close, volume, source: 'FALLBACK' });
    price = close;
  }

  return candles;
}

// ─── Main Engine Functions ────────────────────────────────────────────────────

export async function getCandles(
  asset: string,
  timeframe: string = 'M5',
  count: number = 100
): Promise<{ candles: MarketCandle[]; source: string }> {
  // 1. Try CoinGecko (free, no key, works from Vercel) - crypto only
  const coinGeckoCandles = await fetchCoinGeckoCandles(asset, 1);
  if (coinGeckoCandles && coinGeckoCandles.length > 0) {
    engineStatus.sources[asset] = 'COINGECKO';
    engineStatus.lastPrice[asset] = coinGeckoCandles[coinGeckoCandles.length - 1].close;
    engineStatus.lastUpdate[asset] = new Date().toISOString();
    engineStatus.connected = true;
    priceCache[asset] = {
      price: coinGeckoCandles[coinGeckoCandles.length - 1].close,
      source: 'COINGECKO',
      timestamp: Date.now(),
    };
    return { candles: coinGeckoCandles, source: 'COINGECKO' };
  }

  // 2. Try Binance (crypto)
  const binanceSymbol = BINANCE_SYMBOLS[asset];
  if (binanceSymbol) {
    const binanceInterval = BINANCE_INTERVALS[timeframe] || '5m';
    const klines = await fetchBinanceKlines(binanceSymbol, binanceInterval, count);
    if (klines && klines.length > 0) {
      engineStatus.sources[asset] = 'BINANCE';
      engineStatus.lastPrice[asset] = klines[klines.length - 1].close;
      engineStatus.lastUpdate[asset] = new Date().toISOString();
      engineStatus.connected = true;
      priceCache[asset] = {
        price: klines[klines.length - 1].close,
        source: 'BINANCE',
        timestamp: Date.now(),
      };
      return { candles: klines, source: 'BINANCE' };
    }
  }

  // 3. Try TwelveData (all assets, needs key)
  const twelveDataCandles = await fetchTwelveDataCandles(asset, timeframe, count);
  if (twelveDataCandles && twelveDataCandles.length > 0) {
    engineStatus.sources[asset] = 'TWELVEDATA';
    engineStatus.lastPrice[asset] = twelveDataCandles[twelveDataCandles.length - 1].close;
    engineStatus.lastUpdate[asset] = new Date().toISOString();
    engineStatus.connected = true;
    priceCache[asset] = {
      price: twelveDataCandles[twelveDataCandles.length - 1].close,
      source: 'TWELVEDATA',
      timestamp: Date.now(),
    };
    return { candles: twelveDataCandles, source: 'TWELVEDATA' };
  }

  // 4. Fall back to GBM simulation
  const fallbackCandles = generateGBMCandles(asset, count, timeframe);
  engineStatus.sources[asset] = 'FALLBACK';
  engineStatus.lastPrice[asset] =
    fallbackCandles.length > 0 ? fallbackCandles[fallbackCandles.length - 1].close : ASSET_CONFIGS[asset]?.basePrice || 0;
  engineStatus.lastUpdate[asset] = new Date().toISOString();
  engineStatus.connected = false;
  if (!engineStatus.errors.some((e) => e.startsWith(`${asset}:`) && e.includes('No API available'))) {
    engineStatus.errors.push(`${asset}: No API available, using fallback simulation`);
  }
  return { candles: fallbackCandles, source: 'FALLBACK' };
}

export async function getLatestPrice(
  asset: string
): Promise<{ price: number; source: string; latency: number }> {
  // Check cache first
  const cached = priceCache[asset];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const latency = Date.now() - cached.timestamp;
    return { price: cached.price, source: cached.source, latency };
  }

  const start = Date.now();

  // 1. Try CoinGecko (free, crypto only)
  const isCrypto = COINGECKO_IDS[asset];
  if (isCrypto) {
    const cgPrice = await fetchCoinGeckoPrice(asset);
    if (cgPrice !== null) {
      const latency = Date.now() - start;
      engineStatus.lastPrice[asset] = cgPrice;
      engineStatus.lastUpdate[asset] = new Date().toISOString();
      engineStatus.latency[asset] = latency;
      engineStatus.sources[asset] = 'COINGECKO';
      engineStatus.connected = true;
      priceCache[asset] = { price: cgPrice, source: 'COINGECKO', timestamp: Date.now() };
      return { price: cgPrice, source: 'COINGECKO', latency };
    }
  }

  // 2. Try Frankfurter (free forex rates, no key)
  if (!isCrypto) {
    const ffRate = await fetchFrankfurterRate(asset);
    if (ffRate !== null) {
      const latency = Date.now() - start;
      engineStatus.lastPrice[asset] = ffRate;
      engineStatus.lastUpdate[asset] = new Date().toISOString();
      engineStatus.latency[asset] = latency;
      engineStatus.sources[asset] = 'COINGECKO'; // Using same category for free APIs
      engineStatus.connected = true;
      priceCache[asset] = { price: ffRate, source: 'COINGECKO', timestamp: Date.now() };
      return { price: ffRate, source: 'FRANKFURTER', latency };
    }
  }

  // 3. Try Binance
  const binanceSymbol = BINANCE_SYMBOLS[asset];
  if (binanceSymbol) {
    const price = await fetchBinancePrice(binanceSymbol);
    if (price !== null) {
      const latency = Date.now() - start;
      engineStatus.lastPrice[asset] = price;
      engineStatus.lastUpdate[asset] = new Date().toISOString();
      engineStatus.latency[asset] = latency;
      engineStatus.sources[asset] = 'BINANCE';
      engineStatus.connected = true;
      priceCache[asset] = { price, source: 'BINANCE', timestamp: Date.now() };
      return { price, source: 'BINANCE', latency };
    }
  }

  // 4. Try TwelveData
  const tdPrice = await fetchTwelveDataPrice(asset);
  if (tdPrice !== null) {
    const latency = Date.now() - start;
    engineStatus.lastPrice[asset] = tdPrice;
    engineStatus.lastUpdate[asset] = new Date().toISOString();
    engineStatus.latency[asset] = latency;
    engineStatus.sources[asset] = 'TWELVEDATA';
    engineStatus.connected = true;
    priceCache[asset] = { price: tdPrice, source: 'TWELVEDATA', timestamp: Date.now() };
    return { price: tdPrice, source: 'TWELVEDATA', latency };
  }

  // 5. Fallback
  const fallbackPrice =
    engineStatus.lastPrice[asset] ||
    priceCache[asset]?.price ||
    ASSET_CONFIGS[asset]?.basePrice ||
    0;
  const latency = Date.now() - start;
  engineStatus.sources[asset] = 'FALLBACK';
  return { price: fallbackPrice, source: 'FALLBACK', latency };
}

export function getEngineStatus(): MarketEngineStatus {
  const sources = Object.values(engineStatus.sources);
  if (sources.some((s) => s === 'COINGECKO' || s === 'BINANCE' || s === 'TWELVEDATA')) {
    engineStatus.dataQuality = sources.every(
      (s) => s === 'COINGECKO' || s === 'BINANCE' || s === 'TWELVEDATA'
    ) ? 'HIGH' : 'MEDIUM';
  } else if (sources.some((s) => s === 'FALLBACK')) {
    engineStatus.dataQuality = 'LOW';
  } else {
    engineStatus.dataQuality = 'OFFLINE';
  }
  return { ...engineStatus };
}

export function getAnalysisMode(
  asset: string
): 'FULL' | 'PARTIAL' | 'FALLBACK' | 'DEMO' {
  const source = engineStatus.sources[asset];
  if (source === 'COINGECKO' || source === 'BINANCE' || source === 'TWELVEDATA') return 'FULL';
  if (source === 'FALLBACK') return 'FALLBACK';
  return 'DEMO';
}

// Quick health check - ping all APIs
export async function checkApiHealth(): Promise<{
  binance: boolean;
  twelveData: boolean;
  coinGecko: boolean;
  frankfurter: boolean;
  latency: { binance: number; twelveData: number; coinGecko: number; frankfurter: number };
}> {
  const results = {
    binance: false,
    twelveData: false,
    coinGecko: false,
    frankfurter: false,
    latency: { binance: -1, twelveData: -1, coinGecko: -1, frankfurter: -1 },
  };

  // Check CoinGecko (free, no key)
  try {
    const start = Date.now();
    const res = await fetch(`${COINGECKO_BASE}/ping`, {
      signal: AbortSignal.timeout(5000),
    });
    results.coinGecko = res.ok;
    results.latency.coinGecko = Date.now() - start;
    engineStatus.coinGeckoAvailable = results.coinGecko;
  } catch {
    results.coinGecko = false;
  }

  // Check Frankfurter (free, no key)
  try {
    const start = Date.now();
    const res = await fetch(`${FRANKFURTER_BASE}/latest?from=EUR&to=USD`, {
      signal: AbortSignal.timeout(5000),
    });
    results.frankfurter = res.ok;
    results.latency.frankfurter = Date.now() - start;
  } catch {
    results.frankfurter = false;
  }

  // Check Binance
  for (const baseUrl of BINANCE_ENDPOINTS) {
    try {
      const start = Date.now();
      const res = await fetch(`${baseUrl}/ping`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        results.binance = true;
        results.latency.binance = Date.now() - start;
        engineStatus.binanceAvailable = true;
        break;
      }
    } catch {
      continue;
    }
  }

  // Check TwelveData
  const apiKey = getTwelveDataApiKey();
  if (apiKey) {
    try {
      const start = Date.now();
      const res = await fetch(
        `${TWELVEDATA_BASE}/time_series?symbol=EUR/USD&interval=1min&outputsize=1&apikey=${apiKey}`,
        { signal: AbortSignal.timeout(10000) }
      );
      const data = await res.json();
      results.twelveData = data.status !== 'error';
      results.latency.twelveData = Date.now() - start;
      engineStatus.twelveDataAvailable = results.twelveData;
    } catch {
      results.twelveData = false;
    }
  }

  return results;
}

// Get all prices at once for the dashboard
export async function getAllPrices(): Promise<
  Record<string, { price: number; source: string; latency: number; timestamp: string }>
> {
  const assets = Object.keys(ASSET_CONFIGS);
  const results: Record<string, { price: number; source: string; latency: number; timestamp: string }> = {};

  await Promise.all(
    assets.map(async (asset) => {
      const result = await getLatestPrice(asset);
      results[asset] = { ...result, timestamp: new Date().toISOString() };
    })
  );

  return results;
}
