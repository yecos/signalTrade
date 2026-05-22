// REAL MARKET DATA ENGINE - Multi-source with free APIs
// Architecture: CoinGecko (crypto, free, no key) → TwelveData (all, needs key) → Binance (crypto) → GBM Fallback
//
// SERVERLESS-SAFE: All state uses a global cache with TTL.
// On Vercel, each cold start resets memory, so getEngineStatus() performs
// a quick health check if the cache is stale, ensuring the dashboard
// always shows accurate connectivity status.

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
  frankfurterAvailable: boolean;
  lastHealthCheck: string | null;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const TWELVEDATA_BASE = 'https://api.twelvedata.com';
const FRANKFURTER_BASE = 'https://api.frankfurter.app';

const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision/api/v3',
  'https://api.binance.us/api/v3',
  'https://api1.binance.com/api/v3',
  'https://api2.binance.com/api/v3',
  'https://api3.binance.com/api/v3',
];

const COINGECKO_IDS: Record<string, string> = {
  'BTC/USD': 'bitcoin',
  'ETH/USD': 'ethereum',
};

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

const BINANCE_INTERVALS: Record<string, string> = {
  'M1': '1m', 'M5': '5m', 'M15': '15m', 'M30': '30m', 'H1': '1h',
};

const TWELVEDATA_INTERVALS: Record<string, string> = {
  'M1': '1min', 'M5': '5min', 'M15': '15min', 'M30': '30min', 'H1': '1h',
};

const ASSET_CONFIGS: Record<string, { basePrice: number; volatility: number; drift: number }> = {
  'EUR/USD': { basePrice: 1.0850, volatility: 0.0008, drift: 0.00001 },
  'GBP/USD': { basePrice: 1.2650, volatility: 0.001, drift: 0.00001 },
  'USD/JPY': { basePrice: 149.50, volatility: 0.08, drift: 0.0001 },
  'BTC/USD': { basePrice: 67500, volatility: 500, drift: 5 },
  'ETH/USD': { basePrice: 3500, volatility: 50, drift: 0.5 },
};

// ─── Global Cached State (survives hot-reload in dev, TTL-based in serverless) ─

interface CachedEngineState {
  status: MarketEngineStatus;
  priceCache: Record<string, { price: number; source: string; timestamp: number }>;
  lastHealthCheckTime: number;
  healthCheckPromise: Promise<void> | null;
}

const CACHE_TTL = 30_000;       // 30s for prices
const HEALTH_CHECK_TTL = 60_000; // 60s for health status

const DEFAULT_STATUS: MarketEngineStatus = {
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
  frankfurterAvailable: false,
  lastHealthCheck: null,
};

// Global cache - survives hot reloads in dev, survives within same serverless instance
const globalForEngine = globalThis as unknown as {
  __marketEngine: CachedEngineState | undefined;
};

function getCachedState(): CachedEngineState {
  if (!globalForEngine.__marketEngine) {
    globalForEngine.__marketEngine = {
      status: { ...DEFAULT_STATUS },
      priceCache: {},
      lastHealthCheckTime: 0,
      healthCheckPromise: null,
    };
  }
  return globalForEngine.__marketEngine;
}

// ─── API Key Helpers ──────────────────────────────────────────────────────────

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
    return price && typeof price === 'number' ? price : null;
  } catch {
    return null;
  }
}

async function fetchCoinGeckoCandles(asset: string, days: number = 1): Promise<MarketCandle[] | null> {
  const coinId = COINGECKO_IDS[asset];
  if (!coinId) return null;

  try {
    const url = `${COINGECKO_BASE}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    return data.map((k: number[]) => ({
      timestamp: k[0], open: k[1], high: k[2], low: k[3], close: k[4],
      volume: 0, source: 'COINGECKO' as const,
    }));
  } catch {
    return null;
  }
}

// ─── Frankfurter API (FREE forex rates, no key needed) ────────────────────────

async function fetchFrankfurterRate(asset: string): Promise<number | null> {
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
    return rate && typeof rate === 'number' ? rate : null;
  } catch {
    return null;
  }
}

// ─── Binance API (with multiple endpoint fallback) ───────────────────────────

async function fetchBinanceKlines(symbol: string, interval: string, limit: number = 100): Promise<MarketCandle[] | null> {
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

      const state = getCachedState();
      state.status.latency[symbol] = Date.now() - start;
      state.status.binanceAvailable = true;

      return data.map((k: number[]) => ({
        timestamp: k[0],
        open: parseFloat(String(k[1])), high: parseFloat(String(k[2])),
        low: parseFloat(String(k[3])), close: parseFloat(String(k[4])),
        volume: parseFloat(String(k[5])), source: 'BINANCE' as const,
      }));
    } catch { continue; }
  }
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
        getCachedState().status.binanceAvailable = true;
        return parseFloat(data.price);
      }
    } catch { continue; }
  }
  return null;
}

// ─── TwelveData API ──────────────────────────────────────────────────────────

async function fetchTwelveDataCandles(asset: string, interval: string, outputsize: number = 100): Promise<MarketCandle[] | null> {
  const apiKey = getTwelveDataApiKey();
  if (!apiKey) return null;
  const config = TWELVEDATA_SYMBOLS[asset];
  if (!config) return null;

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

    getCachedState().status.twelveDataAvailable = true;

    return values.map((v: Record<string, string>) => ({
      timestamp: new Date(v.datetime).getTime(),
      open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close),
      volume: parseInt(v.volume || '0'), source: 'TWELVEDATA' as const,
    }));
  } catch {
    return null;
  }
}

async function fetchTwelveDataPrice(asset: string): Promise<number | null> {
  const apiKey = getTwelveDataApiKey();
  if (!apiKey) return null;
  const config = TWELVEDATA_SYMBOLS[asset];
  if (!config) return null;

  try {
    const params = new URLSearchParams({ symbol: config.symbol, apikey: apiKey });
    if (config.market === 'forex') params.set('market', 'forex');
    const url = `${TWELVEDATA_BASE}/price?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.price) {
      getCachedState().status.twelveDataAvailable = true;
      return parseFloat(data.price);
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Fallback GBM Generator ──────────────────────────────────────────────────

function generateGBMCandles(asset: string, count: number, timeframe: string): MarketCandle[] {
  const config = ASSET_CONFIGS[asset];
  if (!config) return [];

  const candles: MarketCandle[] = [];
  const tfMinutes: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
  const tfMs = (tfMinutes[timeframe] || 5) * 60 * 1000;

  const state = getCachedState();
  const cachedPrice = state.priceCache[asset]?.price;
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
    const random = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
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

// ─── Helper: Update source status in cache ────────────────────────────────────

function updateSourceStatus(asset: string, source: 'COINGECKO' | 'BINANCE' | 'TWELVEDATA' | 'FALLBACK', price: number) {
  const state = getCachedState();
  state.status.sources[asset] = source;
  state.status.lastPrice[asset] = price;
  state.status.lastUpdate[asset] = new Date().toISOString();
  state.priceCache[asset] = { price, source, timestamp: Date.now() };

  if (source !== 'FALLBACK') {
    state.status.connected = true;
  }

  // Recalculate data quality
  const sources = Object.values(state.status.sources);
  if (sources.some(s => s === 'COINGECKO' || s === 'BINANCE' || s === 'TWELVEDATA')) {
    state.status.dataQuality = sources.every(s => s === 'COINGECKO' || s === 'BINANCE' || s === 'TWELVEDATA') ? 'HIGH' : 'MEDIUM';
  } else if (sources.some(s => s === 'FALLBACK')) {
    state.status.dataQuality = 'LOW';
  } else {
    state.status.dataQuality = 'OFFLINE';
  }
}

// ─── Main Engine Functions ────────────────────────────────────────────────────

export async function getCandles(
  asset: string, timeframe: string = 'M5', count: number = 100
): Promise<{ candles: MarketCandle[]; source: string }> {
  // 1. CoinGecko (free, crypto only)
  const cgCandles = await fetchCoinGeckoCandles(asset, 1);
  if (cgCandles && cgCandles.length > 0) {
    getCachedState().status.coinGeckoAvailable = true;
    updateSourceStatus(asset, 'COINGECKO', cgCandles[cgCandles.length - 1].close);
    return { candles: cgCandles, source: 'COINGECKO' };
  }

  // 2. Binance (crypto)
  const binanceSymbol = BINANCE_SYMBOLS[asset];
  if (binanceSymbol) {
    const klines = await fetchBinanceKlines(binanceSymbol, BINANCE_INTERVALS[timeframe] || '5m', count);
    if (klines && klines.length > 0) {
      updateSourceStatus(asset, 'BINANCE', klines[klines.length - 1].close);
      return { candles: klines, source: 'BINANCE' };
    }
  }

  // 3. TwelveData (all assets)
  const tdCandles = await fetchTwelveDataCandles(asset, timeframe, count);
  if (tdCandles && tdCandles.length > 0) {
    updateSourceStatus(asset, 'TWELVEDATA', tdCandles[tdCandles.length - 1].close);
    return { candles: tdCandles, source: 'TWELVEDATA' };
  }

  // 4. Fallback
  const fallbackCandles = generateGBMCandles(asset, count, timeframe);
  const fallbackPrice = fallbackCandles.length > 0 ? fallbackCandles[fallbackCandles.length - 1].close : ASSET_CONFIGS[asset]?.basePrice || 0;
  updateSourceStatus(asset, 'FALLBACK', fallbackPrice);
  return { candles: fallbackCandles, source: 'FALLBACK' };
}

export async function getLatestPrice(
  asset: string
): Promise<{ price: number; source: string; latency: number }> {
  const state = getCachedState();

  // Check cache first
  const cached = state.priceCache[asset];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { price: cached.price, source: cached.source, latency: Date.now() - cached.timestamp };
  }

  const start = Date.now();
  const isCrypto = COINGECKO_IDS[asset];

  // 1. CoinGecko (crypto)
  if (isCrypto) {
    const price = await fetchCoinGeckoPrice(asset);
    if (price !== null) {
      state.status.coinGeckoAvailable = true;
      updateSourceStatus(asset, 'COINGECKO', price);
      return { price, source: 'COINGECKO', latency: Date.now() - start };
    }
  }

  // 2. Frankfurter (forex)
  if (!isCrypto) {
    const rate = await fetchFrankfurterRate(asset);
    if (rate !== null) {
      state.status.frankfurterAvailable = true;
      updateSourceStatus(asset, 'COINGECKO', rate);
      return { price: rate, source: 'FRANKFURTER', latency: Date.now() - start };
    }
  }

  // 3. Binance
  const binanceSymbol = BINANCE_SYMBOLS[asset];
  if (binanceSymbol) {
    const price = await fetchBinancePrice(binanceSymbol);
    if (price !== null) {
      updateSourceStatus(asset, 'BINANCE', price);
      return { price, source: 'BINANCE', latency: Date.now() - start };
    }
  }

  // 4. TwelveData
  const tdPrice = await fetchTwelveDataPrice(asset);
  if (tdPrice !== null) {
    updateSourceStatus(asset, 'TWELVEDATA', tdPrice);
    return { price: tdPrice, source: 'TWELVEDATA', latency: Date.now() - start };
  }

  // 5. Fallback
  const fallbackPrice = state.status.lastPrice[asset] || state.priceCache[asset]?.price || ASSET_CONFIGS[asset]?.basePrice || 0;
  return { price: fallbackPrice, source: 'FALLBACK', latency: Date.now() - start };
}

// ─── Engine Status with Auto-Health-Check ─────────────────────────────────────
//
// KEY FIX: On Vercel serverless, each cold start resets module state.
// To prevent showing "OFFLINE" on first load, we perform a quick health check
// if the cached state is stale (> 60s old). This ensures the dashboard always
// shows accurate connectivity status.

export async function getEngineStatus(): Promise<MarketEngineStatus> {
  const state = getCachedState();
  const now = Date.now();

  // If health check is stale, trigger a new one
  if (now - state.lastHealthCheckTime > HEALTH_CHECK_TTL) {
    // If a health check is already in progress, wait for it
    if (state.healthCheckPromise) {
      await state.healthCheckPromise;
    } else {
      // Start a new health check
      state.healthCheckPromise = performHealthCheck().finally(() => {
        state.healthCheckPromise = null;
      });
      await state.healthCheckPromise;
    }
  }

  return { ...state.status };
}

async function performHealthCheck(): Promise<void> {
  const state = getCachedState();
  const now = Date.now();

  // Run all health checks in parallel for speed
  const [coinGecko, frankfurter, binance, twelveData] = await Promise.all([
    checkCoinGeckoHealth(),
    checkFrankfurterHealth(),
    checkBinanceHealth(),
    checkTwelveDataHealth(),
  ]);

  state.status.coinGeckoAvailable = coinGecko.ok;
  state.status.frankfurterAvailable = frankfurter.ok;
  state.status.binanceAvailable = binance.ok;
  state.status.twelveDataAvailable = twelveData.ok;
  state.status.lastHealthCheck = new Date().toISOString();
  state.lastHealthCheckTime = now;

  // Determine overall connectivity
  state.status.connected = coinGecko.ok || frankfurter.ok || binance.ok || twelveData.ok;

  // If no sources have been used yet, mark them based on health check
  const assets = Object.keys(ASSET_CONFIGS);
  for (const asset of assets) {
    if (!state.status.sources[asset] || state.status.sources[asset] === 'OFFLINE') {
      const isCrypto = COINGECKO_IDS[asset];
      if (isCrypto && coinGecko.ok) {
        state.status.sources[asset] = 'COINGECKO';
      } else if (!isCrypto && frankfurter.ok) {
        state.status.sources[asset] = 'COINGECKO'; // Using COINGECKO category for free sources
      } else if (binance.ok) {
        state.status.sources[asset] = 'BINANCE';
      } else if (twelveData.ok) {
        state.status.sources[asset] = 'TWELVEDATA';
      } else {
        state.status.sources[asset] = 'OFFLINE';
      }
    }
  }

  // Recalculate data quality
  const sources = Object.values(state.status.sources);
  if (sources.some(s => s === 'COINGECKO' || s === 'BINANCE' || s === 'TWELVEDATA')) {
    state.status.dataQuality = sources.every(s => s === 'COINGECKO' || s === 'BINANCE' || s === 'TWELVEDATA') ? 'HIGH' : 'MEDIUM';
  } else {
    state.status.dataQuality = 'LOW';
  }
}

async function checkCoinGeckoHealth(): Promise<{ ok: boolean; latency: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${COINGECKO_BASE}/ping`, { signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, latency: Date.now() - start };
  } catch {
    return { ok: false, latency: -1 };
  }
}

async function checkFrankfurterHealth(): Promise<{ ok: boolean; latency: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${FRANKFURTER_BASE}/latest?from=EUR&to=USD`, { signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, latency: Date.now() - start };
  } catch {
    return { ok: false, latency: -1 };
  }
}

async function checkBinanceHealth(): Promise<{ ok: boolean; latency: number }> {
  const start = Date.now();
  for (const baseUrl of BINANCE_ENDPOINTS) {
    try {
      const res = await fetch(`${baseUrl}/ping`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return { ok: true, latency: Date.now() - start };
    } catch { continue; }
  }
  return { ok: false, latency: -1 };
}

async function checkTwelveDataHealth(): Promise<{ ok: boolean; latency: number }> {
  const apiKey = getTwelveDataApiKey();
  if (!apiKey) return { ok: false, latency: -1 };
  const start = Date.now();
  try {
    const res = await fetch(
      `${TWELVEDATA_BASE}/time_series?symbol=EUR/USD&interval=1min&outputsize=1&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await res.json();
    return { ok: data.status !== 'error', latency: Date.now() - start };
  } catch {
    return { ok: false, latency: -1 };
  }
}

// Legacy sync version for cases where we already know the state is fresh
export function getEngineStatusSync(): MarketEngineStatus {
  return { ...getCachedState().status };
}

export function getAnalysisMode(asset: string): 'FULL' | 'PARTIAL' | 'FALLBACK' | 'DEMO' {
  const source = getCachedState().status.sources[asset];
  if (source === 'COINGECKO' || source === 'BINANCE' || source === 'TWELVEDATA') return 'FULL';
  if (source === 'FALLBACK') return 'FALLBACK';
  return 'DEMO';
}

// Full health check (explicit call from API endpoint)
export async function checkApiHealth(): Promise<{
  binance: boolean;
  twelveData: boolean;
  coinGecko: boolean;
  frankfurter: boolean;
  latency: { binance: number; twelveData: number; coinGecko: number; frankfurter: number };
}> {
  const [cg, ff, bn, td] = await Promise.all([
    checkCoinGeckoHealth(),
    checkFrankfurterHealth(),
    checkBinanceHealth(),
    checkTwelveDataHealth(),
  ]);

  // Update cached state
  const state = getCachedState();
  state.status.coinGeckoAvailable = cg.ok;
  state.status.frankfurterAvailable = ff.ok;
  state.status.binanceAvailable = bn.ok;
  state.status.twelveDataAvailable = td.ok;
  state.status.lastHealthCheck = new Date().toISOString();
  state.lastHealthCheckTime = Date.now();

  return {
    coinGecko: cg.ok,
    frankfurter: ff.ok,
    binance: bn.ok,
    twelveData: td.ok,
    latency: { coinGecko: cg.latency, frankfurter: ff.latency, binance: bn.latency, twelveData: td.latency },
  };
}

// Get all prices at once for the dashboard
export async function getAllPrices(): Promise<Record<string, { price: number; source: string; latency: number; timestamp: string }>> {
  const assets = Object.keys(ASSET_CONFIGS);
  const results: Record<string, { price: number; source: string; latency: number; timestamp: string }> = {};

  await Promise.all(assets.map(async (asset) => {
    const result = await getLatestPrice(asset);
    results[asset] = { ...result, timestamp: new Date().toISOString() };
  }));

  return results;
}
