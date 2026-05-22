import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { evaluateSignal, simulateExitPrice, checkAlerts } from "@/lib/signals";

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
      return NextResponse.json({ checked: 0, closed: 0 });
    }

    let closedCount = 0;

    for (const signal of expiredSignals) {
      // Simulate exit price for demo mode
      const exitPrice = simulateExitPrice(signal.entryPrice, signal.direction);
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
      // Check if similar alert already exists and is active
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
