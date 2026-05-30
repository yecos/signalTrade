// FUNDING RATE ARBITRAGE — Estrategia de arbitraje de funding rate
// ═══════════════════════════════════════════════════════════════════════════
// CONCEPTO:
//   Cobrar el funding rate de Bybit manteniendo posición delta-neutral.
//   - Funding > 0: SHORT perpetual + LONG spot → cobras funding de longs
//   - Funding < 0: LONG perpetual + SHORT spot → cobras funding de shorts
//   - Ganancia: 0.01-0.1% cada 8 horas (10-100% anualizable)
//   - Riesgo: Movimiento de base entre spot y perpetual
//
// EDGE: Estructural del mercado — traders apalancados pagan prima a holders.
//       No depende de predecir dirección del precio.
//
// Bybit funding rate:
//   - Se cobra cada 8 horas (00:00, 08:00, 16:00 UTC)
//   - Positive funding = longs pay shorts
//   - Negative funding = shorts pay longs
//   - Typical range: -0.1% to +0.3% per 8h
//   - Extreme: up to ±1% during volatility
// ═══════════════════════════════════════════════════════════════════════════

import { db, withRetry } from './db';
import { BybitClient, getBrokerClientFromDB, assetToSymbol, type BrokerConfig } from './broker-client';

// === TYPES ===

export interface FundingArbConfig {
  enabled: boolean;
  minFundingRatePct: number;     // Minimum funding rate to enter (default: 0.01% = 0.0001)
  maxPositionSizeUsd: number;   // Max USD per position (default: 1000)
  maxTotalExposureUsd: number;  // Max total USD across all arb positions (default: 5000)
  exitThresholdPct: number;     // Exit when funding drops below this (default: 0.005% = 0.00005)
  maxBaseRiskPct: number;       // Max base (spot-perp) divergence before exit (default: 0.5%)
  autoCompound: boolean;        // Reinvest profits (default: true)
  assets: string[];             // Assets to monitor (default: ['BTC/USD', 'ETH/USD'])
}

export interface FundingArbPosition {
  id: string;
  asset: string;
  direction: 'SHORT_PERP_LONG_SPOT' | 'LONG_PERP_SHORT_SPOT';
  perpSide: 'Buy' | 'Sell';
  spotSide: 'Buy' | 'Sell';
  perpEntryPrice: number;
  spotEntryPrice: number;
  perpQuantity: number;
  spotQuantity: number;
  initialBasisPct: number;       // Spot-Perp basis at entry (%)
  entryFundingRate: number;      // Funding rate at entry
  currentFundingRate: number;    // Latest funding rate
  totalFundingCollected: number; // Total funding collected in USD
  fundingEventsCollected: number; // Number of funding events collected
  unrealizedPnl: number;        // P&L from basis change + funding
  basisPnl: number;             // P&L from spot-perp basis change
  status: 'OPEN' | 'CLOSING' | 'CLOSED';
  openedAt: Date;
  closedAt?: Date;
  closeReason?: string;
}

export interface FundingArbScanResult {
  asset: string;
  currentFundingRate: number;
  fundingRateAnnualized: number;
  avgFunding8h: number;          // Average of last 3 funding periods
  fundingTrend: 'RISING' | 'STABLE' | 'DECLINING';
  spotPrice: number;
  perpPrice: number;
  basisPct: number;              // Spot-Perp basis %
  recommendation: 'ENTER' | 'HOLD' | 'EXIT' | 'SKIP';
  reason: string;
  expectedProfit8h: number;      // Expected profit per 8h in USD (per $1000)
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface FundingArbStats {
  totalPositionsOpened: number;
  totalPositionsClosed: number;
  totalFundingCollected: number;
  totalBasisPnl: number;
  totalPnl: number;
  avgFundingCollectedPerPosition: number;
  avgHoldingPeriodHours: number;
  winRate: number;               // % of positions that were profitable
  annualizedReturn: number;      // Estimated annual return on capital
}

// === DEFAULT CONFIG ===

export const DEFAULT_FUNDING_ARB_CONFIG: FundingArbConfig = {
  enabled: false,
  minFundingRatePct: 0.01,       // 0.01% minimum funding to enter
  maxPositionSizeUsd: 1000,
  maxTotalExposureUsd: 5000,
  exitThresholdPct: 0.005,       // Exit when funding < 0.005%
  maxBaseRiskPct: 0.5,           // Exit if basis > 0.5%
  autoCompound: true,
  assets: ['BTC/USD', 'ETH/USD'],
};

// === IN-MEMORY STATE ===

let activePositions: Map<string, FundingArbPosition> = new Map();
let arbStats: FundingArbStats = {
  totalPositionsOpened: 0,
  totalPositionsClosed: 0,
  totalFundingCollected: 0,
  totalBasisPnl: 0,
  totalPnl: 0,
  avgFundingCollectedPerPosition: 0,
  avgHoldingPeriodHours: 0,
  winRate: 0,
  annualizedReturn: 0,
};

// === GET BYBIT CLIENT ===

async function getBybitClient(): Promise<BybitClient> {
  const broker = await getBrokerClientFromDB();
  if (broker instanceof BybitClient) return broker;
  // Fallback: public client for scanning
  return new BybitClient({
    broker: 'BYBIT',
    apiKey: process.env.BYBIT_API_KEY || 'public',
    apiSecret: process.env.BYBIT_API_SECRET || 'public',
    testnet: process.env.BYBIT_TESTNET !== 'false',
  });
}

// === SCAN FUNDING RATES ===
// Check all configured assets for funding rate arbitrage opportunities

export async function scanFundingOpportunities(config?: Partial<FundingArbConfig>): Promise<FundingArbScanResult[]> {
  const cfg = { ...DEFAULT_FUNDING_ARB_CONFIG, ...config };
  const client = await getBybitClient();
  const results: FundingArbScanResult[] = [];

  for (const asset of cfg.assets) {
    try {
      const symbol = assetToSymbol(asset);
      const spotSymbol = asset.replace('/', 'USDT'); // e.g., BTCUSDT for spot

      // Fetch current ticker (has funding rate)
      const ticker = await client.getTicker(symbol, 'linear');
      if (!ticker) continue;

      // Fetch funding history for trend analysis
      const fundingHistory = await client.getFundingHistory(symbol, 10);

      // Fetch spot price
      const spotTicker = await client.getTicker(spotSymbol, 'spot');
      const spotPrice = spotTicker?.lastPrice || ticker.lastPrice; // Fallback to perp price
      const perpPrice = ticker.lastPrice;

      // Calculate basis (spot - perp difference)
      const basisPct = perpPrice > 0 ? ((spotPrice - perpPrice) / perpPrice) * 100 : 0;

      // Analyze funding trend
      const currentFunding = ticker.fundingRate || 0;
      const avgFunding8h = fundingHistory.length > 0
        ? fundingHistory.slice(0, 3).reduce((s, f) => s + f.fundingRate, 0) / Math.min(fundingHistory.length, 3)
        : currentFunding;

      // Funding trend: compare current to 3-period average
      let fundingTrend: 'RISING' | 'STABLE' | 'DECLINING' = 'STABLE';
      if (fundingHistory.length >= 6) {
        const recentAvg = fundingHistory.slice(0, 3).reduce((s, f) => s + f.fundingRate, 0) / 3;
        const olderAvg = fundingHistory.slice(3, 6).reduce((s, f) => s + f.fundingRate, 0) / 3;
        if (recentAvg > olderAvg * 1.3) fundingTrend = 'RISING';
        else if (recentAvg < olderAvg * 0.7) fundingTrend = 'DECLINING';
      }

      // Annualized funding rate (3 payments per day × 365 days)
      const fundingRateAnnualized = Math.abs(currentFunding) * 3 * 365 * 100;

      // Determine recommendation
      const absFundingPct = Math.abs(currentFunding) * 100;
      let recommendation: 'ENTER' | 'HOLD' | 'EXIT' | 'SKIP' = 'SKIP';
      let reason = '';
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';

      // Check if we already have a position for this asset
      const existingPos = activePositions.get(asset);

      if (existingPos && existingPos.status === 'OPEN') {
        // We have an open position — check if we should hold or exit
        if (Math.abs(currentFunding) * 100 < cfg.exitThresholdPct) {
          recommendation = 'EXIT';
          reason = `Funding rate cayo debajo del umbral de salida (${absFundingPct.toFixed(4)}% < ${cfg.exitThresholdPct}%)`;
        } else if (Math.abs(basisPct) > cfg.maxBaseRiskPct) {
          recommendation = 'EXIT';
          reason = `Base spot-perp demasiado grande (${basisPct.toFixed(3)}% > ${cfg.maxBaseRiskPct}%)`;
          riskLevel = 'HIGH';
        } else {
          recommendation = 'HOLD';
          reason = `Mantener posicion: funding ${absFundingPct.toFixed(4)}%, base ${basisPct.toFixed(3)}%`;
        }
      } else if (absFundingPct >= cfg.minFundingRatePct) {
        // No position and funding is above threshold — consider entering
        if (Math.abs(basisPct) > cfg.maxBaseRiskPct) {
          recommendation = 'SKIP';
          reason = `Funding alto (${absFundingPct.toFixed(4)}%) pero base spot-perp demasiado grande (${basisPct.toFixed(3)}%). Riesgo de base alto.`;
          riskLevel = 'HIGH';
        } else {
          recommendation = 'ENTER';
          reason = `Funding ${currentFunding > 0 ? 'positivo' : 'negativo'} (${absFundingPct.toFixed(4)}%), annualizado ~${fundingRateAnnualized.toFixed(1)}%. Base ${basisPct.toFixed(3)}%.`;
          riskLevel = Math.abs(basisPct) > 0.2 ? 'MEDIUM' : 'LOW';
        }
      } else {
        recommendation = 'SKIP';
        reason = `Funding rate demasiado bajo (${absFundingPct.toFixed(4)}% < ${cfg.minFundingRatePct}%). No vale la pena el riesgo de base.`;
      }

      // Expected profit per 8h per $1000
      const expectedProfit8h = Math.abs(currentFunding) * 1000;

      results.push({
        asset,
        currentFundingRate: currentFunding,
        fundingRateAnnualized,
        avgFunding8h,
        fundingTrend,
        spotPrice,
        perpPrice,
        basisPct,
        recommendation,
        reason,
        expectedProfit8h,
        riskLevel,
      });
    } catch (err: any) {
      console.error(`[FUNDING-ARB] Error scanning ${asset}: ${err.message}`);
    }
  }

  return results;
}

// === OPEN FUNDING ARB POSITION ===
// Enter a delta-neutral position: short perp + long spot (or vice versa)

export async function openFundingArbPosition(
  asset: string,
  sizeUsd: number,
  config?: Partial<FundingArbConfig>
): Promise<FundingArbPosition | null> {
  const cfg = { ...DEFAULT_FUNDING_ARB_CONFIG, ...config };
  const client = await getBybitClient();
  const symbol = assetToSymbol(asset);
  const spotSymbol = asset.replace('/', 'USDT');

  try {
    // Get current funding rate
    const ticker = await client.getTicker(symbol, 'linear');
    if (!ticker) {
      console.error(`[FUNDING-ARB] No ticker data for ${asset}`);
      return null;
    }

    const fundingRate = ticker.fundingRate || 0;
    const absFundingPct = Math.abs(fundingRate) * 100;

    // Validate funding rate meets threshold
    if (absFundingPct < cfg.minFundingRatePct) {
      console.warn(`[FUNDING-ARB] Funding rate ${absFundingPct.toFixed(4)}% below threshold ${cfg.minFundingRatePct}%`);
      return null;
    }

    // Determine direction
    // Positive funding = longs pay shorts → SHORT perp, LONG spot
    // Negative funding = shorts pay longs → LONG perp, SHORT spot
    const direction: FundingArbPosition['direction'] = fundingRate > 0
      ? 'SHORT_PERP_LONG_SPOT'
      : 'LONG_PERP_SHORT_SPOT';

    const perpSide: 'Buy' | 'Sell' = direction === 'LONG_PERP_SHORT_SPOT' ? 'Buy' : 'Sell';
    const spotSide: 'Buy' | 'Sell' = direction === 'LONG_PERP_SHORT_SPOT' ? 'Sell' : 'Buy';

    // Calculate quantities
    const perpPrice = ticker.lastPrice;
    const quantity = sizeUsd / perpPrice;

    // Get instrument specs for proper qty rounding
    const instruments = await client.getInstruments(symbol);
    const perpSpec = instruments.length > 0 ? instruments[0] : null;
    const qtyStep = perpSpec?.qtyStep || 0.001;
    const roundedQty = Math.floor(quantity / qtyStep) * qtyStep;

    if (roundedQty < (perpSpec?.minOrderQty || 0.001)) {
      console.error(`[FUNDING-ARB] Quantity too small: ${roundedQty}`);
      return null;
    }

    // Check total exposure
    const currentExposure = Array.from(activePositions.values())
      .filter(p => p.status === 'OPEN')
      .reduce((sum, p) => sum + p.perpQuantity * p.perpEntryPrice, 0);

    if (currentExposure + sizeUsd > cfg.maxTotalExposureUsd) {
      console.warn(`[FUNDING-ARB] Max exposure reached: $${currentExposure} + $${sizeUsd} > $${cfg.maxTotalExposureUsd}`);
      return null;
    }

    // Get spot price for basis tracking
    const spotTicker = await client.getTicker(spotSymbol, 'spot');
    const spotPrice = spotTicker?.lastPrice || perpPrice;
    const initialBasisPct = perpPrice > 0 ? ((spotPrice - perpPrice) / perpPrice) * 100 : 0;

    // Place PERPETUAL order
    console.log(`[FUNDING-ARB] Opening ${direction} for ${asset}: ${perpSide} ${roundedQty} perp @ $${perpPrice}`);
    const perpResult = await client.placeOrder({
      symbol,
      side: perpSide,
      orderType: 'Limit',
      quantity: roundedQty,
      price: perpPrice,
      category: 'linear',
      timeInForce: 'PostOnly', // Maker order for lower fees
    });

    if (!perpResult.success) {
      console.error(`[FUNDING-ARB] Perp order failed: ${perpResult.rejectReason}`);
      return null;
    }

    // Place SPOT order (hedge)
    console.log(`[FUNDING-ARB] Opening spot hedge: ${spotSide} ${roundedQty} spot @ $${spotPrice}`);
    const spotResult = await client.placeOrder({
      symbol: spotSymbol,
      side: spotSide,
      orderType: 'Limit',
      quantity: roundedQty,
      price: spotPrice,
      category: 'spot',
      timeInForce: 'PostOnly',
    });

    if (!spotResult.success) {
      // Rollback: close the perp position
      console.error(`[FUNDING-ARB] Spot order failed, closing perp: ${spotResult.rejectReason}`);
      await client.closePosition(symbol, perpSide, roundedQty);
      return null;
    }

    // Create position record
    const position: FundingArbPosition = {
      id: `FARB-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      asset,
      direction,
      perpSide,
      spotSide,
      perpEntryPrice: perpPrice,
      spotEntryPrice: spotPrice,
      perpQuantity: roundedQty,
      spotQuantity: roundedQty,
      initialBasisPct,
      entryFundingRate: fundingRate,
      currentFundingRate: fundingRate,
      totalFundingCollected: 0,
      fundingEventsCollected: 0,
      unrealizedPnl: 0,
      basisPnl: 0,
      status: 'OPEN',
      openedAt: new Date(),
    };

    activePositions.set(asset, position);
    arbStats.totalPositionsOpened++;

    // Persist to DB
    await persistPosition(position);

    console.log(`[FUNDING-ARB] Position opened: ${position.id} | ${direction} | Funding: ${(fundingRate * 100).toFixed(4)}% | Basis: ${initialBasisPct.toFixed(3)}%`);
    return position;
  } catch (err: any) {
    console.error(`[FUNDING-ARB] Error opening position for ${asset}: ${err.message}`);
    return null;
  }
}

// === CLOSE FUNDING ARB POSITION ===

export async function closeFundingArbPosition(
  asset: string,
  reason: string = 'Manual close'
): Promise<boolean> {
  const position = activePositions.get(asset);
  if (!position || position.status !== 'OPEN') {
    console.warn(`[FUNDING-ARB] No open position for ${asset}`);
    return false;
  }

  const client = await getBybitClient();
  const symbol = assetToSymbol(asset);
  const spotSymbol = asset.replace('/', 'USDT');

  try {
    position.status = 'CLOSING';

    // Close perp position
    const closePerpSide = position.perpSide === 'Buy' ? 'Sell' : 'Buy';
    console.log(`[FUNDING-ARB] Closing perp: ${closePerpSide} ${position.perpQuantity} ${symbol}`);
    await client.closePosition(symbol, position.perpSide, position.perpQuantity);

    // Close spot position
    const closeSpotSide = position.spotSide === 'Buy' ? 'Sell' : 'Buy';
    console.log(`[FUNDING-ARB] Closing spot: ${closeSpotSide} ${position.spotQuantity} ${spotSymbol}`);
    await client.placeOrder({
      symbol: spotSymbol,
      side: closeSpotSide,
      orderType: 'Market',
      quantity: position.spotQuantity,
      category: 'spot',
      reduceOnly: true,
    });

    position.status = 'CLOSED';
    position.closedAt = new Date();
    position.closeReason = reason;

    // Update stats
    arbStats.totalPositionsClosed++;
    arbStats.totalFundingCollected += position.totalFundingCollected;
    arbStats.totalBasisPnl += position.basisPnl;
    arbStats.totalPnl += position.unrealizedPnl;
    if (arbStats.totalPositionsClosed > 0) {
      arbStats.avgFundingCollectedPerPosition = arbStats.totalFundingCollected / arbStats.totalPositionsClosed;
      const profitableCount = Array.from(activePositions.values())
        .filter(p => p.status === 'CLOSED' && p.unrealizedPnl > 0).length;
      arbStats.winRate = (profitableCount / arbStats.totalPositionsClosed) * 100;
    }

    // Persist update
    await persistPosition(position);

    console.log(`[FUNDING-ARB] Position closed: ${position.id} | Reason: ${reason} | P&L: $${position.unrealizedPnl.toFixed(2)} (Funding: $${position.totalFundingCollected.toFixed(2)}, Basis: $${position.basisPnl.toFixed(2)})`);
    return true;
  } catch (err: any) {
    console.error(`[FUNDING-ARB] Error closing position for ${asset}: ${err.message}`);
    position.status = 'OPEN'; // Revert status
    return false;
  }
}

// === MONITOR POSITIONS (called each cycle) ===
// Checks funding rates, updates P&L, collects funding, manages exits

export async function monitorFundingArbPositions(config?: Partial<FundingArbConfig>): Promise<{
  positionsChecked: number;
  fundingCollected: number;
  positionsClosed: number;
  errors: string[];
}> {
  const cfg = { ...DEFAULT_FUNDING_ARB_CONFIG, ...config };
  const client = await getBybitClient();
  let positionsChecked = 0;
  let fundingCollected = 0;
  let positionsClosed = 0;
  const errors: string[] = [];

  for (const [asset, position] of Array.from(activePositions.entries())) {
    if (position.status !== 'OPEN') continue;

    try {
      const symbol = assetToSymbol(asset);
      const spotSymbol = asset.replace('/', 'USDT');

      // Get current prices
      const [perpTicker, spotTicker] = await Promise.all([
        client.getTicker(symbol, 'linear'),
        client.getTicker(spotSymbol, 'spot'),
      ]);

      if (!perpTicker) {
        errors.push(`No ticker for ${asset}`);
        continue;
      }

      const currentPerpPrice = perpTicker.lastPrice;
      const currentSpotPrice = spotTicker?.lastPrice || currentPerpPrice;
      const currentFunding = perpTicker.fundingRate || 0;

      // Update current funding rate
      position.currentFundingRate = currentFunding;

      // Calculate basis P&L
      const currentBasisPct = currentPerpPrice > 0
        ? ((currentSpotPrice - currentPerpPrice) / currentPerpPrice) * 100
        : 0;
      const basisChangePct = currentBasisPct - position.initialBasisPct;

      // Basis P&L: if basis narrowed, short perp + long spot profits
      if (position.direction === 'SHORT_PERP_LONG_SPOT') {
        // Short perp profits when perp drops, long spot profits when spot rises
        // Net P&L from basis change
        position.basisPnl = (basisChangePct / 100) * position.perpQuantity * position.perpEntryPrice;
      } else {
        // Long perp profits when perp rises, short spot profits when spot drops
        position.basisPnl = -(basisChangePct / 100) * position.perpQuantity * position.perpEntryPrice;
      }

      // Check if funding was collected (simplified: estimate based on time elapsed)
      const hoursSinceOpen = (Date.now() - position.openedAt.getTime()) / (1000 * 60 * 60);
      const expectedFundingEvents = Math.floor(hoursSinceOpen / 8);
      if (expectedFundingEvents > position.fundingEventsCollected) {
        // New funding event collected
        const newEvents = expectedFundingEvents - position.fundingEventsCollected;
        const fundingPerEvent = Math.abs(position.entryFundingRate) * position.perpQuantity * position.perpEntryPrice;
        position.totalFundingCollected += fundingPerEvent * newEvents;
        position.fundingEventsCollected = expectedFundingEvents;
        fundingCollected += fundingPerEvent * newEvents;
      }

      // Calculate total unrealized P&L
      position.unrealizedPnl = position.totalFundingCollected + position.basisPnl;

      positionsChecked++;

      // ═══ EXIT CONDITIONS ═══

      // 1. Funding rate dropped below threshold
      if (Math.abs(currentFunding) * 100 < cfg.exitThresholdPct) {
        console.log(`[FUNDING-ARB] Exit: Funding dropped to ${(Math.abs(currentFunding) * 100).toFixed(4)}%`);
        await closeFundingArbPosition(asset, `Funding rate bajo: ${(Math.abs(currentFunding) * 100).toFixed(4)}% < ${cfg.exitThresholdPct}%`);
        positionsClosed++;
        continue;
      }

      // 2. Basis risk too high
      if (Math.abs(currentBasisPct) > cfg.maxBaseRiskPct) {
        console.log(`[FUNDING-ARB] Exit: Basis ${currentBasisPct.toFixed(3)}% exceeds limit ${cfg.maxBaseRiskPct}%`);
        await closeFundingArbPosition(asset, `Base spot-perp demasiado alta: ${currentBasisPct.toFixed(3)}%`);
        positionsClosed++;
        continue;
      }

      // Persist updated position
      await persistPosition(position);
    } catch (err: any) {
      errors.push(`${asset}: ${err.message}`);
    }
  }

  return { positionsChecked, fundingCollected, positionsClosed, errors };
}

// === AUTO-EXECUTE FUNDING ARB (main entry point for worker) ===
// Scans opportunities and opens/closes positions automatically

export async function executeFundingArbCycle(config?: Partial<FundingArbConfig>): Promise<{
  opportunities: FundingArbScanResult[];
  positionsOpened: number;
  positionsClosed: number;
  totalFundingCollected: number;
  errors: string[];
}> {
  const cfg = { ...DEFAULT_FUNDING_ARB_CONFIG, ...config };

  if (!cfg.enabled) {
    return { opportunities: [], positionsOpened: 0, positionsClosed: 0, totalFundingCollected: 0, errors: ['Funding arb disabled'] };
  }

  // 1. Scan for opportunities
  const opportunities = await scanFundingOpportunities(cfg);

  let positionsOpened = 0;
  let positionsClosed = 0;

  // 2. Act on recommendations
  for (const opp of opportunities) {
    if (opp.recommendation === 'ENTER') {
      const position = await openFundingArbPosition(opp.asset, cfg.maxPositionSizeUsd, cfg);
      if (position) positionsOpened++;
    } else if (opp.recommendation === 'EXIT') {
      const closed = await closeFundingArbPosition(opp.asset, opp.reason);
      if (closed) positionsClosed++;
    }
  }

  // 3. Monitor existing positions
  const monitorResult = await monitorFundingArbPositions(cfg);

  return {
    opportunities,
    positionsOpened,
    positionsClosed: positionsClosed + monitorResult.positionsClosed,
    totalFundingCollected: monitorResult.fundingCollected,
    errors: monitorResult.errors,
  };
}

// === GET STATS ===

export function getFundingArbStats(): FundingArbStats {
  return { ...arbStats };
}

// === GET ACTIVE POSITIONS ===

export function getActiveFundingArbPositions(): FundingArbPosition[] {
  return Array.from(activePositions.values()).filter(p => p.status === 'OPEN');
}

// === PERSIST POSITION TO DB ===

async function persistPosition(position: FundingArbPosition): Promise<void> {
  try {
    await withRetry(
      () => db.appSettings.upsert({
        where: { key: `funding_arb_${position.asset.replace('/', '_')}` },
        create: {
          key: `funding_arb_${position.asset.replace('/', '_')}`,
          value: JSON.stringify(position),
          description: `Funding arb position for ${position.asset}`,
        },
        update: { value: JSON.stringify(position) },
      }),
      2, 500, `funding-arb-${position.asset}`
    );
  } catch (err: any) {
    console.error(`[FUNDING-ARB] Failed to persist position: ${err.message}`);
  }
}

// === LOAD POSITIONS FROM DB (on startup) ===

export async function loadFundingArbPositions(): Promise<number> {
  let loaded = 0;
  try {
    const assets = ['BTC_USD', 'ETH_USD'];
    for (const assetKey of assets) {
      const setting = await db.appSettings.findUnique({
        where: { key: `funding_arb_${assetKey}` },
      });
      if (setting) {
        try {
          const position: FundingArbPosition = JSON.parse(setting.value);
          if (position.status === 'OPEN') {
            activePositions.set(position.asset, position);
            loaded++;
          }
        } catch { /* skip invalid JSON */ }
      }
    }
  } catch (err: any) {
    console.error(`[FUNDING-ARB] Failed to load positions: ${err.message}`);
  }
  return loaded;
}
