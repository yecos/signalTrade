// TRADING API — Execution Engine Control Panel
// Manage live/paper trading, positions, account, and risk

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getExecutionEngine, type ExecutionMode } from '@/lib/execution-engine';
import {
  getOrCreateAccount,
  getRiskConfig,
  saveRiskConfig,
  getDailyRiskState,
  deactivateCircuitBreaker,
} from '@/lib/risk-manager';
import { runAutoMigration } from '@/lib/db';

// GET: Get trading status (account, positions, risk state)
export async function GET() {
  try {
    // Ensure tables exist
    await runAutoMigration();

    const engine = getExecutionEngine();
    const status = await engine.getStatus();
    const account = await getOrCreateAccount();
    const riskState = await getDailyRiskState();
    const riskConfig = await getRiskConfig();

    // Get open positions
    const openPositions = await db.position.findMany({
      where: { status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });

    // Get recent trades
    const recentTrades = await db.trade.findMany({
      where: { status: { in: ['OPEN', 'CLOSED'] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // Calculate trading stats
    const allTrades = await db.trade.findMany({
      where: { status: 'CLOSED', realizedPnl: { not: null } },
    });
    const wins = allTrades.filter(t => (t.realizedPnl || 0) > 0).length;
    const losses = allTrades.filter(t => (t.realizedPnl || 0) < 0).length;
    const totalPnl = allTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
    const totalCommission = allTrades.reduce((sum, t) => sum + (t.commission || 0), 0);
    const avgPnl = allTrades.length > 0 ? totalPnl / allTrades.length : 0;
    const winRate = allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0;

    return NextResponse.json({
      // Engine status
      engine: status,
      // Account
      account: {
        id: account.id,
        broker: account.broker,
        balance: account.balance,
        equity: account.equity,
        unrealizedPnl: account.unrealizedPnl,
        isLive: account.isLive,
        isCircuitBreaker: account.isCircuitBreaker,
        circuitBreakerReason: account.circuitBreakerReason,
        riskPerTrade: account.riskPerTrade,
        maxDailyLoss: account.maxDailyLoss,
        maxOpenPositions: account.maxOpenPositions,
        maxDrawdownPct: account.maxDrawdownPct,
        peakEquity: account.peakEquity,
        maxDrawdown: account.maxDrawdown,
      },
      // Risk state
      riskState,
      riskConfig,
      // Positions
      openPositions: openPositions.map(p => ({
        id: p.id,
        asset: p.asset,
        direction: p.direction,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        unrealizedPnl: p.unrealizedPnl,
        unrealizedPnlPct: p.unrealizedPnlPct,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        maxFavorable: p.maxFavorable,
        maxAdverse: p.maxAdverse,
        executionMode: p.executionMode,
        openedAt: p.openedAt,
      })),
      // Recent trades
      recentTrades: recentTrades.map(t => ({
        id: t.id,
        signalId: t.signalId,
        asset: t.asset,
        direction: t.direction,
        quantity: t.quantity,
        signalPrice: t.signalPrice,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        realizedPnl: t.realizedPnl,
        realizedPnlPct: t.realizedPnlPct,
        commission: t.commission,
        slippage: t.slippage,
        status: t.status,
        rejectReason: t.rejectReason,
        executionMode: t.executionMode,
        fillTime: t.fillTime,
        closedAt: t.closedAt,
        createdAt: t.createdAt,
      })),
      // Stats
      stats: {
        totalTrades: allTrades.length,
        wins,
        losses,
        winRate: Math.round(winRate * 10) / 10,
        totalPnl: Math.round(totalPnl * 100) / 100,
        totalCommission: Math.round(totalCommission * 100) / 100,
        avgPnl: Math.round(avgPnl * 100) / 100,
        profitFactor: losses > 0
          ? Math.abs(allTrades.filter(t => (t.realizedPnl || 0) > 0).reduce((s, t) => s + (t.realizedPnl || 0), 0) /
            allTrades.filter(t => (t.realizedPnl || 0) < 0).reduce((s, t) => s + Math.abs(t.realizedPnl || 0), 0))
          : 0,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TRADING API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST: Trading actions
export async function POST(request: NextRequest) {
  try {
    await runAutoMigration();
    const body = await request.json();
    const action = body.action;

    switch (action) {
      // === CLOSE POSITION ===
      case 'close-position': {
        const { positionId } = body;
        if (!positionId) {
          return NextResponse.json({ error: 'positionId required' }, { status: 400 });
        }
        const engine = getExecutionEngine();
        const result = await engine.closePosition(positionId, 'Cierre manual desde dashboard');
        return NextResponse.json(result);
      }

      // === CLOSE ALL POSITIONS ===
      case 'close-all': {
        const positions = await db.position.findMany({ where: { status: 'OPEN' } });
        const engine = getExecutionEngine();
        const results: any[] = [];
        for (const pos of positions) {
          const result = await engine.closePosition(pos.id, 'Cierre total desde dashboard');
          results.push(result);
        }
        return NextResponse.json({ closed: results.length, results });
      }

      // === CHECK SL/TP ===
      case 'check-sltp': {
        const engine = getExecutionEngine();
        const closed = await engine.checkStopLossTakeProfit();
        return NextResponse.json({ closed, message: `${closed} posiciones cerradas por SL/TP` });
      }

      // === CHECK EXPIRED ===
      case 'check-expired': {
        const engine = getExecutionEngine();
        const closed = await engine.checkAndCloseExpired();
        return NextResponse.json({ closed, message: `${closed} posiciones expiradas cerradas` });
      }

      // === UPDATE RISK CONFIG ===
      case 'update-risk-config': {
        const newConfig = body.config;
        if (!newConfig) {
          return NextResponse.json({ error: 'config required' }, { status: 400 });
        }
        const updated = await saveRiskConfig(newConfig);
        return NextResponse.json({ success: true, config: updated });
      }

      // === DEACTIVATE CIRCUIT BREAKER ===
      case 'deactivate-circuit-breaker': {
        const account = await getOrCreateAccount();
        await deactivateCircuitBreaker(account.id);
        return NextResponse.json({
          success: true,
          message: 'Circuit breaker desactivado. Trading reanudado.',
        });
      }

      // === UPDATE ACCOUNT BALANCE ===
      case 'set-balance': {
        const { balance } = body;
        if (typeof balance !== 'number' || balance < 0) {
          return NextResponse.json({ error: 'Balance válido requerido' }, { status: 400 });
        }
        const account = await getOrCreateAccount();
        await db.account.update({
          where: { id: account.id },
          data: { balance, equity: balance, peakEquity: Math.max(account.peakEquity, balance) },
        });
        return NextResponse.json({ success: true, balance });
      }

      // === SET BROKER API KEYS ===
      case 'set-broker-keys': {
        const { apiKey, apiSecret, testnet } = body;
        if (!apiKey || !apiSecret) {
          return NextResponse.json({ error: 'apiKey y apiSecret requeridos' }, { status: 400 });
        }
        const account = await getOrCreateAccount();
        await db.account.update({
          where: { id: account.id },
          data: {
            broker: 'BYBIT',
            apiKey,
            apiSecret,
            isLive: !testnet,
          },
        });
        // Reset execution engine to pick up new credentials
        const { resetExecutionEngine } = await import('@/lib/execution-engine');
        const { resetBrokerClient } = await import('@/lib/broker-client');
        resetExecutionEngine();
        resetBrokerClient();
        return NextResponse.json({
          success: true,
          message: `Bybit ${testnet ? 'TESTNET' : 'MAINNET'} keys configuradas. Engine reiniciado.`,
        });
      }

      // === TEST BROKER CONNECTION ===
      case 'test-connection': {
        const { resetExecutionEngine } = await import('@/lib/execution-engine');
        const { resetBrokerClient } = await import('@/lib/broker-client');
        resetExecutionEngine();
        resetBrokerClient();
        const engine = getExecutionEngine();
        const result = await engine.testConnection();
        return NextResponse.json(result);
      }

      // === ENABLE AUTO-EXECUTION ===
      case 'enable-auto-execution': {
        const { mode } = body; // 'PAPER' or 'LIVE'
        const execMode = mode === 'LIVE' ? 'LIVE' : 'PAPER';
        await db.appSettings.upsert({
          where: { key: 'autoExecution' },
          create: { key: 'autoExecution', value: JSON.stringify({ enabled: true, mode: execMode }), description: 'Auto-execution configuration' },
          update: { value: JSON.stringify({ enabled: true, mode: execMode }) },
        });
        return NextResponse.json({
          success: true,
          message: `Auto-ejecución HABILITADA en modo ${execMode}. Las señales aprobadas se ejecutarán automáticamente.`,
          mode: execMode,
        });
      }

      // === DISABLE AUTO-EXECUTION ===
      case 'disable-auto-execution': {
        const currentSetting = await db.appSettings.findUnique({ where: { key: 'autoExecution' } });
        const current = currentSetting ? JSON.parse(currentSetting.value) : { enabled: false, mode: 'PAPER' };
        await db.appSettings.upsert({
          where: { key: 'autoExecution' },
          create: { key: 'autoExecution', value: JSON.stringify({ ...current, enabled: false }), description: 'Auto-execution configuration' },
          update: { value: JSON.stringify({ ...current, enabled: false }) },
        });
        return NextResponse.json({
          success: true,
          message: 'Auto-ejecución DESHABILITADA. Solo se generarán señales sin ejecutar.',
        });
      }

      // === GET AUTO-EXECUTION STATUS ===
      case 'auto-execution-status': {
        const execSetting = await db.appSettings.findUnique({ where: { key: 'autoExecution' } });
        const execConfig = execSetting ? JSON.parse(execSetting.value) : { enabled: false, mode: 'PAPER' };
        return NextResponse.json(execConfig);
      }

      // === EXECUTE SIGNAL (manual execution) ===
      case 'execute-signal': {
        const { signalId } = body;
        if (!signalId) {
          return NextResponse.json({ error: 'signalId requerido' }, { status: 400 });
        }

        const signal = await db.signal.findUnique({ where: { id: signalId } });
        if (!signal) {
          return NextResponse.json({ error: 'Signal no encontrada' }, { status: 404 });
        }
        if (signal.direction === 'NO_OPERAR') {
          return NextResponse.json({ error: 'No se puede ejecutar una señal NO_OPERAR' }, { status: 400 });
        }

        // Get ATR from indicators
        let atr = 0;
        try {
          const indicators = signal.indicatorsJson ? JSON.parse(signal.indicatorsJson) : {};
          atr = indicators.atr14 || (signal.entryPrice * 0.005);
        } catch {
          atr = signal.entryPrice * 0.005;
        }

        const engine = getExecutionEngine();
        const result = await engine.executeSignal({
          signalId: signal.id,
          asset: signal.asset,
          direction: signal.direction as 'HIGHER' | 'LOWER',
          entryPrice: signal.entryPrice,
          confidence: signal.confidence,
          patternType: signal.patternType,
          sessionType: signal.sessionType,
          edgeClassification: signal.edgeClassification || 'GREY',
          provenEdgeTier: signal.provenEdgeTier || 'UNKNOWN',
          winRate: signal.adjustedWinRate || signal.confidence,
          riskRewardRatio: signal.riskReward || 1.5,
          expectancy: signal.expectancy || 0,
          setupScore: signal.setupScore || 30,
          qualityScore: signal.qualityScore || 50,
          atr,
        });

        return NextResponse.json(result);
      }

      default:
        return NextResponse.json(
          { error: 'Acción inválida. Usa: close-position, close-all, check-sltp, check-expired, update-risk-config, deactivate-circuit-breaker, set-balance, set-broker-keys, test-connection, enable-auto-execution, disable-auto-execution, auto-execution-status, execute-signal' },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TRADING API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
