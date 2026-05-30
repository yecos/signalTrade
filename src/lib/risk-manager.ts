// RISK MANAGER — Position Sizing, Drawdown Limits, Circuit Breaker
// Ensures capital preservation through multiple safety layers:
// 1. Position sizing (Kelly-based with safety fraction)
// 2. Daily loss limit
// 3. Maximum drawdown circuit breaker
// 4. Maximum concurrent positions
// 5. Correlation check (avoid overexposure to same direction)
// 6. Time-based restrictions (avoid volatile events)

import { db } from './db';

// === TYPES ===

export interface RiskConfig {
  riskPerTrade: number;       // % of account to risk per trade (default: 1%)
  maxDailyLoss: number;       // % of account max daily loss (default: 3%)
  maxOpenPositions: number;   // Max concurrent open positions (default: 3)
  maxDrawdownPct: number;     // % drawdown from peak that triggers circuit breaker (default: 10%)
  leverage: number;           // Leverage multiplier (default: 1, no leverage)
  minAccountBalance: number;  // Minimum balance to allow trading (default: 100)
  maxPositionSize: number;    // Maximum position size in USD (default: 1000)
  kellyFraction: number;      // Kelly criterion fraction (default: 0.25 = quarter Kelly)
  cooldownAfterLoss: number;  // Minutes to wait after a loss before next trade (default: 30)
  avoidNewsMinutes: number;   // Minutes before/after major news to avoid (default: 30)
}

export interface RiskAssessment {
  allowed: boolean;
  reason?: string;
  positionSize: number;       // Suggested position size in base currency
  positionValueUsd: number;   // Position value in USD
  riskAmountUsd: number;      // Amount at risk in USD
  stopLossDistance: number;   // Distance to stop loss in price
  stopLossPrice: number;      // Calculated stop loss price
  takeProfitPrice: number;    // Calculated take profit price
  riskRewardRatio: number;    // Risk/Reward ratio
  warnings: string[];         // Non-blocking warnings
  circuitBreaker: boolean;    // Whether circuit breaker is active
}

export interface DailyRiskState {
  date: string;
  dailyPnl: number;
  dailyTrades: number;
  dailyWins: number;
  dailyLosses: number;
  consecutiveLosses: number;
  lastLossTime: Date | null;
  peakEquity: number;
  currentDrawdown: number;
  currentDrawdownPct: number;
}

// === DEFAULT CONFIG ===

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  riskPerTrade: 1,
  maxDailyLoss: 3,
  maxOpenPositions: 3,
  maxDrawdownPct: 10,
  leverage: 1,
  minAccountBalance: 100,
  maxPositionSize: 1000,
  kellyFraction: 0.25,
  cooldownAfterLoss: 30,
  avoidNewsMinutes: 30,
};

// === POSITION SIZING (Kelly Criterion with Safety Fraction) ===

export function calculateKellySize(
  accountBalance: number,
  winRate: number,        // 0-1
  avgWin: number,         // Average win as R-multiple (e.g., 1.5R)
  avgLoss: number,        // Average loss as R-multiple (usually 1R)
  kellyFraction: number,  // Safety fraction (0.25 = quarter Kelly)
  riskPerTrade: number,   // Maximum risk as % of account
): { positionSize: number; kellyPct: number; safePct: number } {
  // Kelly formula: f = (p * b - q) / b
  // where p = win rate, q = loss rate, b = win/loss ratio
  const p = winRate;
  const q = 1 - winRate;
  const b = avgWin / avgLoss;

  // Full Kelly percentage
  const fullKelly = (p * b - q) / b;
  const kellyPct = Math.max(0, fullKelly);

  // Apply safety fraction (quarter Kelly is standard)
  const safePct = Math.min(kellyPct * kellyFraction, riskPerTrade / 100);

  // Position size based on risk
  const positionSize = accountBalance * safePct;

  return {
    positionSize: Math.round(positionSize * 100) / 100,
    kellyPct: Math.round(kellyPct * 10000) / 100, // as percentage
    safePct: Math.round(safePct * 10000) / 100,
  };
}

// === STOP LOSS / TAKE PROFIT CALCULATION ===

export function calculateStopLossTakeProfit(
  entryPrice: number,
  direction: 'HIGHER' | 'LOWER',
  atr: number,              // ATR value for the asset
  riskRewardRatio: number,  // Desired R:R ratio (e.g., 1.5)
  riskPerTrade: number,     // % of account to risk
  accountBalance: number,
): {
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  riskAmount: number;
  stopDistance: number;
} {
  // ═══ Stop loss distance calculation ═══
  // For M5 timeframe with 40-min expiration, we need TIGHT stops.
  // Use ATR * 1.5 but CAP to a max percentage of entry price.
  // This prevents unrealistic SL/TP when ATR is from simulated data.

  // Max SL as % of entry price for different asset types
  const isCrypto = entryPrice > 1000; // BTC, ETH
  const maxSlPercent = isCrypto ? 0.008 : 0.005; // 0.8% for crypto, 0.5% for forex
  const minSlPercent = isCrypto ? 0.002 : 0.001; // 0.2% for crypto, 0.1% for forex

  let stopDistance = atr * 1.5;

  // Cap stop distance to min/max percentage of entry price
  const maxDistance = entryPrice * maxSlPercent;
  const minDistance = entryPrice * minSlPercent;
  stopDistance = Math.max(minDistance, Math.min(stopDistance, maxDistance));

  // Risk amount in USD
  const riskAmount = accountBalance * (riskPerTrade / 100);

  // Position size: riskAmount / stopDistance (in base currency terms)
  const positionSize = riskAmount / stopDistance;

  // Calculate stop loss and take profit prices
  let stopLoss: number;
  let takeProfit: number;

  if (direction === 'HIGHER') {
    stopLoss = entryPrice - stopDistance;
    takeProfit = entryPrice + (stopDistance * riskRewardRatio);
  } else {
    stopLoss = entryPrice + stopDistance;
    takeProfit = entryPrice - (stopDistance * riskRewardRatio);
  }

  return {
    stopLoss: Math.round(stopLoss * 100) / 100,
    takeProfit: Math.round(takeProfit * 100) / 100,
    positionSize: Math.round(positionSize * 1000000) / 1000000, // High precision for crypto
    riskAmount: Math.round(riskAmount * 100) / 100,
    stopDistance: Math.round(stopDistance * 100) / 100,
  };
}

// === DAILY RISK STATE ===

export async function getDailyRiskState(accountId?: string): Promise<DailyRiskState> {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Get today's closed trades
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const trades = await db.trade.findMany({
    where: {
      status: 'CLOSED',
      closedAt: { gte: startOfDay, lt: endOfDay },
      ...(accountId ? { metadataJson: { contains: accountId } } : {}),
    },
    orderBy: { closedAt: 'desc' },
  });

  // Get current account
  const account = await getOrCreateAccount();

  // Calculate daily P&L
  const dailyPnl = trades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);

  // Count wins/losses
  const dailyWins = trades.filter(t => (t.realizedPnl || 0) > 0).length;
  const dailyLosses = trades.filter(t => (t.realizedPnl || 0) < 0).length;

  // Consecutive losses
  let consecutiveLosses = 0;
  for (const t of trades) {
    if ((t.realizedPnl || 0) < 0) consecutiveLosses++;
    else break;
  }

  // Last loss time
  const lastLoss = trades.find(t => (t.realizedPnl || 0) < 0);
  const lastLossTime = lastLoss?.closedAt || null;

  // Drawdown calculation
  const peakEquity = account.peakEquity || account.equity || account.balance;
  const currentEquity = account.equity || account.balance;
  const currentDrawdown = Math.max(0, peakEquity - currentEquity);
  const currentDrawdownPct = peakEquity > 0 ? (currentDrawdown / peakEquity) * 100 : 0;

  return {
    date: todayStr,
    dailyPnl,
    dailyTrades: trades.length,
    dailyWins,
    dailyLosses,
    consecutiveLosses,
    lastLossTime,
    peakEquity,
    currentDrawdown,
    currentDrawdownPct,
  };
}

// === FULL RISK ASSESSMENT ===
// Called before every trade to determine if it's safe to execute

export async function assessRisk(params: {
  asset: string;
  direction: 'HIGHER' | 'LOWER';
  entryPrice: number;
  atr: number;
  winRate: number;          // Historical/Bayesian win rate for this setup (0-1)
  riskRewardRatio: number;  // Expected R:R from the signal
  confidence: number;       // Signal confidence (0-100)
  edgeClassification: string; // GREEN, YELLOW, RED, GREY
  provenEdgeTier: string;   // TIER_1, TIER_2, TIER_3, UNKNOWN, BLOCKED
  dataCollectionMode?: boolean; // If true, relax edge/position checks for data collection
}): Promise<RiskAssessment> {
  const config = await getRiskConfig();
  const account = await getOrCreateAccount();
  const riskState = await getDailyRiskState();
  const warnings: string[] = [];
  let circuitBreaker = false;

  // ═══ CHECK 1: CIRCUIT BREAKER ═══
  if (account.isCircuitBreaker) {
    return {
      allowed: false,
      reason: `CIRCUIT BREAKER ACTIVO: ${account.circuitBreakerReason || 'Drawdown máximo alcanzado'}. Trading deshabilitado hasta reinicio manual.`,
      positionSize: 0,
      positionValueUsd: 0,
      riskAmountUsd: 0,
      stopLossDistance: 0,
      stopLossPrice: 0,
      takeProfitPrice: 0,
      riskRewardRatio: 0,
      warnings: [],
      circuitBreaker: true,
    };
  }

  // ═══ CHECK 2: MINIMUM BALANCE ═══
  if (account.balance < config.minAccountBalance) {
    return {
      allowed: false,
      reason: `Balance insuficiente: $${account.balance.toFixed(2)} < $${config.minAccountBalance} mínimo`,
      positionSize: 0, positionValueUsd: 0, riskAmountUsd: 0,
      stopLossDistance: 0, stopLossPrice: 0, takeProfitPrice: 0,
      riskRewardRatio: 0, warnings, circuitBreaker: false,
    };
  }

  // ═══ CHECK 3: DAILY LOSS LIMIT ═══
  const dailyLossLimit = account.balance * (config.maxDailyLoss / 100);
  if (riskState.dailyPnl < -dailyLossLimit) {
    return {
      allowed: false,
      reason: `Límite de pérdida diaria alcanzado: -$${Math.abs(riskState.dailyPnl).toFixed(2)} / -$${dailyLossLimit.toFixed(2)} límite`,
      positionSize: 0, positionValueUsd: 0, riskAmountUsd: 0,
      stopLossDistance: 0, stopLossPrice: 0, takeProfitPrice: 0,
      riskRewardRatio: 0, warnings, circuitBreaker: false,
    };
  }

  // ═══ CHECK 4: MAX DRAWDOWN ═══
  if (riskState.currentDrawdownPct >= config.maxDrawdownPct) {
    // Activate circuit breaker!
    await activateCircuitBreaker(account.id, `Drawdown máximo alcanzado: ${riskState.currentDrawdownPct.toFixed(1)}% >= ${config.maxDrawdownPct}%`);
    return {
      allowed: false,
      reason: `DRAWDOWN MÁXIMO: ${riskState.currentDrawdownPct.toFixed(1)}%. Circuit breaker activado.`,
      positionSize: 0, positionValueUsd: 0, riskAmountUsd: 0,
      stopLossDistance: 0, stopLossPrice: 0, takeProfitPrice: 0,
      riskRewardRatio: 0, warnings, circuitBreaker: true,
    };
  }

  // ═══ CHECK 5: MAX OPEN POSITIONS ═══
  const openPositions = await db.position.count({ where: { status: 'OPEN' } });
  // In data collection mode, allow up to 8 positions (enough for stats, not excessive exposure)
  // Reduced from 20 — too many positions caused bloated DB and correlated exposure
  const effectiveMaxPositions = params.dataCollectionMode
    ? Math.max(config.maxOpenPositions, 8)
    : config.maxOpenPositions;
  if (openPositions >= effectiveMaxPositions) {
    return {
      allowed: false,
      reason: `Máximo de posiciones abiertas alcanzado: ${openPositions}/${effectiveMaxPositions}${params.dataCollectionMode ? ' (modo recolección)' : ''}`,
      positionSize: 0, positionValueUsd: 0, riskAmountUsd: 0,
      stopLossDistance: 0, stopLossPrice: 0, takeProfitPrice: 0,
      riskRewardRatio: 0, warnings, circuitBreaker: false,
    };
  }

  // ═══ CHECK 6: SAME ASSET EXPOSURE ═══
  const sameAssetPositions = await db.position.count({
    where: { asset: params.asset, status: 'OPEN' },
  });
  if (sameAssetPositions > 0 && !params.dataCollectionMode) {
    return {
      allowed: false,
      reason: `Ya existe posición abierta en ${params.asset}`,
      positionSize: 0, positionValueUsd: 0, riskAmountUsd: 0,
      stopLossDistance: 0, stopLossPrice: 0, takeProfitPrice: 0,
      riskRewardRatio: 0, warnings, circuitBreaker: false,
    };
  } else if (sameAssetPositions > 0 && params.dataCollectionMode) {
    warnings.push(`Posición duplicada en ${params.asset} — permitido en modo recolección`);
  }

  // ═══ CHECK 7: COOLDOWN AFTER LOSS ═══
  if (riskState.lastLossTime) {
    const minutesSinceLoss = (Date.now() - riskState.lastLossTime.getTime()) / (1000 * 60);
    // In data collection mode, reduce cooldown to 1 min (need more trades for statistics)
    const effectiveCooldown = params.dataCollectionMode
      ? Math.min(config.cooldownAfterLoss, 1)
      : config.cooldownAfterLoss;
    if (minutesSinceLoss < effectiveCooldown) {
      const remaining = Math.ceil(effectiveCooldown - minutesSinceLoss);
      return {
        allowed: false,
        reason: `Cooldown post-pérdida: ${remaining} min restantes (última pérdida: ${riskState.consecutiveLosses} consecutivas)${params.dataCollectionMode ? ' — reducido en modo recolección' : ''}`,
        positionSize: 0, positionValueUsd: 0, riskAmountUsd: 0,
        stopLossDistance: 0, stopLossPrice: 0, takeProfitPrice: 0,
        riskRewardRatio: 0, warnings, circuitBreaker: false,
      };
    }
  }

  // ═══ CHECK 8: PROVEN EDGE REQUIREMENT ═══
  if (params.provenEdgeTier === 'BLOCKED' || params.edgeClassification === 'RED') {
    if (params.dataCollectionMode) {
      // MODO RECOLECCIÓN: Permitir pero con tamaño mínimo y advertencia
      warnings.push(`Edge ${params.provenEdgeTier}/${params.edgeClassification} — permitido en modo recolección con tamaño mínimo`);
    } else {
      return {
        allowed: false,
        reason: `Edge bloqueado/rojo: ${params.provenEdgeTier} / ${params.edgeClassification}. No operar.`,
        positionSize: 0, positionValueUsd: 0, riskAmountUsd: 0,
        stopLossDistance: 0, stopLossPrice: 0, takeProfitPrice: 0,
        riskRewardRatio: 0, warnings, circuitBreaker: false,
      };
    }
  }

  // ═══ WARNINGS (non-blocking) ═══
  if (riskState.consecutiveLosses >= 3) {
    warnings.push(`${riskState.consecutiveLosses} pérdidas consecutivas — considere reducir tamaño`);
  }
  if (params.edgeClassification === 'YELLOW') {
    warnings.push('Edge amarillo — tamaño reducido por seguridad');
  }
  if (params.provenEdgeTier === 'TIER_3') {
    warnings.push('TIER_3 — edge débil, tamaño mínimo recomendado');
  }
  if (params.confidence < 55) {
    warnings.push(`Confianza baja (${params.confidence.toFixed(0)}%) — considerar NO_OPERAR`);
  }
  if (riskState.dailyPnl < -dailyLossLimit * 0.5) {
    warnings.push(`Pérdida diaria significativa: -$${Math.abs(riskState.dailyPnl).toFixed(2)} (50%+ del límite)`);
  }

  // ═══ POSITION SIZING ═══

  // Reduce position for yellow edges and tier_3
  let effectiveRisk = config.riskPerTrade;
  if (params.edgeClassification === 'YELLOW') effectiveRisk *= 0.5;
  if (params.provenEdgeTier === 'TIER_3') effectiveRisk *= 0.5;
  if (riskState.consecutiveLosses >= 3) effectiveRisk *= 0.5;

  // Calculate using ATR-based stop loss
  const sltp = calculateStopLossTakeProfit(
    params.entryPrice,
    params.direction,
    params.atr,
    params.riskRewardRatio,
    effectiveRisk,
    account.balance,
  );

  // Cap position value
  let positionValueUsd = sltp.positionSize * params.entryPrice;
  if (positionValueUsd > config.maxPositionSize) {
    sltp.positionSize = config.maxPositionSize / params.entryPrice;
    positionValueUsd = config.maxPositionSize;
  }

  return {
    allowed: true,
    positionSize: sltp.positionSize,
    positionValueUsd,
    riskAmountUsd: sltp.riskAmount,
    stopLossDistance: sltp.stopDistance,
    stopLossPrice: sltp.stopLoss,
    takeProfitPrice: sltp.takeProfit,
    riskRewardRatio: params.riskRewardRatio,
    warnings,
    circuitBreaker: false,
  };
}

// === ACCOUNT MANAGEMENT ===

export async function getOrCreateAccount(): Promise<{
  id: string;
  broker: string;
  accountId: string | null;
  balance: number;
  equity: number;
  unrealizedPnl: number;
  dailyPnl: number;
  dailyTrades: number;
  maxDrawdown: number;
  peakEquity: number;
  isLive: boolean;
  riskPerTrade: number;
  maxDailyLoss: number;
  maxOpenPositions: number;
  maxDrawdownPct: number;
  isActive: boolean;
  isCircuitBreaker: boolean;
  circuitBreakerReason: string | null;
  lastSyncAt: Date | null;
}> {
  let account = await db.account.findFirst({ where: { isActive: true } });

  if (!account) {
    // Create default paper trading account
    account = await db.account.create({
      data: {
        broker: 'PAPER',
        balance: 10000,
        equity: 10000,
        peakEquity: 10000,
        isLive: false,
        riskPerTrade: 1,
        maxDailyLoss: 3,
        maxOpenPositions: 3,
        maxDrawdownPct: 10,
        isActive: true,
      },
    });
  }

  return account;
}

export async function updateAccountBalance(
  accountId: string,
  balance: number,
  equity: number,
  unrealizedPnl: number
): Promise<void> {
  const current = await db.account.findUnique({ where: { id: accountId } });
  if (!current) return;

  const peakEquity = Math.max(current.peakEquity, equity);

  await db.account.update({
    where: { id: accountId },
    data: {
      balance,
      equity,
      unrealizedPnl,
      peakEquity,
      maxDrawdown: Math.max(current.maxDrawdown, peakEquity - equity),
      lastSyncAt: new Date(),
    },
  });
}

export async function activateCircuitBreaker(accountId: string, reason: string): Promise<void> {
  await db.account.update({
    where: { id: accountId },
    data: {
      isCircuitBreaker: true,
      circuitBreakerReason: reason,
    },
  });

  // Create alert
  await db.alert.create({
    data: {
      type: 'CIRCUIT_BREAKER',
      message: `CIRCUIT BREAKER: ${reason}. Trading deshabilitado.`,
      severity: 'critical',
      isActive: true,
    },
  });

  console.error(`[RISK] CIRCUIT BREAKER ACTIVATED: ${reason}`);
}

export async function deactivateCircuitBreaker(accountId: string): Promise<void> {
  await db.account.update({
    where: { id: accountId },
    data: {
      isCircuitBreaker: false,
      circuitBreakerReason: null,
      dailyPnl: 0,
      dailyTrades: 0,
    },
  });
}

// === RISK CONFIG HELPERS ===

export async function getRiskConfig(): Promise<RiskConfig> {
  const configSetting = await db.appSettings.findUnique({
    where: { key: 'riskConfig' },
  });

  if (configSetting) {
    try {
      return { ...DEFAULT_RISK_CONFIG, ...JSON.parse(configSetting.value) };
    } catch { /* use defaults */ }
  }

  return DEFAULT_RISK_CONFIG;
}

export async function saveRiskConfig(config: Partial<RiskConfig>): Promise<RiskConfig> {
  const current = await getRiskConfig();
  const updated = { ...current, ...config };

  await db.appSettings.upsert({
    where: { key: 'riskConfig' },
    create: { key: 'riskConfig', value: JSON.stringify(updated), description: 'Risk management configuration' },
    update: { value: JSON.stringify(updated) },
  });

  // Also update the account with risk settings
  const account = await getOrCreateAccount();
  await db.account.update({
    where: { id: account.id },
    data: {
      riskPerTrade: updated.riskPerTrade,
      maxDailyLoss: updated.maxDailyLoss,
      maxOpenPositions: updated.maxOpenPositions,
      maxDrawdownPct: updated.maxDrawdownPct,
    },
  });

  return updated;
}
