// WORKER STATUS API — Reads real worker state from AppSettings
// Shows what's actually happening with the worker, not fake metrics

import { NextResponse } from 'next/server';
import { db, withRetry } from '@/lib/db';

export async function GET() {
  try {
    // Fetch all worker-related settings in parallel
    const keys = [
      'autoTraderRunning',
      'autoTraderLastCheck',
      'autoTraderConfig',
      'autoExecution',
      'strategy_manager_config',
      'strategy_last_cycle',
      'riskConfig',
    ];

    const settings = await Promise.all(
      keys.map(key =>
        withRetry(
          () => db.appSettings.findUnique({ where: { key } }),
          2, 500, `worker-status-${key}`
        ).then(s => ({ key, value: s?.value || null }))
          .catch(() => ({ key, value: null }))
      )
    );

    // Parse settings into a structured response
    const settingsMap: Record<string, string | null> = {};
    for (const s of settings) {
      settingsMap[s.key] = s.value;
    }

    // Parse auto-execution config
    let autoExecution = { enabled: false, mode: 'PAPER' };
    try {
      if (settingsMap.autoExecution) {
        autoExecution = JSON.parse(settingsMap.autoExecution);
      }
    } catch { /* use default */ }

    // Parse auto-trader config
    let autoTraderConfig = null;
    try {
      if (settingsMap.autoTraderConfig) {
        autoTraderConfig = JSON.parse(settingsMap.autoTraderConfig);
      }
    } catch { /* use default */ }

    // Parse strategy manager config
    let strategyManagerConfig = null;
    try {
      if (settingsMap.strategy_manager_config) {
        strategyManagerConfig = JSON.parse(settingsMap.strategy_manager_config);
      }
    } catch { /* use default */ }

    // Parse last cycle result
    let lastCycleResult = null;
    try {
      if (settingsMap.strategy_last_cycle) {
        lastCycleResult = JSON.parse(settingsMap.strategy_last_cycle);
      }
    } catch { /* use default */ }

    // Parse risk config
    let riskConfig = null;
    try {
      if (settingsMap.riskConfig) {
        riskConfig = JSON.parse(settingsMap.riskConfig);
      }
    } catch { /* use default */ }

    // Get account info
    let account = null;
    try {
      const acc = await db.account.findFirst({ where: { isActive: true } });
      if (acc) {
        account = {
          balance: acc.balance,
          equity: acc.equity,
          unrealizedPnl: acc.unrealizedPnl,
          isLive: acc.isLive,
          isCircuitBreaker: acc.isCircuitBreaker,
          circuitBreakerReason: acc.circuitBreakerReason,
          peakEquity: acc.peakEquity,
          maxDrawdown: acc.maxDrawdown,
          lastSyncAt: acc.lastSyncAt,
        };
      }
    } catch { /* no account */ }

    // Get open positions count
    let openPositionsCount = 0;
    try {
      openPositionsCount = await db.position.count({ where: { status: 'OPEN' } });
    } catch { /* no positions */ }

    // Get today's signal count
    let todaySignalsCount = 0;
    let todayTradesCount = 0;
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      todaySignalsCount = await db.signal.count({
        where: { createdAt: { gte: startOfDay } },
      });
      todayTradesCount = await db.trade.count({
        where: { createdAt: { gte: startOfDay } },
      });
    } catch { /* no signals */ }

    // Determine worker status
    const autoTraderRunning = settingsMap.autoTraderRunning === 'true';
    const lastCheck = settingsMap.autoTraderLastCheck;

    // Calculate worker "connectedness" — if last check was within 10 min, worker is active
    let workerConnected = false;
    let lastCheckAgo = '';
    if (lastCheck) {
      const lastCheckDate = new Date(lastCheck);
      const diffMs = Date.now() - lastCheckDate.getTime();
      const diffMin = Math.floor(diffMs / 60000);
      workerConnected = diffMin < 15;
      if (diffMin < 1) lastCheckAgo = 'Ahora mismo';
      else if (diffMin < 60) lastCheckAgo = `Hace ${diffMin} min`;
      else lastCheckAgo = `Hace ${Math.floor(diffMin / 60)}h ${diffMin % 60}m`;
    }

    return NextResponse.json({
      // Worker status
      workerConnected,
      autoTraderRunning,
      lastCheck: lastCheck || null,
      lastCheckAgo: lastCheckAgo || 'Nunca',
      // Execution config
      autoExecution,
      autoTraderConfig,
      // Strategy manager
      strategyManagerConfig,
      lastCycleResult,
      // Risk config
      riskConfig,
      // Account
      account,
      // Counts
      openPositionsCount,
      todaySignalsCount,
      todayTradesCount,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[WORKER-STATUS API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
