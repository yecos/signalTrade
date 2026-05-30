// BROKER CLIENT — Bybit API Integration
// Handles order placement, position management, account queries
// Supports both TESTNET (paper) and MAINNET (live) environments
// Uses HMAC-SHA256 signed requests for authenticated endpoints

import crypto from 'crypto';

// === TYPES ===

export interface BrokerConfig {
  broker: 'BYBIT' | 'BINANCE' | 'PAPER';
  apiKey: string;
  apiSecret: string;
  testnet: boolean; // true = demo/paper, false = real money
}

export interface OrderRequest {
  symbol: string;       // e.g. "BTCUSDT"
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  quantity: number;     // In base currency (BTC, ETH)
  price?: number;       // Required for Limit orders
  stopLoss?: number;
  takeProfit?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PostOnly';
  reduceOnly?: boolean;
  category?: 'linear' | 'inverse' | 'spot';
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  execId?: string;
  fillPrice?: number;
  fillQuantity?: number;
  commission?: number;
  slippage?: number;
  status: 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED' | 'ERROR';
  rejectReason?: string;
  raw?: any;
}

export interface PositionInfo {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnl: number;
  leverage: number;
  positionValue: number;
}

export interface AccountInfo {
  balance: number;
  equity: number;
  unrealizedPnl: number;
  availableBalance: number;
  totalWalletBalance: number;
}

export interface TickerInfo {
  symbol: string;
  lastPrice: number;
  bid: number;
  ask: number;
  spread: number;
  volume24h: number;
  fundingRate?: number;
}

// === SYMBOL MAPPING ===
// Converts our internal asset names to broker symbol format

export function assetToSymbol(asset: string): string {
  const map: Record<string, string> = {
    'BTC/USD': 'BTCUSDT',
    'ETH/USD': 'ETHUSDT',
    'BTC/USDT': 'BTCUSDT',
    'ETH/USDT': 'ETHUSDT',
    'EUR/USD': 'EURUSDT',  // Not available on Bybit, fallback to paper
    'GBP/USD': 'GBPUSDT',  // Not available on Bybit, fallback to paper
    'USD/JPY': 'USDJPY',   // Not available on Bybit, fallback to paper
  };
  return map[asset] || asset.replace('/', '');
}

export function isCryptoAsset(asset: string): boolean {
  return asset.includes('BTC') || asset.includes('ETH');
}

// === BYBIT API CLIENT ===

export class BybitClient {
  private config: BrokerConfig;
  private baseUrl: string;
  private recvWindow = 5000;

  constructor(config: BrokerConfig) {
    this.config = config;
    // Testnet = Bybit demo trading, Mainnet = real money
    this.baseUrl = config.testnet
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com';
  }

  // === AUTHENTICATION ===

  private sign(params: Record<string, string | number>, method: 'GET' | 'POST' = 'GET'): {
    apiKey: string; timestamp: string; sign: string; recvWindow: string;
  } {
    const timestamp = Date.now().toString();
    let paramStr: string;

    if (method === 'GET') {
      // GET: timestamp + apiKey + recvWindow + queryString
      const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
      paramStr = timestamp + this.config.apiKey + this.recvWindow + queryString;
    } else {
      // POST: timestamp + apiKey + recvWindow + JSON body string
      const bodyStr = JSON.stringify(params);
      paramStr = timestamp + this.config.apiKey + this.recvWindow + bodyStr;
    }

    const sign = crypto.createHmac('sha256', this.config.apiSecret).update(paramStr).digest('hex');

    return {
      apiKey: this.config.apiKey,
      timestamp,
      sign,
      recvWindow: this.recvWindow.toString(),
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number | boolean> = {},
    signed = false
  ): Promise<any> {
    // Filter out undefined/null values
    const cleanParams: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        cleanParams[k] = v;
      }
    }

    // Build query string for GET requests
    const queryString = Object.entries(cleanParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (signed) {
      const auth = this.sign(cleanParams, method);
      headers['X-BAPI-API-KEY'] = auth.apiKey;
      headers['X-BAPI-TIMESTAMP'] = auth.timestamp;
      headers['X-BAPI-SIGN'] = auth.sign;
      headers['X-BAPI-RECV-WINDOW'] = auth.recvWindow;
    }

    // ═══ Retry logic with timeout ═══
    const MAX_RETRIES = 2; // Reduced from 3 — fail fast on persistent errors
    const TIMEOUT_MS = 8000; // 8 second timeout (was 15s — too slow for cycles)
    const isTransientError = (err: any) => {
      const msg = (err.message || '').toLowerCase();
      return msg.includes('fetch failed') || msg.includes('econnreset') ||
             msg.includes('etimedout') || msg.includes('abort') ||
             msg.includes('network') || msg.includes('socket hang up') ||
             msg.includes('enotfound') || msg.includes('connrefused');
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        let url: string;
        let body: string | undefined;

        if (method === 'GET') {
          url = queryString
            ? `${this.baseUrl}${path}?${queryString}`
            : `${this.baseUrl}${path}`;
        } else {
          url = `${this.baseUrl}${path}`;
          body = JSON.stringify(cleanParams);
        }

        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        const text = await response.text();
        if (!text) {
          return { success: false, retCode: -1, retMsg: 'Empty response from server' };
        }

        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          return { success: false, retCode: -1, retMsg: `Invalid JSON response: ${text.substring(0, 100)}` };
        }

        if (data.retCode !== 0) {
          // Don't retry API parameter errors — they'll fail the same way every time
          const isParamError = (data.retMsg || '').includes('params error') || data.retCode === 10001;
          if (isParamError) {
            console.error(`[BYBIT] API Param Error: ${data.retCode} - ${data.retMsg}`, cleanParams);
            return { success: false, retCode: data.retCode, retMsg: data.retMsg };
          }
          console.error(`[BYBIT] API Error: ${data.retCode} - ${data.retMsg}`, cleanParams);
          return { success: false, retCode: data.retCode, retMsg: data.retMsg };
        }

        return { success: true, ...data };
      } catch (err: any) {
        const isTransient = isTransientError(err);
        if (isTransient && attempt < MAX_RETRIES) {
          const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
          console.warn(`[BYBIT] Request failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message} — retrying in ${Math.round(delay)}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.error(`[BYBIT] Request failed (final): ${err.message}`);
        return { success: false, retCode: -1, retMsg: err.message };
      }
    }

    return { success: false, retCode: -1, retMsg: 'Max retries exceeded' };
  }

  // === MARKET DATA ===

  async getTicker(symbol: string, category: string = 'linear'): Promise<TickerInfo | null> {
    // Try linear first (perpetual futures), then spot as fallback
    for (const cat of [category, 'linear', 'spot']) {
      const result = await this.request('GET', '/v5/market/tickers', {
        category: cat,
        symbol,
      });

      if (result.success && result.result?.list?.[0]) {
        const t = result.result.list[0];
        return {
          symbol: t.symbol,
          lastPrice: parseFloat(t.lastPrice),
          bid: parseFloat(t.bid1Price),
          ask: parseFloat(t.ask1Price),
          spread: parseFloat(t.ask1Price) - parseFloat(t.bid1Price),
          volume24h: parseFloat(t.volume24h),
          fundingRate: parseFloat(t.fundingRate || '0'),
        };
      }
    }

    return null;
  }

  async getLastPrice(symbol: string): Promise<number | null> {
    const ticker = await this.getTicker(symbol);
    return ticker?.lastPrice || null;
  }

  // === ACCOUNT ===

  async getAccountInfo(): Promise<AccountInfo | null> {
    const result = await this.request('GET', '/v5/account/wallet-balance', {
      accountType: 'UNIFIED',
    }, true);

    if (!result.success || !result.result?.list?.[0]) return null;

    const account = result.result.list[0];
    return {
      balance: parseFloat(account.totalAvailableBalance || '0'),
      equity: parseFloat(account.totalEquity || '0'),
      unrealizedPnl: parseFloat(account.totalUnrealisedPnl || '0'),
      availableBalance: parseFloat(account.totalAvailableBalance || '0'),
      totalWalletBalance: parseFloat(account.totalWalletBalance || '0'),
    };
  }

  // === TRADING ===

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const params: Record<string, string | number | boolean> = {
      category: order.category || 'linear',
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      qty: order.quantity.toString(),
    };

    if (order.price && order.orderType === 'Limit') {
      params.price = order.price.toString();
    }

    if (order.stopLoss) {
      params.stopLoss = order.stopLoss.toString();
    }

    if (order.takeProfit) {
      params.takeProfit = order.takeProfit.toString();
    }

    if (order.timeInForce) {
      params.timeInForce = order.timeInForce;
    }

    if (order.reduceOnly) {
      params.reduceOnly = true;
    }

    const result = await this.request('POST', '/v5/order/create', params, true);

    if (!result.success) {
      return {
        success: false,
        status: 'REJECTED',
        rejectReason: result.retMsg || 'Unknown error',
        raw: result,
      };
    }

    return {
      success: true,
      orderId: result.result?.orderId,
      status: 'PENDING',
      raw: result,
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    const result = await this.request('POST', '/v5/order/cancel', {
      category: 'linear',
      symbol,
      orderId,
    }, true);

    return result.success;
  }

  async getOrderHistory(symbol: string, limit = 10): Promise<any[]> {
    const result = await this.request('GET', '/v5/order/history', {
      category: 'linear',
      symbol,
      limit,
    }, true);

    return result.success ? (result.result?.list || []) : [];
  }

  // === POSITIONS ===

  async getPositions(symbol?: string): Promise<PositionInfo[]> {
    const params: Record<string, string | number> = {
      category: 'linear',
    };
    if (symbol) params.symbol = symbol;

    const result = await this.request('GET', '/v5/position/list', params, true);

    if (!result.success) return [];

    return (result.result?.list || [])
      .filter((p: any) => parseFloat(p.size) > 0)
      .map((p: any) => ({
        symbol: p.symbol,
        side: p.side,
        size: parseFloat(p.size),
        entryPrice: parseFloat(p.avgPrice),
        stopLoss: p.stopLoss ? parseFloat(p.stopLoss) : undefined,
        takeProfit: p.takeProfit ? parseFloat(p.takeProfit) : undefined,
        unrealizedPnl: parseFloat(p.unrealisedPnl),
        leverage: parseFloat(p.leverage),
        positionValue: parseFloat(p.positionValue),
      }));
  }

  async closePosition(symbol: string, side: 'Buy' | 'Sell', quantity: number): Promise<OrderResult> {
    return this.placeOrder({
      symbol,
      side: side === 'Buy' ? 'Sell' : 'Buy',
      orderType: 'Market',
      quantity,
      category: 'linear',
      reduceOnly: true,
    });
  }

  async setStopLoss(symbol: string, stopLoss: number, takeProfit?: number): Promise<boolean> {
    const params: Record<string, string | number> = {
      category: 'linear',
      symbol,
      stopLoss: stopLoss.toString(),
      slTriggerBy: 'LastPrice',
    };

    if (takeProfit) {
      params.takeProfit = takeProfit.toString();
      params.tpTriggerBy = 'LastPrice';
    }

    const result = await this.request('POST', '/v5/position/trading-stop', params, true);
    return result.success;
  }

  // === LEVERAGE ===

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    const result = await this.request('POST', '/v5/position/set-leverage', {
      category: 'linear',
      symbol,
      buyLeverage: leverage.toString(),
      sellLeverage: leverage.toString(),
    }, true);

    return result.success;
  }

  // === ADVANCED MARKET DATA (Public, no auth required) ===

  // Get order book depth (L2)
  async getOrderBook(symbol: string, limit: number = 25): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
    timestamp: number;
  } | null> {
    const result = await this.request('GET', '/v5/market/orderbook', {
      category: 'linear',
      symbol,
      limit: limit.toString(),
    });
    if (!result.success || !result.result) return null;
    return {
      bids: (result.result.b || []).map((b: string[]) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })),
      asks: (result.result.a || []).map((a: string[]) => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })),
      timestamp: result.result.ts,
    };
  }

  // Get Open Interest
  async getOpenInterest(symbol: string, interval: '5m' | '1h' | '1d' = '1h', limit: number = 30): Promise<Array<{
    timestamp: string;
    openInterest: number;
  }>> {
    const result = await this.request('GET', '/v5/market/open-interest', {
      category: 'linear',
      symbol,
      interval,
      intervalTime: interval,  // Required by recent Bybit API update
      limit: limit.toString(),
    });
    if (!result.success || !result.result?.list) return [];
    return result.result.list.map((item: any) => ({
      timestamp: item.timestamp,
      openInterest: parseFloat(item.openInterest),
    }));
  }

  // Get funding rate history
  async getFundingHistory(symbol: string, limit: number = 30): Promise<Array<{
    fundingRate: number;
    fundingRateTimestamp: string;
  }>> {
    const result = await this.request('GET', '/v5/market/funding/history', {
      category: 'linear',
      symbol,
      limit: limit.toString(),
    });
    if (!result.success || !result.result?.list) return [];
    return result.result.list.map((item: any) => ({
      fundingRate: parseFloat(item.fundingRate),
      fundingRateTimestamp: item.fundingRateTimestamp,
    }));
  }

  // Get klines (candles) from Bybit
  async getKlines(symbol: string, interval: string = '5', limit: number = 200): Promise<Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>> {
    // Bybit V5 requires both 'interval' and 'intervalTime' parameters
    // interval = the timeframe string (e.g. '5', '60', '240')
    // intervalTime = must match interval for linear perpetual
    const result = await this.request('GET', '/v5/market/kline', {
      category: 'linear',
      symbol,
      interval,
      intervalTime: interval,  // Required by recent Bybit API update
      limit: limit.toString(),
    });
    if (!result.success || !result.result?.list) return [];
    return result.result.list.map((k: string[]) => ({
      timestamp: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  // Get recent trades
  async getRecentTrades(symbol: string, limit: number = 50): Promise<Array<{
    price: number;
    size: number;
    side: string;
    time: string;
  }>> {
    const result = await this.request('GET', '/v5/market/recent-trade', {
      category: 'linear',
      symbol,
      limit: limit.toString(),
    });
    if (!result.success || !result.result?.list) return [];
    return result.result.list.map((t: any) => ({
      price: parseFloat(t.price),
      size: parseFloat(t.size),
      side: t.side,
      time: t.time,
    }));
  }

  // Get instrument specifications (tick size, lot size, leverage)
  async getInstruments(symbol?: string): Promise<Array<{
    symbol: string;
    baseCoin: string;
    quoteCoin: string;
    minOrderQty: number;
    maxOrderQty: number;
    qtyStep: number;
    tickSize: number;
    maxLeverage: number;
  }>> {
    const params: Record<string, string | number> = { category: 'linear' };
    if (symbol) params.symbol = symbol;
    const result = await this.request('GET', '/v5/market/instruments-info', params);
    if (!result.success || !result.result?.list) return [];
    return result.result.list.map((i: any) => ({
      symbol: i.symbol,
      baseCoin: i.baseCoin,
      quoteCoin: i.quoteCoin,
      minOrderQty: parseFloat(i.lotSizeFilter?.minimumOrderQty || '0'),
      maxOrderQty: parseFloat(i.lotSizeFilter?.maximumOrderQty || '0'),
      qtyStep: parseFloat(i.lotSizeFilter?.qtyStep || '0.001'),
      tickSize: parseFloat(i.priceFilter?.tickSize || '0.01'),
      maxLeverage: parseFloat(i.leverageFilter?.maxLeverage || '1'),
    }));
  }

  // === HEALTH CHECK ===

  async checkConnection(): Promise<{ ok: boolean; latency: number; serverTime?: number }> {
    const start = Date.now();
    try {
      const result = await this.request('GET', '/v5/market/time');
      return {
        ok: result.success,
        latency: Date.now() - start,
        serverTime: result.result?.timeSecond,
      };
    } catch {
      return { ok: false, latency: Date.now() - start };
    }
  }
}

// === PAPER TRADING CLIENT ===
// Simulates broker operations without real API calls
// Uses market-engine prices for realistic fills with simulated slippage

export class PaperTradingClient {
  private balance: number;
  private equity: number;
  private positions: Map<string, PositionInfo> = new Map();

  constructor(initialBalance = 10000) {
    this.balance = initialBalance;
    this.equity = initialBalance;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    return {
      balance: this.balance,
      equity: this.equity,
      unrealizedPnl: this.equity - this.balance,
      availableBalance: this.balance,
      totalWalletBalance: this.equity,
    };
  }

  async placeOrder(order: OrderRequest, currentPrice?: number): Promise<OrderResult> {
    const fillPrice = currentPrice || order.price || 0;
    if (fillPrice === 0) {
      return {
        success: false,
        status: 'REJECTED',
        rejectReason: 'No price available for fill',
      };
    }

    // Simulate slippage: 0.01-0.05% random
    const slippagePct = (Math.random() * 0.04 + 0.01) / 100;
    const slipMultiplier = order.side === 'Buy' ? 1 + slippagePct : 1 - slippagePct;
    const actualFillPrice = fillPrice * slipMultiplier;
    const commission = order.quantity * actualFillPrice * 0.0006; // 0.06% taker fee

    this.balance -= commission;

    // Track position
    this.positions.set(order.symbol, {
      symbol: order.symbol,
      side: order.side,
      size: order.quantity,
      entryPrice: actualFillPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      unrealizedPnl: 0,
      leverage: 1,
      positionValue: order.quantity * actualFillPrice,
    });

    return {
      success: true,
      orderId: `PAPER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fillPrice: actualFillPrice,
      fillQuantity: order.quantity,
      commission,
      slippage: Math.abs(actualFillPrice - fillPrice),
      status: 'FILLED',
    };
  }

  async closePosition(symbol: string, currentPrice: number): Promise<OrderResult> {
    const pos = this.positions.get(symbol);
    if (!pos) {
      return { success: false, status: 'REJECTED', rejectReason: 'No position found' };
    }

    const slippagePct = (Math.random() * 0.04 + 0.01) / 100;
    const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
    const slipMultiplier = closeSide === 'Buy' ? 1 + slippagePct : 1 - slippagePct;
    const actualFillPrice = currentPrice * slipMultiplier;
    const commission = pos.size * actualFillPrice * 0.0006;

    const rawPnl = closeSide === 'Sell'
      ? (actualFillPrice - pos.entryPrice) * pos.size
      : (pos.entryPrice - actualFillPrice) * pos.size;
    const realizedPnl = rawPnl - commission;

    this.balance += realizedPnl;
    this.equity = this.balance;
    this.positions.delete(symbol);

    return {
      success: true,
      orderId: `PAPER-CLOSE-${Date.now()}`,
      fillPrice: actualFillPrice,
      fillQuantity: pos.size,
      commission,
      slippage: Math.abs(actualFillPrice - currentPrice),
      status: 'FILLED',
    };
  }

  async getPositions(): Promise<PositionInfo[]> {
    return Array.from(this.positions.values());
  }

  async updateMarkPrice(symbol: string, price: number): Promise<void> {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    pos.unrealizedPnl = pos.side === 'Buy'
      ? (price - pos.entryPrice) * pos.size
      : (pos.entryPrice - price) * pos.size;

    this.equity = this.balance + Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.unrealizedPnl, 0);
  }

  async getLastPrice(symbol: string): Promise<number | null> {
    // For paper trading, fetch real price from Binance public API (no auth needed)
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
      const data = await fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
      return parseFloat(data.price);
    } catch {
      return null;
    }
  }

  async getTicker(symbol: string): Promise<TickerInfo | null> {
    try {
      const url = `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`;
      const data = await fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
      const bid = parseFloat(data.bidPrice);
      const ask = parseFloat(data.askPrice);
      return {
        symbol,
        lastPrice: (bid + ask) / 2,
        bid,
        ask,
        spread: ask - bid,
        volume24h: 0,
      };
    } catch {
      return null;
    }
  }

  async checkConnection(): Promise<{ ok: boolean; latency: number }> {
    return { ok: true, latency: 1 }; // Paper trading always "connected"
  }
}

// === BROKER FACTORY ===

export function createBrokerClient(config?: BrokerConfig): BybitClient | PaperTradingClient {
  // If no config or no API keys, use paper trading
  if (!config || !config.apiKey || !config.apiSecret) {
    console.log('[BROKER] No API keys provided — using Paper Trading client');
    return new PaperTradingClient();
  }

  // If PAPER broker type, use paper trading
  if (config.broker === 'PAPER') {
    console.log('[BROKER] Paper Trading mode selected');
    return new PaperTradingClient();
  }

  // Create Bybit client (testnet or mainnet)
  console.log(`[BROKER] ${config.testnet ? 'TESTNET' : 'MAINNET'} Bybit client created`);
  return new BybitClient(config);
}

// Export singleton getter that reads from env OR DB Account table
let _brokerClient: BybitClient | PaperTradingClient | null = null;

export function getBrokerClient(): BybitClient | PaperTradingClient {
  if (!_brokerClient) {
    _brokerClient = createBrokerClient({
      broker: (process.env.BROKER_TYPE as any) || 'PAPER',
      apiKey: process.env.BYBIT_API_KEY || '',
      apiSecret: process.env.BYBIT_API_SECRET || '',
      testnet: process.env.BYBIT_TESTNET !== 'false', // Default to testnet for safety
    });
  }
  return _brokerClient;
}

// Create broker client from DB-stored credentials
// This is the preferred method — reads API keys from the Account table
export async function getBrokerClientFromDB(): Promise<BybitClient | PaperTradingClient> {
  try {
    const { db } = await import('./db');
    const account = await db.account.findFirst({ where: { isActive: true } });

    if (account && account.apiKey && account.apiSecret && account.broker === 'BYBIT') {
      const testnet = !account.isLive; // isLive=false means testnet
      console.log(`[BROKER] Using DB-stored Bybit ${testnet ? 'TESTNET' : 'MAINNET'} credentials`);
      return new BybitClient({
        broker: 'BYBIT',
        apiKey: account.apiKey,
        apiSecret: account.apiSecret,
        testnet,
      });
    }
  } catch (err: any) {
    console.warn(`[BROKER] Could not read DB credentials: ${err.message}`);
  }

  // Fallback to env vars
  return getBrokerClient();
}

export function resetBrokerClient(): void {
  _brokerClient = null;
}
