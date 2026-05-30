// MEAN REVERSION — Estrategia de reversión a la media con Bollinger Bands + RSI + ADX
// ═══════════════════════════════════════════════════════════════════════════
// CONCEPTO:
//   Solo operar reversión a la media en regímenes RANGING confirmados.
//   - Entrada LONG: Precio toca BB inferior + RSI < 30 + Estocástico < 20
//   - Entrada SHORT: Precio toca BB superior + RSI > 70 + Estocástico > 80
//   - SOLO cuando ADX < 25 (mercado sin tendencia fuerte)
//   - Confirmación: Volumen > 1.5x promedio (participación real)
//   - Timeframe: 15M o 1H (menos ruido que M5, menos fees)
//   - R:R: 1:1 con WR > 60% (target = BB media)
//   - SL: 1.5x ATR (amplio para no salir por ruido)
//
// EDGE: Los mercados crypto pasan ~70% del tiempo en rango.
//       La reversión a la media es el edge más documentado en mercados no direccionales.
//       Clave: SOLO operar cuando ADX confirma que NO hay tendencia.
// ═══════════════════════════════════════════════════════════════════════════

import { db, withRetry } from './db';
import { BybitClient, PaperTradingClient, getBrokerClientFromDB, assetToSymbol } from './broker-client';
import { computeAllIndicators, type IndicatorSnapshot } from './indicators';
import { getCandles as getDBCandles } from './market-data';
import { detectRegime, type RegimeResult } from './regime-engine';
import { detectSession, type SessionType } from './sessions';
import { getAIAdjustedConfig, recordWalkForwardTrade, loadAIAnalyzerState, type MeanReversionAdjustments } from './ai-market-analyzer';

// === TYPES ===

export interface MeanReversionConfig {
  enabled: boolean;
  assets: string[];
  timeframe: string;                // Trading timeframe (default: 'M15')
  // Entry conditions
  rsiOversold: number;              // RSI oversold threshold (default: 30)
  rsiOverbought: number;            // RSI overbought threshold (default: 70)
  stochOversold: number;            // Stochastic oversold (default: 20)
  stochOverbought: number;          // Stochastic overbought (default: 80)
  adxMaxRange: number;              // ADX must be below this for range (default: 25)
  bbTouchRequired: boolean;         // Price must touch BB band (default: true)
  volumeConfirmMin: number;         // Min relative volume for confirmation (default: 1.2)
  // Exit conditions
  takeProfitTarget: 'BB_MIDDLE' | 'BB_OPPOSITE' | 'FIXED_PCT'; // TP target (default: BB_MIDDLE)
  takeProfitPct: number;            // Fixed TP % if target is FIXED_PCT (default: 0.5)
  stopLossATRMultiplier: number;    // SL = ATR * multiplier (default: 1.5)
  trailingStop: boolean;            // Use trailing stop after entry (default: true)
  trailingATRMultiplier: number;    // Trail = ATR * multiplier (default: 1.0)
  // Risk management
  maxPositionSizeUsd: number;       // Max USD per trade (default: 500)
  maxConcurrentPositions: number;   // Max open positions (default: 3)
  minConfidence: number;            // Min confidence score 0-100 (default: 60)
  // Session filter
  allowedSessions: SessionType[];   // Only trade in these sessions (default: [Asia, Overlap])
  // Fee optimization
  useLimitOrders: boolean;          // Use limit orders for lower fees (default: true)
}

export interface MeanReversionSignal {
  asset: string;
  direction: 'HIGHER' | 'LOWER' | 'NO_TRADE';
  confidence: number;               // 0-100
  reason: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  // Conditions
  rsi: number;
  stochK: number;
  stochD: number;
  adx: number;
  bbPosition: 'ABOVE_UPPER' | 'AT_UPPER' | 'MIDDLE' | 'AT_LOWER' | 'BELOW_LOWER';
  relativeVolume: number;
  regime: string;
  session: SessionType;
  // Quality
  isHighQuality: boolean;           // All conditions met perfectly
  setupType: 'PERFECT' | 'GOOD' | 'FAIR' | 'POOR';
}

export interface MeanReversionPosition {
  id: string;
  asset: string;
  direction: 'HIGHER' | 'LOWER';
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop: number;
  quantity: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  maxFavorable: number;             // Max favorable excursion %
  maxAdverse: number;               // Max adverse excursion %
  confidence: number;
  status: 'OPEN' | 'CLOSING' | 'CLOSED';
  openedAt: Date;
  closedAt?: Date;
  closeReason?: string;
  realizedPnl?: number;
}

export interface MeanReversionStats {
  totalSignals: number;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  totalPnl: number;
  avgPnlPerTrade: number;
  avgWinPnl: number;
  avgLossPnl: number;
  profitFactor: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  sharpeRatio: number;
}

// === DEFAULT CONFIG ===

export const DEFAULT_MEAN_REVERSION_CONFIG: MeanReversionConfig = {
  enabled: false,
  assets: ['ETH/USD'],             // ETH has better mean reversion characteristics (backtest proven)
  timeframe: 'H1',                 // H1 proven: 62.3% WR, PF 2.32, Sharpe 6.04 on ETHUSDT
  rsiOversold: 30,
  rsiOverbought: 70,
  stochOversold: 20,
  stochOverbought: 80,
  adxMaxRange: 25,
  bbTouchRequired: true,
  volumeConfirmMin: 1.2,
  takeProfitTarget: 'BB_MIDDLE',
  takeProfitPct: 0.5,
  stopLossATRMultiplier: 1.5,
  trailingStop: true,
  trailingATRMultiplier: 1.0,
  maxPositionSizeUsd: 500,
  maxConcurrentPositions: 3,
  minConfidence: 60,
  allowedSessions: ['Asia', 'Overlap', 'London'], // Ranging sessions
  useLimitOrders: true,
};

// === IN-MEMORY STATE ===

let openPositions: Map<string, MeanReversionPosition> = new Map();
let mrStats: MeanReversionStats = {
  totalSignals: 0,
  totalTrades: 0,
  totalWins: 0,
  totalLosses: 0,
  winRate: 0,
  totalPnl: 0,
  avgPnlPerTrade: 0,
  avgWinPnl: 0,
  avgLossPnl: 0,
  profitFactor: 0,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
  sharpeRatio: 0,
};

// === GENERATE MEAN REVERSION SIGNAL ===

export async function generateMeanReversionSignal(
  asset: string,
  config?: Partial<MeanReversionConfig>
): Promise<MeanReversionSignal> {
  const cfg = { ...DEFAULT_MEAN_REVERSION_CONFIG, ...config };

  // ═══ AI-ADAPTIVE PARAMETERS ═══
  // Get AI-adjusted parameters (cached, calls LLM every 30 min)
  let aiAdjustments: MeanReversionAdjustments | null = null;
  let aiShouldTrade = true;
  let aiPositionSizeMultiplier = 1.0;

  try {
    const aiConfig = await getAIAdjustedConfig();
    aiAdjustments = aiConfig.adjustments;
    aiShouldTrade = aiConfig.shouldTrade;
    aiPositionSizeMultiplier = aiConfig.positionSizeMultiplier;

    // Apply AI adjustments to config (override defaults)
    if (aiAdjustments) {
      cfg.rsiOversold = aiAdjustments.rsiOversold.value;
      cfg.rsiOverbought = aiAdjustments.rsiOverbought.value;
      cfg.adxMaxRange = aiAdjustments.adxMaxRange.value;
      cfg.volumeConfirmMin = aiAdjustments.volumeConfirmMin.value;
      cfg.stopLossATRMultiplier = aiAdjustments.stopLossATRMultiplier.value;
      cfg.trailingATRMultiplier = aiAdjustments.trailingATRMultiplier.value;
      cfg.minConfidence = aiAdjustments.minConfidence.value;
    }
  } catch (err: any) {
    console.warn(`[MEAN-REV] AI adjustments unavailable: ${err.message}. Using backtest-proven defaults.`);
    // Continue with backtest-proven defaults — this is safe
  }

  // Default NO_TRADE signal
  const noTrade: MeanReversionSignal = {
    asset,
    direction: 'NO_TRADE',
    confidence: 0,
    reason: '',
    entryPrice: 0,
    stopLoss: 0,
    takeProfit: 0,
    riskReward: 0,
    rsi: 0,
    stochK: 0,
    stochD: 0,
    adx: 0,
    bbPosition: 'MIDDLE',
    relativeVolume: 0,
    regime: 'UNKNOWN',
    session: 'OffHours',
    isHighQuality: false,
    setupType: 'POOR',
  };

  try {
    // Get candles
    const candles = await getDBCandles(asset, cfg.timeframe, 100);
    if (candles.length < 50) {
      noTrade.reason = `Datos insuficientes: ${candles.length} velas (necesario 50)`;
      return noTrade;
    }

    // Compute indicators
    const indicators = computeAllIndicators(candles);
    const currentPrice = candles[candles.length - 1].close;

    // Detect regime
    const regimeResult = detectRegime(candles, indicators);

    // Detect session
    const sessionInfo = detectSession();

    // Extract indicator values
    const rsi = indicators.rsi14 || 50;
    const stochK = indicators.stochK || 50;
    const stochD = indicators.stochD || 50;
    const adx = indicators.adx || 25; // Default to 25 (threshold)
    const atr = indicators.atr14 || currentPrice * 0.01;
    const bbUpper = indicators.bbUpper || currentPrice * 1.02;
    const bbLower = indicators.bbLower || currentPrice * 0.98;
    const bbMiddle = (bbUpper + bbLower) / 2;
    const relativeVolume = indicators.volumeAnalysis?.relativeVolume || 1;

    // Determine BB position
    let bbPosition: MeanReversionSignal['bbPosition'] = 'MIDDLE';
    const bbWidth = bbUpper - bbLower;
    const pricePosition = (currentPrice - bbLower) / bbWidth;

    if (pricePosition > 1.0) bbPosition = 'ABOVE_UPPER';
    else if (pricePosition > 0.9) bbPosition = 'AT_UPPER';
    else if (pricePosition < 0.0) bbPosition = 'BELOW_LOWER';
    else if (pricePosition < 0.1) bbPosition = 'AT_LOWER';
    else bbPosition = 'MIDDLE';

    // Build signal
    const signal: MeanReversionSignal = {
      asset,
      direction: 'NO_TRADE',
      confidence: 0,
      reason: '',
      entryPrice: currentPrice,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      rsi,
      stochK,
      stochD,
      adx,
      bbPosition,
      relativeVolume,
      regime: regimeResult.regime,
      session: sessionInfo.session,
      isHighQuality: false,
      setupType: 'POOR',
    };

    // ═══ FILTER 0: AI Should-Trade Check ═══
    if (!aiShouldTrade) {
      signal.reason = `IA recomienda NO operar: ${aiAdjustments ? 'ajustes disponibles pero riesgo alto' : 'análisis no disponible'}`;
      return signal;
    }

    // ═══ FILTER 1: Session Check ═══
    if (!cfg.allowedSessions.includes(sessionInfo.session)) {
      signal.reason = `Sesión ${sessionInfo.session} no permitida. Solo: ${cfg.allowedSessions.join(', ')}`;
      return signal;
    }

    // ═══ FILTER 2: Regime Check — MUST be RANGING ═══
    if (regimeResult.regime === 'TRENDING' || regimeResult.regime === 'VOLATILE') {
      signal.reason = `Régimen ${regimeResult.regime} — no operar reversión a la media en mercados con tendencia`;
      return signal;
    }

    // ═══ FILTER 3: ADX Check — MUST be below threshold (no strong trend) ═══
    if (adx > cfg.adxMaxRange) {
      signal.reason = `ADX ${adx.toFixed(1)} > ${cfg.adxMaxRange} — tendencia fuerte, no operar reversión`;
      return signal;
    }

    // ═══ EVALUATE LONG ENTRY (oversold) ═══
    const longConditions = {
      rsiOversold: rsi < cfg.rsiOversold,
      stochOversold: stochK < cfg.stochOversold && stochK < stochD, // K < D = bearish momentum fading
      bbTouch: !cfg.bbTouchRequired || bbPosition === 'AT_LOWER' || bbPosition === 'BELOW_LOWER',
      volumeConfirm: relativeVolume >= cfg.volumeConfirmMin,
    };

    // ═══ EVALUATE SHORT ENTRY (overbought) ═══
    const shortConditions = {
      rsiOverbought: rsi > cfg.rsiOverbought,
      stochOverbought: stochK > cfg.stochOverbought && stochK > stochD, // K > D = bullish momentum fading
      bbTouch: !cfg.bbTouchRequired || bbPosition === 'AT_UPPER' || bbPosition === 'ABOVE_UPPER',
      volumeConfirm: relativeVolume >= cfg.volumeConfirmMin,
    };

    const longScore = Object.values(longConditions).filter(Boolean).length;
    const shortScore = Object.values(shortConditions).filter(Boolean).length;

    // Determine direction
    if (longScore >= 3 && longScore > shortScore) {
      // LONG signal — mean reversion from oversold
      signal.direction = 'HIGHER';
      signal.stopLoss = currentPrice - atr * cfg.stopLossATRMultiplier;
      signal.takeProfit = cfg.takeProfitTarget === 'BB_MIDDLE' ? bbMiddle
        : cfg.takeProfitTarget === 'BB_OPPOSITE' ? bbUpper
        : currentPrice * (1 + cfg.takeProfitPct / 100);

      const risk = currentPrice - signal.stopLoss;
      const reward = signal.takeProfit - currentPrice;
      signal.riskReward = risk > 0 ? reward / risk : 0;

      // Calculate confidence based on conditions met
      signal.confidence = longScore * 20 + (longConditions.volumeConfirm ? 10 : 0) + (adx < 15 ? 10 : 0);
      signal.isHighQuality = longScore === 4 && longConditions.volumeConfirm;
      signal.setupType = longScore === 4 ? 'PERFECT' : longScore === 3 ? 'GOOD' : 'FAIR';

      const conditions = [];
      if (longConditions.rsiOversold) conditions.push(`RSI ${rsi.toFixed(1)} < ${cfg.rsiOversold}`);
      if (longConditions.stochOversold) conditions.push(`Stoch ${stochK.toFixed(1)} < ${cfg.stochOversold}`);
      if (longConditions.bbTouch) conditions.push(`Precio en BB inferior`);
      if (longConditions.volumeConfirm) conditions.push(`Vol ${relativeVolume.toFixed(1)}x`);
      signal.reason = `LONG (reversión): ${conditions.join(' + ')} | ADX ${adx.toFixed(1)} | ${signal.setupType}`;

    } else if (shortScore >= 3 && shortScore > longScore) {
      // SHORT signal — mean reversion from overbought
      signal.direction = 'LOWER';
      signal.stopLoss = currentPrice + atr * cfg.stopLossATRMultiplier;
      signal.takeProfit = cfg.takeProfitTarget === 'BB_MIDDLE' ? bbMiddle
        : cfg.takeProfitTarget === 'BB_OPPOSITE' ? bbLower
        : currentPrice * (1 - cfg.takeProfitPct / 100);

      const risk = signal.stopLoss - currentPrice;
      const reward = currentPrice - signal.takeProfit;
      signal.riskReward = risk > 0 ? reward / risk : 0;

      signal.confidence = shortScore * 20 + (shortConditions.volumeConfirm ? 10 : 0) + (adx < 15 ? 10 : 0);
      signal.isHighQuality = shortScore === 4 && shortConditions.volumeConfirm;
      signal.setupType = shortScore === 4 ? 'PERFECT' : shortScore === 3 ? 'GOOD' : 'FAIR';

      const conditions = [];
      if (shortConditions.rsiOverbought) conditions.push(`RSI ${rsi.toFixed(1)} > ${cfg.rsiOverbought}`);
      if (shortConditions.stochOverbought) conditions.push(`Stoch ${stochK.toFixed(1)} > ${cfg.stochOverbought}`);
      if (shortConditions.bbTouch) conditions.push(`Precio en BB superior`);
      if (shortConditions.volumeConfirm) conditions.push(`Vol ${relativeVolume.toFixed(1)}x`);
      signal.reason = `SHORT (reversión): ${conditions.join(' + ')} | ADX ${adx.toFixed(1)} | ${signal.setupType}`;

    } else {
      signal.reason = `Condiciones insuficientes: LONG ${longScore}/4, SHORT ${shortScore}/4. RSI ${rsi.toFixed(1)}, Stoch ${stochK.toFixed(1)}, ADX ${adx.toFixed(1)}`;
    }

    mrStats.totalSignals++;
    return signal;

  } catch (err: any) {
    noTrade.reason = `Error: ${err.message}`;
    return noTrade;
  }
}

// === EXECUTE MEAN REVERSION TRADE ===

export async function executeMeanReversionTrade(
  signal: MeanReversionSignal,
  config?: Partial<MeanReversionConfig>,
  aiPositionSizeMultiplier?: number
): Promise<MeanReversionPosition | null> {
  const cfg = { ...DEFAULT_MEAN_REVERSION_CONFIG, ...config };

  if (signal.direction === 'NO_TRADE' || signal.confidence < cfg.minConfidence) {
    return null;
  }

  // Check max concurrent positions
  if (openPositions.size >= cfg.maxConcurrentPositions) {
    console.warn(`[MEAN-REV] Max positions reached: ${openPositions.size}/${cfg.maxConcurrentPositions}`);
    return null;
  }

  // Check if already have position for this asset
  if (openPositions.has(signal.asset)) {
    return null;
  }

  const client = await getBybitClient();
  const symbol = assetToSymbol(signal.asset);

  try {
    // Calculate quantity with AI position size multiplier
    const effectiveSize = cfg.maxPositionSizeUsd * (aiPositionSizeMultiplier || 1.0);
    const quantity = Math.max(0.001, effectiveSize / signal.entryPrice);

    // Place order
    const side = signal.direction === 'HIGHER' ? 'Buy' : 'Sell';
    const result = await clientPlaceOrder(client, {
      symbol,
      side,
      orderType: cfg.useLimitOrders ? 'Limit' : 'Market',
      quantity,
      price: cfg.useLimitOrders ? signal.entryPrice : undefined,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      category: 'linear',
      timeInForce: cfg.useLimitOrders ? 'PostOnly' : 'IOC',
    }, signal.entryPrice);

    if (!result.success) {
      console.error(`[MEAN-REV] Order failed: ${result.rejectReason}`);
      return null;
    }

    const position: MeanReversionPosition = {
      id: `MR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      asset: signal.asset,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      currentPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      trailingStop: signal.stopLoss,
      quantity,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      maxFavorable: 0,
      maxAdverse: 0,
      confidence: signal.confidence,
      status: 'OPEN',
      openedAt: new Date(),
    };

    openPositions.set(signal.asset, position);
    mrStats.totalTrades++;

    // Persist to DB
    await persistMRPosition(position);

    // Also create a Signal record in the DB for tracking
    await withRetry(
      () => db.signal.create({
        data: {
          asset: signal.asset,
          timeframe: cfg.timeframe,
          direction: signal.direction,
          entryPrice: signal.entryPrice,
          entryTime: new Date(),
          expirationMinutes: 240, // 4 hours max hold
          expirationTime: new Date(Date.now() + 240 * 60 * 1000),
          confidence: signal.confidence,
          aiReason: signal.reason,
          patternType: 'mean_reversion',
          sessionType: signal.session,
          marketRegime: signal.regime,
          setupScore: signal.confidence,
          source: 'AUTO',
          status: 'PENDING',
        },
      }),
      2, 500, 'mean-reversion-signal'
    );

    console.log(`[MEAN-REV] Opened ${signal.direction} ${signal.asset} @ $${signal.entryPrice} | SL: $${signal.stopLoss} | TP: $${signal.takeProfit} | R:R ${signal.riskReward.toFixed(2)} | Confidence: ${signal.confidence}% | Size: ${(aiPositionSizeMultiplier || 1.0) * 100}%`);
    return position;
  } catch (err: any) {
    console.error(`[MEAN-REV] Error executing trade: ${err.message}`);
    return null;
  }
}

// === MONITOR MEAN REVERSION POSITIONS ===

export async function monitorMeanReversionPositions(config?: Partial<MeanReversionConfig>): Promise<{
  positionsChecked: number;
  positionsClosed: number;
  trailingStopsUpdated: number;
  totalPnl: number;
  errors: string[];
}> {
  const cfg = { ...DEFAULT_MEAN_REVERSION_CONFIG, ...config };
  const client = await getBybitClient();

  let positionsChecked = 0;
  let positionsClosed = 0;
  let trailingStopsUpdated = 0;
  let totalPnl = 0;
  const errors: string[] = [];

  for (const [asset, position] of Array.from(openPositions.entries())) {
    if (position.status !== 'OPEN') continue;

    try {
      const symbol = assetToSymbol(asset);
      const ticker = await getClientTicker(client, symbol);
      if (!ticker) {
        errors.push(`No ticker for ${asset}`);
        continue;
      }

      const currentPrice = ticker.lastPrice;
      position.currentPrice = currentPrice;

      // Calculate unrealized P&L
      if (position.direction === 'HIGHER') {
        position.unrealizedPnl = (currentPrice - position.entryPrice) * position.quantity;
        position.unrealizedPnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      } else {
        position.unrealizedPnl = (position.entryPrice - currentPrice) * position.quantity;
        position.unrealizedPnlPct = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
      }

      // Track max favorable/adverse excursion
      position.maxFavorable = Math.max(position.maxFavorable, position.unrealizedPnlPct);
      position.maxAdverse = Math.min(position.maxAdverse, position.unrealizedPnlPct);

      // ═══ TRAILING STOP LOGIC ═══
      if (cfg.trailingStop) {
        // Get fresh ATR
        const candles = await getDBCandles(asset, cfg.timeframe, 50);
        if (candles.length >= 20) {
          const indicators = computeAllIndicators(candles);
          const atr = indicators.atr14 || currentPrice * 0.01;
          const trailDistance = atr * cfg.trailingATRMultiplier;

          if (position.direction === 'HIGHER') {
            const newTrail = currentPrice - trailDistance;
            if (newTrail > position.trailingStop) {
              position.trailingStop = newTrail;
              trailingStopsUpdated++;
              // Update SL on exchange (only works with BybitClient, PaperTrading tracks internally)
              if (client instanceof BybitClient) {
                await client.setStopLoss(symbol, newTrail, position.takeProfit);
              }
            }
          } else {
            const newTrail = currentPrice + trailDistance;
            if (newTrail < position.trailingStop || position.trailingStop === position.stopLoss) {
              position.trailingStop = newTrail;
              trailingStopsUpdated++;
              if (client instanceof BybitClient) {
                await client.setStopLoss(symbol, newTrail, position.takeProfit);
              }
            }
          }
        }
      }

      // ═══ CHECK EXIT CONDITIONS ═══
      const slHit = position.direction === 'HIGHER'
        ? currentPrice <= position.trailingStop
        : currentPrice >= position.trailingStop;

      const tpHit = position.direction === 'HIGHER'
        ? currentPrice >= position.takeProfit
        : currentPrice <= position.takeProfit;

      if (slHit || tpHit) {
        const closeSide = position.direction === 'HIGHER' ? 'Sell' : 'Buy';
        const closeResult = await clientClosePosition(client, symbol, position.direction === 'HIGHER' ? 'Buy' : 'Sell', position.quantity, currentPrice);

        position.status = 'CLOSED';
        position.closedAt = new Date();
        position.closeReason = slHit ? 'Stop Loss' : 'Take Profit';
        position.realizedPnl = position.unrealizedPnl;

        // Update stats
        if (position.realizedPnl > 0) {
          mrStats.totalWins++;
          mrStats.avgWinPnl = (mrStats.avgWinPnl * (mrStats.totalWins - 1) + position.realizedPnl) / mrStats.totalWins;
        } else {
          mrStats.totalLosses++;
          mrStats.avgLossPnl = (mrStats.avgLossPnl * (mrStats.totalLosses - 1) + Math.abs(position.realizedPnl)) / mrStats.totalLosses;
        }
        mrStats.totalPnl += position.realizedPnl;
        totalPnl += position.realizedPnl;

        if (mrStats.totalTrades > 0) {
          mrStats.winRate = (mrStats.totalWins / mrStats.totalTrades) * 100;
          mrStats.avgPnlPerTrade = mrStats.totalPnl / mrStats.totalTrades;
          mrStats.profitFactor = mrStats.avgLossPnl > 0
            ? (mrStats.avgWinPnl * mrStats.totalWins) / (mrStats.avgLossPnl * mrStats.totalLosses)
            : 0;
        }

        openPositions.delete(asset);
        positionsClosed++;

        await persistMRPosition(position);
        console.log(`[MEAN-REV] Closed ${position.direction} ${asset}: ${position.closeReason} | P&L: $${position.realizedPnl.toFixed(2)}`);

        // ═══ RECORD WALK-FORWARD TRADE FOR AI ANALYZER ═══
        try {
          recordWalkForwardTrade(
            asset,
            position.direction,
            position.realizedPnl > 0 ? 'WIN' : 'LOSS',
            position.realizedPnl
          );
        } catch { /* non-critical */ }
      } else {
        positionsChecked++;
        await persistMRPosition(position);
      }
    } catch (err: any) {
      errors.push(`${asset}: ${err.message}`);
    }
  }

  return { positionsChecked, positionsClosed, trailingStopsUpdated, totalPnl, errors };
}

// === AUTO-EXECUTE MEAN REVERSION CYCLE (main entry for worker) ===

export async function executeMeanReversionCycle(config?: Partial<MeanReversionConfig>): Promise<{
  signalsGenerated: number;
  tradesOpened: number;
  positionsChecked: number;
  positionsClosed: number;
  totalPnl: number;
  errors: string[];
}> {
  const cfg = { ...DEFAULT_MEAN_REVERSION_CONFIG, ...config };

  if (!cfg.enabled) {
    return { signalsGenerated: 0, tradesOpened: 0, positionsChecked: 0, positionsClosed: 0, totalPnl: 0, errors: ['Mean reversion disabled'] };
  }

  let signalsGenerated = 0;
  let tradesOpened = 0;
  const errors: string[] = [];

  // Get AI position size multiplier for this cycle
  let aiPositionSizeMultiplier = 1.0;
  try {
    const { getAIAdjustedConfig } = await import('./ai-market-analyzer');
    const aiConfig = await getAIAdjustedConfig();
    aiPositionSizeMultiplier = aiConfig.positionSizeMultiplier;
  } catch { /* use default */ }

  // Generate signals for all configured assets
  for (const asset of cfg.assets) {
    try {
      const signal = await generateMeanReversionSignal(asset, cfg);
      signalsGenerated++;

      if (signal.direction !== 'NO_TRADE' && signal.confidence >= cfg.minConfidence) {
        const position = await executeMeanReversionTrade(signal, cfg, aiPositionSizeMultiplier);
        if (position) tradesOpened++;
      }
    } catch (err: any) {
      errors.push(`${asset}: ${err.message}`);
    }
  }

  // Monitor existing positions
  const monitorResult = await monitorMeanReversionPositions(cfg);

  return {
    signalsGenerated,
    tradesOpened,
    positionsChecked: monitorResult.positionsChecked,
    positionsClosed: monitorResult.positionsClosed,
    totalPnl: monitorResult.totalPnl,
    errors: [...errors, ...monitorResult.errors],
  };
}

// === GET STATS ===

export function getMeanReversionStats(): MeanReversionStats {
  return { ...mrStats };
}

// === GET OPEN POSITIONS ===

export function getOpenMRPositions(): MeanReversionPosition[] {
  return Array.from(openPositions.values()).filter(p => p.status === 'OPEN');
}

// === HELPERS ===

type BrokerClient = BybitClient | PaperTradingClient;

async function getBybitClient(): Promise<BrokerClient> {
  // Use the same broker resolution as the rest of the app.
  // If no real API keys → PaperTradingClient (simulates orders)
  // If real API keys → BybitClient (real exchange)
  return getBrokerClientFromDB();
}

// Wrapper: get last price for a symbol (works with both client types)
async function getClientLastPrice(client: BrokerClient, symbol: string): Promise<number | null> {
  if (client instanceof PaperTradingClient) {
    return client.getLastPrice(symbol);
  }
  return client.getLastPrice(symbol);
}

// Wrapper: get ticker (works with both client types)
async function getClientTicker(client: BrokerClient, symbol: string): Promise<{ lastPrice: number; fundingRate?: number } | null> {
  if (client instanceof PaperTradingClient) {
    return client.getTicker(symbol);
  }
  return client.getTicker(symbol, 'linear');
}

// Wrapper: place order (works with both client types)
async function clientPlaceOrder(client: BrokerClient, order: import('./broker-client').OrderRequest, currentPrice?: number): Promise<import('./broker-client').OrderResult> {
  if (client instanceof PaperTradingClient) {
    return client.placeOrder(order, currentPrice || order.price);
  }
  return client.placeOrder(order);
}

// Wrapper: close position (works with both client types)
async function clientClosePosition(client: BrokerClient, symbol: string, side: 'Buy' | 'Sell', quantity: number, currentPrice: number): Promise<import('./broker-client').OrderResult> {
  if (client instanceof PaperTradingClient) {
    return client.closePosition(symbol, currentPrice);
  }
  return client.closePosition(symbol, side, quantity);
}

async function persistMRPosition(position: MeanReversionPosition): Promise<void> {
  try {
    await withRetry(
      () => db.appSettings.upsert({
        where: { key: `mr_position_${position.asset.replace('/', '_')}` },
        create: {
          key: `mr_position_${position.asset.replace('/', '_')}`,
          value: JSON.stringify(position),
          description: `Mean reversion position for ${position.asset}`,
        },
        update: { value: JSON.stringify(position) },
      }),
      2, 500, `mr-position-${position.asset}`
    );
  } catch (err: any) {
    console.error(`[MEAN-REV] Failed to persist position: ${err.message}`);
  }
}

export async function loadMRPositions(): Promise<number> {
  let loaded = 0;
  const assets = ['BTC_USD', 'ETH_USD'];
  for (const assetKey of assets) {
    try {
      const setting = await db.appSettings.findUnique({
        where: { key: `mr_position_${assetKey}` },
      });
      if (setting) {
        const position: MeanReversionPosition = JSON.parse(setting.value);
        if (position.status === 'OPEN') {
          openPositions.set(position.asset, position);
          loaded++;
        }
      }
    } catch { /* skip */ }
  }
  return loaded;
}
