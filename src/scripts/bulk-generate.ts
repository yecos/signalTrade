// Bulk Signal Generation Script
// Generates many signals quickly to build the initial dataset
// Run: npx tsx src/scripts/bulk-generate.ts

import { db } from '../lib/db';
import { generateHistoricalCandles } from '../lib/market-data';
import { computeAllIndicators } from '../lib/indicators';
import { detectPatterns } from '../lib/patterns';
import { detectSession } from '../lib/sessions';
import { evaluateSignal } from '../lib/signals';

const ASSETS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'BTC/USD', 'ETH/USD'];
const TIMEFRAMES = ['M5', 'M15', 'H1'];
const TF_MINUTES: Record<string, number> = { 'M1': 1, 'M5': 5, 'M15': 15, 'M30': 30, 'H1': 60 };

async function main() {
  console.log('🚀 Bulk Signal Generation - Building the dataset!');
  console.log('================================================\n');
  
  // Step 1: Ensure we have market data
  console.log('📊 Step 1: Generating market data...');
  for (const asset of ASSETS) {
    for (const tf of TIMEFRAMES) {
      await generateHistoricalCandles(asset, tf, 500);
      console.log(`  ✓ ${asset} ${tf}: 500 candles`);
    }
  }
  
  // Step 2: Generate signals by stepping through time
  console.log('\n🤖 Step 2: Generating signals through historical data...\n');
  
  let totalGenerated = 0;
  let wins = 0;
  let losses = 0;
  let noOperar = 0;
  
  for (const asset of ASSETS) {
    for (const tf of TIMEFRAMES) {
      const candles = await db.marketCandle.findMany({
        where: { asset, timeframe: tf },
        orderBy: { timestamp: 'asc' },
        take: 200,
      });
      
      if (candles.length < 50) continue;
      
      for (let i = 50; i < candles.length; i += 5) {
        const slice = candles.slice(0, i + 1);
        const currentCandle = slice[slice.length - 1];
        
        const ohlcvSlice = slice.map(c => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));
        
        const indicators = computeAllIndicators(ohlcvSlice);
        const patterns = detectPatterns(ohlcvSlice, indicators);
        const bestPattern = patterns.length > 0 ? patterns.reduce((a, b) => a.confidence > b.confidence ? a : b) : null;
        const sessionInfo = detectSession(currentCandle.timestamp);
        
        let direction: 'HIGHER' | 'LOWER' | 'NO_OPERAR' = 'NO_OPERAR';
        let confidence = 0;
        let reason = '';
        
        if (bestPattern) {
          direction = bestPattern.direction === 'BULLISH' ? 'HIGHER' : 'LOWER';
          confidence = bestPattern.confidence;
          reason = bestPattern.description;
        } else {
          let bullish = 0, bearish = 0;
          if (indicators.rsi14 !== null) {
            if (indicators.rsi14 > 55) bullish += 1;
            else if (indicators.rsi14 < 45) bearish += 1;
          }
          if (indicators.macdHistogram !== null) {
            if (indicators.macdHistogram > 0) bullish += 1;
            else bearish += 1;
          }
          if (indicators.ema12 !== null && indicators.ema26 !== null) {
            if (indicators.ema12 > indicators.ema26) bullish += 1;
            else bearish += 1;
          }
          if (indicators.trend === 'BULLISH') bullish += 1;
          else if (indicators.trend === 'BEARISH') bearish += 1;
          
          const balance = bullish - bearish;
          if (Math.abs(balance) >= 1) {
            direction = balance > 0 ? 'HIGHER' : 'LOWER';
            confidence = Math.min(65, 30 + Math.abs(balance) * 10);
            reason = `Decisión por indicadores: ${direction === 'HIGHER' ? 'Alcista' : 'Bajista'} (${bullish} vs ${bearish})`;
          } else {
            direction = 'NO_OPERAR';
            confidence = 0;
            reason = 'Sin consenso en indicadores';
          }
        }
        
        if (direction === 'NO_OPERAR') {
          noOperar++;
          continue;
        }
        
        let setupScore = 30;
        if (bestPattern) setupScore += 15;
        if (confidence > 60) setupScore += 10;
        if (sessionInfo.session === 'Overlap') setupScore += 10;
        else if (sessionInfo.session === 'London') setupScore += 7;
        if (indicators.volumeAnalysis.relativeVolume > 1.5) setupScore += 5;
        setupScore = Math.min(100, setupScore);
        
        const tfMin = TF_MINUTES[tf] || 5;
        const futureCandle = candles.find(c => 
          c.timestamp.getTime() >= currentCandle.timestamp.getTime() + tfMin * 2 * 60 * 1000
        );
        
        const exitPrice = futureCandle ? futureCandle.close : null;
        if (!exitPrice) continue;
        
        const result = evaluateSignal(direction, currentCandle.close, exitPrice);
        const priceDifference = exitPrice - currentCandle.close;
        
        if (result === 'WIN') wins++;
        else if (result === 'LOSS') losses++;
        
        await db.signal.create({
          data: {
            asset,
            timeframe: tf,
            direction,
            entryPrice: currentCandle.close,
            entryTime: currentCandle.timestamp,
            expirationMinutes: tfMin * 2,
            expirationTime: new Date(currentCandle.timestamp.getTime() + tfMin * 2 * 60 * 1000),
            confidence,
            aiReason: reason + ' [BULK GENERATION]',
            patternType: bestPattern?.type || null,
            sessionType: sessionInfo.session,
            setupScore,
            source: 'AUTO',
            analysisMode: 'FULL',
            dataAvailability: JSON.stringify({
              candles: true,
              indicators: indicators.rsi14 !== null,
              patterns: bestPattern !== null,
              session: true,
              volume: indicators.volumeAnalysis.avgVolume20 > 0,
            }),
            statisticalReliability: 'INSUFFICIENT',
            exitPrice,
            result,
            priceDifference: Math.round(priceDifference * 100000) / 100000,
            estimatedProfit: result === 'WIN' ? Math.abs(priceDifference) : 0,
            estimatedLoss: result === 'LOSS' ? Math.abs(priceDifference) : 0,
            status: 'CLOSED',
            verificationMethod: 'REAL',
            indicatorsJson: JSON.stringify(indicators),
            technicalJson: JSON.stringify({
              trend: indicators.trend,
              momentum: indicators.momentum,
              volatilityLevel: indicators.volatilityLevel,
            }),
            patternsJson: JSON.stringify(patterns.map(p => ({
              type: p.type,
              direction: p.direction,
              confidence: p.confidence,
              description: p.description,
            }))),
            volumeJson: JSON.stringify(indicators.volumeAnalysis),
          },
        });
        
        totalGenerated++;
      }
      console.log(`  ✓ ${asset} ${tf}: done`);
    }
  }
  
  // Step 3: Update setup stats
  console.log('\n📈 Step 3: Updating setup stats...');
  
  const closedSignals = await db.signal.findMany({
    where: { status: 'CLOSED', result: { in: ['WIN', 'LOSS'] } },
  });
  
  const statsMap: Record<string, { wins: number; losses: number; total: number; confidence: number; setupScore: number }> = {};
  
  for (const s of closedSignals) {
    const key = `${s.patternType || 'none'}_${s.asset}_${s.sessionType || 'OffHours'}_${s.timeframe}`;
    if (!statsMap[key]) statsMap[key] = { wins: 0, losses: 0, total: 0, confidence: 0, setupScore: 0 };
    statsMap[key].total++;
    if (s.result === 'WIN') statsMap[key].wins++;
    else statsMap[key].losses++;
    statsMap[key].confidence += s.confidence;
    if (s.setupScore) statsMap[key].setupScore += s.setupScore;
  }
  
  for (const [key, data] of Object.entries(statsMap)) {
    const [patternType, asset, session, timeframe] = key.split('_');
    const winRate = data.total > 0 ? (data.wins / data.total) * 100 : 0;
    const avgConfidence = data.total > 0 ? data.confidence / data.total : 0;
    const avgSetupScore = data.total > 0 ? data.setupScore / data.total : 0;
    
    try {
      await db.setupStats.upsert({
        where: {
          patternType_asset_session_timeframe: {
            patternType,
            asset,
            session,
            timeframe,
          },
        },
        create: {
          patternType,
          asset,
          session,
          timeframe,
          totalSignals: data.total,
          wins: data.wins,
          losses: data.losses,
          winRate,
          avgConfidence,
          avgSetupScore,
        },
        update: {
          totalSignals: data.total,
          wins: data.wins,
          losses: data.losses,
          winRate,
          avgConfidence,
          avgSetupScore,
        },
      });
    } catch (e) {
      // Skip if constraint fails
    }
  }
  
  console.log('\n✅ Bulk Generation Complete!');
  console.log('==========================================');
  console.log(`Total signals generated: ${totalGenerated}`);
  console.log(`  WIN: ${wins} (${totalGenerated > 0 ? (wins/totalGenerated*100).toFixed(1) : 0}%)`);
  console.log(`  LOSS: ${losses} (${totalGenerated > 0 ? (losses/totalGenerated*100).toFixed(1) : 0}%)`);
  console.log(`  NO_OPERAR skipped: ${noOperar}`);
  console.log(`  Setup stats entries: ${Object.keys(statsMap).length}`);
  
  const totalInDb = await db.signal.count();
  const autoInDb = await db.signal.count({ where: { source: 'AUTO' } });
  const closedInDb = await db.signal.count({ where: { status: 'CLOSED', result: { in: ['WIN', 'LOSS'] } } });
  
  console.log(`\n📊 Database Totals:`);
  console.log(`  Total signals in DB: ${totalInDb}`);
  console.log(`  Auto-generated: ${autoInDb}`);
  console.log(`  Closed decisive: ${closedInDb}`);
  console.log(`  Reliability: ${closedInDb >= 500 ? 'HIGH' : closedInDb >= 100 ? 'MEDIUM' : closedInDb >= 30 ? 'LOW' : 'INSUFFICIENT'}`);
  console.log(`  Goal: 1000 decisive signals (currently at ${closedInDb})`);
  
  await db.$disconnect();
}

main().catch(console.error);
