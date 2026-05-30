// ORDER FLOW / OI CONFIRMATION — Análisis de flujo de órdenes + Open Interest
// ═══════════════════════════════════════════════════════════════════════════
// CONCEPTO:
//   Leer el libro de órdenes y OI de Bybit para detectar presión direccional.
//   - Bid/Ask ratio > 2.0 = presión compradora
//   - Bid/Ask ratio < 0.5 = presión vendedora
//   - OI creciente + volumen alto = confirmación de dirección
//   - OI decreciente + volumen alto = unwinding (posibles reversal)
//   - Absorción: Grandes órdenes en un lado que no mueven precio = acumulación
//
// EDGE: Información asimétrica — ves el libro de órdenes ANTES de que
//       el precio se mueve. Los grandes jugadores dejan huellas.
//
// USO: Como filtro de confirmación para otras estrategias (mean reversion,
//      breakout) o como señal standalone de muy corto plazo.
// ═══════════════════════════════════════════════════════════════════════════

import { BybitClient, getBrokerClientFromDB, assetToSymbol } from './broker-client';
import { db, withRetry } from './db';

// === TYPES ===

export interface OrderFlowConfig {
  enabled: boolean;
  assets: string[];
  orderBookDepth: number;          // Number of levels to fetch (default: 50)
  minBidAskRatio: number;          // Min ratio for strong signal (default: 1.8)
  maxBidAskRatio: number;          // Max ratio for extreme signal (default: 3.0)
  minDepthUsd: number;             // Min total depth for quality signal (default: 50000)
  oiChangeThresholdPct: number;   // OI change % for significant signal (default: 2.0)
  absorptionMinSizeUsd: number;    // Min size for absorption detection (default: 100000)
  signalCooldownMin: number;       // Cooldown between signals (default: 15)
}

export interface OrderBookSnapshot {
  asset: string;
  timestamp: Date;
  bidPrice: number;
  askPrice: number;
  spread: number;
  spreadPct: number;
  // Depth analysis
  totalBidDepth: number;           // Total bid volume (in base currency)
  totalAskDepth: number;           // Total ask volume
  totalBidValueUsd: number;        // Total bid value in USD
  totalAskValueUsd: number;        // Total ask value in USD
  bidAskRatio: number;             // totalBidDepth / totalAskDepth
  // Large orders (whales)
  largestBidOrder: { price: number; size: number; valueUsd: number };
  largestAskOrder: { price: number; size: number; valueUsd: number };
  bidOrdersAbove1kUsd: number;     // Count of bid orders > $1k
  askOrdersAbove1kUsd: number;     // Count of ask orders > $1k
  // Distribution
  bidConcentration: number;        // 0-1: how concentrated bids are near mid
  askConcentration: number;        // 0-1: how concentrated asks are near mid
}

export interface OIAnalysis {
  asset: string;
  timestamp: Date;
  currentOI: number;
  oiChange1h: number;              // % change in last hour
  oiChange4h: number;              // % change in last 4 hours
  oiChange24h: number;             // % change in last 24 hours
  oiTrend: 'RISING' | 'STABLE' | 'DECLINING';
  oiPriceCorrelation: 'ALIGNED' | 'DIVERGENT' | 'NEUTRAL';
  // ALIGNED: OI up + price up = bullish conviction
  // ALIGNED: OI down + price down = bearish conviction
  // DIVERGENT: OI up + price down = short buildup (potential squeeze)
  // DIVERGENT: OI down + price up = short covering (weak rally)
  interpretation: string;
}

export interface OrderFlowSignal {
  asset: string;
  timestamp: Date;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number;                // 0-100
  confidence: number;              // 0-100
  reason: string;
  // Components
  orderBookSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  orderBookStrength: number;
  oiSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  oiStrength: number;
  absorptionDetected: boolean;
  absorptionSide: 'BID' | 'ASK' | 'NONE';
  // Quality
  depthQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  isActionable: boolean;           // Can be used for trade execution
  recommendedAction: 'BUY' | 'SELL' | 'WAIT' | 'AVOID';
}

export interface OrderFlowStats {
  totalSnapshots: number;
  totalSignals: number;
  bullishSignals: number;
  bearishSignals: number;
  absorptionEvents: number;
  avgBidAskRatio: number;
  signalAccuracy: number;          // % of signals that predicted direction correctly
}

// === DEFAULT CONFIG ===

export const DEFAULT_ORDERFLOW_CONFIG: OrderFlowConfig = {
  enabled: false,
  assets: ['BTC/USD', 'ETH/USD'],
  orderBookDepth: 50,
  minBidAskRatio: 1.8,
  maxBidAskRatio: 3.0,
  minDepthUsd: 50000,
  oiChangeThresholdPct: 2.0,
  absorptionMinSizeUsd: 100000,
  signalCooldownMin: 15,
};

// === IN-MEMORY STATE ===

let orderBookHistory: Map<string, OrderBookSnapshot[]> = new Map();
let oiHistory: Map<string, OIAnalysis[]> = new Map();
let signalHistory: Map<string, OrderFlowSignal[]> = new Map();
let lastSignalTime: Map<string, Date> = new Map();
let ofStats: OrderFlowStats = {
  totalSnapshots: 0,
  totalSignals: 0,
  bullishSignals: 0,
  bearishSignals: 0,
  absorptionEvents: 0,
  avgBidAskRatio: 0,
  signalAccuracy: 0,
};

// === GET BYBIT CLIENT ===

async function getBybitClient(): Promise<BybitClient> {
  const broker = await getBrokerClientFromDB();
  if (broker instanceof BybitClient) return broker;
  return new BybitClient({
    broker: 'BYBIT',
    apiKey: process.env.BYBIT_API_KEY || 'public',
    apiSecret: process.env.BYBIT_API_SECRET || 'public',
    testnet: process.env.BYBIT_TESTNET !== 'false',
  });
}

// === SNAPSHOT ORDER BOOK ===

export async function snapshotOrderBook(
  asset: string,
  config?: Partial<OrderFlowConfig>
): Promise<OrderBookSnapshot | null> {
  const cfg = { ...DEFAULT_ORDERFLOW_CONFIG, ...config };
  const client = await getBybitClient();
  const symbol = assetToSymbol(asset);

  try {
    const ob = await client.getOrderBook(symbol, cfg.orderBookDepth);
    if (!ob || ob.bids.length === 0 || ob.asks.length === 0) return null;

    const bidPrice = ob.bids[0].price;
    const askPrice = ob.asks[0].price;
    const spread = askPrice - bidPrice;
    const spreadPct = askPrice > 0 ? (spread / askPrice) * 100 : 0;
    const midPrice = (bidPrice + askPrice) / 2;

    // Calculate depth totals
    const totalBidDepth = ob.bids.reduce((s, b) => s + b.size, 0);
    const totalAskDepth = ob.asks.reduce((s, a) => s + a.size, 0);
    const totalBidValueUsd = ob.bids.reduce((s, b) => s + b.price * b.size, 0);
    const totalAskValueUsd = ob.asks.reduce((s, a) => s + a.price * a.size, 0);
    const bidAskRatio = totalAskDepth > 0 ? totalBidDepth / totalAskDepth : 1;

    // Find largest orders (whale detection)
    const largestBid = ob.bids.reduce((max, b) => b.price * b.size > max.price * max.size ? b : max, ob.bids[0]);
    const largestAsk = ob.asks.reduce((max, a) => a.price * a.size > max.price * max.size ? a : max, ob.asks[0]);

    // Count large orders (> $1k)
    const bidOrdersAbove1k = ob.bids.filter(b => b.price * b.size > 1000).length;
    const askOrdersAbove1k = ob.asks.filter(a => a.price * a.size > 1000).length;

    // Calculate concentration (how much depth is within 0.1% of mid)
    const nearMidRange = midPrice * 0.001; // 0.1%
    const nearMidBids = ob.bids.filter(b => midPrice - b.price < nearMidRange);
    const nearMidAsks = ob.asks.filter(a => a.price - midPrice < nearMidRange);
    const bidConcentration = totalBidDepth > 0
      ? nearMidBids.reduce((s, b) => s + b.size, 0) / totalBidDepth : 0;
    const askConcentration = totalAskDepth > 0
      ? nearMidAsks.reduce((s, a) => s + a.size, 0) / totalAskDepth : 0;

    const snapshot: OrderBookSnapshot = {
      asset,
      timestamp: new Date(),
      bidPrice,
      askPrice,
      spread,
      spreadPct,
      totalBidDepth,
      totalAskDepth,
      totalBidValueUsd,
      totalAskValueUsd,
      bidAskRatio,
      largestBidOrder: { price: largestBid.price, size: largestBid.size, valueUsd: largestBid.price * largestBid.size },
      largestAskOrder: { price: largestAsk.price, size: largestAsk.size, valueUsd: largestAsk.price * largestAsk.size },
      bidOrdersAbove1kUsd: bidOrdersAbove1k,
      askOrdersAbove1kUsd: askOrdersAbove1k,
      bidConcentration,
      askConcentration,
    };

    // Store in history (keep last 20 snapshots)
    if (!orderBookHistory.has(asset)) orderBookHistory.set(asset, []);
    const history = orderBookHistory.get(asset)!;
    history.push(snapshot);
    if (history.length > 20) history.shift();

    ofStats.totalSnapshots++;
    ofStats.avgBidAskRatio = ofStats.avgBidAskRatio * 0.95 + bidAskRatio * 0.05; // EMA

    return snapshot;
  } catch (err: any) {
    console.error(`[ORDERFLOW] Error snapshotting ${asset}: ${err.message}`);
    return null;
  }
}

// === ANALYZE OPEN INTEREST ===

export async function analyzeOI(
  asset: string,
  currentPrice: number,
  config?: Partial<OrderFlowConfig>
): Promise<OIAnalysis | null> {
  const cfg = { ...DEFAULT_ORDERFLOW_CONFIG, ...config };
  const client = await getBybitClient();
  const symbol = assetToSymbol(asset);

  try {
    const oiData = await client.getOpenInterest(symbol, '1h', 30);
    if (oiData.length < 2) return null;

    const currentOI = oiData[0].openInterest;
    const oi1hAgo = oiData.length > 1 ? oiData[1].openInterest : currentOI;
    const oi4hAgo = oiData.length > 4 ? oiData[4].openInterest : oiData[oiData.length - 1].openInterest;
    const oi24hAgo = oiData.length > 24 ? oiData[24].openInterest : oiData[oiData.length - 1].openInterest;

    const oiChange1h = oi1hAgo > 0 ? ((currentOI - oi1hAgo) / oi1hAgo) * 100 : 0;
    const oiChange4h = oi4hAgo > 0 ? ((currentOI - oi4hAgo) / oi4hAgo) * 100 : 0;
    const oiChange24h = oi24hAgo > 0 ? ((currentOI - oi24hAgo) / oi24hAgo) * 100 : 0;

    // OI Trend
    let oiTrend: OIAnalysis['oiTrend'] = 'STABLE';
    if (oiChange4h > cfg.oiChangeThresholdPct) oiTrend = 'RISING';
    else if (oiChange4h < -cfg.oiChangeThresholdPct) oiTrend = 'DECLINING';

    // OI-Price Correlation
    // We'd need price history here; simplified version based on recent changes
    const priceUpEstimate = currentPrice > 0; // Always positive, simplified
    let oiPriceCorrelation: OIAnalysis['oiPriceCorrelation'] = 'NEUTRAL';

    if (oiTrend === 'RISING' && oiChange1h > 0) {
      oiPriceCorrelation = 'ALIGNED'; // OI growing = new positions
    } else if (oiTrend === 'DECLINING' && oiChange1h < 0) {
      oiPriceCorrelation = 'ALIGNED'; // OI shrinking = closing
    } else if (oiTrend === 'RISING' && oiChange1h < -0.5) {
      oiPriceCorrelation = 'DIVERGENT'; // OI up but slowing = potential reversal
    } else if (oiTrend === 'DECLINING' && oiChange1h > 0.5) {
      oiPriceCorrelation = 'DIVERGENT'; // OI down but recovering = potential reversal
    }

    // Interpretation
    let interpretation = '';
    if (oiPriceCorrelation === 'ALIGNED' && oiTrend === 'RISING') {
      interpretation = 'OI creciente confirma conviccion direccional. Nuevo dinero entra al mercado.';
    } else if (oiPriceCorrelation === 'ALIGNED' && oiTrend === 'DECLINING') {
      interpretation = 'OI decreciente indica cierre de posiciones. Posible final de movimiento.';
    } else if (oiPriceCorrelation === 'DIVERGENT' && oiTrend === 'RISING') {
      interpretation = 'OI sube pero momentum frena. Posible acumulacion contraria (squeeze potential).';
    } else if (oiPriceCorrelation === 'DIVERGENT' && oiTrend === 'DECLINING') {
      interpretation = 'OI baja pero momentum recupera. Short covering — rally debil.';
    } else {
      interpretation = 'OI estable sin señal clara de flujo direccional.';
    }

    const analysis: OIAnalysis = {
      asset,
      timestamp: new Date(),
      currentOI,
      oiChange1h,
      oiChange4h,
      oiChange24h,
      oiTrend,
      oiPriceCorrelation,
      interpretation,
    };

    // Store in history
    if (!oiHistory.has(asset)) oiHistory.set(asset, []);
    const history = oiHistory.get(asset)!;
    history.push(analysis);
    if (history.length > 20) history.shift();

    return analysis;
  } catch (err: any) {
    console.error(`[ORDERFLOW] Error analyzing OI for ${asset}: ${err.message}`);
    return null;
  }
}

// === GENERATE ORDER FLOW SIGNAL ===

export async function generateOrderFlowSignal(
  asset: string,
  currentPrice: number,
  config?: Partial<OrderFlowConfig>
): Promise<OrderFlowSignal> {
  const cfg = { ...DEFAULT_ORDERFLOW_CONFIG, ...config };

  const noSignal: OrderFlowSignal = {
    asset,
    timestamp: new Date(),
    direction: 'NEUTRAL',
    strength: 0,
    confidence: 0,
    reason: 'Sin datos de order flow',
    orderBookSignal: 'NEUTRAL',
    orderBookStrength: 0,
    oiSignal: 'NEUTRAL',
    oiStrength: 0,
    absorptionDetected: false,
    absorptionSide: 'NONE',
    depthQuality: 'LOW',
    isActionable: false,
    recommendedAction: 'WAIT',
  };

  // Check cooldown
  const lastTime = lastSignalTime.get(asset);
  if (lastTime && (Date.now() - lastTime.getTime()) < cfg.signalCooldownMin * 60 * 1000) {
    noSignal.reason = `En cooldown (${cfg.signalCooldownMin} min)`;
    return noSignal;
  }

  try {
    // Fetch data in parallel
    const [obSnapshot, oiAnalysis] = await Promise.all([
      snapshotOrderBook(asset, cfg),
      analyzeOI(asset, currentPrice, cfg),
    ]);

    if (!obSnapshot) {
      noSignal.reason = 'No se pudo obtener order book';
      return noSignal;
    }

    const signal: OrderFlowSignal = {
      asset,
      timestamp: new Date(),
      direction: 'NEUTRAL',
      strength: 0,
      confidence: 0,
      reason: '',
      orderBookSignal: 'NEUTRAL',
      orderBookStrength: 0,
      oiSignal: 'NEUTRAL',
      oiStrength: 0,
      absorptionDetected: false,
      absorptionSide: 'NONE',
      depthQuality: 'MEDIUM',
      isActionable: false,
      recommendedAction: 'WAIT',
    };

    // ═══ ORDER BOOK SIGNAL ═══
    const { bidAskRatio, totalBidValueUsd, totalAskValueUsd } = obSnapshot;

    if (bidAskRatio >= cfg.maxBidAskRatio) {
      signal.orderBookSignal = 'BULLISH';
      signal.orderBookStrength = 90;
    } else if (bidAskRatio >= cfg.minBidAskRatio) {
      signal.orderBookSignal = 'BULLISH';
      signal.orderBookStrength = 60;
    } else if (bidAskRatio <= 1 / cfg.maxBidAskRatio) {
      signal.orderBookSignal = 'BEARISH';
      signal.orderBookStrength = 90;
    } else if (bidAskRatio <= 1 / cfg.minBidAskRatio) {
      signal.orderBookSignal = 'BEARISH';
      signal.orderBookStrength = 60;
    }

    // Depth quality
    const totalDepthUsd = totalBidValueUsd + totalAskValueUsd;
    signal.depthQuality = totalDepthUsd > cfg.minDepthUsd * 4 ? 'HIGH'
      : totalDepthUsd > cfg.minDepthUsd ? 'MEDIUM' : 'LOW';

    // ═══ ABSORPTION DETECTION ═══
    // Large order on one side that absorbs market orders without price moving
    if (obSnapshot.largestBidOrder.valueUsd > cfg.absorptionMinSizeUsd && bidAskRatio > 1.5) {
      signal.absorptionDetected = true;
      signal.absorptionSide = 'BID';
      signal.orderBookStrength = Math.min(100, signal.orderBookStrength + 20);
    }
    if (obSnapshot.largestAskOrder.valueUsd > cfg.absorptionMinSizeUsd && bidAskRatio < 0.67) {
      signal.absorptionDetected = true;
      signal.absorptionSide = 'ASK';
      signal.orderBookStrength = Math.min(100, signal.orderBookStrength + 20);
    }

    // ═══ OI SIGNAL ═══
    if (oiAnalysis) {
      if (oiAnalysis.oiPriceCorrelation === 'ALIGNED' && oiAnalysis.oiTrend === 'RISING') {
        signal.oiSignal = 'BULLISH'; // OI rising = conviction
        signal.oiStrength = Math.min(90, Math.abs(oiAnalysis.oiChange4h) * 10);
      } else if (oiAnalysis.oiPriceCorrelation === 'ALIGNED' && oiAnalysis.oiTrend === 'DECLINING') {
        signal.oiSignal = 'NEUTRAL'; // Closing positions = neutral
        signal.oiStrength = 30;
      } else if (oiAnalysis.oiPriceCorrelation === 'DIVERGENT' && oiAnalysis.oiTrend === 'RISING') {
        // Divergence: OI up but price stalling = potential squeeze
        signal.oiSignal = 'BULLISH';
        signal.oiStrength = 70;
      } else if (oiAnalysis.oiPriceCorrelation === 'DIVERGENT' && oiAnalysis.oiTrend === 'DECLINING') {
        signal.oiSignal = 'BEARISH'; // Short covering = weak
        signal.oiStrength = 50;
      }
    }

    // ═══ COMPOSITE SIGNAL ═══
    const bullishSignals = [
      signal.orderBookSignal === 'BULLISH' ? signal.orderBookStrength : 0,
      signal.oiSignal === 'BULLISH' ? signal.oiStrength : 0,
    ].filter(s => s > 0);

    const bearishSignals = [
      signal.orderBookSignal === 'BEARISH' ? signal.orderBookStrength : 0,
      signal.oiSignal === 'BEARISH' ? signal.oiStrength : 0,
    ].filter(s => s > 0);

    const bullishTotal = bullishSignals.reduce((s, v) => s + v, 0);
    const bearishTotal = bearishSignals.reduce((s, v) => s + v, 0);

    if (bullishTotal > bearishTotal + 30) {
      signal.direction = 'BULLISH';
      signal.strength = Math.min(100, bullishTotal);
    } else if (bearishTotal > bullishTotal + 30) {
      signal.direction = 'BEARISH';
      signal.strength = Math.min(100, bearishTotal);
    } else {
      signal.direction = 'NEUTRAL';
      signal.strength = Math.abs(bullishTotal - bearishTotal);
    }

    signal.confidence = signal.strength * (signal.depthQuality === 'HIGH' ? 1 : signal.depthQuality === 'MEDIUM' ? 0.7 : 0.4);

    // Actionability
    signal.isActionable = signal.confidence >= 50 && signal.depthQuality !== 'LOW';

    // Recommended action
    if (signal.isActionable) {
      signal.recommendedAction = signal.direction === 'BULLISH' ? 'BUY' : signal.direction === 'BEARISH' ? 'SELL' : 'WAIT';
    } else {
      signal.recommendedAction = 'WAIT';
    }

    // Build reason
    const parts: string[] = [];
    if (signal.orderBookSignal !== 'NEUTRAL') {
      parts.push(`OB:${signal.orderBookSignal}(${signal.orderBookStrength}) B/A=${bidAskRatio.toFixed(2)}`);
    }
    if (signal.oiSignal !== 'NEUTRAL') {
      parts.push(`OI:${signal.oiSignal}(${signal.oiStrength})`);
    }
    if (signal.absorptionDetected) {
      parts.push(`ABSORPTION:${signal.absorptionSide}`);
    }
    parts.push(`Depth:${signal.depthQuality}`);
    signal.reason = parts.join(' | ');

    // Update stats
    ofStats.totalSignals++;
    if (signal.direction === 'BULLISH') ofStats.bullishSignals++;
    if (signal.direction === 'BEARISH') ofStats.bearishSignals++;
    if (signal.absorptionDetected) ofStats.absorptionEvents++;

    // Store signal
    if (!signalHistory.has(asset)) signalHistory.set(asset, []);
    signalHistory.get(asset)!.push(signal);
    lastSignalTime.set(asset, new Date());

    return signal;
  } catch (err: any) {
    noSignal.reason = `Error: ${err.message}`;
    return noSignal;
  }
}

// === GET ORDER FLOW AS CONFIRMATION FILTER ===
// Use this to confirm/reject signals from other strategies

export async function confirmSignalWithOrderFlow(
  asset: string,
  direction: 'HIGHER' | 'LOWER',
  currentPrice: number,
  config?: Partial<OrderFlowConfig>
): Promise<{
  confirmed: boolean;
  strengthBoost: number;    // ±0-20 confidence boost
  reason: string;
}> {
  const signal = await generateOrderFlowSignal(asset, currentPrice, config);

  if (!signal.isActionable) {
    return {
      confirmed: false,
      strengthBoost: 0,
      reason: `Order flow no accionable: ${signal.reason}`,
    };
  }

  const aligned = (
    (direction === 'HIGHER' && signal.direction === 'BULLISH') ||
    (direction === 'LOWER' && signal.direction === 'BEARISH')
  );

  const opposed = (
    (direction === 'HIGHER' && signal.direction === 'BEARISH') ||
    (direction === 'LOWER' && signal.direction === 'BULLISH')
  );

  if (aligned) {
    return {
      confirmed: true,
      strengthBoost: Math.min(20, signal.strength * 0.2),
      reason: `Order flow confirma ${direction}: ${signal.reason}`,
    };
  } else if (opposed) {
    return {
      confirmed: false,
      strengthBoost: -15,
      reason: `Order flow CONTRADICE ${direction}: ${signal.reason}. NO operar.`,
    };
  } else {
    return {
      confirmed: true, // Neutral doesn't block
      strengthBoost: 0,
      reason: `Order flow neutral: ${signal.reason}`,
    };
  }
}

// === AUTO-EXECUTE ORDER FLOW CYCLE (main entry for worker) ===

export async function executeOrderFlowCycle(config?: Partial<OrderFlowConfig>): Promise<{
  snapshotsTaken: number;
  signalsGenerated: number;
  actionableSignals: number;
  errors: string[];
}> {
  const cfg = { ...DEFAULT_ORDERFLOW_CONFIG, ...config };

  if (!cfg.enabled) {
    return { snapshotsTaken: 0, signalsGenerated: 0, actionableSignals: 0, errors: ['Order flow disabled'] };
  }

  let snapshotsTaken = 0;
  let signalsGenerated = 0;
  let actionableSignals = 0;
  const errors: string[] = [];

  const client = await getBybitClient();

  for (const asset of cfg.assets) {
    try {
      // Get current price
      const symbol = assetToSymbol(asset);
      const ticker = await client.getTicker(symbol, 'linear');
      if (!ticker) {
        errors.push(`No ticker for ${asset}`);
        continue;
      }

      // Take snapshot
      const snapshot = await snapshotOrderBook(asset, cfg);
      if (snapshot) snapshotsTaken++;

      // Generate signal
      const signal = await generateOrderFlowSignal(asset, ticker.lastPrice, cfg);
      signalsGenerated++;
      if (signal.isActionable) actionableSignals++;

      // Persist signal to DB for dashboard
      await withRetry(
        () => db.appSettings.upsert({
          where: { key: `orderflow_${asset.replace('/', '_')}` },
          create: {
            key: `orderflow_${asset.replace('/', '_')}`,
            value: JSON.stringify({ snapshot, signal, timestamp: new Date() }),
            description: `Latest order flow signal for ${asset}`,
          },
          update: { value: JSON.stringify({ snapshot, signal, timestamp: new Date() }) },
        }),
        2, 500, `orderflow-${asset}`
      );
    } catch (err: any) {
      errors.push(`${asset}: ${err.message}`);
    }
  }

  return { snapshotsTaken, signalsGenerated, actionableSignals, errors };
}

// === GET STATS ===

export function getOrderFlowStats(): OrderFlowStats {
  return { ...ofStats };
}

// === GET LATEST SIGNAL ===

export function getLatestSignal(asset: string): OrderFlowSignal | null {
  const history = signalHistory.get(asset);
  return history && history.length > 0 ? history[history.length - 1] : null;
}

// === GET LATEST SNAPSHOT ===

export function getLatestSnapshot(asset: string): OrderBookSnapshot | null {
  const history = orderBookHistory.get(asset);
  return history && history.length > 0 ? history[history.length - 1] : null;
}
