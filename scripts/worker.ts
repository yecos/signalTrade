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
import { db } from '../src/lib/db';
import { evaluateSignal, checkAlerts } from '../src/lib/signals';
import { getLatestPrice as getEngineLatestPrice, getEngineStatus, getCandles as getEngineCandles } from '../src/lib/market-engine';
import { updateSetupStats, runAutoTraderCycle, DEFAULT_CONFIG, generateAutoSignal } from '../src/lib/auto-trader';

// ─── Configuration ──────────────────────────────────────────────────────────
const WORKER_PORT = parseInt(process.env.WORKER_PORT || '3111');
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '300000'); // 5 min
const STATUS_PORT = parseInt(process.env.STATUS_PORT || '3112');

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
  const expiredSignals = await db.signal.findMany({
    where: {
      status: 'PENDING',
      expirationTime: { lte: now },
    },
  });

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
          await db.signal.update({
            where: { id: signal.id },
            data: { status: 'CLOSED', result: 'DRAW', verificationMethod: 'UNVERIFIABLE' },
          });
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

      await db.signal.update({
        where: { id: signal.id },
        data: {
          exitPrice, result, priceDifference, estimatedProfit, estimatedLoss,
          status: 'CLOSED', verificationMethod: priceSource,
        },
      });

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
  const runningSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderRunning' } });
  state.autoTraderEnabled = runningSetting?.value === 'true';

  if (!state.autoTraderEnabled) {
    return { generated: 0, skipped: 0, errors: ['Auto-Trader desactivado'] };
  }

  const configSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderConfig' } });
  const config = configSetting ? JSON.parse(configSetting.value) : DEFAULT_CONFIG;

  const result = await runAutoTraderCycle(config);

  // Update last check time
  await db.appSettings.upsert({
    where: { key: 'autoTraderLastCheck' },
    create: { key: 'autoTraderLastCheck', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });

  return { generated: result.signalsGenerated, skipped: result.signalsSkipped, errors: result.errors };
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

  // Phase 3: Seed market data
  try {
    log('CYCLE', 'Fase 3: Actualizando datos de mercado...');
    const seedResult = await seedMarketData();
    log('CYCLE', `  → ${seedResult.seeded}/${seedResult.total} assets actualizados`);
  } catch (err: any) {
    log('ERROR', `Fase 3 error: ${err.message}`);
    errors++;
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
        }).then(() => {
          state.autoTraderEnabled = true;
          log('INFO', '✅ Auto-Trader ACTIVADO vía /activate');
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Auto-Trader activado' }));
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
          assets: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'BTC/USD', 'ETH/USD'],
          timeframe: 'M5',
          intervalMinutes: 5,
          minSetupScore: 15,
          maxConcurrentSignals: 20,
          confidenceBoost: 0,
          noOperarThreshold: 20,
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
          state.autoTraderEnabled = true;
          log('INFO', '🎯 Configuración ÓPTIMA aplicada — Modo recolección de datos');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Configuración óptima aplicada', config: optimalConfig }));
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
        errors: state.totalErrors,
        engine: state.engineStatus,
        cycleHistory: state.cycleHistory,
        endpoints: {
          health: '/health',
          activate: '/activate',
          deactivate: '/deactivate',
          runNow: '/run-now',
          optimalConfig: '/optimal-config (GET — aplica config óptima)',
          setConfig: '/set-config (POST — config personalizada)',
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
      await db.signal.count();
      log('INFO', '✅ Turso DB conectado (count test)');
    } catch {
      log('ERROR', `No se pudo conectar a Turso DB: ${err.message}`);
      process.exit(1);
    }
  }

  // Test market engine
  try {
    await checkEngineHealth();
    const activeSources = Object.values(state.engineStatus?.sources || {}).filter(s => s !== 'OFFLINE').length;
    log('INFO', `✅ Market Engine: ${activeSources} fuentes activas, calidad ${state.engineStatus?.dataQuality}`);
  } catch (err: any) {
    log('WARN', `Market Engine no disponible: ${err.message}`);
  }

  // Check auto-trader state from DB
  try {
    const runningSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderRunning' } });
    state.autoTraderEnabled = runningSetting?.value === 'true';
    log('INFO', `Auto-Trader: ${state.autoTraderEnabled ? '✅ ACTIVADO' : '⏹ Desactivado (actívalo en http://localhost:' + STATUS_PORT + '/activate)'}`);
  } catch {
    log('INFO', `Auto-Trader: ⏹ Desactivado (actívalo en http://localhost:${STATUS_PORT}/activate)`);
  }

  // Start status server FIRST (keeps process alive)
  await startStatusServer();

  // Run first cycle immediately
  log('INFO', '🏃 Ejecutando primer ciclo...');
  await runCycle();

  // Schedule recurring cycles
  log('INFO', `⏰ Próximo ciclo en ${CYCLE_INTERVAL_MS / 1000}s (${CYCLE_INTERVAL_MS / 60000} minutos)`);
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
