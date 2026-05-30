// Market Sentiment API: Fear & Greed, BTC Dominance, Funding, OI, Pressure Score
// Reads from DB (appSettings) which is updated by the worker's market-data-feeder

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  try {
    // Fetch sentiment data from DB (set by worker's market-data-feeder)
    const sentiments: Record<string, any> = {};
    const sentimentKeys = ['sentiment_BTC_USD', 'sentiment_ETH_USD'];

    for (const key of sentimentKeys) {
      try {
        const setting = await db.appSettings.findUnique({ where: { key } });
        if (setting) {
          sentiments[key] = JSON.parse(setting.value);
        }
      } catch { /* ignore */ }
    }

    // Fetch macro data (Fear & Greed, BTC Dominance)
    let macroData: any = null;
    try {
      const macroSetting = await db.appSettings.findUnique({ where: { key: 'macro_market_data' } });
      if (macroSetting) {
        macroData = JSON.parse(macroSetting.value);
      }
    } catch { /* ignore */ }

    // Build response
    const assets: Record<string, any> = {};
    for (const [key, value] of Object.entries(sentiments)) {
      const asset = value.asset || key.replace('sentiment_', '').replace('_', '/');
      assets[asset] = {
        lastPrice: value.lastPrice,
        sentiment: value.sentiment,
        pressureScore: value.pressureScore,
        liquidityQuality: value.liquidityQuality,
        fundingRate: value.fundingRate,
        fundingRateAvg: value.fundingRateAvg,
        openInterest: value.openInterest,
        oiChange1h: value.oiChange1h,
        oiChange24h: value.oiChange24h,
        bidDepth: value.bidDepth,
        askDepth: value.askDepth,
        depthImbalance: value.depthImbalance,
        spreadPct: value.spreadPct,
        volume24h: value.volume24h,
        fearGreedIndex: value.fearGreedIndex,
        fearGreedLabel: value.fearGreedLabel,
        btcDominance: value.btcDominance,
        timestamp: value.timestamp,
      };
    }

    return NextResponse.json({
      macro: macroData ? {
        fearGreedIndex: macroData.fearGreedIndex,
        fearGreedLabel: macroData.fearGreedLabel,
        btcDominance: macroData.btcDominance,
        totalMarketCap: macroData.totalMarketCap,
        totalVolume24h: macroData.totalVolume24h,
        timestamp: macroData.timestamp,
      } : null,
      assets,
      lastUpdated: Object.values(sentiments)[0]?.timestamp || null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
