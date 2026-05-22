import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { evaluateSignal, simulateExitPrice, checkAlerts } from "@/lib/signals";
import { getLatestPrice as getEngineLatestPrice } from "@/lib/market-engine";
import { getLatestPrice as getDBLatestPrice } from "@/lib/market-data";
import { updateSetupStats } from "@/lib/auto-trader";

export async function POST() {
  try {
    const now = new Date();

    // Find all pending signals that have expired
    const expiredSignals = await db.signal.findMany({
      where: {
        status: "PENDING",
        expirationTime: { lte: now },
      },
    });

    if (expiredSignals.length === 0) {
      // Also check if auto-trader should run a cycle
      const runningSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderRunning' } });
      if (runningSetting?.value === 'true') {
        // Auto-trader is running but nothing to close - signal the checker
        return NextResponse.json({ checked: 0, closed: 0, autoTraderActive: true });
      }
      return NextResponse.json({ checked: 0, closed: 0 });
    }

    let closedCount = 0;

    for (const signal of expiredSignals) {
      // Try to get real price from market engine first, then DB, then simulate
      let exitPrice: number;
      try {
        // Try real market engine (Binance/TwelveData)
        const engineResult = await getEngineLatestPrice(signal.asset);
        const latestPrice = engineResult.price;
        if (latestPrice && latestPrice > 0 && engineResult.source !== 'FALLBACK') {
          // Use real market price with slight variation for realistic verification
          const variation = latestPrice * (Math.random() * 0.001 - 0.0005);
          exitPrice = latestPrice + variation;
        } else {
          // Try DB price
          const dbPrice = await getDBLatestPrice(signal.asset);
          if (dbPrice && dbPrice > 0) {
            const variation = dbPrice * (Math.random() * 0.001 - 0.0005);
            exitPrice = dbPrice + variation;
          } else {
            exitPrice = simulateExitPrice(signal.entryPrice, signal.direction);
          }
        }
        // Round appropriately for asset type
        if (signal.asset.includes('JPY')) exitPrice = Math.round(exitPrice * 100) / 100;
        else if (signal.asset.includes('BTC') || signal.asset.includes('ETH')) exitPrice = Math.round(exitPrice * 100) / 100;
        else exitPrice = Math.round(exitPrice * 100000) / 100000;
      } catch {
        exitPrice = simulateExitPrice(signal.entryPrice, signal.direction);
      }

      const priceDifference = Math.round((exitPrice - signal.entryPrice) * 100000) / 100000;
      const result = evaluateSignal(signal.direction, signal.entryPrice, exitPrice);

      // Calculate estimated profit/loss
      let estimatedProfit = signal.estimatedProfit;
      let estimatedLoss = signal.estimatedLoss;
      if (result === "WIN") {
        estimatedProfit = estimatedProfit || Math.abs(priceDifference);
        estimatedLoss = 0;
      } else if (result === "LOSS") {
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
          status: "CLOSED",
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
        });
      }

      closedCount++;
    }

    // After closing, check for alerts
    const allClosedSignals = await db.signal.findMany({
      where: { status: "CLOSED", result: { not: null } },
      orderBy: { entryTime: "desc" },
      take: 100,
    });

    const alertConditions = checkAlerts(allClosedSignals as Parameters<typeof checkAlerts>[0]);

    for (const alert of alertConditions) {
      const existingAlert = await db.alert.findFirst({
        where: {
          type: alert.type,
          isActive: true,
        },
        orderBy: { createdAt: "desc" },
      });

      if (!existingAlert) {
        await db.alert.create({
          data: {
            type: alert.type,
            message: alert.message,
            severity: alert.severity,
            isActive: true,
          },
        });
      }
    }

    return NextResponse.json({
      checked: expiredSignals.length,
      closed: closedCount,
    });
  } catch (error) {
    console.error("Error checking pending signals:", error);
    return NextResponse.json(
      { error: "Error al verificar señales pendientes" },
      { status: 500 }
    );
  }
}
