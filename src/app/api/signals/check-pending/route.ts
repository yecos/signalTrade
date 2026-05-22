import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { evaluateSignal, checkAlerts } from "@/lib/signals";
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
      const runningSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderRunning' } });
      if (runningSetting?.value === 'true') {
        return NextResponse.json({ checked: 0, closed: 0, autoTraderActive: true });
      }
      return NextResponse.json({ checked: 0, closed: 0 });
    }

    let closedCount = 0;
    const verificationDetails: Array<{ signalId: string; asset: string; exitPrice: number; source: string }> = [];

    for (const signal of expiredSignals) {
      let exitPrice: number;
      let priceSource: string;

      try {
        // 1. Try real market engine (CoinGecko, Binance, TwelveData)
        const engineResult = await getEngineLatestPrice(signal.asset);
        if (engineResult.price > 0 && engineResult.source !== 'FALLBACK') {
          // Use the EXACT real market price - NO random variation
          // For trading verification, accuracy is critical
          exitPrice = engineResult.price;
          priceSource = engineResult.source;
        } else {
          // 2. Try DB price (stored candles)
          const dbPrice = await getDBLatestPrice(signal.asset);
          if (dbPrice && dbPrice > 0) {
            exitPrice = dbPrice;
            priceSource = 'DB_CANDLES';
          } else {
            // 3. No real price available - mark as unverifiable
            // Instead of faking a price, we skip verification and flag it
            await db.signal.update({
              where: { id: signal.id },
              data: {
                status: "CLOSED",
                result: "DRAW", // Cannot verify without real price
                verificationMethod: "UNVERIFIABLE",
              },
            });
            closedCount++;
            continue;
          }
        }

        // Round appropriately for asset type
        if (signal.asset.includes('JPY')) exitPrice = Math.round(exitPrice * 100) / 100;
        else if (signal.asset.includes('BTC') || signal.asset.includes('ETH')) exitPrice = Math.round(exitPrice * 100) / 100;
        else exitPrice = Math.round(exitPrice * 100000) / 100000;
      } catch {
        // Cannot get any price - mark as unverifiable
        await db.signal.update({
          where: { id: signal.id },
          data: {
            status: "CLOSED",
            result: "DRAW",
            verificationMethod: "UNVERIFIABLE",
          },
        });
        closedCount++;
        continue;
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
          verificationMethod: priceSource,
        },
      });

      verificationDetails.push({
        signalId: signal.id,
        asset: signal.asset,
        exitPrice,
        source: priceSource,
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
        where: { type: alert.type, isActive: true },
        orderBy: { createdAt: "desc" },
      });

      if (!existingAlert) {
        await db.alert.create({
          data: { type: alert.type, message: alert.message, severity: alert.severity, isActive: true },
        });
      }
    }

    return NextResponse.json({
      checked: expiredSignals.length,
      closed: closedCount,
      verifications: verificationDetails,
    });
  } catch (error) {
    console.error("Error checking pending signals:", error);
    return NextResponse.json(
      { error: "Error al verificar señales pendientes" },
      { status: 500 }
    );
  }
}
