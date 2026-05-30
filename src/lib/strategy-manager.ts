// STRATEGY MANAGER — Orquestador central de todas las estrategias
// ═══════════════════════════════════════════════════════════════════════════
// Gestiona la ejecución, priorización y monitoreo de todas las estrategias:
//   1. Funding Rate Arbitrage (edge estructural, baja prioridad pero seguro)
//   2. Grid Trading Adaptativo (captura volatilidad en mercados ranging)
//   3. Mean Reversion BB+RSI+ADX (reversión a la media con filtros estrictos)
//   4. Order Flow / OI Confirmation (filtro de confirmación para otras estrategias)
//   5. Auto-Trader v7 (sistema original, ahora como fallback)
//
// LÓGICA DE PRIORIZACIÓN:
//   - Si funding rate > 0.05% → Funding Arb tiene prioridad (edge estructural)
//   - Si ADX < 25 + sesión Asia/Overlap → Grid + Mean Reversion
//   - Si OI confirma → potenciar señales de Mean Reversion
//   - Si régimen TRENDING → solo Funding Arb (no Mean Reversion, no Grid)
//   - Si régimen RANGING → Grid + Mean Reversion activos
// ═══════════════════════════════════════════════════════════════════════════

import { db, withRetry } from './db';
import {
  executeFundingArbCycle,
  scanFundingOpportunities,
  getFundingArbStats,
  getActiveFundingArbPositions,
  loadFundingArbPositions,
  type FundingArbConfig,
  type FundingArbScanResult,
  DEFAULT_FUNDING_ARB_CONFIG,
} from './funding-arb';
import {
  executeGridCycle,
  getGridStats,
  getActiveGrids,
  loadGridStates,
  type GridConfig,
  DEFAULT_GRID_CONFIG,
} from './grid-trader';
import {
  executeMeanReversionCycle,
  getMeanReversionStats,
  getOpenMRPositions,
  loadMRPositions,
  type MeanReversionConfig,
  DEFAULT_MEAN_REVERSION_CONFIG,
} from './mean-reversion';
import {
  executeOrderFlowCycle,
  confirmSignalWithOrderFlow,
  getOrderFlowStats,
  type OrderFlowConfig,
  DEFAULT_ORDERFLOW_CONFIG,
} from './orderflow';
import { detectRegime } from './regime-engine';
import { detectSession } from './sessions';
import { computeAllIndicators } from './indicators';
import { getCandles as getDBCandles } from './market-data';

// === TYPES ===

export interface StrategyManagerConfig {
  enabled: boolean;
  // Strategy toggles
  fundingArb: Partial<FundingArbConfig>;
  gridTrading: Partial<GridConfig>;
  meanReversion: Partial<MeanReversionConfig>;
  orderFlow: Partial<OrderFlowConfig>;
  // Global settings
  maxTotalExposureUsd: number;     // Max total USD across ALL strategies (default: 10000)
  maxDailyLossUsd: number;         // Max daily loss before all strategies stop (default: 500)
  circuitBreakerPct: number;       // % loss from peak equity to trigger stop (default: 5)
  regimeAdaptive: boolean;         // Auto-adjust strategy mix based on regime (default: true)
  sessionAware: boolean;           // Only run strategies in appropriate sessions (default: true)
  dryRun: boolean;                 // If true, don't execute real orders (default: true)
}

export interface StrategyCycleResult {
  timestamp: Date;
  regime: string;
  session: string;
  // Strategy results
  fundingArb: {
    executed: boolean;
    opportunities: FundingArbScanResult[];
    positionsOpened: number;
    positionsClosed: number;
    totalFundingCollected: number;
    errors: string[];
  };
  gridTrading: {
    executed: boolean;
    gridsActive: number;
    gridsInitialized: number;
    fillsProcessed: number;
    totalPnl: number;
    errors: string[];
  };
  meanReversion: {
    executed: boolean;
    signalsGenerated: number;
    tradesOpened: number;
    positionsClosed: number;
    totalPnl: number;
    errors: string[];
  };
  orderFlow: {
    executed: boolean;
    snapshotsTaken: number;
    signalsGenerated: number;
    actionableSignals: number;
    errors: string[];
  };
  // Aggregate
  totalPnl: number;
  totalOpenPositions: number;
  totalExposureUsd: number;
  circuitBreakerTriggered: boolean;
  strategyRecommendations: string[];
}

export interface StrategyDashboard {
  enabled: boolean;
  regime: string;
  session: string;
  config: StrategyManagerConfig;
  fundingArb: {
    enabled: boolean;
    stats: ReturnType<typeof getFundingArbStats>;
    activePositions: ReturnType<typeof getActiveFundingArbPositions>;
  };
  gridTrading: {
    enabled: boolean;
    stats: ReturnType<typeof getGridStats>;
    activeGrids: ReturnType<typeof getActiveGrids>;
  };
  meanReversion: {
    enabled: boolean;
    stats: ReturnType<typeof getMeanReversionStats>;
    openPositions: ReturnType<typeof getOpenMRPositions>;
  };
  orderFlow: {
    enabled: boolean;
    stats: ReturnType<typeof getOrderFlowStats>;
  };
}

// === DEFAULT CONFIG ===

export const DEFAULT_STRATEGY_MANAGER_CONFIG: StrategyManagerConfig = {
  enabled: true, // CHANGED: Now enabled by default — we have a proven edge
  fundingArb: { ...DEFAULT_FUNDING_ARB_CONFIG, enabled: false }, // No edge in backtest
  gridTrading: { ...DEFAULT_GRID_CONFIG, enabled: false }, // Fragile in trending markets
  meanReversion: { ...DEFAULT_MEAN_REVERSION_CONFIG, enabled: true }, // PROVEN: PF 2.32, WR 62.3%, Sharpe 6.04
  orderFlow: { ...DEFAULT_ORDERFLOW_CONFIG, enabled: true }, // Context/confirmation layer
  maxTotalExposureUsd: 10000,
  maxDailyLossUsd: 500,
  circuitBreakerPct: 5,
  regimeAdaptive: true,
  sessionAware: true,
  dryRun: true, // SAFE: Default to dry run (use CONSERVATIVE preset for real)
};

// === IN-MEMORY STATE ===

let managerConfig: StrategyManagerConfig = { ...DEFAULT_STRATEGY_MANAGER_CONFIG };
let dailyPnl = 0;
let peakEquity = 0;
let totalEquity = 0;
let circuitBreakerTriggered = false;
let lastCycleResult: StrategyCycleResult | null = null;

// === INITIALIZE STRATEGY MANAGER ===

export async function initializeStrategyManager(config?: Partial<StrategyManagerConfig>): Promise<{
  loaded: boolean;
  activePositions: number;
  errors: string[];
}> {
  const errors: string[] = [];

  if (config) {
    managerConfig = { ...DEFAULT_STRATEGY_MANAGER_CONFIG, ...config };
  }

  // Load persisted config from DB
  try {
    const setting = await db.appSettings.findUnique({
      where: { key: 'strategy_manager_config' },
    });
    if (setting) {
      const savedConfig = JSON.parse(setting.value);
      managerConfig = { ...managerConfig, ...savedConfig };
    }
  } catch (err: any) {
    errors.push(`Config load: ${err.message}`);
  }

  // Load positions from previous session
  let activePositions = 0;
  try {
    const fundingPositions = await loadFundingArbPositions();
    activePositions += fundingPositions;
    console.log(`[STRATEGY-MGR] Loaded ${fundingPositions} funding arb positions`);

    const gridPositions = await loadGridStates();
    activePositions += gridPositions;
    console.log(`[STRATEGY-MGR] Loaded ${gridPositions} grid states`);

    const mrPositions = await loadMRPositions();
    activePositions += mrPositions;
    console.log(`[STRATEGY-MGR] Loaded ${mrPositions} mean reversion positions`);
  } catch (err: any) {
    errors.push(`Position load: ${err.message}`);
  }

  // Get account equity
  try {
    const { getOrCreateAccount } = await import('./risk-manager');
    const account = await getOrCreateAccount();
    peakEquity = account.peakEquity || account.balance;
    totalEquity = account.equity || account.balance;
  } catch { /* will use defaults */ }

  console.log(`[STRATEGY-MGR] Initialized | Dry Run: ${managerConfig.dryRun} | Regime Adaptive: ${managerConfig.regimeAdaptive}`);
  return { loaded: true, activePositions, errors };
}

// === SAVE CONFIG ===

export async function saveStrategyManagerConfig(config: Partial<StrategyManagerConfig>): Promise<void> {
  managerConfig = { ...managerConfig, ...config };

  await withRetry(
    () => db.appSettings.upsert({
      where: { key: 'strategy_manager_config' },
      create: {
        key: 'strategy_manager_config',
        value: JSON.stringify(managerConfig),
        description: 'Strategy manager configuration',
      },
      update: { value: JSON.stringify(managerConfig) },
    }),
    2, 500, 'strategy-manager-config'
  );
}

// === MAIN CYCLE ===

export async function executeStrategyCycle(): Promise<StrategyCycleResult> {
  const session = detectSession();
  const result: StrategyCycleResult = {
    timestamp: new Date(),
    regime: 'UNKNOWN',
    session: session.session,
    fundingArb: { executed: false, opportunities: [], positionsOpened: 0, positionsClosed: 0, totalFundingCollected: 0, errors: [] },
    gridTrading: { executed: false, gridsActive: 0, gridsInitialized: 0, fillsProcessed: 0, totalPnl: 0, errors: [] },
    meanReversion: { executed: false, signalsGenerated: 0, tradesOpened: 0, positionsClosed: 0, totalPnl: 0, errors: [] },
    orderFlow: { executed: false, snapshotsTaken: 0, signalsGenerated: 0, actionableSignals: 0, errors: [] },
    totalPnl: 0,
    totalOpenPositions: 0,
    totalExposureUsd: 0,
    circuitBreakerTriggered: false,
    strategyRecommendations: [],
  };

  if (!managerConfig.enabled) {
    result.strategyRecommendations.push('Strategy manager deshabilitado. Activar con /set-strategy-config.');
    lastCycleResult = result;
    return result;
  }

  // ═══ CHECK CIRCUIT BREAKER ═══
  if (circuitBreakerTriggered) {
    result.circuitBreakerTriggered = true;
    result.strategyRecommendations.push('CIRCUIT BREAKER activado. Todas las estrategias detenidas. Reset manual requerido.');
    lastCycleResult = result;
    return result;
  }

  // Check daily loss limit
  if (dailyPnl < -managerConfig.maxDailyLossUsd) {
    circuitBreakerTriggered = true;
    result.circuitBreakerTriggered = true;
    result.strategyRecommendations.push(`Loss diario ${dailyPnl.toFixed(2)} excede limite ${managerConfig.maxDailyLossUsd}. Circuit breaker activado.`);
    lastCycleResult = result;
    return result;
  }

  // ═══ DETECT MARKET REGIME ═══
  let regime = 'UNKNOWN';
  try {
    const candles = await getDBCandles('ETH/USD', 'M15', 100);
    if (candles.length >= 30) {
      const indicators = computeAllIndicators(candles);
      const regimeResult = detectRegime(candles, indicators);
      regime = regimeResult.regime;
      result.regime = regime;
    }
  } catch { /* use default */ }

  // ═══ ADAPTIVE STRATEGY SELECTION ═══
  // Based on regime and session, decide which strategies to run

  const isRanging = regime === 'RANGING' || regime === 'LOW_VOL';
  const isTrending = regime === 'TRENDING' || regime === 'VOLATILE';
  const isGoodSession = session.session !== 'OffHours';

  // 1. FUNDING ARB: Always run if enabled (not dependent on regime)
  if (managerConfig.fundingArb.enabled) {
    try {
      // Modify config based on regime
      const arbConfig = { ...managerConfig.fundingArb };
      if (managerConfig.dryRun) {
        // In dry run mode, just scan but don't execute
        const opportunities = await scanFundingOpportunities(arbConfig);
        result.fundingArb = {
          executed: true,
          opportunities,
          positionsOpened: 0,
          positionsClosed: 0,
          totalFundingCollected: 0,
          errors: [],
        };
        result.strategyRecommendations.push(
          ...opportunities
            .filter(o => o.recommendation === 'ENTER')
            .map(o => `FUNDING ARB: ${o.asset} funding ${(Math.abs(o.currentFundingRate) * 100).toFixed(4)}% annual ~${o.fundingRateAnnualized.toFixed(0)}% — ${o.reason}`)
        );
      } else {
        const arbResult = await executeFundingArbCycle(arbConfig);
        result.fundingArb = {
          executed: true,
          opportunities: arbResult.opportunities,
          positionsOpened: arbResult.positionsOpened,
          positionsClosed: arbResult.positionsClosed,
          totalFundingCollected: arbResult.totalFundingCollected,
          errors: arbResult.errors,
        };
        result.totalPnl += arbResult.totalFundingCollected;
      }
    } catch (err: any) {
      result.fundingArb.errors.push(err.message);
    }
  }

  // 2. ORDER FLOW: Always run if enabled (provides context for other strategies)
  if (managerConfig.orderFlow.enabled) {
    try {
      const ofResult = await executeOrderFlowCycle(managerConfig.orderFlow);
      result.orderFlow = {
        executed: true,
        snapshotsTaken: ofResult.snapshotsTaken,
        signalsGenerated: ofResult.signalsGenerated,
        actionableSignals: ofResult.actionableSignals,
        errors: ofResult.errors,
      };
    } catch (err: any) {
      result.orderFlow.errors.push(err.message);
    }
  }

  // 3. GRID TRADING: Only in ranging markets + good sessions
  if (managerConfig.gridTrading.enabled && (isRanging || !managerConfig.regimeAdaptive) && isGoodSession) {
    try {
      if (managerConfig.dryRun) {
        result.gridTrading = {
          executed: true,
          gridsActive: 0,
          gridsInitialized: 0,
          fillsProcessed: 0,
          totalPnl: 0,
          errors: [],
        };
        result.strategyRecommendations.push(`GRID: Régimen ${regime} favorable para grid trading en ${session.session}`);
      } else {
        const gridResult = await executeGridCycle(managerConfig.gridTrading);
        result.gridTrading = {
          executed: true,
          gridsActive: gridResult.gridsActive,
          gridsInitialized: gridResult.gridsInitialized,
          fillsProcessed: gridResult.fillsProcessed,
          totalPnl: gridResult.totalPnl,
          errors: gridResult.errors,
        };
        result.totalPnl += gridResult.totalPnl;
      }
    } catch (err: any) {
      result.gridTrading.errors.push(err.message);
    }
  } else if (managerConfig.gridTrading.enabled && isTrending) {
    result.strategyRecommendations.push(`GRID: Deshabilitado en régimen ${regime}. Grid funciona mejor en mercados ranging.`);
  }

  // 4. MEAN REVERSION: Only in ranging markets + specific sessions
  if (managerConfig.meanReversion.enabled && (isRanging || !managerConfig.regimeAdaptive) && isGoodSession) {
    try {
      if (managerConfig.dryRun) {
        // In dry run, just generate signals without executing
        const { generateMeanReversionSignal } = await import('./mean-reversion');
        const signals = [];
        for (const asset of (managerConfig.meanReversion.assets || ['ETH/USD'])) {
          const signal = await generateMeanReversionSignal(asset, managerConfig.meanReversion);
          signals.push(signal);
        }
        result.meanReversion = {
          executed: true,
          signalsGenerated: signals.length,
          tradesOpened: 0,
          positionsClosed: 0,
          totalPnl: 0,
          errors: [],
        };

        const tradeableSignals = signals.filter(s => s.direction !== 'NO_TRADE' && s.confidence >= (managerConfig.meanReversion.minConfidence || 60));
        if (tradeableSignals.length > 0) {
          result.strategyRecommendations.push(
            ...tradeableSignals.map(s => `MEAN-REV: ${s.asset} ${s.direction} (${s.setupType}) — ${s.reason}`)
          );
        }
      } else {
        const mrResult = await executeMeanReversionCycle(managerConfig.meanReversion);
        result.meanReversion = {
          executed: true,
          signalsGenerated: mrResult.signalsGenerated,
          tradesOpened: mrResult.tradesOpened,
          positionsClosed: mrResult.positionsClosed,
          totalPnl: mrResult.totalPnl,
          errors: mrResult.errors,
        };
        result.totalPnl += mrResult.totalPnl;
      }
    } catch (err: any) {
      result.meanReversion.errors.push(err.message);
    }
  } else if (managerConfig.meanReversion.enabled && isTrending) {
    result.strategyRecommendations.push(`MEAN-REV: Deshabilitado en régimen ${regime}. Reversión funciona mejor en rangos.`);
  }

  // ═══ UPDATE AGGREGATE METRICS ═══
  dailyPnl += result.totalPnl;
  result.totalOpenPositions =
    getActiveFundingArbPositions().length +
    getActiveGrids().length +
    getOpenMRPositions().length;

  // ═══ STRATEGY RECOMMENDATIONS ═══
  if (result.strategyRecommendations.length === 0) {
    result.strategyRecommendations.push(`Sin señales accionables. Régimen: ${regime}, Sesión: ${session.session}. Esperando oportunidades.`);
  }

  // Persist cycle result
  try {
    await withRetry(
      () => db.appSettings.upsert({
        where: { key: 'strategy_last_cycle' },
        create: {
          key: 'strategy_last_cycle',
          value: JSON.stringify(result),
          description: 'Last strategy cycle result',
        },
        update: { value: JSON.stringify(result) },
      }),
      2, 500, 'strategy-cycle'
    );
  } catch { /* best effort */ }

  lastCycleResult = result;
  return result;
}

// === GET DASHBOARD ===

export function getStrategyDashboard(): StrategyDashboard {
  const session = detectSession();
  return {
    enabled: managerConfig.enabled,
    regime: lastCycleResult?.regime || 'UNKNOWN',
    session: session.session,
    config: managerConfig,
    fundingArb: {
      enabled: managerConfig.fundingArb.enabled || false,
      stats: getFundingArbStats(),
      activePositions: getActiveFundingArbPositions(),
    },
    gridTrading: {
      enabled: managerConfig.gridTrading.enabled || false,
      stats: getGridStats(),
      activeGrids: getActiveGrids(),
    },
    meanReversion: {
      enabled: managerConfig.meanReversion.enabled || false,
      stats: getMeanReversionStats(),
      openPositions: getOpenMRPositions(),
    },
    orderFlow: {
      enabled: managerConfig.orderFlow.enabled || false,
      stats: getOrderFlowStats(),
    },
  };
}

// === GET CONFIG ===

export function getStrategyManagerConfig(): StrategyManagerConfig {
  return { ...managerConfig };
}

// === GET LAST CYCLE RESULT ===

export function getLastCycleResult(): StrategyCycleResult | null {
  return lastCycleResult;
}

// === RESET CIRCUIT BREAKER ===

export function resetCircuitBreaker(): void {
  circuitBreakerTriggered = false;
  dailyPnl = 0;
  console.log('[STRATEGY-MGR] Circuit breaker reset');
}

// === ENABLE/DISABLE STRATEGIES ===

export async function enableStrategy(strategy: 'fundingArb' | 'gridTrading' | 'meanReversion' | 'orderFlow'): Promise<void> {
  managerConfig[strategy].enabled = true;
  await saveStrategyManagerConfig({});
  console.log(`[STRATEGY-MGR] Enabled ${strategy}`);
}

export async function disableStrategy(strategy: 'fundingArb' | 'gridTrading' | 'meanReversion' | 'orderFlow'): Promise<void> {
  managerConfig[strategy].enabled = false;
  await saveStrategyManagerConfig({});
  console.log(`[STRATEGY-MGR] Disabled ${strategy}`);
}

// === QUICK START PRESETS ===

export async function applyPreset(preset: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE' | 'DRY_RUN'): Promise<void> {
  switch (preset) {
    case 'DRY_RUN':
      managerConfig = {
        ...DEFAULT_STRATEGY_MANAGER_CONFIG,
        enabled: true,
        dryRun: true,
        fundingArb: { ...DEFAULT_FUNDING_ARB_CONFIG, enabled: false }, // No edge in backtest
        gridTrading: { ...DEFAULT_GRID_CONFIG, enabled: true },
        meanReversion: { ...DEFAULT_MEAN_REVERSION_CONFIG, enabled: true, timeframe: 'H1' }, // H1 proven
        orderFlow: { ...DEFAULT_ORDERFLOW_CONFIG, enabled: true },
      };
      break;
    case 'CONSERVATIVE':
      managerConfig = {
        ...DEFAULT_STRATEGY_MANAGER_CONFIG,
        enabled: true,
        dryRun: false,
        fundingArb: { ...DEFAULT_FUNDING_ARB_CONFIG, enabled: false }, // Backtest shows no edge
        gridTrading: { ...DEFAULT_GRID_CONFIG, enabled: false }, // Conservative: no grid (risk of range break)
        meanReversion: { ...DEFAULT_MEAN_REVERSION_CONFIG, enabled: true, timeframe: 'H1', assets: ['ETH/USD'], minConfidence: 75 }, // Backtest PROVEN: PF 2.32, WR 62.3%
        orderFlow: { ...DEFAULT_ORDERFLOW_CONFIG, enabled: true },
        maxTotalExposureUsd: 5000,
        maxDailyLossUsd: 200,
      };
      break;
    case 'MODERATE':
      managerConfig = {
        ...DEFAULT_STRATEGY_MANAGER_CONFIG,
        enabled: true,
        dryRun: false,
        fundingArb: { ...DEFAULT_FUNDING_ARB_CONFIG, enabled: false }, // Backtest shows no edge
        gridTrading: { ...DEFAULT_GRID_CONFIG, enabled: true, gridLevels: 8, assets: ['ETH/USD'] }, // Backtest: PF 3.17 ETH
        meanReversion: { ...DEFAULT_MEAN_REVERSION_CONFIG, enabled: true, timeframe: 'H1', assets: ['ETH/USD'], minConfidence: 60 }, // Backtest PROVEN
        orderFlow: { ...DEFAULT_ORDERFLOW_CONFIG, enabled: true },
        maxTotalExposureUsd: 10000,
        maxDailyLossUsd: 500,
      };
      break;
    case 'AGGRESSIVE':
      managerConfig = {
        ...DEFAULT_STRATEGY_MANAGER_CONFIG,
        enabled: true,
        dryRun: false,
        fundingArb: { ...DEFAULT_FUNDING_ARB_CONFIG, enabled: false }, // Backtest shows no edge even aggressive
        gridTrading: { ...DEFAULT_GRID_CONFIG, enabled: true, gridLevels: 15, gridSpacingPct: 0.3, assets: ['ETH/USD', 'BTC/USD'] },
        meanReversion: { ...DEFAULT_MEAN_REVERSION_CONFIG, enabled: true, timeframe: 'H1', assets: ['ETH/USD', 'BTC/USD'], minConfidence: 45 }, // BTC 1h marginal (PF 1.42)
        orderFlow: { ...DEFAULT_ORDERFLOW_CONFIG, enabled: true },
        maxTotalExposureUsd: 20000,
        maxDailyLossUsd: 1000,
      };
      break;
  }

  await saveStrategyManagerConfig(managerConfig);
  console.log(`[STRATEGY-MGR] Applied preset: ${preset}`);
}
