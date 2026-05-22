import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateStats } from "@/lib/signals";

export async function GET() {
  try {
    const signals = await db.signal.findMany({
      where: { status: "CLOSED", result: { not: null } },
      orderBy: { entryTime: "desc" },
    });

    const stats = calculateStats(signals as Parameters<typeof calculateStats>[0]);

    // Best and worst performing assets
    const assetPerformance = Object.entries(stats.winRateByAsset)
      .filter(([, data]) => data.total >= 2)
      .sort(([, a], [, b]) => b.rate - a.rate)
      .map(([asset, data]) => ({
        asset,
        wins: data.wins,
        total: data.total,
        winRate: Math.round(data.rate * 10) / 10,
        recommendation: data.rate >= 60 ? "OPERAR" : data.rate >= 50 ? "PRECAUCIÓN" : "EVITAR",
      }));

    // Best and worst timeframes
    const timeframePerformance = Object.entries(stats.winRateByTimeframe)
      .filter(([, data]) => data.total >= 2)
      .sort(([, a], [, b]) => b.rate - a.rate)
      .map(([timeframe, data]) => ({
        timeframe,
        wins: data.wins,
        total: data.total,
        winRate: Math.round(data.rate * 10) / 10,
        recommendation: data.rate >= 60 ? "OPERAR" : data.rate >= 50 ? "PRECAUCIÓN" : "EVITAR",
      }));

    // Direction analysis
    const directionPerformance = Object.entries(stats.winRateByDirection)
      .map(([direction, data]) => ({
        direction,
        wins: data.wins,
        total: data.total,
        winRate: Math.round(data.rate * 10) / 10,
      }));

    // Hour analysis - which hours are good/bad
    const hourPerformance = Object.entries(stats.winRateByHour)
      .filter(([, data]) => data.total >= 2)
      .sort(([, a], [, b]) => b.rate - a.rate)
      .map(([hour, data]) => ({
        hour,
        wins: data.wins,
        total: data.total,
        winRate: Math.round(data.rate * 10) / 10,
        recommendation: data.rate >= 65 ? "BUENO" : data.rate >= 50 ? "NEUTRAL" : "MALO",
      }));

    // Confidence threshold analysis
    const confidenceBuckets = [
      { range: "0-40", min: 0, max: 40 },
      { range: "40-55", min: 40, max: 55 },
      { range: "55-65", min: 55, max: 65 },
      { range: "65-75", min: 65, max: 75 },
      { range: "75-85", min: 75, max: 85 },
      { range: "85-100", min: 85, max: 100 },
    ];

    const confidenceAnalysis = confidenceBuckets.map((bucket) => {
      const bucketSignals = signals.filter(
        (s) => s.confidence >= bucket.min && s.confidence < bucket.max
      );
      const wins = bucketSignals.filter((s) => s.result === "WIN").length;
      const total = bucketSignals.filter((s) => s.result === "WIN" || s.result === "LOSS").length;
      return {
        range: bucket.range,
        wins,
        total,
        winRate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0,
      };
    });

    // Recommended filters
    const goodAssets = assetPerformance
      .filter((a) => a.recommendation === "OPERAR")
      .map((a) => a.asset);
    const badAssets = assetPerformance
      .filter((a) => a.recommendation === "EVITAR")
      .map((a) => a.asset);
    const goodTimeframes = timeframePerformance
      .filter((t) => t.recommendation === "OPERAR")
      .map((t) => t.timeframe);
    const goodHours = hourPerformance
      .filter((h) => h.recommendation === "BUENO")
      .map((h) => h.hour);
    const badHours = hourPerformance
      .filter((h) => h.recommendation === "MALO")
      .map((h) => h.hour);

    // Find the confidence threshold that maximizes win rate
    let bestThreshold = 65;
    let bestWinRate = 0;
    for (let threshold = 40; threshold <= 90; threshold += 5) {
      const filtered = signals.filter(
        (s) => s.confidence >= threshold && (s.result === "WIN" || s.result === "LOSS")
      );
      const wR = filtered.length > 0
        ? filtered.filter((s) => s.result === "WIN").length / filtered.length
        : 0;
      if (wR > bestWinRate && filtered.length >= 3) {
        bestWinRate = wR;
        bestThreshold = threshold;
      }
    }

    const insights = {
      summary: {
        totalSignals: stats.totalSignals,
        overallWinRate: stats.winRate,
        profitFactor: stats.profitFactor,
        recommendedConfidenceThreshold: bestThreshold,
        bestThresholdWinRate: Math.round(bestWinRate * 1000) / 10,
      },
      assetPerformance,
      timeframePerformance,
      directionPerformance,
      hourPerformance,
      confidenceAnalysis,
      recommendedFilters: {
        goodAssets,
        badAssets,
        goodTimeframes,
        goodHours,
        badHours,
        minimumConfidence: bestThreshold,
        avoidConsecutiveLosses: stats.currentConsecutiveLosses >= 3,
      },
      warnings: [
        ...(stats.currentConsecutiveLosses >= 3
          ? [`Racha de ${stats.currentConsecutiveLosses} pérdidas consecutivas activa`]
          : []),
        ...(stats.winRate < 55 && stats.totalSignals >= 10
          ? [`Win rate general por debajo de 55%: ${stats.winRate.toFixed(1)}%`]
          : []),
        ...(badAssets.length > 0
          ? [`Evitar operar en: ${badAssets.join(", ")}`]
          : []),
        ...(badHours.length > 0
          ? [`Horas con mal rendimiento: ${badHours.join(", ")}`]
          : []),
      ],
    };

    return NextResponse.json(insights);
  } catch (error) {
    console.error("Error fetching backtesting insights:", error);
    return NextResponse.json(
      { error: "Error al obtener insights de backtesting" },
      { status: 500 }
    );
  }
}
