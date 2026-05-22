// CRON ENDPOINT — Runs every 5 minutes via Vercel Cron
// 1. Checks & verifies expired pending signals with REAL prices
// 2. Runs auto-trader cycle if enabled
// 3. Seeds market data candles for analysis

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { evaluateSignal, checkAlerts } from '@/lib/signals';
import { getLatestPrice as getEngineLatestPrice, getEngineStatus } from '@/lib/market-engine';
import { getLatestPrice as getDBLatestPrice, seedCandlesFromEngine } from '@/lib/market-data';
import { updateSetupStats, runAutoTraderCycle, DEFAULT_CONFIG } from '@/lib/auto-trader';

export const maxDuration = 30; // 30s timeout for cron

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const results: string[] = [];
  const errors: string[] = [];

  // Verify this is a legitimate cron call (Vercel sends cron query param)
  const isCron = request.nextUrl.searchParams.get('cron');

  // ============================================================
  // PHASE 1: Verify expired pending signals with REAL prices
  // ============================================================
  try {
    const now = new Date();
    const expiredSignals = await db.signal.findMany({
      where: {
        status: 'PENDING',
        expirationTime: { lte: now },
      },
    });

    let closedCount = 0;
    let unverifiableCount = 0;
    let verifiedWithRealPrice = 0;

    for (const signal of expiredSignals) {
      try {
        let exitPrice: number;
        let priceSource: string;

        // 1. Try real market engine (CoinGecko, Binance, TwelveData)
        const engineResult = await getEngineLatestPrice(signal.asset);
        if (engineResult.price > 0 && engineResult.source !== 'FALLBACK') {
          exitPrice = engineResult.price;
          priceSource = engineResult.source;
          verifiedWithRealPrice++;
        } else {
          // 2. Try DB price (stored candles)
          const dbPrice = await getDBLatestPrice(signal.asset);
          if (dbPrice && dbPrice > 0) {
            exitPrice = dbPrice;
            priceSource = 'DB_CANDLES';
          } else {
            // 3. No real price — mark as unverifiable instead of guessing
            await db.signal.update({
              where: { id: signal.id },
              data: {
                status: 'CLOSED',
                result: 'DRAW',
                verificationMethod: 'UNVERIFIABLE',
              },
            });
            unverifiableCount++;
            closedCount++;
            continue;
          }
        }

        // Round appropriately for asset type
        if (signal.asset.includes('JPY')) exitPrice = Math.round(exitPrice * 100) / 100;
        else if (signal.asset.includes('BTC') || signal.asset.includes('ETH')) exitPrice = Math.round(exitPrice * 100) / 100;
        else exitPrice = Math.round(exitPrice * 100000) / 100000;

        const priceDifference = Math.round((exitPrice - signal.entryPrice) * 100000) / 100000;
        const result = evaluateSignal(signal.direction, signal.entryPrice, exitPrice);

        // Calculate estimated profit/loss
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
            exitPrice,
            result,
            priceDifference,
            estimatedProfit,
            estimatedLoss,
            status: 'CLOSED',
            verificationMethod: priceSource,
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

        closedCount++;
      } catch (signalError: any) {
        errors.push(`Signal ${signal.id}: ${signalError.message}`);
      }
    }

    results.push(`Verificación: ${closedCount} cerradas, ${verifiedWithRealPrice} con precio real, ${unverifiableCount} inverificables`);

    // Check alerts after closing signals
    if (closedCount > 0) {
      const allClosedSignals = await db.signal.findMany({
        where: { status: 'CLOSED', result: { not: null } },
        orderBy: { entryTime: 'desc' },
        take: 100,
      });

      const alertConditions = checkAlerts(allClosedSignals as Parameters<typeof checkAlerts>[0]);
      for (const alert of alertConditions) {
        const existingAlert = await db.alert.findFirst({
          where: { type: alert.type, isActive: true },
          orderBy: { createdAt: 'desc' },
        });
        if (!existingAlert) {
          await db.alert.create({
            data: { type: alert.type, message: alert.message, severity: alert.severity, isActive: true },
          });
        }
      }
    }
  } catch (error: any) {
    errors.push(`Fase verificación: ${error.message}`);
  }

  // ============================================================
  // PHASE 2: Run auto-trader cycle if enabled
  // ============================================================
  try {
    const runningSetting = await db.appSettings.findUnique({
      where: { key: 'autoTraderRunning' },
    });

    if (runningSetting?.value === 'true') {
      const configSetting = await db.appSettings.findUnique({
        where: { key: 'autoTraderConfig' },
      });
      const config = configSetting ? JSON.parse(configSetting.value) : DEFAULT_CONFIG;

      const cycleResult = await runAutoTraderCycle(config);
      results.push(`Auto-Trader: ${cycleResult.signalsGenerated} generadas, ${cycleResult.signalsSkipped} omitidas`);

      if (cycleResult.errors.length > 0) {
        errors.push(...cycleResult.errors);
      }

      // Update last check time
      await db.appSettings.upsert({
        where: { key: 'autoTraderLastCheck' },
        create: { key: 'autoTraderLastCheck', value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      });
    } else {
      results.push('Auto-Trader: desactivado (no se generaron señales)');
    }
  } catch (error: any) {
    errors.push(`Auto-Trader: ${error.message}`);
  }

  // ============================================================
  // PHASE 3: Seed market data candles for active assets
  // ============================================================
  try {
    const assets = ['EUR/USD', 'GBP/USD', 'BTC/USD', 'ETH/USD'];
    let seeded = 0;
    for (const asset of assets) {
      try {
        await seedCandlesFromEngine(asset, 'M5');
        seeded++;
      } catch {
        // Skip if engine not available for this asset
      }
    }
    results.push(`Market Data: ${seeded}/${assets.length} assets con datos actualizados`);
  } catch (error: any) {
    errors.push(`Market Data: ${error.message}`);
  }

  // ============================================================
  // PHASE 4: Engine health check
  // ============================================================
  try {
    const engineStatus = await getEngineStatus();
    const activeSources = Object.entries(engineStatus.sources || {})
      .filter(([_, src]) => src !== 'OFFLINE')
      .length;
    results.push(`Engine: ${activeSources} fuentes activas, calidad ${engineStatus.dataQuality}`);
  } catch (error: any) {
    errors.push(`Engine health: ${error.message}`);
  }

  const duration = Date.now() - startTime;

  return NextResponse.json({
    success: true,
    cron: isCron ? 'scheduled' : 'manual',
    duration_ms: duration,
    phases: results,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString(),
  });
}
