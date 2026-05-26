// TRADE MANAGER — "Cómo Operar" (Gestión Dinámica)
// La parte más ignorada por las apps de señales. Este sistema maneja:
// 1. Sizing Automático: Basado en volatilidad actual (ATR), NO en porcentaje fijo
// 2. Gestión de Riesgo Dinámica: Ajustar stops según correlación de cartera
// 3. Alertas de Cierre: No solo entrada, sino cuándo salir si la thesis se invalida

import type { ContextualizedSetup } from './confluence-engine';
import type { NoTradeAssessment } from './no-trade-system';
import type { RegimeResult } from './regime-engine';

// === TYPES ===

export interface DynamicPositionSize {
  baseSize: number;          // Size in base currency (BTC, ETH)
  adjustedSize: number;      // After all adjustments
  sizeUsd: number;           // Position value in USD
  riskAmount: number;        // Amount at risk in USD
  riskPercent: number;       // % of account risked
  sizingMethod: 'ATR_BASED' | 'KELLY' | 'FIXED' | 'REDUCED';
  adjustments: SizingAdjustment[];
}

export interface SizingAdjustment {
  type: string;
  originalValue: number;
  adjustedValue: number;
  reason: string;
}

export interface DynamicStopLoss {
  originalStop: number;
  adjustedStop: number;
  stopType: 'ATR' | 'STRUCTURAL' | 'BREAKEVEN' | 'TRAILING';
  stopDistance: number;      // Distance from entry in price
  stopDistancePct: number;   // Distance as % of entry
  adjustments: StopAdjustment[];
}

export interface StopAdjustment {
  type: 'PORTFOLIO_CORRELATION' | 'VOLATILITY_WIDEN' | 'BREAKEVEN_MOVE' | 'TRAILING_UPDATE';
  reason: string;
  originalStop: number;
  adjustedStop: number;
}

export interface ExitAlert {
  type: 'THESIS_INVALIDATED' | 'STOP_HIT' | 'TAKE_PROFIT' | 'TIME_EXPIRED' | 'REGIME_CHANGE' | 'CORRELATION_BREAK' | 'PARTIAL_PROFIT';
  urgency: 'IMMEDIATE' | 'SOON' | 'WATCH';
  reason: string;
  action: string;
  suggestedPrice: number;
}

export interface TradeManagementPlan {
  positionSize: DynamicPositionSize;
  stopLoss: DynamicStopLoss;
  takeProfit: number;
  riskRewardRatio: number;
  exitAlerts: ExitAlert[];
  partialProfitPlan: PartialProfitLevel[];
  trailingStopPlan: TrailingStopPlan;
  timeManagement: TimeManagement;
  portfolioRisk: PortfolioRiskAssessment;
}

export interface PartialProfitLevel {
  price: number;
  percentToClose: number;    // % of position to close
  reason: string;
}

export interface TrailingStopPlan {
  enabled: boolean;
  method: 'ATR' | 'PERCENTAGE' | 'STRUCTURE';
  activationPrice: number;   // Price at which trailing starts
  trailDistance: number;     // Distance behind price
  currentStop: number;
}

export interface TimeManagement {
  maxHoldMinutes: number;
  firstCheckMinutes: number;  // When to first evaluate the trade
  breakevenDeadlineMinutes: number; // If not in profit by this time, consider exit
  reason: string;
}

export interface PortfolioRiskAssessment {
  totalOpenRisk: number;       // Total $ at risk across all positions
  totalOpenRiskPct: number;    // % of account at risk
  correlationRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  diversificationScore: number; // 0-100
  maxAdditionalRisk: number;   // How much more risk we can take
  reason: string;
}

// === POSITION SIZING: ATR-BASED (Core Method) ===
// Instead of fixed % per trade, use ATR to determine stop distance
// then calculate size so that the dollar risk equals the desired risk %

export function calculateATRBasedSize(params: {
  accountBalance: number;
  riskPerTrade: number;       // % of account to risk (e.g., 1)
  atr: number;                // Current ATR value
  atrMultiplier: number;      // Stop = entry ± (ATR * multiplier), typically 1.5
  entryPrice: number;
  direction: 'HIGHER' | 'LOWER';
  maxPositionSize: number;    // Maximum position in base currency
  maxRiskPerTrade: number;    // Maximum risk % allowed (e.g., 3)
  confluenceScore: number;    // 0-100 from confluence engine
  regimeConfidence: number;   // 0-100 from regime engine
  consecutiveLosses: number;
  edgeClassification: string; // GREEN, YELLOW, RED, GREY
}): DynamicPositionSize {
  const {
    accountBalance, riskPerTrade, atr, atrMultiplier, entryPrice, direction,
    maxPositionSize, maxRiskPerTrade, confluenceScore, regimeConfidence,
    consecutiveLosses, edgeClassification,
  } = params;

  const adjustments: SizingAdjustment[] = [];

  // Step 1: Base risk amount
  let effectiveRisk = Math.min(riskPerTrade, maxRiskPerTrade);
  const baseRiskAmount = accountBalance * (effectiveRisk / 100);

  // Step 2: Calculate stop distance from ATR
  const stopDistance = atr * atrMultiplier;

  // Step 3: Calculate base position size
  const baseSize = stopDistance > 0 ? baseRiskAmount / stopDistance : 0;

  // Step 4: Apply dynamic adjustments
  let adjustedSize = baseSize;

  // Adjustment: Confluence score
  if (confluenceScore < 40) {
    const reduction = 0.5; // Half size for low confluence
    adjustments.push({
      type: 'LOW_CONFLUENCE',
      originalValue: adjustedSize,
      adjustedValue: adjustedSize * reduction,
      reason: `Confluencia baja (${confluenceScore.toFixed(0)}%): reducir tamaño al 50%`,
    });
    adjustedSize *= reduction;
  } else if (confluenceScore >= 80) {
    const boost = 1.25;
    adjustments.push({
      type: 'HIGH_CONFLUENCE',
      originalValue: adjustedSize,
      adjustedValue: adjustedSize * boost,
      reason: `Confluencia alta (${confluenceScore.toFixed(0)}%): aumentar tamaño al 125%`,
    });
    adjustedSize *= boost;
  }

  // Adjustment: Regime confidence
  if (regimeConfidence < 30) {
    const reduction = 0.6;
    adjustments.push({
      type: 'LOW_REGIME_CONFIDENCE',
      originalValue: adjustedSize,
      adjustedValue: adjustedSize * reduction,
      reason: `Confianza de régimen baja (${regimeConfidence.toFixed(0)}%): reducir al 60%`,
    });
    adjustedSize *= reduction;
  }

  // Adjustment: Consecutive losses
  if (consecutiveLosses >= 3) {
    const reduction = 0.5;
    adjustments.push({
      type: 'CONSECUTIVE_LOSSES',
      originalValue: adjustedSize,
      adjustedValue: adjustedSize * reduction,
      reason: `${consecutiveLosses} pérdidas consecutivas: reducir al 50%`,
    });
    adjustedSize *= reduction;
  } else if (consecutiveLosses >= 2) {
    const reduction = 0.75;
    adjustments.push({
      type: 'CONSECUTIVE_LOSSES',
      originalValue: adjustedSize,
      adjustedValue: adjustedSize * reduction,
      reason: `${consecutiveLosses} pérdidas consecutivas: reducir al 75%`,
    });
    adjustedSize *= reduction;
  }

  // Adjustment: Edge classification
  if (edgeClassification === 'YELLOW') {
    const reduction = 0.7;
    adjustments.push({
      type: 'YELLOW_EDGE',
      originalValue: adjustedSize,
      adjustedValue: adjustedSize * reduction,
      reason: 'Edge amarillo: reducir al 70%',
    });
    adjustedSize *= reduction;
  } else if (edgeClassification === 'GREY') {
    const reduction = 0.6;
    adjustments.push({
      type: 'GREY_EDGE',
      originalValue: adjustedSize,
      adjustedValue: adjustedSize * reduction,
      reason: 'Edge gris (sin datos): reducir al 60%',
    });
    adjustedSize *= reduction;
  }

  // Cap at max position size
  if (adjustedSize > maxPositionSize) {
    adjustments.push({
      type: 'MAX_SIZE_CAP',
      originalValue: adjustedSize,
      adjustedValue: maxPositionSize,
      reason: `Tamaño máximo alcanzado: ${maxPositionSize}`,
    });
    adjustedSize = maxPositionSize;
  }

  const sizeUsd = adjustedSize * entryPrice;
  const actualRiskAmount = adjustedSize * stopDistance;
  const actualRiskPct = accountBalance > 0 ? (actualRiskAmount / accountBalance) * 100 : 0;

  // Determine sizing method
  let sizingMethod: DynamicPositionSize['sizingMethod'] = 'ATR_BASED';
  if (adjustments.length >= 3) sizingMethod = 'REDUCED';
  else if (edgeClassification === 'GREEN' && confluenceScore >= 70) sizingMethod = 'KELLY';

  return {
    baseSize: Math.round(baseSize * 1000000) / 1000000,
    adjustedSize: Math.round(adjustedSize * 1000000) / 1000000,
    sizeUsd: Math.round(sizeUsd * 100) / 100,
    riskAmount: Math.round(actualRiskAmount * 100) / 100,
    riskPercent: Math.round(actualRiskPct * 100) / 100,
    sizingMethod,
    adjustments,
  };
}

// === DYNAMIC STOP LOSS ===

export function calculateDynamicStopLoss(params: {
  entryPrice: number;
  direction: 'HIGHER' | 'LOWER';
  atr: number;
  setup: ContextualizedSetup;
  regimeResult: RegimeResult;
  portfolioCorrelationRisk: 'LOW' | 'MEDIUM' | 'HIGH';
}): DynamicStopLoss {
  const { entryPrice, direction, atr, setup, regimeResult, portfolioCorrelationRisk } = params;
  const adjustments: StopAdjustment[] = [];

  // Base stop: ATR * 1.5 (or from setup key levels)
  let originalStop: number;
  let stopType: DynamicStopLoss['stopType'] = 'ATR';

  if (setup.stopLoss) {
    originalStop = setup.stopLoss;
    stopType = 'STRUCTURAL';
  } else {
    if (direction === 'HIGHER') {
      originalStop = entryPrice - atr * 1.5;
    } else {
      originalStop = entryPrice + atr * 1.5;
    }
  }

  let adjustedStop = originalStop;

  // Adjustment: Widen stop in volatile regime
  if (regimeResult.regime === 'VOLATILE') {
    const widenFactor = 1.3;
    const newStop = direction === 'HIGHER'
      ? entryPrice - (entryPrice - originalStop) * widenFactor
      : entryPrice + (originalStop - entryPrice) * widenFactor;
    adjustments.push({
      type: 'VOLATILITY_WIDEN',
      reason: `Régimen volátil: ampliar stop al ${widenFactor}x`,
      originalStop: adjustedStop,
      adjustedStop: newStop,
    });
    adjustedStop = newStop;
  }

  // Adjustment: Tighten stop if high portfolio correlation
  if (portfolioCorrelationRisk === 'HIGH') {
    const tightenFactor = 0.8;
    const newStop = direction === 'HIGHER'
      ? entryPrice - (entryPrice - adjustedStop) * tightenFactor
      : entryPrice + (adjustedStop - entryPrice) * tightenFactor;
    adjustments.push({
      type: 'PORTFOLIO_CORRELATION',
      reason: 'Alta correlación en cartera: acercar stop para limitar riesgo',
      originalStop: adjustedStop,
      adjustedStop: newStop,
    });
    adjustedStop = newStop;
  }

  const stopDistance = Math.abs(entryPrice - adjustedStop);
  const stopDistancePct = (stopDistance / entryPrice) * 100;

  return {
    originalStop,
    adjustedStop,
    stopType,
    stopDistance: Math.round(stopDistance * 100) / 100,
    stopDistancePct: Math.round(stopDistancePct * 1000) / 1000,
    adjustments,
  };
}

// === EXIT ALERTS ===

export function generateExitAlerts(params: {
  setup: ContextualizedSetup;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  regimeResult: RegimeResult;
  minutesInTrade: number;
  maxHoldMinutes: number;
  noTradeAssessment: NoTradeAssessment | null;
}): ExitAlert[] {
  const { setup, entryPrice, currentPrice, stopLoss, takeProfit, regimeResult, minutesInTrade, maxHoldMinutes, noTradeAssessment } = params;
  const alerts: ExitAlert[] = [];

  // Alert: Thesis invalidation
  const isLong = setup.direction === 'HIGHER';
  const pnlPct = isLong
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;

  if (pnlPct < -1) {
    alerts.push({
      type: 'THESIS_INVALIDATED',
      urgency: 'IMMEDIATE',
      reason: `Precio se mueve ${Math.abs(pnlPct).toFixed(1)}% en contra. La thesis del setup puede estar invalidada.`,
      action: `Evaluar cierre manual. Stop en ${stopLoss.toFixed(2)}.`,
      suggestedPrice: currentPrice,
    });
  }

  // Alert: Stop hit
  const stopHit = isLong ? currentPrice <= stopLoss : currentPrice >= stopLoss;
  if (stopHit) {
    alerts.push({
      type: 'STOP_HIT',
      urgency: 'IMMEDIATE',
      reason: `Stop loss alcanzado: ${stopLoss.toFixed(2)}. Cerrar posición inmediatamente.`,
      action: 'CERRAR POSICIÓN',
      suggestedPrice: stopLoss,
    });
  }

  // Alert: Take profit
  const tpHit = isLong ? currentPrice >= takeProfit : currentPrice <= takeProfit;
  if (tpHit) {
    alerts.push({
      type: 'TAKE_PROFIT',
      urgency: 'IMMEDIATE',
      reason: `Take profit alcanzado: ${takeProfit.toFixed(2)}. Cerrar posición o asegurar ganancias.`,
      action: 'CERRAR POSICIÓN o mover stop a breakeven',
      suggestedPrice: takeProfit,
    });
  }

  // Alert: Partial profit at 1:1
  const slDistance = Math.abs(entryPrice - stopLoss);
  const firstTp = isLong ? entryPrice + slDistance : entryPrice - slDistance;
  const firstTpHit = isLong ? currentPrice >= firstTp : currentPrice <= firstTp;
  if (firstTpHit && !tpHit && pnlPct > 0) {
    alerts.push({
      type: 'PARTIAL_PROFIT',
      urgency: 'SOON',
      reason: `Primer objetivo (1:1 R:R) alcanzado en ${firstTp.toFixed(2)}. Considerar cerrar 50% y mover stop a breakeven.`,
      action: 'Cerrar 50% de posición, mover SL a entry',
      suggestedPrice: firstTp,
    });
  }

  // Alert: Time expiration
  if (minutesInTrade >= maxHoldMinutes * 0.8) {
    const remaining = maxHoldMinutes - minutesInTrade;
    alerts.push({
      type: 'TIME_EXPIRED',
      urgency: remaining <= 5 ? 'SOON' : 'WATCH',
      reason: `Tiempo en trade: ${minutesInTrade} min de ${maxHoldMinutes} máx. ${remaining > 0 ? `${remaining} min restantes.` : 'Tiempo expirado.'}`,
      action: remaining <= 5 ? 'Evaluar cierre' : 'Monitorear de cerca',
      suggestedPrice: currentPrice,
    });
  }

  // Alert: Regime change
  if (noTradeAssessment && !noTradeAssessment.canTrade) {
    alerts.push({
      type: 'REGIME_CHANGE',
      urgency: 'SOON',
      reason: `Condiciones de mercado cambiaron: ${noTradeAssessment.blockedBy.join(', ')}. Considerar cierre protector.`,
      action: 'Evaluar cierre de posición para proteger capital',
      suggestedPrice: currentPrice,
    });
  }

  return alerts;
}

// === PARTIAL PROFIT PLAN ===

export function calculatePartialProfitPlan(params: {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'HIGHER' | 'LOWER';
  riskRewardRatio: number;
}): PartialProfitLevel[] {
  const { entryPrice, stopLoss, takeProfit, direction, riskRewardRatio } = params;
  const slDistance = Math.abs(entryPrice - stopLoss);

  const levels: PartialProfitLevel[] = [];

  // Level 1: 1:1 R:R — Close 30%
  const tp1 = direction === 'HIGHER' ? entryPrice + slDistance : entryPrice - slDistance;
  levels.push({
    price: Math.round(tp1 * 100) / 100,
    percentToClose: 30,
    reason: 'Primer objetivo (1:1 R:R): asegurar ganancias parciales, mover stop a breakeven',
  });

  // Level 2: 1.5:1 R:R — Close 30% more
  const tp2 = direction === 'HIGHER' ? entryPrice + slDistance * 1.5 : entryPrice - slDistance * 1.5;
  levels.push({
    price: Math.round(tp2 * 100) / 100,
    percentToClose: 30,
    reason: 'Segundo objetivo (1.5:1 R:R): reducir exposición, dejar correr resto',
  });

  // Level 3: Final TP — Close remaining 40%
  levels.push({
    price: Math.round(takeProfit * 100) / 100,
    percentToClose: 40,
    reason: `Objetivo final (${riskRewardRatio.toFixed(1)}:1 R:R): cerrar posición completa`,
  });

  return levels;
}

// === TRAILING STOP PLAN ===

export function calculateTrailingStopPlan(params: {
  entryPrice: number;
  direction: 'HIGHER' | 'LOWER';
  atr: number;
}): TrailingStopPlan {
  const { entryPrice, direction, atr } = params;

  // Activation: when price moves 1 ATR in our favor
  const activationPrice = direction === 'HIGHER'
    ? entryPrice + atr
    : entryPrice - atr;

  // Trail distance: 1 ATR behind price
  const trailDistance = atr;

  return {
    enabled: true,
    method: 'ATR',
    activationPrice: Math.round(activationPrice * 100) / 100,
    trailDistance: Math.round(trailDistance * 100) / 100,
    currentStop: direction === 'HIGHER'
      ? entryPrice - atr * 1.5 // Initial stop
      : entryPrice + atr * 1.5,
  };
}

// === TIME MANAGEMENT ===

export function calculateTimeManagement(params: {
  timeframe: string;
  confluenceScore: number;
  regimeResult: RegimeResult;
}): TimeManagement {
  const { timeframe, confluenceScore, regimeResult } = params;

  // Base max hold time depends on timeframe
  const tfMinutes: Record<string, number> = {
    'M1': 5, 'M5': 40, 'M15': 90, 'M30': 180, 'H1': 360,
  };
  const baseMaxHold = tfMinutes[timeframe] || 40;

  // Reduce max hold in ranging market (less directional persistence)
  let maxHoldMinutes = baseMaxHold;
  if (regimeResult.regime === 'RANGING') maxHoldMinutes = Math.round(maxHoldMinutes * 0.7);
  if (regimeResult.regime === 'VOLATILE') maxHoldMinutes = Math.round(maxHoldMinutes * 0.8);
  if (regimeResult.regime === 'TRENDING') maxHoldMinutes = Math.round(maxHoldMinutes * 1.2);

  // First check: 25% of max hold time
  const firstCheckMinutes = Math.round(maxHoldMinutes * 0.25);

  // Breakeven deadline: 50% of max hold time
  const breakevenDeadlineMinutes = Math.round(maxHoldMinutes * 0.5);

  const reason = `Máximo ${maxHoldMinutes} min (base ${baseMaxHold}, ajustado por régimen ${regimeResult.regime}). Primera evaluación a ${firstCheckMinutes} min. Deadline breakeven a ${breakevenDeadlineMinutes} min.`;

  return {
    maxHoldMinutes,
    firstCheckMinutes,
    breakevenDeadlineMinutes,
    reason,
  };
}

// === PORTFOLIO RISK ASSESSMENT ===

export function assessPortfolioRisk(params: {
  accountBalance: number;
  openPositions: Array<{
    asset: string;
    direction: string;
    entryPrice: number;
    quantity: number;
    unrealizedPnl: number;
  }>;
  newPosition?: {
    asset: string;
    direction: string;
    riskAmount: number;
  };
}): PortfolioRiskAssessment {
  const { accountBalance, openPositions, newPosition } = params;

  // Calculate total open risk
  const openRisk = openPositions.reduce((sum, p) => {
    // Estimate risk as 2% of position value (conservative)
    const positionValue = p.quantity * p.entryPrice;
    return sum + positionValue * 0.02;
  }, 0);

  const additionalRisk = newPosition?.riskAmount || 0;
  const totalOpenRisk = openRisk + additionalRisk;
  const totalOpenRiskPct = accountBalance > 0 ? (totalOpenRisk / accountBalance) * 100 : 0;

  // Correlation risk: count same-direction positions
  const sameDirectionCount = openPositions.filter(p =>
    p.direction === (newPosition?.direction || 'BUY')
  ).length;

  let correlationRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  if (sameDirectionCount >= 3) correlationRisk = 'HIGH';
  else if (sameDirectionCount >= 2) correlationRisk = 'MEDIUM';
  else correlationRisk = 'LOW';

  // Diversification score
  const uniqueAssets = new Set(openPositions.map(p => p.asset));
  if (newPosition) uniqueAssets.add(newPosition.asset);
  const diversificationScore = Math.min(100, uniqueAssets.size * 25);

  // Max additional risk
  const maxTotalRiskPct = 6; // Max 6% of account at risk total
  const currentRiskPct = accountBalance > 0 ? (openRisk / accountBalance) * 100 : 0;
  const maxAdditionalRisk = Math.max(0, accountBalance * (maxTotalRiskPct / 100) - openRisk);

  const reason = `Riesgo total: ${totalOpenRiskPct.toFixed(1)}% ($${totalOpenRisk.toFixed(2)}). Correlación: ${correlationRisk}. Disponible: $${maxAdditionalRisk.toFixed(2)} más.`;

  return {
    totalOpenRisk: Math.round(totalOpenRisk * 100) / 100,
    totalOpenRiskPct: Math.round(totalOpenRiskPct * 100) / 100,
    correlationRisk,
    diversificationScore,
    maxAdditionalRisk: Math.round(maxAdditionalRisk * 100) / 100,
    reason,
  };
}

// === FULL TRADE MANAGEMENT PLAN ===

export function createTradeManagementPlan(params: {
  setup: ContextualizedSetup;
  accountBalance: number;
  atr: number;
  regimeResult: RegimeResult;
  noTradeAssessment: NoTradeAssessment | null;
  consecutiveLosses: number;
  openPositions: Array<{
    asset: string;
    direction: string;
    entryPrice: number;
    quantity: number;
    unrealizedPnl: number;
  }>;
  timeframe: string;
}): TradeManagementPlan {
  const {
    setup, accountBalance, atr, regimeResult, noTradeAssessment,
    consecutiveLosses, openPositions, timeframe,
  } = params;

  // Position sizing
  const positionSize = calculateATRBasedSize({
    accountBalance,
    riskPerTrade: setup.riskPercent,
    atr,
    atrMultiplier: 1.5,
    entryPrice: setup.entryPrice,
    direction: setup.direction,
    maxPositionSize: setup.suggestedPositionSize * 2, // Allow up to 2x suggested
    maxRiskPerTrade: 3,
    confluenceScore: setup.confluenceScore,
    regimeConfidence: regimeResult.confidence,
    consecutiveLosses,
    edgeClassification: setup.regimeCompatibility === 'OPTIMAL' ? 'GREEN' : 
                       setup.regimeCompatibility === 'COMPATIBLE' ? 'YELLOW' : 'GREY',
  });

  // Portfolio risk assessment
  const portfolioRisk = assessPortfolioRisk({
    accountBalance,
    openPositions,
    newPosition: {
      asset: setup.asset,
      direction: setup.direction === 'HIGHER' ? 'BUY' : 'SELL',
      riskAmount: positionSize.riskAmount,
    },
  });

  // Dynamic stop loss
  const stopLoss = calculateDynamicStopLoss({
    entryPrice: setup.entryPrice,
    direction: setup.direction,
    atr,
    setup,
    regimeResult,
    portfolioCorrelationRisk: portfolioRisk.correlationRisk,
  });

  // Take profit
  const takeProfit = setup.takeProfit;

  // Risk/Reward
  const riskRewardRatio = Math.abs(takeProfit - setup.entryPrice) / stopLoss.stopDistance;

  // Partial profit plan
  const partialProfitPlan = calculatePartialProfitPlan({
    entryPrice: setup.entryPrice,
    stopLoss: stopLoss.adjustedStop,
    takeProfit,
    direction: setup.direction,
    riskRewardRatio,
  });

  // Trailing stop plan
  const trailingStopPlan = calculateTrailingStopPlan({
    entryPrice: setup.entryPrice,
    direction: setup.direction,
    atr,
  });

  // Time management
  const timeManagement = calculateTimeManagement({
    timeframe,
    confluenceScore: setup.confluenceScore,
    regimeResult,
  });

  // Initial exit alerts
  const exitAlerts = generateExitAlerts({
    setup,
    entryPrice: setup.entryPrice,
    currentPrice: setup.entryPrice,
    stopLoss: stopLoss.adjustedStop,
    takeProfit,
    regimeResult,
    minutesInTrade: 0,
    maxHoldMinutes: timeManagement.maxHoldMinutes,
    noTradeAssessment,
  });

  return {
    positionSize,
    stopLoss,
    takeProfit,
    riskRewardRatio,
    exitAlerts,
    partialProfitPlan,
    trailingStopPlan,
    timeManagement,
    portfolioRisk,
  };
}
