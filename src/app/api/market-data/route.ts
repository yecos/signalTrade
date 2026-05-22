// Market Data API: Real market data via market-engine + legacy DB operations

import { NextRequest, NextResponse } from 'next/server';
import {
  getCandles as getEngineCandles,
  getEngineStatus,
  getLatestPrice,
  getAllPrices,
  checkApiHealth,
  setTwelveDataApiKey,
  getTwelveDataApiKeyStatus,
} from '@/lib/market-engine';
import {
  getCandles as getDBCandles,
  generateHistoricalCandles,
  seedMarketData,
  ASSET_CONFIGS,
} from '@/lib/market-data';

// GET: Get candles or engine status
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode');

    // /api/market-data?mode=status → engine status
    if (mode === 'status') {
      const status = getEngineStatus();
      return NextResponse.json({
        ...status,
        twelveDataApiKeySet: getTwelveDataApiKeyStatus(),
      });
    }

    // /api/market-data?mode=prices → all latest prices
    if (mode === 'prices') {
      const prices = await getAllPrices();
      return NextResponse.json(prices);
    }

    // /api/market-data?asset=BTC/USD&timeframe=M5&count=100 → candles
    const asset = searchParams.get('asset') || 'EUR/USD';
    const timeframe = searchParams.get('timeframe') || 'M5';
    const count = parseInt(searchParams.get('count') || '100');

    // Try real market engine first
    const result = await getEngineCandles(asset, timeframe, count);

    if (result.candles.length > 0) {
      return NextResponse.json({
        asset,
        timeframe,
        count: result.candles.length,
        candles: result.candles.slice(-count),
        source: result.source,
        availableAssets: Object.keys(ASSET_CONFIGS),
        engineStatus: getEngineStatus(),
      });
    }

    // Fallback to DB candles (legacy)
    const candles = await getDBCandles(asset, timeframe, count);

    return NextResponse.json({
      asset,
      timeframe,
      count: candles.length,
      candles: candles.slice(-count).map((c) => ({
        timestamp: new Date(c.timestamp).getTime(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        source: 'FALLBACK',
      })),
      source: 'FALLBACK',
      availableAssets: Object.keys(ASSET_CONFIGS),
      engineStatus: getEngineStatus(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST: Generate/seed data, check health, set API key
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action;

    switch (action) {
      case 'generate': {
        const { asset, timeframe, count } = body;
        const candles = await generateHistoricalCandles(
          asset || 'EUR/USD',
          timeframe || 'M5',
          count || 200
        );
        return NextResponse.json({
          success: true,
          generated: candles.length,
          asset,
          timeframe,
        });
      }

      case 'seed': {
        await seedMarketData();
        return NextResponse.json({
          success: true,
          message: 'Market data seeded for all assets and timeframes',
        });
      }

      case 'check-health': {
        const health = await checkApiHealth();
        return NextResponse.json({
          health,
          engineStatus: getEngineStatus(),
        });
      }

      case 'set-api-key': {
        const { apiKey } = body;
        if (!apiKey || typeof apiKey !== 'string') {
          return NextResponse.json(
            { error: 'API key is required' },
            { status: 400 }
          );
        }
        setTwelveDataApiKey(apiKey);
        // Verify key works
        const health = await checkApiHealth();
        return NextResponse.json({
          success: true,
          message: health.twelveData
            ? 'TwelveData API key set and verified'
            : 'TwelveData API key set but verification failed',
          health,
        });
      }

      case 'get-price': {
        const { asset } = body;
        if (!asset) {
          return NextResponse.json(
            { error: 'Asset is required' },
            { status: 400 }
          );
        }
        const priceResult = await getLatestPrice(asset);
        return NextResponse.json(priceResult);
      }

      default:
        return NextResponse.json(
          {
            error:
              'Invalid action. Use: generate, seed, check-health, set-api-key, get-price',
          },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
