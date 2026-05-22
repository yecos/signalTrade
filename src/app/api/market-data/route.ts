// Market Data API: Get candles, generate data, seed

import { NextRequest, NextResponse } from 'next/server';
import { 
  getCandles, 
  generateHistoricalCandles, 
  ASSET_CONFIGS,
  seedMarketData 
} from '@/lib/market-data';

// GET: Get candles for an asset/timeframe
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const asset = searchParams.get('asset') || 'EUR/USD';
    const timeframe = searchParams.get('timeframe') || 'M5';
    const count = parseInt(searchParams.get('count') || '100');
    
    const candles = await getCandles(asset, timeframe, count);
    
    return NextResponse.json({
      asset,
      timeframe,
      count: candles.length,
      candles: candles.slice(-count),
      availableAssets: Object.keys(ASSET_CONFIGS),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST: Generate or seed market data
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action; // 'generate', 'seed'
    
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
          timeframe 
        });
      }
      
      case 'seed': {
        await seedMarketData();
        return NextResponse.json({ 
          success: true, 
          message: 'Market data seeded for all assets and timeframes',
        });
      }
      
      default:
        return NextResponse.json({ error: 'Invalid action. Use: generate, seed' }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
