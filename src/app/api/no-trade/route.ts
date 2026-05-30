// No-Trade + Confluence + Trade Management API
// Exposes the 3-System Architecture for the dashboard

import { NextRequest, NextResponse } from 'next/server';
import { getCandles as getEngineCandles } from '@/lib/market-engine';
import { getCandles as getDBCandles, generateHistoricalCandles } from '@/lib/market-data';
import { computeAllIndicators } from '@/lib/indicators';
import { detectPatterns } from '@/lib/patterns';
import { detectSession } from '@/lib/sessions';
import { detectRegime } from '@/lib/regime-engine';
import { assessNoTrade } from '@/lib/no-trade-system';
import { assessConfluence } from '@/lib/confluence-engine';
import { createTradeManagementPlan, assessPortfolioRisk } from '@/lib/trade-manager';
import { getOrCreateAccount } from '@/lib/risk-manager';
import { calculateSetupScore } from '@/lib/auto-trader';
import { quickMTFScore } from '@/lib/mtf-analysis';
import { getEdgeDecision } from '@/lib/edge-profile';
import { db } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const asset = searchParams.get('asset') || 'BTC/USD';
    const timeframe = searchParams.get('timeframe') || 'M5';

    // Get candles
    let candles: any[] = [];
    let dataSource = 'FALLBACK';

    try {
      const engineResult = await getEngineCandles(asset, timeframe, 100);
      if (engineResult.candles.length >= 30) {
        candles = engineResult.candles;
        dataSource = engineResult.source;
      }
    } catch { /* fallback */ }

    if (candles.length < 50) {
      const dbCandles = await getDBCandles(asset, timeframe, 100);
      if (dbCandles.length >= 30) {
        candles = dbCandles;
        dataSource = 'FALLBACK';
      } else {
        await generateHistoricalCandles(asset, timeframe, 200);
        candles = await getDBCandles(asset, timeframe, 100);
      }
    }

    if (candles.length < 30) {
      return NextResponse.json({
        error: 'Datos insuficientes',
        noTrade: null,
        confluence: null,
        tradeManagement: null,
      });
    }

    // Compute all analytics
    const indicators = computeAllIndicators(candles);
    const patterns = detectPatterns(candles, indicators);
    const bestPattern = patterns.length > 0 ? patterns.reduce((a, b) => a.confidence > b.confidence ? a : b) : null;
    const session = detectSession();
    const regimeResult = detectRegime(candles, indicators);

    // MTF analysis
    let mtfScore = 0;
    let mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    try {
      const m15Candles = await getDBCandles(asset, 'M15', 100);
      const h1Candles = await getDBCandles(asset, 'H1', 100);
      const h4Candles = await getDBCandles(asset, 'H4', 100);
      const mtfResult = quickMTFScore(candles, m15Candles, h1Candles, h4Candles);
      mtfScore = mtfResult.score;
      mtfDirection = mtfResult.confluence.overallDirection;
    } catch { /* best effort */ }

    // Historical stats
    const { sampleSize, historicalWinRate } = await calculateSetupScore(
      bestPattern?.type || null, asset, session.session, indicators
    );

    // Edge classification
    let edgeClassification = 'GREY';
    try {
      const sampleSizeCheck = await db.signal.count({ where: { asset, status: { not: 'PENDING' } } });
      const strictMode = sampleSizeCheck >= 1000;
      const edgeDecision = await getEdgeDecision(
        bestPattern?.type || null, session.session, asset, 50, !strictMode
      );
      edgeClassification = edgeDecision.classification;
    } catch { /* default */ }

    // ═══ SYSTEM 1: NO-TRADE ASSESSMENT ═══
    const noTrade = assessNoTrade({
      asset,
      candles,
      indicators,
      regimeResult,
      patternType: bestPattern?.type || null,
      sessionType: session.session,
    });

    // ═══ SYSTEM 2: CONFLUENCE ASSESSMENT ═══
    const confluence = assessConfluence({
      asset,
      pattern: bestPattern,
      indicators,
      regimeResult,
      mtfScore,
      mtfDirection,
      sessionType: session.session,
      historicalWinRate,
      historicalSampleSize: sampleSize,
      historicalExpectancy: 0,
      edgeClassification,
      noTradeAssessment: noTrade,
      entryPrice: candles[candles.length - 1].close,
      atr: indicators.atr14 || candles[candles.length - 1].close * 0.005,
    });

    // ═══ SYSTEM 3: TRADE MANAGEMENT ═══
    let tradeManagement: any = null;
    if (confluence.shouldTrade && confluence.setup) {
      try {
        const account = await getOrCreateAccount();
        const openPositions = await db.position.findMany({ where: { status: 'OPEN' } });

        tradeManagement = createTradeManagementPlan({
          setup: confluence.setup,
          accountBalance: account.balance,
          atr: indicators.atr14 || candles[candles.length - 1].close * 0.005,
          regimeResult,
          noTradeAssessment: noTrade,
          consecutiveLosses: 0,
          openPositions: openPositions.map(p => ({
            asset: p.asset,
            direction: p.direction,
            entryPrice: p.entryPrice,
            quantity: p.quantity,
            unrealizedPnl: p.unrealizedPnl || 0,
          })),
          timeframe,
        });
      } catch (err: any) {
        console.error('Trade management failed:', err.message);
      }
    }

    // Portfolio risk
    let portfolioRisk: any = null;
    try {
      const account = await getOrCreateAccount();
      const openPositions = await db.position.findMany({ where: { status: 'OPEN' } });
      portfolioRisk = assessPortfolioRisk({
        accountBalance: account.balance,
        openPositions: openPositions.map(p => ({
          asset: p.asset,
          direction: p.direction,
          entryPrice: p.entryPrice,
          quantity: p.quantity,
          unrealizedPnl: p.unrealizedPnl || 0,
        })),
      });
    } catch { /* best effort */ }

    return NextResponse.json({
      asset,
      timeframe,
      dataSource,
      currentPrice: candles[candles.length - 1].close,
      session: session.session,
      regime: {
        regime: regimeResult.regime,
        confidence: regimeResult.confidence,
        description: regimeResult.regimeDescription,
      },
      pattern: bestPattern ? {
        type: bestPattern.type,
        direction: bestPattern.direction,
        confidence: bestPattern.confidence,
      } : null,
      noTrade,
      confluence: {
        confluenceScore: confluence.confluenceScore,
        shouldTrade: confluence.shouldTrade,
        reason: confluence.reason,
        setup: confluence.setup ? {
          strategyName: confluence.setup.strategyName,
          direction: confluence.setup.direction,
          entryPrice: confluence.setup.entryPrice,
          stopLoss: confluence.setup.stopLoss,
          takeProfit: confluence.setup.takeProfit,
          riskRewardRatio: confluence.setup.riskRewardRatio,
          riskPercent: confluence.setup.riskPercent,
          confluenceScore: confluence.setup.confluenceScore,
          regimeCompatibility: confluence.setup.regimeCompatibility,
          sessionQuality: confluence.setup.sessionQuality,
          timeframeAlignment: confluence.setup.timeframeAlignment,
          thesisInvalidation: confluence.setup.thesisInvalidation,
        } : null,
        factors: confluence.factors.map(f => ({
          name: f.nameEs,
          score: f.score,
          weight: f.weight,
          direction: f.direction,
          reason: f.reason,
        })),
      },
      tradeManagement: tradeManagement ? {
        positionSize: {
          adjustedSize: tradeManagement.positionSize.adjustedSize,
          sizeUsd: tradeManagement.positionSize.sizeUsd,
          riskAmount: tradeManagement.positionSize.riskAmount,
          riskPercent: tradeManagement.positionSize.riskPercent,
          sizingMethod: tradeManagement.positionSize.sizingMethod,
          adjustments: tradeManagement.positionSize.adjustments,
        },
        stopLoss: {
          adjustedStop: tradeManagement.stopLoss.adjustedStop,
          stopType: tradeManagement.stopLoss.stopType,
          stopDistance: tradeManagement.stopLoss.stopDistance,
          adjustments: tradeManagement.stopLoss.adjustments,
        },
        takeProfit: tradeManagement.takeProfit,
        riskRewardRatio: tradeManagement.riskRewardRatio,
        exitAlerts: tradeManagement.exitAlerts,
        partialProfitPlan: tradeManagement.partialProfitPlan,
        timeManagement: tradeManagement.timeManagement,
      } : null,
      portfolioRisk,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
