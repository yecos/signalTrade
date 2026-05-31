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
import { db, runAutoMigration, withRetry, startDbKeepalive } from '../src/lib/db';
import { evaluateSignal, checkAlerts } from '../src/lib/signals';
import { getLatestPrice as getEngineLatestPrice, getEngineStatus, getCandles as getEngineCandles } from '../src/lib/market-engine';
import { updateSetupStats, runAutoTraderCycle, DEFAULT_CONFIG, generateAutoSignal } from '../src/lib/auto-trader';
import { getExecutionEngine } from '../src/lib/execution-engine';
import { getBrokerClientFromDB, BybitClient, assetToSymbol } from '../src/lib/broker-client';
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
// ═══ DISABLED: Old pattern-based auto-trader (v7) has NO EDGE ═══
// Backtests v3-v7 proved pattern strategies (liq_sweep, fakeout, breakout, etc.)
// have 25-34% WR and -91% to -100% returns. DISABLED permanently.
// Only the Strategy Manager (Phase 6) with Mean Reversion generates signals.
// This function is kept ONLY for: cleanup of orphaned signals + position limit sync.
async function runAutoTrader(): Promise<{ generated: number; skipped: number; errors: string[] }> {
  // ═══ PERMANENTLY DISABLE pattern-based auto-trader ═══
  // Set the flag to false regardless of DB setting
  state.autoTraderEnabled = false;

  // Ensure DB also reflects this
  try {
    await withRetry(
      () => db.appSettings.upsert({
        where: { key: 'autoTraderRunning' },
        create: { key: 'autoTraderRunning', value: 'false', description: 'Pattern-based auto-trader PERMANENTLY DISABLED (no edge)' },
        update: { value: 'false' },
      }),
      2, 500, 'autoTrader-disable'
    );
  } catch { /* best effort */ }

  const config = DEFAULT_CONFIG;

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

  // ═══ SKIP runAutoTraderCycle — pattern strategies have NO EDGE ═══
  // The old auto-trader cycle generated signals from: breakout, liq_sweep,
  // engulfing, fakeout, reversal, trend_continuation, momentum_shift
  // ALL of these have been backtested and proven unprofitable.
  // Only Mean Reversion ETHUSDT 1H has proven edge (PF 2.32, WR 62.3%).
  // That runs in Phase 6 (Strategy Manager).

  // ═══ Sync position limit to BOTH account table AND riskConfig ═══
  // BUG FIX: Previously only updated account.maxOpenPositions, but the risk
  // manager reads from appSettings.riskConfig.maxOpenPositions — so the limit
  // was never actually changed. Now we update BOTH.
  //
  // Since backtest v8.1 proved Mean Reversion ETHUSDT 1H as the winner,
  // we reduce from 8 → 5 positions (don't need data collection on unproven
  // patterns anymore — focus on the proven edge)
  const EFFECTIVE_MAX_POSITIONS = 5;
  try {
    // 1. Update account table (for display/status)
    const account = await getOrCreateAccount();
    if (account.maxOpenPositions !== EFFECTIVE_MAX_POSITIONS) {
      await db.account.update({
        where: { id: account.id },
        data: { maxOpenPositions: EFFECTIVE_MAX_POSITIONS },
      });
      log('INFO', `⚙️ account.maxOpenPositions: ${account.maxOpenPositions} → ${EFFECTIVE_MAX_POSITIONS}`);
    }
    // 2. Update riskConfig in appSettings (the one actually used for enforcement)
    const riskConfigSetting = await db.appSettings.findUnique({ where: { key: 'riskConfig' } });
    if (riskConfigSetting) {
      const riskConfig = JSON.parse(riskConfigSetting.value);
      if (riskConfig.maxOpenPositions !== EFFECTIVE_MAX_POSITIONS) {
        riskConfig.maxOpenPositions = EFFECTIVE_MAX_POSITIONS;
        await db.appSettings.update({
          where: { key: 'riskConfig' },
          data: { value: JSON.stringify(riskConfig) },
        });
        log('INFO', `⚙️ riskConfig.maxOpenPositions: → ${EFFECTIVE_MAX_POSITIONS} (enforcement fixed)`);
      }
    } else {
      // No riskConfig yet — create one with the correct limit
      await db.appSettings.upsert({
        where: { key: 'riskConfig' },
        create: { key: 'riskConfig', value: JSON.stringify({ maxOpenPositions: EFFECTIVE_MAX_POSITIONS }), description: 'Risk management configuration' },
        update: { value: JSON.stringify({ maxOpenPositions: EFFECTIVE_MAX_POSITIONS }) },
      });
      log('INFO', `⚙️ riskConfig created with maxOpenPositions: ${EFFECTIVE_MAX_POSITIONS}`);
    }
  } catch (err: any) {
    log('WARN', `Could not sync position limit: ${err.message}`);
  }

  // ═══ CLEANUP ONLY: Close orphaned PENDING signals from old auto-trader ═══
  // These accumulate when the old system generated signals that were never executed
  log('INFO', '  🚫 Auto-trader viejo DESACTIVADO (patrones sin edge). Solo Strategy Manager genera señales.');

  // Update last check time
  await withRetry(
    () => db.appSettings.upsert({
      where: { key: 'autoTraderLastCheck' },
      create: { key: 'autoTraderLastCheck', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    }),
    2, 500, 'autoTrader-lastCheck'
  );

  return { generated: 0, skipped: 0, errors: ['Auto-trader viejo DESACTIVADO permanentemente (patrones sin edge)'] };
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

// ─── Phase 3: Seed market data candles (OPTIMIZED — only seed when needed) ──
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
        } else if (existingCount >= 50) {
          // Have some history — only fetch latest 20 candles (not full seed)
          const result = await getEngineCandles(asset, tf, 20);
          if (result.candles && result.candles.length > 0) {
            let upserted = 0;
            for (const candle of result.candles) {
              const timestamp = new Date(candle.timestamp);
              try {
                await db.marketCandle.upsert({
                  where: { asset_timeframe_timestamp: { asset, timeframe: tf, timestamp } },
                  create: {
                    asset, timeframe: tf, timestamp,
                    open: candle.open, high: candle.high, low: candle.low,
                    close: candle.close, volume: candle.volume,
                  },
                  update: {
                    open: candle.open, high: candle.high, low: candle.low,
                    close: candle.close, volume: candle.volume,
                  },
                });
                upserted++;
              } catch { /* skip */ }
            }
            if (upserted > 0 && tf === 'M5') seeded++;
            log('INFO', `  📊 ${asset} ${tf}: ${existingCount} velas → +${upserted} incrementales`);
          }
        } else {
          // Not enough history (< 50) — seed from engine (CRITICAL for MTF analysis)
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
          const symbol = assetToSymbol(pos.asset);
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

  // ═══ PHASE TIMING — identify bottlenecks ═══
  const phaseTimes: Record<string, number> = {};

  // Phase 1: Verify pending signals
  try {
    const t0 = Date.now();
    log('CYCLE', 'Fase 1: Verificando señales pendientes...');
    const verifyResult = await verifyPendingSignals();
    verified = verifyResult.closed;
    state.totalSignalsVerified += verifyResult.verified;
    phaseTimes['P1'] = Date.now() - t0;
    log('CYCLE', `  → ${verifyResult.closed} cerradas, ${verifyResult.verified} con precio real, ${verifyResult.unverifiable} inverificables [${phaseTimes['P1']}ms]`);
  } catch (err: any) {
    log('ERROR', `Fase 1 error: ${err.message}`);
    errors++;
  }

  // Phase 2: Auto-trader
  try {
    const t0 = Date.now();
    log('CYCLE', 'Fase 2: Auto-Trader...');
    const traderResult = await runAutoTrader();
    generated = traderResult.generated;
    state.totalSignalsGenerated += generated;
    phaseTimes['P2'] = Date.now() - t0;
    log('CYCLE', `  → ${traderResult.generated} generadas, ${traderResult.skipped} omitidas [${phaseTimes['P2']}ms]`);
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
    const t0 = Date.now();
    log('CYCLE', 'Fase 2.5: Monitoreando posiciones abiertas...');
    const monitorResult = await monitorOpenPositions();
    phaseTimes['P2.5'] = Date.now() - t0;
    log('CYCLE', `Position monitoring: ${monitorResult.closedBySLTP} closed by SL/TP, ${monitorResult.expired} expired [${phaseTimes['P2.5']}ms]`);
  } catch (err: any) {
    log('ERROR', `Fase 2.5 error: ${err.message}`);
    errors++;
  }

  // Phase 3: Seed market data
  try {
    const t0 = Date.now();
    log('CYCLE', 'Fase 3: Actualizando datos de mercado...');
    const seedResult = await seedMarketData();
    phaseTimes['P3'] = Date.now() - t0;
    log('CYCLE', `  → ${seedResult.seeded}/${seedResult.total} assets actualizados [${phaseTimes['P3']}ms]`);
  } catch (err: any) {
    log('ERROR', `Fase 3 error: ${err.message}`);
    errors++;
  }

  // Phase 3.5: Sync account balance from Bybit
  try {
    const t0 = Date.now();
    log('CYCLE', 'Fase 3.5: Sincronizando balance de cuenta...');
    const syncResult = await syncAccountBalance();
    phaseTimes['P3.5'] = Date.now() - t0;
    if (syncResult.synced) {
      log('CYCLE', `Balance sync: $${syncResult.balance!.toFixed(2)} balance, $${syncResult.equity!.toFixed(2)} equity from Bybit [${phaseTimes['P3.5']}ms]`);
    } else {
      log('CYCLE', `  → Balance sync skipped (paper trading or unavailable) [${phaseTimes['P3.5']}ms]`);
    }
  } catch (err: any) {
    // Balance sync failure is non-critical — don't count as error
    log('WARN', `Fase 3.5: Balance sync skipped — ${err.message}`);
  }

  // Phase 4: Health check
  try {
    const t0 = Date.now();
    await checkEngineHealth();
    const activeSources = Object.values(state.engineStatus?.sources || {})
      .filter(s => s !== 'OFFLINE').length;
    phaseTimes['P4'] = Date.now() - t0;
    log('CYCLE', `Fase 4: Engine ${activeSources} fuentes activas, calidad ${state.engineStatus?.dataQuality} [${phaseTimes['P4']}ms]`);
  } catch (err: any) {
    log('ERROR', `Fase 4 error: ${err.message}`);
    errors++;
  }

  // ═══ Phase 5: Feed advanced market data from Bybit ═══
  // Klines (candles), Open Interest, Funding Rate, Order Book, Instruments
  try {
    const t0 = Date.now();
    log('CYCLE', 'Fase 5: Alimentando datos avanzados de mercado...');
    const feedResult = await feedMarketData();
    state.totalMarketDataFeeds++;
    phaseTimes['P5'] = Date.now() - t0;
    if (feedResult.errors.length > 0) {
      feedResult.errors.slice(0, 3).forEach(e => log('WARN', `  ⚠ ${e}`));
    }

    // Log market summary (includes macro + per-asset sentiment)
    const marketSummary = getMarketSummary();
    log('CYCLE', `  → ${feedResult.candlesUpdated} velas Bybit, ${feedResult.sentimentsUpdated} sentimientos | ${marketSummary} [${phaseTimes['P5']}ms]`);
  } catch (err: any) {
    log('WARN', `Fase 5: Market data feed error — ${err.message}`);
    // Non-critical, don't count as error
  }

  // ═══ Phase 6: NEW STRATEGY ENGINE (v8) ═══
  // Funding Arb + Grid Trading + Mean Reversion + Order Flow
  // + AI Market Analyzer for adaptive parameter adjustment
  try {
    const t0 = Date.now();
    log('CYCLE', 'Fase 6: Strategy Manager (Mean Reversion + IA adaptativa)...');
    const { executeStrategyCycle, getStrategyManagerConfig } = await import('../src/lib/strategy-manager');
    const strategyConfig = getStrategyManagerConfig();

    if (strategyConfig.enabled) {
      const strategyResult = await executeStrategyCycle();
      phaseTimes['P6'] = Date.now() - t0;

      // Log strategy results
      if (strategyResult.fundingArb.executed) {
        log('CYCLE', `  → Funding Arb: ${strategyResult.fundingArb.opportunities.length} oportunidades, ${strategyResult.fundingArb.positionsOpened} abiertas, $${strategyResult.fundingArb.totalFundingCollected.toFixed(2)} cobrado`);
      }
      if (strategyResult.gridTrading.executed) {
        log('CYCLE', `  → Grid Trading: ${strategyResult.gridTrading.gridsActive} grids activos, ${strategyResult.gridTrading.fillsProcessed} fills, $${strategyResult.gridTrading.totalPnl.toFixed(2)} P&L`);
      }
      if (strategyResult.meanReversion.executed) {
        log('CYCLE', `  → Mean Reversion: ${strategyResult.meanReversion.signalsGenerated} señales, ${strategyResult.meanReversion.tradesOpened} trades, $${strategyResult.meanReversion.totalPnl.toFixed(2)} P&L`);
      }
      if (strategyResult.orderFlow.executed) {
        log('CYCLE', `  → Order Flow: ${strategyResult.orderFlow.snapshotsTaken} snapshots, ${strategyResult.orderFlow.actionableSignals} señales accionables`);
      }

      // Log recommendations
      for (const rec of strategyResult.strategyRecommendations) {
        log('INFO', `  💡 ${rec}`);
      }

      // ═══ Log AI Market Analyzer Status ═══
      try {
        const { getCachedAnalysis } = await import('../src/lib/ai-market-analyzer');
        const aiAnalysis = getCachedAnalysis();
        if (aiAnalysis) {
          log('INFO', `  🤖 IA: Régimen ${aiAnalysis.aiRegime} (${aiAnalysis.aiRegimeConfidence}%) | Riesgo ${aiAnalysis.riskLevel} | Size ${aiAnalysis.positionSizeMultiplier * 100}% | ${aiAnalysis.shouldTrade ? 'OPERAR' : 'NO operar'}`);
          if (aiAnalysis.walkForwardValid) {
            log('INFO', `  📊 Walk-Forward: WR ${aiAnalysis.walkForwardWinRate.toFixed(1)}%, PF ${aiAnalysis.walkForwardProfitFactor.toFixed(2)} — Edge válido`);
          } else {
            log('WARN', `  ⚠️ Walk-Forward: WR ${aiAnalysis.walkForwardWinRate.toFixed(1)}%, PF ${aiAnalysis.walkForwardProfitFactor.toFixed(2)} — Edge CUESTIONABLE`);
          }
          if (aiAnalysis.detectedEvents.length > 0) {
            for (const evt of aiAnalysis.detectedEvents) {
              log('INFO', `  📰 Evento: ${evt.type} (${evt.impact}) — ${evt.description}`);
            }
          }
          // Log AI parameter adjustments if different from defaults
          const adj = aiAnalysis.suggestedAdjustments;
          const changes: string[] = [];
          if (adj.rsiOversold.value !== 30) changes.push(`RSI=${adj.rsiOversold.value}`);
          if (adj.adxMaxRange.value !== 25) changes.push(`ADX=${adj.adxMaxRange.value}`);
          if (adj.volumeConfirmMin.value !== 1.2) changes.push(`Vol=${adj.volumeConfirmMin.value}x`);
          if (adj.stopLossATRMultiplier.value !== 1.5) changes.push(`SL=${adj.stopLossATRMultiplier.value}xATR`);
          if (adj.minConfidence.value !== 60) changes.push(`Conf=${adj.minConfidence.value}%`);
          if (changes.length > 0) {
            log('INFO', `  ⚙️ IA Ajustes: ${changes.join(' | ')}`);
          }
        } else {
          log('INFO', `  🤖 IA: Sin análisis cacheado (se generará en el próximo ciclo)`);
        }
      } catch (aiErr: any) {
        log('WARN', `  🤖 IA: Error obteniendo análisis — ${aiErr.message}`);
      }

      if (strategyResult.circuitBreakerTriggered) {
        log('ERROR', '🚨 CIRCUIT BREAKER ACTIVADO — Todas las estrategias detenidas');
      }
      log('CYCLE', `  → Strategy Manager [${phaseTimes['P6']}ms]`);
    } else {
      phaseTimes['P6'] = Date.now() - t0;
      log('CYCLE', `  → Strategy Manager deshabilitado. Activar con /set-strategy-config [${phaseTimes['P6']}ms]`);
    }
  } catch (err: any) {
    log('WARN', `Fase 6: Strategy Manager error — ${err.message}`);
    // Non-critical, don't count as error — strategies are new and may have issues
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

  // ═══ PHASE TIMING SUMMARY — identify slow phases ═══
  const timingSummary = Object.entries(phaseTimes)
    .sort(([, a], [, b]) => b - a) // Sort by time descending (slowest first)
    .map(([phase, ms]) => `${phase}:${(ms / 1000).toFixed(1)}s`)
    .join(' | ');
  log('CYCLE', `⏱️ Timing: ${timingSummary} | Total: ${(duration / 1000).toFixed(1)}s`);
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
          autoTraderV7: false,  // PERMANENTLY DISABLED (no edge)
          strategyManager: true,  // Mean Reversion ETHUSDT 1H active
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
        // ═══ PROTECTED: Old auto-trader V7 is PERMANENTLY DISABLED (no edge) ═══
        // This endpoint now only enables auto-execution for Strategy Manager (Mean Reversion)
        // It does NOT re-enable the old pattern-based auto-trader
        try {
          // Enable auto-execution in PAPER mode for Strategy Manager
          await enableAutoExecutionPaper();
          // DO NOT set autoTraderRunning = 'true' or state.autoTraderEnabled = true
          // The old auto-trader stays disabled — runAutoTrader() enforces this each cycle
          log('INFO', '✅ Auto-execution (PAPER) activado vía /activate — Strategy Manager opera, Auto-Trader V7 sigue DESACTIVADO');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Auto-execution PAPER activado. Auto-Trader V7 permanece DESACTIVADO (sin edge). Solo Strategy Manager genera señales.' }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
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
          // DO NOT enable old auto-trader (permanently disabled — no edge)
          // Only enable auto-execution for Strategy Manager
          await enableAutoExecutionPaper();
          // state.autoTraderEnabled stays false — old auto-trader is dead
          log('INFO', '🎯 Configuración ÓPTIMA aplicada — Auto-execution PAPER activado (Auto-Trader V7 sigue DESACTIVADO)');
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
          let closed = 0;
          
          for (const pos of openPositions) {
            try {
              const engine = getExecutionEngine();
              await engine.closePosition(pos.id, `FORCE CLOSE via /force-close-all`);
              closed++;
            } catch {
              try {
                if (pos.tradeId) {
                  await db.trade.update({
                    where: { id: pos.tradeId },
                    data: { status: 'CLOSED', exitPrice: pos.currentPrice || pos.entryPrice, closedAt: new Date() },
                  });
                }
                const trade = pos.tradeId ? await db.trade.findUnique({ where: { id: pos.tradeId } }) : null;
                if (trade?.signalId) {
                  await db.signal.update({
                    where: { id: trade.signalId },
                    data: { status: 'CLOSED', verificationMethod: 'FORCE_CLOSE_ALL' },
                  });
                }
                await db.position.update({
                  where: { id: pos.id },
                  data: { status: 'CLOSED', closedAt: new Date() },
                });
                closed++;
              } catch (dbErr: any) {
                log('WARN', `  Could not force-close position ${pos.id}: ${dbErr.message}`);
              }
            }
          }
          
          const remainingOpen = await db.position.count({ where: { status: 'OPEN' } });
          if (remainingOpen > 0) {
            await db.position.updateMany({
              where: { status: 'OPEN' },
              data: { status: 'CLOSED', closedAt: new Date() },
            });
            await db.trade.updateMany({
              where: { status: 'OPEN' },
              data: { status: 'CLOSED', closedAt: new Date() },
            });
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

      // ═══ NEW STRATEGY ENDPOINTS (v8) ═══

      // Get strategy dashboard
      if (url.pathname === '/strategies') {
        try {
          const { getStrategyDashboard } = await import('../src/lib/strategy-manager');
          const dashboard = getStrategyDashboard();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(dashboard, null, 2));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Set strategy config (POST)
      if (url.pathname === '/set-strategy-config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const config = JSON.parse(body);
            const { saveStrategyManagerConfig } = await import('../src/lib/strategy-manager');
            await saveStrategyManagerConfig(config);
            log('INFO', `⚙️ Strategy config actualizada: ${JSON.stringify(config)}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, config }));
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }

      // Apply strategy preset
      if (url.pathname === '/strategy-preset') {
        const preset = url.searchParams.get('preset') as 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE' | 'DRY_RUN' | null;
        if (!preset || !['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE', 'DRY_RUN'].includes(preset)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid preset. Use: CONSERVATIVE, MODERATE, AGGRESSIVE, DRY_RUN' }));
          return;
        }
        try {
          const { applyPreset } = await import('../src/lib/strategy-manager');
          await applyPreset(preset);
          log('INFO', `🎯 Strategy preset aplicado: ${preset}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, preset, message: `Preset ${preset} aplicado` }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      // Enable/disable individual strategy
      if (url.pathname === '/toggle-strategy') {
        const strategy = url.searchParams.get('strategy') as 'fundingArb' | 'gridTrading' | 'meanReversion' | 'orderFlow' | null;
        const action = url.searchParams.get('action') as 'enable' | 'disable' | null;
        if (!strategy || !action || !['fundingArb', 'gridTrading', 'meanReversion', 'orderFlow'].includes(strategy)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid params. Use: ?strategy=fundingArb|gridTrading|meanReversion|orderFlow&action=enable|disable' }));
          return;
        }
        try {
          const { enableStrategy, disableStrategy } = await import('../src/lib/strategy-manager');
          if (action === 'enable') await enableStrategy(strategy);
          else await disableStrategy(strategy);
          log('INFO', `${action === 'enable' ? '✅' : '🛑'} Strategy ${strategy} ${action === 'enable' ? 'habilitada' : 'deshabilitada'}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, strategy, action }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      // Reset circuit breaker
      if (url.pathname === '/reset-circuit-breaker') {
        try {
          const { resetCircuitBreaker } = await import('../src/lib/strategy-manager');
          resetCircuitBreaker();
          log('INFO', '🔄 Circuit breaker reset');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Circuit breaker reset' }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      // ═══ AI MARKET ANALYZER ENDPOINTS ═══

      // Get AI analysis (cached, no LLM call)
      if (url.pathname === '/ai-analysis') {
        try {
          const { getCachedAnalysis } = await import('../src/lib/ai-market-analyzer');
          const analysis = getCachedAnalysis();
          if (analysis) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(analysis, null, 2));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'No hay análisis de IA disponible. Se generará en el próximo ciclo.', hint: 'Usa /ai-refresh para forzar un análisis.' }));
          }
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Force AI analysis refresh (calls LLM)
      if (url.pathname === '/ai-refresh') {
        try {
          const { getAIMarketAnalysis, forceRefreshAnalysis } = await import('../src/lib/ai-market-analyzer');
          forceRefreshAnalysis();
          log('INFO', '🤖 AI analysis refresh requested');
          const analysis = await getAIMarketAnalysis('ETH/USD');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            message: 'Análisis de IA actualizado',
            regime: analysis.aiRegime,
            confidence: analysis.aiRegimeConfidence,
            riskLevel: analysis.riskLevel,
            positionSizeMultiplier: analysis.positionSizeMultiplier,
            shouldTrade: analysis.shouldTrade,
            walkForwardValid: analysis.walkForwardValid,
            walkForwardWinRate: analysis.walkForwardWinRate,
            adjustments: analysis.suggestedAdjustments,
            events: analysis.detectedEvents,
            reasoning: analysis.overallReasoning,
          }, null, 2));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Scan funding opportunities (read-only, no execution)
      if (url.pathname === '/funding-scan') {
        try {
          const { scanFundingOpportunities } = await import('../src/lib/funding-arb');
          const opportunities = await scanFundingOpportunities();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(opportunities, null, 2));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Mean reversion signal scan (read-only, no execution)
      if (url.pathname === '/mean-reversion-scan') {
        try {
          const { generateMeanReversionSignal } = await import('../src/lib/mean-reversion');
          const signals = [];
          for (const asset of ['BTC/USD', 'ETH/USD']) {
            const signal = await generateMeanReversionSignal(asset);
            signals.push(signal);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(signals, null, 2));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
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
          strategies: '/strategies (GET — dashboard de estrategias)',
          strategyPreset: '/strategy-preset?preset=DRY_RUN|CONSERVATIVE|MODERATE|AGGRESSIVE',
          toggleStrategy: '/toggle-strategy?strategy=fundingArb|gridTrading|meanReversion|orderFlow&action=enable|disable',
          fundingScan: '/funding-scan (GET — escanear funding rates)',
          meanReversionScan: '/mean-reversion-scan (GET — escanear señales mean reversion)',
          aiAnalysis: '/ai-analysis (GET — ver análisis de IA)',
          aiRefresh: '/ai-refresh (GET — forzar nuevo análisis de IA)',
          resetCircuitBreaker: '/reset-circuit-breaker (GET)',
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
    const { testConnection, startDbKeepalive } = await import('../src/lib/db');
    const dbOk = await testConnection();
    if (!dbOk) {
      log('ERROR', 'No se pudo conectar a Turso DB. Verifica TURSO_DATABASE_URL en .env');
      process.exit(1);
    }
    log('INFO', '✅ Turso DB conectado');
    // Start keepalive to prevent cold connections
    startDbKeepalive();
  } catch (err: any) {
    // testConnection might not exist, try a simple query
    try {
      await withRetry(() => db.signal.count(), 2, 500, 'startup-count');
      log('INFO', '✅ Turso DB conectado (count test)');
      // Start keepalive
      const { startDbKeepalive } = await import('../src/lib/db');
      startDbKeepalive();
    } catch {
      log('ERROR', `No se pudo conectar a Turso DB: ${err.message}`);
      process.exit(1);
    }
  }

  // ─── START DB KEEPALIVE ──────────────────────────────────────────────
  // Periodically pings Turso to prevent idle connection drops
  startDbKeepalive(120_000); // Every 2 minutes

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

    // ═══ DISABLE old auto-trader (v7 patterns have NO EDGE) ═══
    // The pattern-based system (v3-v7) has 25-34% WR and -91% to -100% returns.
    // Only the Strategy Manager with Mean Reversion ETHUSDT 1H has proven edge.
    try {
      await db.appSettings.upsert({
        where: { key: 'autoTraderRunning' },
        create: { key: 'autoTraderRunning', value: 'false', description: 'Auto-trader disabled — using Strategy Manager instead' },
        update: { value: 'false' },
      });
      state.autoTraderEnabled = false;
      log('INFO', '  ⏹ Auto-Trader V7 DESACTIVADO (patrones sin edge)');
    } catch (err: any) {
      log('WARN', `  ⚠️ Error desactivando auto-trader: ${err.message}`);
    }

    // ═══ ACTIVATE Strategy Manager with Mean Reversion ═══
    try {
      const { applyPreset } = await import('../src/lib/strategy-manager');
      // DRY_RUN preset: scans + generates signals but uses PaperTradingClient
      await applyPreset('DRY_RUN');
      log('INFO', '  ⭐ Strategy Manager ACTIVADO — Mean Reversion ETHUSDT 1H (paper trading)');
    } catch (err: any) {
      log('WARN', `  ⚠️ Error activando Strategy Manager: ${err.message}`);
    }

    // Enable auto-execution in PAPER mode
    await enableAutoExecutionPaper();

    // ═══ INITIALIZE AI MARKET ANALYZER ═══
    // Loads cached analysis + walk-forward trade history from DB
    try {
      const { loadAIAnalyzerState } = await import('../src/lib/ai-market-analyzer');
      await loadAIAnalyzerState();
      log('INFO', '  🤖 AI Market Analyzer cargado (análisis adaptativo cada 30 min)');
    } catch (err: any) {
      log('WARN', `  ⚠️ AI Analyzer init falló: ${err.message}. Se usarán parámetros por defecto.`);
    }

    log('INFO', '🚀 AUTO-START completo — Worker listo para operar');
    log('INFO', '');
    log('INFO', '  📊 ESTRATEGIA ACTIVA:');
    log('INFO', '    ⭐ Mean Reversion ETHUSDT 1H — PF 2.32, WR 62.3%, Sharpe 6.04');
    log('INFO', '    🤖 IA Adaptativa — Ajusta parámetros según condiciones del mercado');
    log('INFO', '    ✅ Paper Trading (sin capital real)');
    log('INFO', '    ❌ Auto-Trader V7 DESACTIVADO (sin edge probado)');
    log('INFO', '');
    log('INFO', '  💡 Comandos:');
    log('INFO', '    /strategies           → Ver dashboard de estrategias');
    log('INFO', '    /strategy-preset?preset=CONSERVATIVE → Operar con capital real');
    log('INFO', '');
  } else {
    // ═══ Non-auto mode: still configure for proven strategy ═══
    // Check auto-trader state from DB, but recommend Strategy Manager
    try {
      const runningSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderRunning' } });
      state.autoTraderEnabled = runningSetting?.value === 'true';

      if (state.autoTraderEnabled) {
        // Auto-trader is on — warn that it has no edge, suggest disabling
        log('INFO', `⚠️ Auto-Trader V7 está ACTIVADO pero NO tiene edge probado (25-34% WR)`);
        log('INFO', `💡 Recomendado: desactívalo y usa el Strategy Manager:`);
        log('INFO', `   curl http://localhost:${STATUS_PORT}/strategy-preset?preset=DRY_RUN`);
      } else {
        log('INFO', `Auto-Trader V7: ⏹ Desactivado`);
      }
    } catch {
      log('INFO', `Auto-Trader V7: ⏹ Desactivado`);
    }

    // Check if Strategy Manager is already configured
    try {
      const { getStrategyManagerConfig, applyPreset, initializeStrategyManager } = await import('../src/lib/strategy-manager');
      const initResult = await initializeStrategyManager();
      const strategyConfig = getStrategyManagerConfig();

      if (strategyConfig.enabled && strategyConfig.meanReversion.enabled) {
        log('INFO', `⭐ Strategy Manager: ✅ ACTIVADO — Mean Reversion ETHUSDT 1H`);
      } else {
        log('INFO', `Strategy Manager: ⏹ No configurado. Actívalo con:`);
        log('INFO', `   curl http://localhost:${STATUS_PORT}/strategy-preset?preset=DRY_RUN`);
      }
    } catch (err: any) {
      log('WARN', `Strategy Manager check failed: ${err.message}`);
    }

    // Initialize AI Analyzer (non-auto mode)
    try {
      const { loadAIAnalyzerState } = await import('../src/lib/ai-market-analyzer');
      await loadAIAnalyzerState();
      log('INFO', '🤖 AI Market Analyzer cargado');
    } catch (err: any) {
      log('WARN', `AI Analyzer init falló: ${err.message}`);
    }
  }

  // Start status server FIRST (keeps process alive)
  await startStatusServer();

  // ═══ CLEANUP: Close ALL open positions on fresh start ═══
  // When starting with --auto, any existing OPEN positions are from a previous
  // worker session that was interrupted. They can't be properly monitored anymore
  // (their SL/TP/expiry context is stale). Close them all for a clean start.
  try {
    const openPositions = await db.position.findMany({ where: { status: 'OPEN' } });

    if (openPositions.length > 0) {
      log('INFO', `🧹 CLEANUP: Encontradas ${openPositions.length} posiciones abiertas de sesiones anteriores...`);

      if (AUTO_START) {
        // With --auto: close ALL positions (fresh start)
        const engine = getExecutionEngine();
        let closed = 0;
        for (const pos of openPositions) {
          try {
            await engine.closePosition(pos.id, `STARTUP CLEANUP: fresh start (--auto mode)`);
            closed++;
          } catch {
            // Force-close directly in DB if engine fails
            await db.position.update({
              where: { id: pos.id },
              data: { status: 'CLOSED', closedAt: new Date() },
            });
            closed++;
          }
        }
        // Also close any associated OPEN trades
        const openTrades = await db.trade.findMany({ where: { status: 'OPEN' } });
        for (const trade of openTrades) {
          try {
            await db.trade.update({
              where: { id: trade.id },
              data: { status: 'CLOSED' },
            });
          } catch { /* ignore */ }
        }
        log('INFO', `🧹 CLEANUP: ${closed} posiciones cerradas + ${openTrades.length} trades limpiados (sesión limpia)`);
      } else {
        // Without --auto: close ALL positions from previous sessions.
        // FIX: Previously only closed positions >40 min old, but this caused
        // the "10/10 stuck" bug — positions pile up because each restart only
        // cleans old ones, new ones get created, and the limit is reached
        // before any age out. Now we close ALL positions since they're from
        // a previous worker session that was interrupted and can't be properly
        // monitored anymore (their SL/TP/expiry context is stale).
        const engine = getExecutionEngine();
        let staleClosed = 0;
        for (const pos of openPositions) {
          try {
            await engine.closePosition(pos.id, `STARTUP CLEANUP: position from previous session`);
            staleClosed++;
          } catch {
            // Force-close directly in DB if engine fails
            await db.position.update({
              where: { id: pos.id },
              data: { status: 'CLOSED', closedAt: new Date() },
            });
            staleClosed++;
          }
        }
        // Also close any associated OPEN trades
        const openTrades = await db.trade.findMany({ where: { status: 'OPEN' } });
        for (const trade of openTrades) {
          try {
            await db.trade.update({
              where: { id: trade.id },
              data: { status: 'CLOSED' },
            });
          } catch { /* ignore */ }
        }
        if (staleClosed > 0) {
          log('INFO', `🧹 CLEANUP: ${staleClosed} posiciones de sesión anterior cerradas + ${openTrades.length} trades limpiados`);
        } else {
          log('INFO', `📊 Sin posiciones abiertas de sesiones anteriores`);
        }
      }
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
