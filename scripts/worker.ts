#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — LOCAL WORKER
// Runs on your PC: auto-trader, signal verification, market data seeding
// Connects to the SAME Turso database as the Vercel deployment
// ══════════════════════════════════════════════════════════════════════════════

import { createServer } from 'http';
import { config } from 'dotenv';

// Load .env from project root
config({ path: '../.env' });
config({ path: '.env' });

// ─── Imports from project libs ──────────────────────────────────────────────
import { db, runAutoMigration, withRetry } from '../src/lib/db';
import { evaluateSignal, checkAlerts } from '../src/lib/signals';
import { getLatestPrice as getEngineLatestPrice, getEngineStatus, getCandles as getEngineCandles } from '../src/lib/market-engine';
import { updateSetupStats, runAutoTraderCycle, DEFAULT_CONFIG, generateAutoSignal } from '../src/lib/auto-trader';
import { getExecutionEngine } from '../src/lib/execution-engine';
import { getBrokerClientFromDB, BybitClient } from '../src/lib/broker-client';
import { getOrCreateAccount, updateAccountBalance } from '../src/lib/risk-manager';
import { feedMarketData, getAllSentiments, getSentimentConfidenceAdjustment, refreshPrices, getMarketSummary } from '../src/lib/market-data-feeder';

// ─── Configuration ──────────────────────────────────────────────────────────
const WORKER_PORT = parseInt(process.env.WORKER_PORT || '3111');
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '300000'); // 5 min
const STATUS_PORT = parseInt(process.env.STATUS_PORT || '3112');

// Parse CLI args
const CLI_ARGS = process.argv.slice(2);
const AUTO_START = CLI_ARGS.includes('--auto') || CLI_ARGS.includes('--auto-start') || process.env.AUTO_START === 'true';

// ─── State ──────────────────────────────────────────────────────────────────
interface WorkerState {
  isRunning: boolean;
  lastCycle: string | null;
  lastCycleDurationMs: number;
  totalCycles: number;
  totalSignalsGenerated: number;
  totalSignalsVerified: number;
  totalErrors: number;
  autoTraderEnabled: boolean;
  totalPositionsClosedSLTP: number;
  totalPositionsExpired: number;
  totalBalanceSyncs: number;
  totalMarketDataFeeds: number;
  cycleHistory: Array<{
    time: string;
    duration_ms: number;
    generated: number;
    verified: number;
    errors: number;
  }>;
  engineStatus: {
    connected: boolean;
    sources: Record<string, string>;
    dataQuality: string;
  } | null;
}

const state: WorkerState = {
  isRunning: false,
  lastCycle: null,
  lastCycleDurationMs: 0,
  totalCycles: 0,
  totalSignalsGenerated: 0,
  totalSignalsVerified: 0,
  totalErrors: 0,
  autoTraderEnabled: false,
  totalPositionsClosedSLTP: 0,
  totalPositionsExpired: 0,
  totalBalanceSyncs: 0,
  totalMarketDataFeeds: 0,
  cycleHistory: [],
  engineStatus: null,
};

// ─── Logging ────────────────────────────────────────────────────────────────
function log(level: 'INFO' | 'WARN' | 'ERROR' | 'CYCLE', message: string) {
  const ts = new Date().toISOString();
  const prefix = level === 'CYCLE' ? '🔄' : level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : 'ℹ️';
  console.log(`[${ts}] ${prefix} [${level}] ${message}`);
}

// ─── Phase 1: Verify expired pending signals with REAL prices ───────────────
async function verifyPendingSignals(): Promise<{ closed: number; verified: number; unverifiable: number }> {
  const now = new Date();
  const expiredSignals = await withRetry(
    () => db.signal.findMany({
      where: {
        status: 'PENDING',
        expirationTime: { lte: now },
      },
    }),
    3, 1000, 'verifyPending-findMany'
  );

  let closed = 0;
  let verified = 0;
  let unverifiable = 0;

  for (const signal of expiredSignals) {
    try {
      let exitPrice: number;
      let priceSource: string;

      // 1. Try real market engine
      const engineResult = await getEngineLatestPrice(signal.asset);
      if (engineResult.price > 0 && engineResult.source !== 'FALLBACK') {
        exitPrice = engineResult.price;
        priceSource = engineResult.source;
        verified++;
      } else {
        // 2. Try DB candles
        const { getLatestPrice: getDBPrice } = await import('../src/lib/market-data');
        const dbPrice = await getDBPrice(signal.asset);
        if (dbPrice && dbPrice > 0) {
          exitPrice = dbPrice;
          priceSource = 'DB_CANDLES';
        } else {
          // 3. Mark as unverifiable — NO random guessing
          await withRetry(
            () => db.signal.update({
              where: { id: signal.id },
              data: { status: 'CLOSED', result: 'DRAW', verificationMethod: 'UNVERIFIABLE' },
            }),
            2, 500, 'verify-unverifiable'
          );
          unverifiable++;
          closed++;
          continue;
        }
      }

      // Round for asset type
      if (signal.asset.includes('JPY')) exitPrice = Math.round(exitPrice * 100) / 100;
      else if (signal.asset.includes('BTC') || signal.asset.includes('ETH')) exitPrice = Math.round(exitPrice * 100) / 100;
      else exitPrice = Math.round(exitPrice * 100000) / 100000;

      const priceDifference = Math.round((exitPrice - signal.entryPrice) * 100000) / 100000;
      const result = evaluateSignal(signal.direction, signal.entryPrice, exitPrice);

      let estimatedProfit = signal.estimatedProfit;
      let estimatedLoss = signal.estimatedLoss;
      if (result === 'WIN') {
        estimatedProfit = estimatedProfit || Math.abs(priceDifference);
        estimatedLoss = 0;
      } else if (result === 'LOSS') {
        estimatedProfit = 0;
        estimatedLoss = estimatedLoss || Math.abs(priceDifference);
      }

      await withRetry(
        () => db.signal.update({
          where: { id: signal.id },
          data: {
            exitPrice, result, priceDifference, estimatedProfit, estimatedLoss,
            status: 'CLOSED', verificationMethod: priceSource,
          },
        }),
        2, 500, 'verify-update'
      );

      // Update setup stats for AUTO signals
      if (signal.source === 'AUTO' && result !== 'DRAW') {
        await updateSetupStats({
          patternType: signal.patternType,
          asset: signal.asset,
          sessionType: signal.sessionType,
          timeframe: signal.timeframe,
          result: result || '',
          confidence: signal.confidence,
          setupScore: signal.setupScore,
          expectancy: signal.expectancy,
          riskReward: signal.riskReward,
          qualityScore: signal.qualityScore,
        });
      }

      closed++;
      log('INFO', `Señal ${signal.id.substring(0,8)} ${signal.asset} → ${result} @ ${exitPrice} (${priceSource})`);
    } catch (err: any) {
      log('ERROR', `Error verificando señal ${signal.id}: ${err.message}`);
    }
  }

  // Check alerts after closing
  if (closed > 0) {
    try {
      const allClosed = await db.signal.findMany({
        where: { status: 'CLOSED', result: { not: null } },
        orderBy: { entryTime: 'desc' },
        take: 100,
      });
      const alerts = checkAlerts(allClosed as Parameters<typeof checkAlerts>[0]);
      for (const alert of alerts) {
        const existing = await db.alert.findFirst({
          where: { type: alert.type, isActive: true },
          orderBy: { createdAt: 'desc' },
        });
        if (!existing) {
          await db.alert.create({
            data: { type: alert.type, message: alert.message, severity: alert.severity, isActive: true },
          });
        }
      }
    } catch (err: any) {
      log('WARN', `Error checking alerts: ${err.message}`);
    }
  }

  return { closed, verified, unverifiable };
}

// ─── Phase 2: Run auto-trader cycle ─────────────────────────────────────────
async function runAutoTrader(): Promise<{ generated: number; skipped: number; errors: string[] }> {
  // Check if auto-trader is enabled in DB settings
  const runningSetting = await withRetry(
    () => db.appSettings.findUnique({ where: { key: 'autoTraderRunning' } }),
    3, 1000, 'autoTrader-running'
  );
  state.autoTraderEnabled = runningSetting?.value === 'true';

  if (!state.autoTraderEnabled) {
    return { generated: 0, skipped: 0, errors: ['Auto-Trader desactivado'] };
  }

  const configSetting = await withRetry(
    () => db.appSettings.findUnique({ where: { key: 'autoTraderConfig' } }),
    3, 1000, 'autoTrader-config'
  );
  const config = configSetting ? JSON.parse(configSetting.value) : DEFAULT_CONFIG;

  // ═══ CLEANUP: Close orphaned PENDING signals (no open Position/Trade) ═══
  // These accumulate when Risk Manager rejects trades but signals stay PENDING
  try {
    const orphanedSignals = await db.signal.findMany({
      where: { status: 'PENDING', source: 'AUTO' },
      select: { id: true },
    });

    if (orphanedSignals.length > 0) {
      // Check which ones have an open trade/position
      const signalIds = orphanedSignals.map(s => s.id);
      const openTrades = await db.trade.findMany({
        where: {
          signalId: { in: signalIds },
          status: { in: ['OPEN', 'FILLED'] },
        },
        select: { signalId: true },
      });
      const tradedSignalIds = new Set(openTrades.map(t => t.signalId));

      // Signals without open trades = orphaned
      const orphanedIds = signalIds.filter(id => !tradedSignalIds.has(id));

      if (orphanedIds.length > 0) {
        await db.signal.updateMany({
          where: { id: { in: orphanedIds }, status: 'PENDING' },
          data: {
            status: 'CLOSED',
            result: 'DRAW',
            verificationMethod: 'ORPHAN_CLEANUP',
          },
        });
        log('INFO', `🧹 Cleaned up ${orphanedIds.length} orphaned PENDING signals (no open trade)`);
      }
    }
  } catch (cleanupErr: any) {
    log('WARN', `Signal cleanup failed: ${cleanupErr.message}`);
  }

  // Override maxConcurrentSignals from DB config to 50
  if (config.maxConcurrentSignals && config.maxConcurrentSignals < 50) {
    config.maxConcurrentSignals = 50;
  }

  // ═══ Force maxOpenPositions to 10 in data collection mode ═══
  // The DB default is 3, which is too low for building statistics
  try {
    const account = await getOrCreateAccount();
    if (account.maxOpenPositions < 10) {
      await db.account.update({
        where: { id: account.id },
        data: { maxOpenPositions: 10 },
      });
      log('INFO', `⚙️ maxOpenPositions actualizado: ${account.maxOpenPositions} → 10 (modo recolección)`);
    }
  } catch (err: any) {
    log('WARN', `Could not update maxOpenPositions: ${err.message}`);
  }

  const result = await runAutoTraderCycle(config);

  // Update last check time
  await withRetry(
    () => db.appSettings.upsert({
      where: { key: 'autoTraderLastCheck' },
      create: { key: 'autoTraderLastCheck', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    }),
    2, 500, 'autoTrader-lastCheck'
  );

  return { generated: result.signalsGenerated, skipped: result.signalsSkipped, errors: result.errors };
}

// ─── Phase 2.5: Monitor open positions (SL/TP hits + expiration) ───────────
async function monitorOpenPositions(): Promise<{ closedBySLTP: number; expired: number }> {
  let closedBySLTP = 0;
  let expired = 0;

  // Check if auto-execution is enabled
  const autoExecSetting = await db.appSettings.findUnique({ where: { key: 'autoExecution' } });
  const autoExecEnabled = autoExecSetting ? (JSON.parse(autoExecSetting.value) as { enabled: boolean }).enabled : false;

  if (!autoExecEnabled) {
    // Even without auto-execution, check for open positions that need closing
    // This handles positions that were opened manually or from a previous session
    const openCount = await db.position.count({ where: { status: 'OPEN' } });
    if (openCount === 0) {
      return { closedBySLTP: 0, expired: 0 };
    }
    log('INFO', `  ⚠️ Auto-execution disabled but ${openCount} open positions found — checking anyway`);
  }

  try {
    const engine = getExecutionEngine();

    // Check SL/TP hits first
    try {
      closedBySLTP = await engine.checkStopLossTakeProfit();
      if (closedBySLTP > 0) {
        state.totalPositionsClosedSLTP += closedBySLTP;
        log('INFO', `  🔴 ${closedBySLTP} position(s) closed by SL/TP`);
      }
    } catch (err: any) {
      log('WARN', `  Error checking SL/TP: ${err.message}`);
    }

    // Check expired positions
    try {
      expired = await engine.checkAndCloseExpired();
      if (expired > 0) {
        state.totalPositionsExpired += expired;
        log('INFO', `  ⏰ ${expired} position(s) closed by expiration`);
      }
    } catch (err: any) {
      log('WARN', `  Error checking expired positions: ${err.message}`);
    }
  } catch (err: any) {
    log('WARN', `  Position monitoring error: ${err.message}`);
  }

  return { closedBySLTP, expired };
}

// ─── Phase 3: Seed market data candles ──────────────────────────────────────
async function seedMarketData(): Promise<{ seeded: number; total: number }> {
  const assets = ['EUR/USD', 'GBP/USD', 'BTC/USD', 'ETH/USD', 'USD/JPY'];
  const timeframes = ['M5', 'M15', 'H1', 'H4']; // MTF: seed all timeframes
  let seeded = 0;

  for (const asset of assets) {
    for (const tf of timeframes) {
      try {
        // Check how many candles we already have for this asset+timeframe
        const existingCount = await db.marketCandle.count({
          where: { asset, timeframe: tf },
        });

        if (existingCount >= 200) {
          // We have enough history — just add the latest candle
          const result = await getEngineCandles(asset, tf, 2);
          if (result.candles && result.candles.length > 0) {
            const latest = result.candles[result.candles.length - 1];
            const timestamp = new Date(latest.timestamp);
            try {
              await db.marketCandle.upsert({
                where: {
                  asset_timeframe_timestamp: { asset, timeframe: tf, timestamp },
                },
                create: {
                  asset, timeframe: tf, timestamp,
                  open: latest.open, high: latest.high, low: latest.low,
                  close: latest.close, volume: latest.volume,
                },
                update: {
                  open: latest.open, high: latest.high, low: latest.low,
                  close: latest.close, volume: latest.volume,
                },
              });
              if (tf === 'M5') seeded++; // Count only M5 for the summary
            } catch {
              // Skip DB errors
            }
          }
        } else {
          // Not enough history — seed from engine (CRITICAL for MTF analysis)
          const { seedCandlesFromEngine } = await import('../src/lib/market-data');
          const count = await seedCandlesFromEngine(asset, tf);
          if (count > 0 && tf === 'M5') seeded++;
          if (count > 0) {
            log('INFO', `  📊 ${asset} ${tf}: ${existingCount} velas existentes → sembradas ${count} nuevas`);
          }
        }
      } catch {
        // Skip unavailable assets/timeframes
      }
    }
  }

  return { seeded, total: assets.length };
}

// ─── Phase 3.5: Sync account balance from Bybit ────────────────────────────
async function syncAccountBalance(): Promise<{ synced: boolean; balance?: number; equity?: number }> {
  try {
    const broker = await getBrokerClientFromDB();

    // Only sync if using a real Bybit client (not paper trading)
    if (!(broker instanceof BybitClient)) {
      return { synced: false };
    }

    const accountInfo = await broker.getAccountInfo();
    if (!accountInfo) {
      log('WARN', '  Bybit account info unavailable — skipping balance sync');
      return { synced: false };
    }

    // Update local account record with real balance/equity
    const localAccount = await getOrCreateAccount();
    await updateAccountBalance(
      localAccount.id,
      accountInfo.balance,
      accountInfo.equity,
      accountInfo.unrealizedPnl
    );

    state.totalBalanceSyncs++;
    log('INFO', `  💰 Balance sync: $${accountInfo.balance.toFixed(2)} balance, $${accountInfo.equity.toFixed(2)} equity from Bybit`);

    return { synced: true, balance: accountInfo.balance, equity: accountInfo.equity };
  } catch (err: any) {
    // Paper trading or connection error — skip silently
    return { synced: false };
  }
}

// ─── Phase 4: Engine health check ───────────────────────────────────────────
async function checkEngineHealth(): Promise<void> {
  try {
    const status = await getEngineStatus();
    state.engineStatus = {
      connected: status.connected,
      sources: status.sources || {},
      dataQuality: status.dataQuality,
    };
  } catch {
    state.engineStatus = { connected: false, sources: {}, dataQuality: 'UNKNOWN' };
  }
}

// ─── Main Cycle ─────────────────────────────────────────────────────────────
async function runCycle(): Promise<void> {
  if (state.isRunning) {
    log('WARN', 'Ciclo anterior aún ejecutándose, saltando...');
    return;
  }

  state.isRunning = true;
  const startTime = Date.now();
  log('CYCLE', '═══ Inicio de ciclo ═══');

  // ═══ CLEANUP: Close positions with unrealistic SL/TP (>1.5% from entry) ═══
  // These were created before the SL/TP cap fix and will never close properly
  try {
    const badPositions = await db.position.findMany({ where: { status: 'OPEN' } });
    const toClose: string[] = [];
    for (const pos of badPositions) {
      const entry = pos.entryPrice;
      if (!entry || entry === 0) continue;
      const isCrypto = pos.asset.includes('BTC') || pos.asset.includes('ETH');
      const maxPct = isCrypto ? 0.015 : 0.01; // 1.5% for crypto, 1% for forex
      const slPct = pos.stopLoss ? Math.abs(entry - pos.stopLoss) / entry : 0;
      const tpPct = pos.takeProfit ? Math.abs(entry - pos.takeProfit) / entry : 0;
      if (slPct > maxPct || tpPct > maxPct * 2) { // SL too wide OR TP too wide
        toClose.push(pos.id);
      }
    }
    if (toClose.length > 0) {
      // Close positions and their trades
      for (const posId of toClose) {
        const pos = await db.position.findUnique({ where: { id: posId } });
        if (!pos) continue;
        // Get real price for P&L
        let closePrice = pos.entryPrice; // fallback
        try {
          const broker = await getBrokerClientFromDB();
          const symbol = pos.asset.replace('/', '').replace('USD', 'USDT');
          const lastPrice = await broker.getLastPrice(symbol);
          if (lastPrice) closePrice = lastPrice;
        } catch { /* use entry price */ }

        await db.position.update({
          where: { id: posId },
          data: { status: 'CLOSED', currentPrice: closePrice, unrealizedPnl: 0, closedAt: new Date() },
        });
        // Close linked trade
        if (pos.tradeId) {
          const pnl = pos.direction === 'BUY'
            ? (closePrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - closePrice) * pos.quantity;
          await db.trade.update({
            where: { id: pos.tradeId },
            data: {
              status: 'CLOSED',
              exitPrice: closePrice,
              realizedPnl: pnl,
              realizedPnlPct: pos.entryPrice > 0 ? (pnl / (pos.entryPrice * pos.quantity)) * 100 : 0,
              closedAt: new Date(),
            },
          });
        }
        // Close linked signal
        const trade = pos.tradeId ? await db.trade.findUnique({ where: { id: pos.tradeId } }) : null;
        if (trade?.signalId) {
          const pnl = pos.direction === 'BUY'
            ? (closePrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - closePrice) * pos.quantity;
          await db.signal.update({
            where: { id: trade.signalId },
            data: {
              status: 'CLOSED',
              exitPrice: closePrice,
              result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'DRAW',
              verificationMethod: 'BAD_SLTP_CLEANUP',
            },
          });
        }
      }
      log('INFO', `🧹 Closed ${toClose.length} positions with unrealistic SL/TP (>1.5% SL / >3% TP from entry)`);
    }
  } catch (cleanupErr: any) {
    log('WARN', `Position cleanup failed: ${cleanupErr.message}`);
  }

  let generated = 0;
  let verified = 0;
  let errors = 0;

  // Phase 1: Verify pending signals
  try {
    log('CYCLE', 'Fase 1: Verificando señales pendientes...');
    const verifyResult = await verifyPendingSignals();
    verified = verifyResult.closed;
    state.totalSignalsVerified += verifyResult.verified;
    log('CYCLE', `  → ${verifyResult.closed} cerradas, ${verifyResult.verified} con precio real, ${verifyResult.unverifiable} inverificables`);
  } catch (err: any) {
    log('ERROR', `Fase 1 error: ${err.message}`);
    errors++;
  }

  // Phase 2: Auto-trader
  try {
    log('CYCLE', 'Fase 2: Auto-Trader...');
    const traderResult = await runAutoTrader();
    generated = traderResult.generated;
    state.totalSignalsGenerated += generated;
    log('CYCLE', `  → ${traderResult.generated} generadas, ${traderResult.skipped} omitidas`);
    if (traderResult.errors.length > 0) {
      traderResult.errors.forEach(e => log('WARN', `  ⚠ ${e}`));
      errors += traderResult.errors.length;
    }
  } catch (err: any) {
    log('ERROR', `Fase 2 error: ${err.message}`);
    errors++;
  }

  // Phase 2.5: Monitor open positions (SL/TP + expiration)
  try {
    log('CYCLE', 'Fase 2.5: Monitoreando posiciones abiertas...');
    const monitorResult = await monitorOpenPositions();
    log('CYCLE', `Position monitoring: ${monitorResult.closedBySLTP} closed by SL/TP, ${monitorResult.expired} expired`);
  } catch (err: any) {
    log('ERROR', `Fase 2.5 error: ${err.message}`);
    errors++;
  }

  // Phase 3: Seed market data
  try {
    log('CYCLE', 'Fase 3: Actualizando datos de mercado...');
    const seedResult = await seedMarketData();
    log('CYCLE', `  → ${seedResult.seeded}/${seedResult.total} assets actualizados`);
  } catch (err: any) {
    log('ERROR', `Fase 3 error: ${err.message}`);
    errors++;
  }

  // Phase 3.5: Sync account balance from Bybit
  try {
    log('CYCLE', 'Fase 3.5: Sincronizando balance de cuenta...');
    const syncResult = await syncAccountBalance();
    if (syncResult.synced) {
      log('CYCLE', `Balance sync: $${syncResult.balance!.toFixed(2)} balance, $${syncResult.equity!.toFixed(2)} equity from Bybit`);
    } else {
      log('CYCLE', `  → Balance sync skipped (paper trading or unavailable)`);
    }
  } catch (err: any) {
    // Balance sync failure is non-critical — don't count as error
    log('WARN', `Fase 3.5: Balance sync skipped — ${err.message}`);
  }

  // Phase 4: Health check
  try {
    await checkEngineHealth();
    const activeSources = Object.values(state.engineStatus?.sources || {})
      .filter(s => s !== 'OFFLINE').length;
    log('CYCLE', `Fase 4: Engine ${activeSources} fuentes activas, calidad ${state.engineStatus?.dataQuality}`);
  } catch (err: any) {
    log('ERROR', `Fase 4 error: ${err.message}`);
    errors++;
  }

  // ═══ Phase 5: Feed advanced market data from Bybit ═══
  // Klines (candles), Open Interest, Funding Rate, Order Book, Instruments
  try {
    log('CYCLE', 'Fase 5: Alimentando datos avanzados de mercado...');
    const feedResult = await feedMarketData();
    state.totalMarketDataFeeds++;
    if (feedResult.errors.length > 0) {
      feedResult.errors.slice(0, 3).forEach(e => log('WARN', `  ⚠ ${e}`));
    }

    // Log market summary (includes macro + per-asset sentiment)
    const marketSummary = getMarketSummary();
    log('CYCLE', `  → ${feedResult.candlesUpdated} velas Bybit, ${feedResult.sentimentsUpdated} sentimientos | ${marketSummary}`);
  } catch (err: any) {
    log('WARN', `Fase 5: Market data feed error — ${err.message}`);
    // Non-critical, don't count as error
  }

  const duration = Date.now() - startTime;
  state.totalCycles++;
  state.totalErrors += errors;
  state.lastCycle = new Date().toISOString();
  state.lastCycleDurationMs = duration;

  // Keep last 20 cycles in history
  state.cycleHistory.push({
    time: new Date().toISOString(),
    duration_ms: duration,
    generated,
    verified,
    errors,
  });
  if (state.cycleHistory.length > 20) state.cycleHistory.shift();

  log('CYCLE', `═══ Ciclo completado en ${(duration / 1000).toFixed(1)}s | Generadas: ${generated} | Verificadas: ${verified} | Errores: ${errors} ═══`);
  state.isRunning = false;
}

// ─── Helper: Enable auto-execution in PAPER mode ───────────────────────────
async function enableAutoExecutionPaper(): Promise<void> {
  try {
    await db.appSettings.upsert({
      where: { key: 'autoExecution' },
      create: {
        key: 'autoExecution',
        value: JSON.stringify({ enabled: true, mode: 'PAPER' }),
        description: 'Auto-execution setting — connects signal generation to trade execution',
      },
      update: {
        value: JSON.stringify({ enabled: true, mode: 'PAPER' }),
      },
    });
    log('INFO', '  ✅ Auto-execution habilitado (PAPER mode)');
  } catch (err: any) {
    log('WARN', `  ⚠️ Error habilitando auto-execution: ${err.message}`);
  }
}

// ─── Status HTTP Server ─────────────────────────────────────────────────────
function startStatusServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${STATUS_PORT}`);

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          worker: 'running',
          autoTrader: state.autoTraderEnabled,
          lastCycle: state.lastCycle,
          totalCycles: state.totalCycles,
          positionsClosedSLTP: state.totalPositionsClosedSLTP,
          positionsExpired: state.totalPositionsExpired,
          balanceSyncs: state.totalBalanceSyncs,
          engine: state.engineStatus,
          uptime: process.uptime(),
        }, null, 2));
        return;
      }

      if (url.pathname === '/activate') {
        db.appSettings.upsert({
          where: { key: 'autoTraderRunning' },
          create: { key: 'autoTraderRunning', value: 'true', description: 'Auto-trader running' },
          update: { value: 'true' },
        }).then(async () => {
          state.autoTraderEnabled = true;
          // Also enable auto-execution in PAPER mode
          await enableAutoExecutionPaper();
          log('INFO', '✅ Auto-Trader ACTIVADO vía /activate (auto-execution PAPER enabled)');
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Auto-Trader activado + auto-execution PAPER enabled' }));
        return;
      }

      if (url.pathname === '/deactivate') {
        db.appSettings.upsert({
          where: { key: 'autoTraderRunning' },
          create: { key: 'autoTraderRunning', value: 'false', description: 'Auto-trader stopped' },
          update: { value: 'false' },
        }).then(() => {
          state.autoTraderEnabled = false;
          log('INFO', '🛑 Auto-Trader DESACTIVADO vía /deactivate');
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Auto-Trader desactivado' }));
        return;
      }

      if (url.pathname === '/run-now') {
        log('INFO', '🏃 Ciclo manual solicitado vía /run-now');
        runCycle().catch(err => log('ERROR', `Manual cycle error: ${err.message}`));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Ciclo iniciado' }));
        return;
      }

      // NEW: Set auto-trader config
      if (url.pathname === '/set-config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const config = JSON.parse(body);
            await db.appSettings.upsert({
              where: { key: 'autoTraderConfig' },
              create: { key: 'autoTraderConfig', value: JSON.stringify(config), description: 'Auto-trader configuration' },
              update: { value: JSON.stringify(config) },
            });
            log('INFO', `⚙️ Config actualizada: ${JSON.stringify(config)}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, config }));
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }

      // NEW: Apply optimal config for data collection
      if (url.pathname === '/optimal-config') {
        const optimalConfig = {
          enabled: true,
          assets: ['BTC/USD', 'ETH/USD'], // Only assets with proven backtest edge
          timeframe: 'M5',
          intervalMinutes: 5,
          expirationMinutes: 40, // Backtest-proven optimal (56.8% WR on liquidity_sweep)
          minSetupScore: 15,
          maxConcurrentSignals: 50,
        };
        try {
          await db.appSettings.upsert({
            where: { key: 'autoTraderConfig' },
            create: { key: 'autoTraderConfig', value: JSON.stringify(optimalConfig), description: 'Optimal data collection config' },
            update: { value: JSON.stringify(optimalConfig) },
          });
          // Also enable auto-trader
          await db.appSettings.upsert({
            where: { key: 'autoTraderRunning' },
            create: { key: 'autoTraderRunning', value: 'true', description: 'Auto-trader running' },
            update: { value: 'true' },
          });
          // Also enable auto-execution in PAPER mode
          await enableAutoExecutionPaper();
          state.autoTraderEnabled = true;
          log('INFO', '🎯 Configuración ÓPTIMA aplicada — Modo recolección de datos (auto-execution PAPER enabled)');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Configuración óptima aplicada + auto-execution PAPER', config: optimalConfig }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      // NEW: Force database migration
      if (url.pathname === '/migrate') {
        try {
          log('INFO', '🔄 Migración manual solicitada vía /migrate');
          const result = await runAutoMigration();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      // NEW: Force close ALL open positions (emergency cleanup)
      if (url.pathname === '/force-close-all') {
        try {
          log('INFO', '🧹 Force-close ALL solicitado vía /force-close-all');
          const openPositions = await db.position.findMany({ where: { status: 'OPEN' } });
          const engine = getExecutionEngine();
          let closed = 0;
          for (const pos of openPositions) {
            try {
              await engine.closePosition(pos.id, `FORCE CLOSE via /force-close-all`);
              closed++;
            } catch {
              // Force-close in DB directly
              await db.position.update({
                where: { id: pos.id },
                data: { status: 'CLOSED', closedAt: new Date() },
              });
              closed++;
            }
          }
          log('INFO', `🧹 Force-closed ${closed} positions`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, closed, message: `Closed ${closed} positions` }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      // Default: simple status JSON
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        worker: 'SignalTrader Pro — LOCAL WORKER',
        status: 'running',
        autoTrader: state.autoTraderEnabled,
        lastCycle: state.lastCycle,
        cycleDuration: state.lastCycleDurationMs,
        totalCycles: state.totalCycles,
        signalsGenerated: state.totalSignalsGenerated,
        signalsVerified: state.totalSignalsVerified,
        positionsClosedSLTP: state.totalPositionsClosedSLTP,
        positionsExpired: state.totalPositionsExpired,
        balanceSyncs: state.totalBalanceSyncs,
        errors: state.totalErrors,
        engine: state.engineStatus,
        cycleHistory: state.cycleHistory,
        endpoints: {
          health: '/health',
          activate: '/activate (also enables auto-execution PAPER)',
          deactivate: '/deactivate',
          runNow: '/run-now',
          optimalConfig: '/optimal-config (GET — aplica config óptima)',
          setConfig: '/set-config (POST — config personalizada)',
          migrate: '/migrate (GET — fuerza migración de DB)',
          forceCloseAll: '/force-close-all (GET — cierra TODAS las posiciones abiertas)',
        },
        dashboard: 'https://signal-trade-seven.vercel.app',
      }, null, 2));
    });

    server.on('error', (err: any) => {
      log('WARN', `Status server error: ${err.message}. Continuing without status server.`);
      resolve();
    });

    server.listen(STATUS_PORT, () => {
      log('INFO', `📊 Status server: http://localhost:${STATUS_PORT}`);
      log('INFO', `📋 Health endpoint: http://localhost:${STATUS_PORT}/health`);
      log('INFO', `▶ Activar Auto-Trader: http://localhost:${STATUS_PORT}/activate`);
      resolve();
    });
  });
}

// ─── Startup ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🤖 SignalTrader Pro — LOCAL WORKER');
  console.log('  Conectado a Turso DB → Comparte datos con Vercel');
  console.log('  Dashboard: https://signal-trade-seven.vercel.app');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Test DB connection
  try {
    const { testConnection } = await import('../src/lib/db');
    const dbOk = await testConnection();
    if (!dbOk) {
      log('ERROR', 'No se pudo conectar a Turso DB. Verifica TURSO_DATABASE_URL en .env');
      process.exit(1);
    }
    log('INFO', '✅ Turso DB conectado');
  } catch (err: any) {
    // testConnection might not exist, try a simple query
    try {
      await withRetry(() => db.signal.count(), 2, 500, 'startup-count');
      log('INFO', '✅ Turso DB conectado (count test)');
    } catch {
      log('ERROR', `No se pudo conectar a Turso DB: ${err.message}`);
      process.exit(1);
    }
  }

  // ─── AUTO-MIGRATION: Add missing columns (MTF etc.) ──────────────────────
  try {
    log('INFO', '🔄 Verificando migraciones de base de datos...');
    const migrationResult = await runAutoMigration();
    if (migrationResult.applied.length > 0) {
      log('INFO', `✅ Migración aplicada: ${migrationResult.applied.join(', ')}`);
    } else if (migrationResult.skipped.length > 0) {
      log('INFO', `⏭️ Migración OK (columnas ya existen: ${migrationResult.skipped.join(', ')})`);
    }
    if (migrationResult.errors.length > 0) {
      log('WARN', `⚠️ Errores en migración: ${migrationResult.errors.join('; ')}`);
    }
  } catch (err: any) {
    log('WARN', `Migración automática falló: ${err.message}. Continuando...`);
  }

  // Test market engine
  try {
    await checkEngineHealth();
    const activeSources = Object.values(state.engineStatus?.sources || {}).filter(s => s !== 'OFFLINE').length;
    log('INFO', `✅ Market Engine: ${activeSources} fuentes activas, calidad ${state.engineStatus?.dataQuality}`);
  } catch (err: any) {
    log('WARN', `Market Engine no disponible: ${err.message}`);
  }

  // ─── AUTO-START: Apply optimal config and activate auto-trader automatically ────
  if (AUTO_START) {
    log('INFO', '🚀 AUTO-START: Configurando automáticamente...');

    // Apply optimal config
    const optimalConfig = {
      enabled: true,
      assets: ['BTC/USD', 'ETH/USD'],
      timeframe: 'M5',
      intervalMinutes: 5,
      expirationMinutes: 40,
      minSetupScore: 15,
      maxConcurrentSignals: 50,
      confidenceBoost: 0,
      noOperarThreshold: 20,
      strictMode: true,
    };

    try {
      await db.appSettings.upsert({
        where: { key: 'autoTraderConfig' },
        create: { key: 'autoTraderConfig', value: JSON.stringify(optimalConfig), description: 'Optimal config (auto-start)' },
        update: { value: JSON.stringify(optimalConfig) },
      });
      log('INFO', '  ✅ Config óptima aplicada (strict mode, BTC+ETH, 40min expiry)');
    } catch (err: any) {
      log('WARN', `  ⚠️ Error aplicando config: ${err.message}`);
    }

    // Activate auto-trader
    try {
      await db.appSettings.upsert({
        where: { key: 'autoTraderRunning' },
        create: { key: 'autoTraderRunning', value: 'true', description: 'Auto-trader running' },
        update: { value: 'true' },
      });
      state.autoTraderEnabled = true;
      log('INFO', '  ✅ Auto-Trader ACTIVADO automáticamente');
    } catch (err: any) {
      log('WARN', `  ⚠️ Error activando auto-trader: ${err.message}`);
    }

    // Enable auto-execution in PAPER mode
    await enableAutoExecutionPaper();

    log('INFO', '🚀 AUTO-START completo — Worker listo para operar');
    log('INFO', '');
    log('INFO', '  📊 Proven Edges activos:');
    log('INFO', '    TIER_1: liq_sweep+NY+BTC 66.7%, liq_sweep+Asia+BTC 62.2%, liq_sweep+Overlap+ETH 61.1%');
    log('INFO', '    TIER_2: liq_sweep+NY+ETH 58.2%, liq_sweep+London+BTC 55.7%, fakeout+Asia+ETH 56.5%');
    log('INFO', '  🚫 Patrones bloqueados: breakout, trend_continuation, none');
    log('INFO', '');
  } else {
    // Check auto-trader state from DB
    try {
      const runningSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderRunning' } });
      state.autoTraderEnabled = runningSetting?.value === 'true';
      log('INFO', `Auto-Trader: ${state.autoTraderEnabled ? '✅ ACTIVADO' : '⏹ Desactivado (actívalo con --auto o http://localhost:' + STATUS_PORT + '/activate)'}`);
    } catch {
      log('INFO', `Auto-Trader: ⏹ Desactivado (actívalo con --auto o http://localhost:${STATUS_PORT}/activate)`);
    }
  }

  // Start status server FIRST (keeps process alive)
  await startStatusServer();

  // ═══ CLEANUP: Close stale positions from previous sessions ═══
  // Positions older than 40 min (expiration time) are definitely stale
  try {
    const stalePositions = await db.position.findMany({ where: { status: 'OPEN' } });
    const now = Date.now();
    const STALE_THRESHOLD_MS = 40 * 60 * 1000; // 40 minutes (matches expiration)
    let staleClosed = 0;

    const engine = getExecutionEngine();
    for (const pos of stalePositions) {
      const age = now - new Date(pos.openedAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        try {
          await engine.closePosition(pos.id, `STARTUP CLEANUP: position open ${Math.round(age / 60000)} min (stale from previous session)`);
          staleClosed++;
        } catch (err: any) {
          // Force-close directly in DB if engine fails
          await db.position.update({
            where: { id: pos.id },
            data: { status: 'CLOSED', closedAt: new Date() },
          });
          staleClosed++;
        }
      }
    }

    if (staleClosed > 0) {
      log('INFO', `🧹 CLEANUP: ${staleClosed} posiciones huérfanas cerradas (de sesiones anteriores)`);
    } else if (stalePositions.length > 0) {
      log('INFO', `📊 ${stalePositions.length} posiciones abiertas activas (dentro del expiry)`);
    }
  } catch (err: any) {
    log('WARN', `Cleanup error: ${err.message}`);
  }

  // Run first cycle immediately
  log('INFO', '🏃 Ejecutando primer ciclo...');
  await runCycle();

  // ═══ MID-CYCLE MONITORING ═══
  // Check SL/TP + expiration + safety timeout every 60 seconds between full cycles
  // This is critical for M5 trading with tight stops (0.5-0.8%)
  const MONITOR_INTERVAL_MS = 60000; // 1 minute
  const MAX_POSITION_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours safety timeout
  let monitorRunning = false;

  setInterval(async () => {
    if (monitorRunning || state.isRunning) return; // Don't overlap with full cycle
    try {
      const openCount = await db.position.count({ where: { status: 'OPEN' } });
      if (openCount === 0) return; // Nothing to monitor

      monitorRunning = true;
      const engine = getExecutionEngine();

      // Refresh prices from Bybit for accurate SL/TP checking
      try {
        const freshPrices = await refreshPrices();
        if (freshPrices.size > 0) {
          // Update position mark prices with fresh data
          const openPositions = await db.position.findMany({ where: { status: 'OPEN' } });
          for (const pos of openPositions) {
            const freshPrice = freshPrices.get(pos.asset);
            if (freshPrice && freshPrice > 0) {
              await db.position.update({
                where: { id: pos.id },
                data: { currentPrice: freshPrice },
              });
            }
          }
        }
      } catch { /* price refresh is best-effort */ }

      // Check SL/TP hits (includes trailing stop + breakeven)
      let closed = await engine.checkStopLossTakeProfit();

      // Check expired positions (was missing — positions sat past expiration!)
      try {
        const expired = await engine.checkAndCloseExpired();
        closed += expired;
        if (expired > 0) state.totalPositionsExpired += expired;
      } catch { /* ignore */ }

      // Safety timeout: force-close any position open > 2 hours
      try {
        const stalePositions = await db.position.findMany({ where: { status: 'OPEN' } });
        const now = Date.now();
        for (const pos of stalePositions) {
          const age = now - new Date(pos.openedAt).getTime();
          if (age > MAX_POSITION_AGE_MS) {
            await engine.closePosition(pos.id, `SAFETY TIMEOUT: position open ${Math.round(age / 60000)} min (max 120 min)`);
            closed++;
            log('WARN', `⏰ [MONITOR] Force-closed stale position ${pos.id.substring(0,8)} (${Math.round(age / 60000)} min old)`);
          }
        }
      } catch { /* ignore */ }

      if (closed > 0) {
        state.totalPositionsClosedSLTP += closed;
        log('INFO', `🔴 [MONITOR] ${closed} position(s) closed (mid-cycle: SL/TP/expiry/timeout)`);
      }
      monitorRunning = false;
    } catch (err: any) {
      monitorRunning = false;
      // Silently ignore monitoring errors — don't spam logs
    }
  }, MONITOR_INTERVAL_MS);

  // Schedule recurring cycles
  log('INFO', `⏰ Próximo ciclo en ${CYCLE_INTERVAL_MS / 1000}s (${CYCLE_INTERVAL_MS / 60000} minutos)`);
  log('INFO', `👁️ Monitoreo SL/TP cada ${MONITOR_INTERVAL_MS / 1000}s (entre ciclos)`);
  setInterval(async () => {
    try {
      await runCycle();
    } catch (err: any) {
      log('ERROR', `Error en ciclo programado: ${err.message}`);
    }
  }, CYCLE_INTERVAL_MS);

  // Keep process alive — stdin ref prevents Node from exiting
  if (process.stdin && process.stdin.isTTY) {
    process.stdin.resume();
  }

  // Safety: ensure process never exits silently
  setInterval(() => {
    // Heartbeat — keeps the event loop alive
  }, 30000);

  log('INFO', '');
  log('INFO', '🟢 Worker corriendo. Ctrl+C para detener.');
  log('INFO', '');
}

main().catch(err => {
  log('ERROR', `Fatal: ${err.message}`);
  process.exit(1);
});
