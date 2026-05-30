// EXECUTION ENGINE — Signal → Order → Position → Close Pipeline
// Bridges the gap between signal generation and real trading
// Supports PAPER (simulation) and LIVE (real broker) execution modes
//
// Pipeline:
// 1. Signal passes all filters → Execution Engine receives it
// 2. Risk Manager assesses the trade (position sizing, limits check)
// 3. If approved, order is placed via Broker Client
// 4. Position is tracked in DB with real-time mark-to-market
// 5. SL/TP/Timer-based exit triggers close
// 6. Trade result is recorded with P&L, slippage, journal

import { db } from './db';
import { getBrokerClientFromDB, assetToSymbol, isCryptoAsset, BybitClient, PaperTradingClient, type OrderResult } from './broker-client';
import { assessRisk, getOrCreateAccount, updateAccountBalance } from './risk-manager';

// === TYPES ===

export type ExecutionMode = 'PAPER' | 'LIVE';

export interface ExecutionRequest {
  signalId: string;
  asset: string;
  direction: 'HIGHER' | 'LOWER';
  entryPrice: number;
  confidence: number;
  // Statistical context
  patternType: string | null;
  sessionType: string | null;
  edgeClassification: string;
  provenEdgeTier: string;
  winRate: number;        // Bayesian WR (0-100)
  riskRewardRatio: number;
  expectancy: number;
  setupScore: number;
  qualityScore: number;
  // ATR for SL calculation
  atr: number;
  // Market data
  currentPrice?: number;  // Latest real-time price (if available)
  // Data collection mode
  dataCollectionMode?: boolean; // If true, relax risk checks for data collection
}

export interface ExecutionResult {
  success: boolean;
  tradeId: string | null;
  reason?: string;
  // Fill details
  fillPrice?: number;
  slippage?: number;
  commission?: number;
  positionSize?: number;
  positionValueUsd?: number;
  stopLoss?: number;
  takeProfit?: number;
  // Risk assessment
  riskAssessment?: any;
  // Broker details
  brokerOrderId?: string;
  executionMode: ExecutionMode;
}

export interface PositionCloseResult {
  success: boolean;
  tradeId: string | null;
  closePrice?: number;
  realizedPnl?: number;
  realizedPnlPct?: number;
  commission?: number;
  slippage?: number;
  reason: string;
}

// === EXECUTION ENGINE ===

export class ExecutionEngine {
  private mode: ExecutionMode;
  private brokerClient: BybitClient | PaperTradingClient | null = null;
  private _modeExplicitlySet: boolean;

  constructor(mode?: ExecutionMode) {
    // Default to PAPER for safety — LIVE must be explicitly requested
    this.mode = mode || 'PAPER';
    this._modeExplicitlySet = !!mode;
    // Broker client is lazy-loaded from DB on first use
  }

  // Lazy-load broker client from DB credentials
  private async getBroker(): Promise<BybitClient | PaperTradingClient> {
    if (!this.brokerClient) {
      this.brokerClient = await getBrokerClientFromDB();
      // Update mode based on actual broker type
      if (this.brokerClient instanceof PaperTradingClient) {
        this.mode = 'PAPER';
      } else if (this.brokerClient instanceof BybitClient) {
        // If broker is real Bybit but mode wasn't explicitly set to LIVE, keep PAPER behavior
        if (this._modeExplicitlySet && this.mode === 'LIVE') {
          this.mode = 'LIVE';
        }
        // Otherwise stays as PAPER for safety (even though the client is real)
      }
    }
    return this.brokerClient;
  }

  // === MAIN ENTRY: EXECUTE SIGNAL ===

  async executeSignal(req: ExecutionRequest): Promise<ExecutionResult> {
    console.log(`[EXEC] Executing signal ${req.signalId}: ${req.asset} ${req.direction} @ ${req.entryPrice}`);

    // ═══ STEP 1: RISK ASSESSMENT ═══
    const riskAssessment = await assessRisk({
      asset: req.asset,
      direction: req.direction,
      entryPrice: req.entryPrice,
      atr: req.atr,
      winRate: req.winRate / 100, // Convert 0-100 to 0-1
      riskRewardRatio: req.riskRewardRatio,
      confidence: req.confidence,
      edgeClassification: req.edgeClassification,
      provenEdgeTier: req.provenEdgeTier,
      dataCollectionMode: req.dataCollectionMode || false,
    });

    if (!riskAssessment.allowed) {
      console.warn(`[EXEC] Trade blocked by Risk Manager: ${riskAssessment.reason}`);
      // Record the rejected trade
      const trade = await db.trade.create({
        data: {
          signalId: req.signalId,
          asset: req.asset,
          direction: req.direction === 'HIGHER' ? 'BUY' : 'SELL',
          orderType: 'MARKET',
          orderSide: req.direction === 'HIGHER' ? 'Buy' : 'Sell',
          quantity: 0,
          signalPrice: req.entryPrice,
          status: 'REJECTED',
          rejectReason: riskAssessment.reason,
          executionMode: this.mode,
          riskPercent: 0,
          positionValueUsd: 0,
          metadataJson: JSON.stringify({
            riskAssessment,
            signalContext: {
              pattern: req.patternType,
              session: req.sessionType,
              confidence: req.confidence,
              winRate: req.winRate,
              edge: req.edgeClassification,
              tier: req.provenEdgeTier,
            },
          }),
        },
      });

      return {
        success: false,
        tradeId: trade.id,
        reason: riskAssessment.reason,
        riskAssessment,
        executionMode: this.mode,
      };
    }

    // ═══ STEP 2: GET BROKER CLIENT + CURRENT PRICE ═══
    const broker = await this.getBroker();
    const symbol = assetToSymbol(req.asset);
    let fillPrice = req.currentPrice || req.entryPrice;

    // Try to get real-time price from broker
    if (this.mode === 'LIVE' && isCryptoAsset(req.asset)) {
      try {
        const lastPrice = await broker.getLastPrice(symbol);
        if (lastPrice) fillPrice = lastPrice;
      } catch (err) {
        console.warn('[EXEC] Could not get live price, using signal price');
      }
    }

    // ═══ STEP 3: PLACE ORDER ═══
    const side = req.direction === 'HIGHER' ? 'Buy' : 'Sell';
    const orderResult: OrderResult = await broker.placeOrder({
      symbol,
      side,
      orderType: 'MARKET',
      quantity: riskAssessment.positionSize,
      stopLoss: riskAssessment.stopLossPrice,
      takeProfit: riskAssessment.takeProfitPrice,
      category: 'linear',
    }, this.mode === 'PAPER' ? fillPrice : undefined);

    if (!orderResult.success) {
      // Order failed — record as REJECTED
      const trade = await db.trade.create({
        data: {
          signalId: req.signalId,
          asset: req.asset,
          direction: req.direction === 'HIGHER' ? 'BUY' : 'SELL',
          orderType: 'MARKET',
          orderSide: side,
          quantity: riskAssessment.positionSize,
          signalPrice: req.entryPrice,
          status: 'REJECTED',
          rejectReason: orderResult.rejectReason || 'Order placement failed',
          executionMode: this.mode,
          riskPercent: riskAssessment.riskAmountUsd > 0 ? (riskAssessment.riskAmountUsd / (await getOrCreateAccount()).balance) * 100 : 0,
          positionValueUsd: riskAssessment.positionValueUsd,
          metadataJson: JSON.stringify({
            riskAssessment,
            orderResult: orderResult.raw,
          }),
        },
      });

      return {
        success: false,
        tradeId: trade.id,
        reason: orderResult.rejectReason || 'Order placement failed',
        riskAssessment,
        executionMode: this.mode,
      };
    }

    // ═══ STEP 4: RECORD TRADE IN DB ═══
    const actualFillPrice = orderResult.fillPrice || fillPrice;
    const slippage = orderResult.slippage || Math.abs(actualFillPrice - req.entryPrice);

    const trade = await db.trade.create({
      data: {
        signalId: req.signalId,
        asset: req.asset,
        direction: req.direction === 'HIGHER' ? 'BUY' : 'SELL',
        orderType: 'MARKET',
        orderSide: side,
        quantity: riskAssessment.positionSize,
        leverage: 1,
        signalPrice: req.entryPrice,
        entryPrice: actualFillPrice,
        stopLoss: riskAssessment.stopLossPrice,
        takeProfit: riskAssessment.takeProfitPrice,
        brokerOrderId: orderResult.orderId,
        slippage,
        commission: orderResult.commission || 0,
        fillTime: new Date(),
        status: 'OPEN',
        riskPercent: riskAssessment.riskAmountUsd > 0 ? (riskAssessment.riskAmountUsd / (await getOrCreateAccount()).balance) * 100 : 0,
        positionValueUsd: riskAssessment.positionValueUsd,
        executionMode: this.mode,
        metadataJson: JSON.stringify({
          riskAssessment,
          signalContext: {
            pattern: req.patternType,
            session: req.sessionType,
            confidence: req.confidence,
            winRate: req.winRate,
            edge: req.edgeClassification,
            tier: req.provenEdgeTier,
            expectancy: req.expectancy,
            setupScore: req.setupScore,
            qualityScore: req.qualityScore,
          },
          warnings: riskAssessment.warnings,
        }),
      },
    });

    // ═══ STEP 5: CREATE POSITION TRACKING ═══
    await db.position.create({
      data: {
        tradeId: trade.id,
        asset: req.asset,
        direction: req.direction === 'HIGHER' ? 'BUY' : 'SELL',
        quantity: riskAssessment.positionSize,
        entryPrice: actualFillPrice,
        stopLoss: riskAssessment.stopLossPrice,
        takeProfit: riskAssessment.takeProfitPrice,
        currentPrice: actualFillPrice,
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
        executionMode: this.mode,
        metadataJson: JSON.stringify({
          signalId: req.signalId,
          brokerOrderId: orderResult.orderId,
        }),
      },
    });

    // ═══ STEP 6: UPDATE ACCOUNT ═══
    const account = await getOrCreateAccount();
    await db.account.update({
      where: { id: account.id },
      data: {
        dailyTrades: { increment: 1 },
      },
    });

    console.log(`[EXEC] ✅ Trade opened: ${trade.id} | ${req.asset} ${side} | Size: ${riskAssessment.positionSize} @ ${actualFillPrice} | SL: ${riskAssessment.stopLossPrice} | TP: ${riskAssessment.takeProfitPrice}`);

    return {
      success: true,
      tradeId: trade.id,
      fillPrice: actualFillPrice,
      slippage,
      commission: orderResult.commission || 0,
      positionSize: riskAssessment.positionSize,
      positionValueUsd: riskAssessment.positionValueUsd,
      stopLoss: riskAssessment.stopLossPrice,
      takeProfit: riskAssessment.takeProfitPrice,
      riskAssessment,
      brokerOrderId: orderResult.orderId,
      executionMode: this.mode,
    };
  }

  // === CLOSE POSITION ===

  async closePosition(positionId: string, reason: string): Promise<PositionCloseResult> {
    const position = await db.position.findUnique({ where: { id: positionId } });
    if (!position || position.status !== 'OPEN') {
      return { success: false, tradeId: null, reason: 'Position not found or already closed' };
    }

    // Get broker client
    const broker = await this.getBroker();

    // Get current price
    const symbol = assetToSymbol(position.asset);
    let closePrice = position.currentPrice || position.entryPrice;

    if (this.mode === 'LIVE' && isCryptoAsset(position.asset)) {
      try {
        const lastPrice = await broker.getLastPrice(symbol);
        if (lastPrice) closePrice = lastPrice;
      } catch { /* use current price */ }
    }

    // Close via broker
    const side = position.direction === 'BUY' ? 'Sell' : 'Buy';
    let closeResult: OrderResult;

    if (broker instanceof PaperTradingClient) {
      closeResult = await (broker as PaperTradingClient).closePosition(symbol, closePrice);
    } else {
      closeResult = await (broker as BybitClient).closePosition(symbol, side as any, position.quantity);
    }

    const actualClosePrice = closeResult.fillPrice || closePrice;
    const slippage = closeResult.slippage || Math.abs(actualClosePrice - closePrice);

    // Calculate P&L
    let realizedPnl: number;
    if (position.direction === 'BUY') {
      realizedPnl = (actualClosePrice - position.entryPrice) * position.quantity;
    } else {
      realizedPnl = (position.entryPrice - actualClosePrice) * position.quantity;
    }
    realizedPnl -= (closeResult.commission || 0);

    const realizedPnlPct = position.entryPrice > 0
      ? (realizedPnl / (position.entryPrice * position.quantity)) * 100
      : 0;

    // Update trade
    const trade = await db.trade.findFirst({
      where: { id: position.tradeId || undefined },
    });

    if (trade) {
      await db.trade.update({
        where: { id: trade.id },
        data: {
          exitPrice: actualClosePrice,
          realizedPnl,
          realizedPnlPct,
          commission: (trade.commission || 0) + (closeResult.commission || 0),
          status: 'CLOSED',
          closedAt: new Date(),
        },
      });
    }

    // Update position
    await db.position.update({
      where: { id: positionId },
      data: {
        status: 'CLOSED',
        currentPrice: actualClosePrice,
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
        closedAt: new Date(),
      },
    });

    // Update account
    const account = await getOrCreateAccount();
    const newBalance = account.balance + realizedPnl;
    const newEquity = newBalance;
    await updateAccountBalance(account.id, newBalance, newEquity, 0);
    await db.account.update({
      where: { id: account.id },
      data: {
        dailyPnl: { increment: realizedPnl },
      },
    });

    // Also update the linked signal with the real trade result
    if (trade?.signalId) {
      const signalResult = realizedPnl > 0 ? 'WIN' : realizedPnl < 0 ? 'LOSS' : 'DRAW';
      await db.signal.update({
        where: { id: trade.signalId },
        data: {
          exitPrice: actualClosePrice,
          result: signalResult,
          priceDifference: actualClosePrice - (trade.entryPrice || 0),
          estimatedProfit: realizedPnl > 0 ? realizedPnl : 0,
          estimatedLoss: realizedPnl < 0 ? Math.abs(realizedPnl) : 0,
          status: 'CLOSED',
          verificationMethod: 'REAL',
        },
      });
    }

    console.log(`[EXEC] Position closed: ${positionId} | P&L: $${realizedPnl.toFixed(2)} (${realizedPnlPct.toFixed(2)}%) | Reason: ${reason}`);

    return {
      success: true,
      tradeId: trade?.id || null,
      closePrice: actualClosePrice,
      realizedPnl,
      realizedPnlPct,
      commission: closeResult.commission || 0,
      slippage,
      reason,
    };
  }

  // === CHECK AND CLOSE EXPIRED POSITIONS ===
  // Called by the worker/cron to close positions that hit their expiration time

  async checkAndCloseExpired(): Promise<number> {
    // Find open positions linked to signals that have expired
    const expiredPositions = await db.position.findMany({
      where: { status: 'OPEN' },
    });

    let closed = 0;
    for (const pos of expiredPositions) {
      // Check if the linked signal has expired
      const metadata = pos.metadataJson ? JSON.parse(pos.metadataJson) : {};
      const signalId = metadata.signalId;

      if (signalId) {
        const signal = await db.signal.findUnique({ where: { id: signalId } });
        if (signal && signal.expirationTime && new Date() >= signal.expirationTime) {
          await this.closePosition(pos.id, `EXPIRATION: ${signal.expirationMinutes} min timer`);
          closed++;
        }
      }
    }

    return closed;
  }

  // === CHECK AND CLOSE SL/TP HITS + TRAILING STOP + BREAKEVEN ===
  // Called by the worker/cron to check if SL/TP has been hit
  // Also implements trailing stop and breakeven logic

  async checkStopLossTakeProfit(): Promise<number> {
    const openPositions = await db.position.findMany({
      where: { status: 'OPEN' },
    });

    const broker = await this.getBroker();
    let closed = 0;

    for (const pos of openPositions) {
      // Get current price — ALWAYS try to get real price, even in PAPER mode
      const symbol = assetToSymbol(pos.asset);
      let currentPrice = pos.currentPrice || pos.entryPrice;

      try {
        const lastPrice = await broker.getLastPrice(symbol);
        if (lastPrice) currentPrice = lastPrice;
      } catch { /* use last known price */ }

      // Update mark price
      let unrealizedPnl: number;
      if (pos.direction === 'BUY') {
        unrealizedPnl = (currentPrice - pos.entryPrice) * pos.quantity;
      } else {
        unrealizedPnl = (pos.entryPrice - currentPrice) * pos.quantity;
      }
      const unrealizedPnlPct = pos.entryPrice > 0
        ? (unrealizedPnl / (pos.entryPrice * pos.quantity)) * 100
        : 0;

      // ═══ TRAILING STOP + BREAKEVEN LOGIC ═══
      let updatedStopLoss = pos.stopLoss;
      const entryPrice = pos.entryPrice;
      const slDistance = Math.abs(entryPrice - pos.stopLoss);
      const isBuy = pos.direction === 'BUY';
      const favorableMove = isBuy
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice;

      // BREAKEVEN: When price moves 1R in our favor, move stop to entry (risk-free trade)
      if (favorableMove >= slDistance / entryPrice && updatedStopLoss !== entryPrice) {
        if (isBuy && updatedStopLoss < entryPrice) {
          updatedStopLoss = entryPrice;
          console.log(`[EXEC] 🔒 BREAKEVEN: ${pos.asset} BUY — SL moved from ${pos.stopLoss} to entry ${entryPrice}`);
        } else if (!isBuy && updatedStopLoss > entryPrice) {
          updatedStopLoss = entryPrice;
          console.log(`[EXEC] 🔒 BREAKEVEN: ${pos.asset} SELL — SL moved from ${pos.stopLoss} to entry ${entryPrice}`);
        }
      }

      // TRAILING STOP: After breakeven, trail SL at 50% of favorable move
      if (updatedStopLoss === entryPrice && favorableMove > slDistance / entryPrice) {
        const trailDistance = favorableMove * entryPrice * 0.5; // 50% of favorable move
        const newTrailingStop = isBuy
          ? entryPrice + trailDistance
          : entryPrice - trailDistance;

        // Only move stop in favorable direction (never backward)
        if (isBuy && newTrailingStop > updatedStopLoss) {
          updatedStopLoss = newTrailingStop;
          console.log(`[EXEC] 📈 TRAILING: ${pos.asset} BUY — SL trailed to ${newTrailingStop.toFixed(2)} (price: ${currentPrice.toFixed(2)})`);
        } else if (!isBuy && newTrailingStop < updatedStopLoss) {
          updatedStopLoss = newTrailingStop;
          console.log(`[EXEC] 📉 TRAILING: ${pos.asset} SELL — SL trailed to ${newTrailingStop.toFixed(2)} (price: ${currentPrice.toFixed(2)})`);
        }
      }

      await db.position.update({
        where: { id: pos.id },
        data: {
          currentPrice,
          unrealizedPnl,
          unrealizedPnlPct,
          stopLoss: updatedStopLoss, // Update SL with breakeven/trailing
          maxFavorable: Math.max(pos.maxFavorable || 0, unrealizedPnl),
          maxAdverse: Math.min(pos.maxAdverse || 0, unrealizedPnl),
        },
      });

      // Check stop loss hit (with updated breakeven/trailing stop)
      if (updatedStopLoss) {
        const slHit = isBuy
          ? currentPrice <= updatedStopLoss
          : currentPrice >= updatedStopLoss;

        if (slHit) {
          const reason = updatedStopLoss === entryPrice
            ? `BREAKEVEN HIT: ${updatedStopLoss} (risk-free exit)`
            : favorableMove > slDistance / entryPrice
              ? `TRAILING STOP HIT: ${updatedStopLoss.toFixed(2)}`
              : `STOP LOSS HIT: ${updatedStopLoss}`;
          await this.closePosition(pos.id, reason);
          closed++;
          continue;
        }
      }

      // Check take profit hit
      if (pos.takeProfit) {
        const tpHit = pos.direction === 'BUY'
          ? currentPrice >= pos.takeProfit
          : currentPrice <= pos.takeProfit;

        if (tpHit) {
          await this.closePosition(pos.id, `TAKE PROFIT HIT: ${pos.takeProfit}`);
          closed++;
          continue;
        }
      }
    }

    return closed;
  }

  // === GET EXECUTION ENGINE STATUS ===

  async getStatus(): Promise<{
    mode: ExecutionMode;
    connected: boolean;
    latency: number;
    account: any;
    openPositions: number;
    todayTrades: number;
    todayPnl: number;
    circuitBreaker: boolean;
    brokerType: string;
  }> {
    const broker = await this.getBroker();
    const connCheck = await broker.checkConnection();
    const account = await getOrCreateAccount();
    const openPositions = await db.position.count({ where: { status: 'OPEN' } });

    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayTrades = await db.trade.count({
      where: { createdAt: { gte: startOfDay }, status: { not: 'REJECTED' } },
    });
    const todayClosedTrades = await db.trade.findMany({
      where: { closedAt: { gte: startOfDay }, status: 'CLOSED' },
    });
    const todayPnl = todayClosedTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);

    return {
      mode: this.mode,
      connected: connCheck.ok,
      latency: connCheck.latency,
      account: {
        balance: account.balance,
        equity: account.equity,
        isLive: account.isLive,
        riskPerTrade: account.riskPerTrade,
        maxDailyLoss: account.maxDailyLoss,
        maxOpenPositions: account.maxOpenPositions,
      },
      openPositions,
      todayTrades,
      todayPnl,
      circuitBreaker: account.isCircuitBreaker,
      brokerType: broker instanceof BybitClient ? 'BYBIT' : 'PAPER',
    };
  }

  // === TEST BROKER CONNECTION ===
  // Verifies that the Bybit API keys work correctly

  async testConnection(): Promise<{
    connected: boolean;
    latency: number;
    testnet: boolean;
    accountInfo?: any;
    error?: string;
  }> {
    try {
      const broker = await this.getBroker();
      const connCheck = await broker.checkConnection();

      if (!connCheck.ok) {
        return { connected: false, latency: connCheck.latency, testnet: false, error: 'Connection failed' };
      }

      // If Bybit, also test authenticated endpoint
      if (broker instanceof BybitClient) {
        const accountInfo = await broker.getAccountInfo();
        const ticker = await broker.getTicker('BTCUSDT');
        return {
          connected: true,
          latency: connCheck.latency,
          testnet: !this.mode || this.mode === 'PAPER',
          accountInfo: accountInfo ? {
            balance: accountInfo.balance,
            equity: accountInfo.equity,
            availableBalance: accountInfo.availableBalance,
          } : null,
          error: !accountInfo ? 'Could not fetch account info — check API key permissions' : undefined,
        };
      }

      return {
        connected: true,
        latency: connCheck.latency,
        testnet: true, // Paper trading
      };
    } catch (err: any) {
      return { connected: false, latency: 0, testnet: false, error: err.message };
    }
  }
}

// === SINGLETON ===

let _engine: ExecutionEngine | null = null;

export function getExecutionEngine(mode?: ExecutionMode): ExecutionEngine {
  if (!_engine) {
    _engine = new ExecutionEngine(mode);
  }
  return _engine;
}

export function resetExecutionEngine(): void {
  _engine = null;
}
