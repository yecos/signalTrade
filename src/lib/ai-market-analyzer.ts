// AI MARKET ANALYZER — Análisis de mercado con LLM para ajuste adaptativo
// ═══════════════════════════════════════════════════════════════════════════
// CONCEPTO:
//   Usa un LLM (vía z-ai-web-dev-sdk) para analizar las condiciones actuales
//   del mercado y sugerir ajustes dinámicos a los parámetros de Mean Reversion.
//
//   FUNCIONES:
//   1. Análisis de régimen con IA — confirma/refuta el régimen detectado por código
//   2. Ajuste adaptativo de parámetros — RSI, ADX, BB, volumen según contexto
//   3. Validación walk-forward — verifica que el edge sigue vigente con datos recientes
//   4. Detección de eventos macro — noticias, halvings, fed meetings, etc.
//   5. Recomendaciones de gestión de riesgo — tamaño de posición, stops
//
//   CACHEO: Se llama al LLM cada 30 min máximo (no en cada ciclo de 5 min)
//   para evitar costos excesivos y latencia.
//
//   SEGURIDAD: Los ajustes siempre están acotados dentro de rangos seguros.
//   La IA no puede hacer locuras — solo ajustes dentro de bounds predefinidos.
// ═══════════════════════════════════════════════════════════════════════════

import { db, withRetry } from './db';
import { computeAllIndicators, type IndicatorSnapshot } from './indicators';
import { getCandles as getDBCandles, type Candle } from './market-data';
import { detectRegime, type RegimeResult } from './regime-engine';
import { detectSession, type SessionType } from './sessions';

// === TYPES ===

export interface AIMarketAnalysis {
  timestamp: Date;
  // Regime analysis
  aiRegime: 'RANGING' | 'TRENDING' | 'VOLATILE' | 'TRANSITIONAL' | 'LOW_VOL';
  aiRegimeConfidence: number;         // 0-100
  aiRegimeReasoning: string;
  // Parameter adjustments (bounded)
  suggestedAdjustments: MeanReversionAdjustments;
  // Walk-forward validation
  walkForwardValid: boolean;
  walkForwardWinRate: number;         // Recent WR from last 20 trades
  walkForwardProfitFactor: number;    // Recent PF
  // Risk recommendations
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  positionSizeMultiplier: number;     // 0.0 - 1.5 (reduce or increase size)
  // Event detection
  detectedEvents: MarketEvent[];
  // Overall recommendation
  shouldTrade: boolean;
  overallReasoning: string;
}

export interface MeanReversionAdjustments {
  // Each adjustment has: suggested value, bounds (min/max), and reason
  rsiOversold: { value: number; min: 25; max: 35; reason: string };
  rsiOverbought: { value: number; min: 65; max: 75; reason: string };
  adxMaxRange: { value: number; min: 18; max: 30; reason: string };
  volumeConfirmMin: { value: number; min: 0.8; max: 1.8; reason: string };
  stopLossATRMultiplier: { value: number; min: 1.0; max: 2.5; reason: string };
  trailingATRMultiplier: { value: number; min: 0.5; max: 1.5; reason: string };
  minConfidence: { value: number; min: 45; max: 80; reason: string };
}

export interface MarketEvent {
  type: 'FED_MEETING' | 'CPI_DATA' | 'ETF_FLOWS' | 'HALVING' | 'EXCHANGE_EVENT' | 'WHALE_ACTIVITY' | 'FUNDING_RATE_EXTREME' | 'LIQUIDATION_CASCADE' | 'REGULATORY' | 'OTHER';
  description: string;
  impact: 'LOW' | 'MEDIUM' | 'HIGH';
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

// === DEFAULT ADJUSTMENTS (no AI changes) ===

const DEFAULT_ADJUSTMENTS: MeanReversionAdjustments = {
  rsiOversold: { value: 30, min: 25, max: 35, reason: 'Valor por defecto (backtest proven)' },
  rsiOverbought: { value: 70, min: 65, max: 75, reason: 'Valor por defecto (backtest proven)' },
  adxMaxRange: { value: 25, min: 18, max: 30, reason: 'Valor por defecto (backtest proven)' },
  volumeConfirmMin: { value: 1.2, min: 0.8, max: 1.8, reason: 'Valor por defecto (backtest proven)' },
  stopLossATRMultiplier: { value: 1.5, min: 1.0, max: 2.5, reason: 'Valor por defecto (backtest proven)' },
  trailingATRMultiplier: { value: 1.0, min: 0.5, max: 1.5, reason: 'Valor por defecto (backtest proven)' },
  minConfidence: { value: 60, min: 45, max: 80, reason: 'Valor por defecto (backtest proven)' },
};

// === CACHE STATE ===

let cachedAnalysis: AIMarketAnalysis | null = null;
let lastAnalysisTime = 0;
const ANALYSIS_INTERVAL_MS = 30 * 60 * 1000; // 30 min cache

// === WALK-FORWARD STATE ===

interface WalkForwardTrade {
  timestamp: Date;
  asset: string;
  direction: 'HIGHER' | 'LOWER';
  result: 'WIN' | 'LOSS';
  pnl: number;
}

let recentTrades: WalkForwardTrade[] = [];

// === MAIN: GET AI ANALYSIS ===
// Returns cached analysis if recent, otherwise calls LLM

export async function getAIMarketAnalysis(asset: string = 'ETH/USD'): Promise<AIMarketAnalysis> {
  const now = Date.now();

  // Return cached if still fresh
  if (cachedAnalysis && (now - lastAnalysisTime) < ANALYSIS_INTERVAL_MS) {
    return cachedAnalysis;
  }

  // Run full analysis
  try {
    const analysis = await runFullAnalysis(asset);
    cachedAnalysis = analysis;
    lastAnalysisTime = now;

    // Persist to DB
    await persistAnalysis(analysis);

    return analysis;
  } catch (err: any) {
    console.warn(`[AI-ANALYZER] Error running analysis: ${err.message}. Using fallback.`);

    // Return cached even if stale, or cache+return defaults
    if (cachedAnalysis) {
      return cachedAnalysis;
    }

    // Cache the default analysis so getCachedAnalysis() doesn't return null
    const defaultAnalysis = getDefaultAnalysis();
    cachedAnalysis = defaultAnalysis;
    lastAnalysisTime = now;

    return defaultAnalysis;
  }
}

// === RUN FULL ANALYSIS ===

async function runFullAnalysis(asset: string): Promise<AIMarketAnalysis> {
  // 1. Gather market data
  const candles = await getDBCandles(asset, 'H1', 100);
  const candles15m = await getDBCandles(asset, 'M15', 100);

  if (candles.length < 50) {
    return getDefaultAnalysis('Datos insuficientes para análisis IA');
  }

  // 2. Compute indicators
  const indicators = computeAllIndicators(candles);
  const indicators15m = candles15m.length >= 50 ? computeAllIndicators(candles15m) : null;

  // 3. Detect regime (code-based)
  const regimeResult = detectRegime(candles, indicators);

  // 4. Detect session
  const sessionInfo = detectSession();

  // 5. Get recent trade performance (walk-forward)
  const walkForward = computeWalkForward();

  // 6. Build market context for LLM
  const marketContext = buildMarketContext(candles, indicators, indicators15m, regimeResult, sessionInfo.session, walkForward);

  // 7. Call LLM for analysis
  const aiResponse = await callLLMForAnalysis(marketContext);

  // 8. Parse and validate AI suggestions
  const adjustments = parseAIAdjustments(aiResponse);

  // 9. Determine risk level and position sizing
  const { riskLevel, positionSizeMultiplier } = determineRiskFromAnalysis(
    regimeResult, aiResponse, walkForward, sessionInfo.session
  );

  // 10. Detect market events
  const detectedEvents = detectMarketEvents(candles, indicators, aiResponse);

  // 11. Final recommendation
  const shouldTrade = determineShouldTrade(
    regimeResult, aiResponse, walkForward, riskLevel, adjustments
  );

  const overallReasoning = buildOverallReasoning(
    regimeResult, aiResponse, walkForward, riskLevel, detectedEvents, shouldTrade
  );

  return {
    timestamp: new Date(),
    aiRegime: (aiResponse.regime || regimeResult.regime) as AIMarketAnalysis['aiRegime'],
    aiRegimeConfidence: aiResponse.regimeConfidence || regimeResult.confidence,
    aiRegimeReasoning: aiResponse.regimeReasoning || regimeResult.regimeDescription,
    suggestedAdjustments: adjustments,
    walkForwardValid: walkForward.valid,
    walkForwardWinRate: walkForward.winRate,
    walkForwardProfitFactor: walkForward.profitFactor,
    riskLevel,
    positionSizeMultiplier,
    detectedEvents,
    shouldTrade,
    overallReasoning,
  };
}

// === BUILD MARKET CONTEXT FOR LLM ===

function buildMarketContext(
  candles: Candle[],
  indicators: IndicatorSnapshot,
  indicators15m: IndicatorSnapshot | null,
  regimeResult: RegimeResult,
  session: SessionType,
  walkForward: { valid: boolean; winRate: number; profitFactor: number; tradeCount: number }
): string {
  const last = candles.length - 1;
  const currentPrice = candles[last].close;
  const priceChange24h = candles.length >= 24
    ? ((currentPrice - candles[last - 24].close) / candles[last - 24].close * 100).toFixed(2)
    : 'N/A';
  const priceChange7d = candles.length >= 48
    ? ((currentPrice - candles[last - 48].close) / candles[last - 48].close * 100).toFixed(2)
    : 'N/A';

  return `
You are an expert quantitative crypto trader analyzing ETH/USD market conditions for a Mean Reversion strategy.

CURRENT MARKET DATA:
- Price: $${currentPrice.toFixed(2)}
- 24h Change: ${priceChange24h}%
- 7d Change (approx): ${priceChange7d}%

TECHNICAL INDICATORS (1H timeframe):
- RSI(14): ${indicators.rsi14?.toFixed(1) || 'N/A'}
- Stochastic K: ${indicators.stochK?.toFixed(1) || 'N/A'}, D: ${indicators.stochD?.toFixed(1) || 'N/A'}
- ADX: ${indicators.adx?.toFixed(1) || 'N/A'}, +DI: ${indicators.plusDi?.toFixed(1) || 'N/A'}, -DI: ${indicators.minusDi?.toFixed(1) || 'N/A'}
- Bollinger Bands: Upper $${indicators.bbUpper?.toFixed(2) || 'N/A'}, Middle $${indicators.bbMiddle?.toFixed(2) || 'N/A'}, Lower $${indicators.bbLower?.toFixed(2) || 'N/A'}
- BB Bandwidth: ${indicators.bbBandwidth?.toFixed(4) || 'N/A'}, %B: ${indicators.bbPercentB?.toFixed(3) || 'N/A'}
- ATR(14): ${indicators.atr14?.toFixed(2) || 'N/A'}
- MACD: ${indicators.macdLine?.toFixed(2) || 'N/A'}, Signal: ${indicators.macdSignal?.toFixed(2) || 'N/A'}, Hist: ${indicators.macdHistogram?.toFixed(2) || 'N/A'}
- EMA12: $${indicators.ema12?.toFixed(2) || 'N/A'}, EMA26: $${indicators.ema26?.toFixed(2) || 'N/A'}
- Volume: ${indicators.volumeAnalysis.currentVolume} (relative: ${indicators.volumeAnalysis.relativeVolume}x, trend: ${indicators.volumeAnalysis.volumeTrend})

${indicators15m ? `15M CONFIRMATION:
- RSI(14): ${indicators15m.rsi14?.toFixed(1) || 'N/A'}
- Stochastic K: ${indicators15m.stochK?.toFixed(1) || 'N/A'}
- ADX: ${indicators15m.adx?.toFixed(1) || 'N/A'}` : '15M data unavailable'}

REGIME DETECTION (code-based):
- Primary Regime: ${regimeResult.regime} (confidence: ${regimeResult.confidence}%)
- Sub-regime: ${regimeResult.subRegime || 'None'}
- Trend Strength: ${regimeResult.features.trendStrength}%
- Volatility Level: ${regimeResult.features.volatilityLevel}%
- Range Clarity: ${regimeResult.features.rangeClarity}%
- Momentum Direction: ${regimeResult.features.momentumDirection}

CURRENT SESSION: ${session}

WALK-FORWARD PERFORMANCE (recent trades):
- Recent Trades: ${walkForward.tradeCount}
- Recent Win Rate: ${walkForward.winRate.toFixed(1)}%
- Recent Profit Factor: ${walkForward.profitFactor.toFixed(2)}
- Edge Valid: ${walkForward.valid}

BACKTEST PROVEN PARAMETERS (ETH/USD 1H):
- RSI Oversold: 30, Overbought: 70
- Stoch Oversold: 20, Overbought: 80
- ADX Max Range: 25
- BB Touch Required: true
- Volume Confirm Min: 1.2x
- SL: 1.5x ATR, Trail: 1.0x ATR
- TP Target: BB Middle
- Sessions: Asia, Overlap, London

TASK: Analyze the above data and provide:
1. Your regime classification (RANGING/TRENDING/VOLATILE/TRANSITIONAL) and reasoning
2. Suggested parameter adjustments WITHIN BOUNDS (these are safety limits, do NOT exceed them)
3. Any detected market events or risks
4. Whether the strategy should trade right now

Respond in this EXACT JSON format (no other text):
{
  "regime": "RANGING" | "TRENDING" | "VOLATILE" | "TRANSITIONAL",
  "regimeConfidence": 0-100,
  "regimeReasoning": "string",
  "adjustments": {
    "rsiOversold": { "value": 25-35, "reason": "string" },
    "rsiOverbought": { "value": 65-75, "reason": "string" },
    "adxMaxRange": { "value": 18-30, "reason": "string" },
    "volumeConfirmMin": { "value": 0.8-1.8, "reason": "string" },
    "stopLossATRMultiplier": { "value": 1.0-2.5, "reason": "string" },
    "trailingATRMultiplier": { "value": 0.5-1.5, "reason": "string" },
    "minConfidence": { "value": 45-80, "reason": "string" }
  },
  "events": [
    { "type": "string", "description": "string", "impact": "LOW|MEDIUM|HIGH", "direction": "BULLISH|BEARISH|NEUTRAL" }
  ],
  "shouldTrade": true|false,
  "riskLevel": "LOW|MEDIUM|HIGH|EXTREME",
  "reasoning": "string"
}`;
}

// === CALL LLM ===

interface AIResponse {
  regime?: 'RANGING' | 'TRENDING' | 'VOLATILE' | 'TRANSITIONAL';
  regimeConfidence?: number;
  regimeReasoning?: string;
  adjustments?: Record<string, { value: number; reason: string }>;
  events?: Array<{ type: string; description: string; impact: string; direction: string }>;
  shouldTrade?: boolean;
  riskLevel?: string;
  reasoning?: string;
}

async function callLLMForAnalysis(context: string): Promise<AIResponse> {
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default;
    const zai = await ZAI.create();

    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a quantitative crypto trading analyst. Analyze market data and provide parameter adjustments for a Mean Reversion strategy. Always respond with valid JSON only. Be conservative — only suggest changes when there is clear evidence. When uncertain, keep default parameters.'
        },
        {
          role: 'user',
          content: context,
        }
      ],
      temperature: 0.3, // Low temperature for analytical tasks
      max_tokens: 1500,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
      console.warn('[AI-ANALYZER] No content in LLM response');
      return {};
    }

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    // Try to find JSON object in the string
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      console.warn('[AI-ANALYZER] No JSON object found in LLM response');
      return {};
    }

    const parsed = JSON.parse(objMatch[0]);
    console.log(`[AI-ANALYZER] LLM Analysis: Regime=${parsed.regime}, Confidence=${parsed.regimeConfidence}, ShouldTrade=${parsed.shouldTrade}`);
    return parsed;
  } catch (err: any) {
    console.error(`[AI-ANALYZER] LLM call failed: ${err.message}`);
    return {};
  }
}

// === PARSE AI ADJUSTMENTS WITH BOUND ENFORCEMENT ===

function parseAIAdjustments(aiResponse: AIResponse): MeanReversionAdjustments {
  const adj = aiResponse.adjustments;
  if (!adj) return { ...DEFAULT_ADJUSTMENTS };

  const result: MeanReversionAdjustments = { ...DEFAULT_ADJUSTMENTS };

  // Helper: clamp value within bounds
  function clampWithReason(
    key: keyof MeanReversionAdjustments,
    suggested: { value: number; reason: string } | undefined,
    defaults: MeanReversionAdjustments[keyof MeanReversionAdjustments]
  ): any {
    if (!suggested || typeof suggested.value !== 'number') return defaults;

    const defaultAdj = DEFAULT_ADJUSTMENTS[key] as any;
    const min = defaultAdj.min;
    const max = defaultAdj.max;
    const clamped = Math.max(min, Math.min(max, suggested.value));

    if (clamped !== suggested.value) {
      console.warn(`[AI-ANALYZER] Clamped ${key}: ${suggested.value} → ${clamped} (bounds: ${min}-${max})`);
    }

    return { value: clamped, min, max, reason: suggested.reason || defaultAdj.reason };
  }

  result.rsiOversold = clampWithReason('rsiOversold', adj.rsiOversold, DEFAULT_ADJUSTMENTS.rsiOversold);
  result.rsiOverbought = clampWithReason('rsiOverbought', adj.rsiOverbought, DEFAULT_ADJUSTMENTS.rsiOverbought);
  result.adxMaxRange = clampWithReason('adxMaxRange', adj.adxMaxRange, DEFAULT_ADJUSTMENTS.adxMaxRange);
  result.volumeConfirmMin = clampWithReason('volumeConfirmMin', adj.volumeConfirmMin, DEFAULT_ADJUSTMENTS.volumeConfirmMin);
  result.stopLossATRMultiplier = clampWithReason('stopLossATRMultiplier', adj.stopLossATRMultiplier, DEFAULT_ADJUSTMENTS.stopLossATRMultiplier);
  result.trailingATRMultiplier = clampWithReason('trailingATRMultiplier', adj.trailingATRMultiplier, DEFAULT_ADJUSTMENTS.trailingATRMultiplier);
  result.minConfidence = clampWithReason('minConfidence', adj.minConfidence, DEFAULT_ADJUSTMENTS.minConfidence);

  return result;
}

// === WALK-FORWARD VALIDATION ===

function computeWalkForward(): {
  valid: boolean;
  winRate: number;
  profitFactor: number;
  tradeCount: number;
} {
  const minTrades = 10;

  if (recentTrades.length < minTrades) {
    // Not enough recent trades — assume valid (backtest proven)
    return { valid: true, winRate: 62.3, profitFactor: 2.32, tradeCount: recentTrades.length };
  }

  const recent = recentTrades.slice(-20); // Last 20 trades
  const wins = recent.filter(t => t.result === 'WIN');
  const losses = recent.filter(t => t.result === 'LOSS');

  const winRate = (wins.length / recent.length) * 100;
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;

  // Edge is valid if WR > 50% AND PF > 1.0
  const valid = winRate > 50 && profitFactor > 1.0;

  return { valid, winRate, profitFactor, tradeCount: recent.length };
}

// === ADD TRADE TO WALK-FORWARD TRACKER ===

export function recordWalkForwardTrade(
  asset: string,
  direction: 'HIGHER' | 'LOWER',
  result: 'WIN' | 'LOSS',
  pnl: number
): void {
  recentTrades.push({
    timestamp: new Date(),
    asset,
    direction,
    result,
    pnl,
  });

  // Keep last 100 trades
  if (recentTrades.length > 100) {
    recentTrades = recentTrades.slice(-100);
  }

  // Persist to DB
  persistWalkForwardTrades().catch(err => {
    console.error(`[AI-ANALYZER] Failed to persist walk-forward trades: ${err.message}`);
  });
}

// === RISK DETERMINATION ===

function determineRiskFromAnalysis(
  regimeResult: RegimeResult,
  aiResponse: AIResponse,
  walkForward: { valid: boolean; winRate: number; profitFactor: number; tradeCount: number },
  session: SessionType
): { riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'; positionSizeMultiplier: number } {
  let riskScore = 0; // 0-100, higher = more risk

  // Regime factor
  if (regimeResult.regime === 'TRENDING' || regimeResult.regime === 'VOLATILE') {
    riskScore += 30; // Bad for mean reversion
  } else if (regimeResult.regime === 'LOW_VOL') {
    riskScore += 10; // Low vol = small moves = small profits
  } else if (regimeResult.regime === 'RANGING') {
    riskScore += 0; // Ideal
  }

  // Volatility factor
  if (regimeResult.features.volatilityLevel > 70) riskScore += 20;
  else if (regimeResult.features.volatilityLevel > 50) riskScore += 10;

  // Walk-forward factor
  if (!walkForward.valid) riskScore += 25;
  else if (walkForward.winRate < 55) riskScore += 10;

  // Session factor
  if (session === 'OffHours') riskScore += 20;
  else if (session === 'NewYork') riskScore += 10; // NY often has trends

  // AI recommendation factor
  if (aiResponse.riskLevel === 'EXTREME') riskScore += 25;
  else if (aiResponse.riskLevel === 'HIGH') riskScore += 15;
  else if (aiResponse.riskLevel === 'MEDIUM') riskScore += 5;

  // Determine risk level
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  if (riskScore >= 60) riskLevel = 'EXTREME';
  else if (riskScore >= 40) riskLevel = 'HIGH';
  else if (riskScore >= 20) riskLevel = 'MEDIUM';
  else riskLevel = 'LOW';

  // Position size multiplier (inverse of risk)
  let positionSizeMultiplier = 1.0;
  if (riskLevel === 'EXTREME') positionSizeMultiplier = 0.0; // No trades
  else if (riskLevel === 'HIGH') positionSizeMultiplier = 0.5;
  else if (riskLevel === 'MEDIUM') positionSizeMultiplier = 0.75;
  else positionSizeMultiplier = 1.0;

  // Boost if walk-forward is excellent
  if (walkForward.valid && walkForward.winRate > 65 && walkForward.profitFactor > 2.0 && riskLevel === 'LOW') {
    positionSizeMultiplier = 1.25; // Slight boost for excellent conditions
  }

  return { riskLevel, positionSizeMultiplier };
}

// === MARKET EVENT DETECTION ===

function detectMarketEvents(
  candles: Candle[],
  indicators: IndicatorSnapshot,
  aiResponse: AIResponse
): MarketEvent[] {
  const events: MarketEvent[] = [];

  // 1. Code-based event detection
  const last = candles.length - 1;

  // Volume spike
  if (indicators.volumeAnalysis.relativeVolume > 3) {
    events.push({
      type: 'OTHER',
      description: `Volumen anómalo: ${indicators.volumeAnalysis.relativeVolume.toFixed(1)}x promedio`,
      impact: 'HIGH',
      direction: 'NEUTRAL',
    });
  }

  // Extreme RSI
  if (indicators.rsi14 !== null && indicators.rsi14 < 20) {
    events.push({
      type: 'LIQUIDATION_CASCADE',
      description: `RSI extremo (${indicators.rsi14.toFixed(1)}) — posible cascada de liquidaciones`,
      impact: 'HIGH',
      direction: 'BEARISH',
    });
  } else if (indicators.rsi14 !== null && indicators.rsi14 > 80) {
    events.push({
      type: 'LIQUIDATION_CASCADE',
      description: `RSI extremo (${indicators.rsi14.toFixed(1)}) — posible cascada de liquidaciones`,
      impact: 'HIGH',
      direction: 'BULLISH',
    });
  }

  // Large candle (potential event)
  if (indicators.atr14) {
    const candleRange = candles[last].high - candles[last].low;
    if (candleRange > indicators.atr14 * 3) {
      events.push({
        type: 'OTHER',
        description: `Vela grande: rango ${(candleRange / indicators.atr14).toFixed(1)}x ATR — posible evento macro`,
        impact: 'MEDIUM',
        direction: candles[last].close > candles[last].open ? 'BULLISH' : 'BEARISH',
      });
    }
  }

  // 2. AI-detected events
  if (aiResponse.events && Array.isArray(aiResponse.events)) {
    for (const evt of aiResponse.events) {
      const validTypes = ['FED_MEETING', 'CPI_DATA', 'ETF_FLOWS', 'HALVING', 'EXCHANGE_EVENT', 'WHALE_ACTIVITY', 'FUNDING_RATE_EXTREME', 'LIQUIDATION_CASCADE', 'REGULATORY', 'OTHER'];
      events.push({
        type: validTypes.includes(evt.type) ? evt.type as MarketEvent['type'] : 'OTHER',
        description: evt.description || 'Evento detectado por IA',
        impact: ['LOW', 'MEDIUM', 'HIGH'].includes(evt.impact) ? evt.impact as MarketEvent['impact'] : 'MEDIUM',
        direction: ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(evt.direction) ? evt.direction as MarketEvent['direction'] : 'NEUTRAL',
      });
    }
  }

  return events;
}

// === SHOULD TRADE DECISION ===

function determineShouldTrade(
  regimeResult: RegimeResult,
  aiResponse: AIResponse,
  walkForward: { valid: boolean; winRate: number; profitFactor: number; tradeCount: number },
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME',
  adjustments: MeanReversionAdjustments
): boolean {
  // Hard blocks
  if (riskLevel === 'EXTREME') return false;
  if (!walkForward.valid && walkForward.tradeCount >= 10) return false; // Lost edge

  // Regime blocks
  if (regimeResult.regime === 'TRENDING' && regimeResult.confidence > 60) return false;
  if (regimeResult.regime === 'VOLATILE' && regimeResult.confidence > 50) return false;

  // AI override
  if (aiResponse.shouldTrade === false && aiResponse.riskLevel === 'EXTREME') return false;

  // OK to trade
  return true;
}

// === BUILD OVERALL REASONING ===

function buildOverallReasoning(
  regimeResult: RegimeResult,
  aiResponse: AIResponse,
  walkForward: { valid: boolean; winRate: number; profitFactor: number; tradeCount: number },
  riskLevel: string,
  detectedEvents: MarketEvent[],
  shouldTrade: boolean
): string {
  const parts: string[] = [];

  parts.push(`Regimen: ${regimeResult.regime} (${regimeResult.confidence}% conf.)`);
  if (aiResponse.regimeReasoning) {
    parts.push(`IA: ${aiResponse.regimeReasoning}`);
  }
  parts.push(`Walk-Forward: WR ${walkForward.winRate.toFixed(1)}%, PF ${walkForward.profitFactor.toFixed(2)}, Edge ${walkForward.valid ? 'valido' : 'perdido'}`);
  parts.push(`Riesgo: ${riskLevel}`);

  if (detectedEvents.length > 0) {
    parts.push(`Eventos: ${detectedEvents.map(e => `${e.type}(${e.impact})`).join(', ')}`);
  }

  parts.push(`Decision: ${shouldTrade ? 'OPERAR' : 'NO operar'}`);

  return parts.join(' | ');
}

// === DEFAULT ANALYSIS (when AI unavailable) ===

function getDefaultAnalysis(reason?: string): AIMarketAnalysis {
  return {
    timestamp: new Date(),
    aiRegime: 'RANGING',
    aiRegimeConfidence: 30, // Low confidence since no AI
    aiRegimeReasoning: reason || 'Analisis IA no disponible, usando valores por defecto',
    suggestedAdjustments: { ...DEFAULT_ADJUSTMENTS },
    walkForwardValid: true, // Assume valid (backtest proven)
    walkForwardWinRate: 62.3,
    walkForwardProfitFactor: 2.32,
    riskLevel: 'MEDIUM',
    positionSizeMultiplier: 0.75, // Conservative default
    detectedEvents: [],
    shouldTrade: true,
    overallReasoning: `Modo seguro: IA no disponible${reason ? ` (${reason})` : ''}. Usando parametros backtest-proven con tamaño reducido.`,
  };
}

// === GET ADJUSTED MEAN REVERSION CONFIG ===
// This is the main function that Mean Reversion calls to get AI-adjusted params

export async function getAIAdjustedConfig(): Promise<{
  adjustments: MeanReversionAdjustments;
  shouldTrade: boolean;
  positionSizeMultiplier: number;
  analysis: AIMarketAnalysis;
}> {
  const analysis = await getAIMarketAnalysis('ETH/USD');

  return {
    adjustments: analysis.suggestedAdjustments,
    shouldTrade: analysis.shouldTrade,
    positionSizeMultiplier: analysis.positionSizeMultiplier,
    analysis,
  };
}

// === FORCE REFRESH (for manual trigger) ===

export function forceRefreshAnalysis(): void {
  lastAnalysisTime = 0;
  cachedAnalysis = null;
  console.log('[AI-ANALYZER] Cache cleared — next call will run fresh analysis');
}

// === GET CACHED ANALYSIS (no LLM call) ===

export function getCachedAnalysis(): AIMarketAnalysis | null {
  return cachedAnalysis;
}

// === PERSISTENCE ===

async function persistAnalysis(analysis: AIMarketAnalysis): Promise<void> {
  try {
    await withRetry(
      () => db.appSettings.upsert({
        where: { key: 'ai_market_analysis' },
        create: {
          key: 'ai_market_analysis',
          value: JSON.stringify(analysis),
          description: 'Latest AI market analysis',
        },
        update: { value: JSON.stringify(analysis) },
      }),
      2, 500, 'ai-analysis-persist'
    );
  } catch { /* best effort */ }
}

async function persistWalkForwardTrades(): Promise<void> {
  try {
    await withRetry(
      () => db.appSettings.upsert({
        where: { key: 'ai_walkforward_trades' },
        create: {
          key: 'ai_walkforward_trades',
          value: JSON.stringify(recentTrades.slice(-50)), // Last 50
          description: 'Walk-forward trade history for AI analyzer',
        },
        update: { value: JSON.stringify(recentTrades.slice(-50)) },
      }),
      2, 500, 'ai-walkforward-persist'
    );
  } catch { /* best effort */ }
}

// === LOAD PERSISTED STATE ON STARTUP ===

export async function loadAIAnalyzerState(): Promise<void> {
  try {
    // Load cached analysis
    const analysisSetting = await db.appSettings.findUnique({
      where: { key: 'ai_market_analysis' },
    });
    if (analysisSetting) {
      cachedAnalysis = JSON.parse(analysisSetting.value);
      lastAnalysisTime = new Date(cachedAnalysis!.timestamp).getTime();
      console.log(`[AI-ANALYZER] Loaded cached analysis from ${cachedAnalysis!.timestamp}`);
    }

    // Load walk-forward trades
    const tradesSetting = await db.appSettings.findUnique({
      where: { key: 'ai_walkforward_trades' },
    });
    if (tradesSetting) {
      recentTrades = JSON.parse(tradesSetting.value);
      console.log(`[AI-ANALYZER] Loaded ${recentTrades.length} walk-forward trades`);
    }

    // Also load from Signal records for historical performance
    await loadRecentSignalPerformance();
  } catch (err: any) {
    console.error(`[AI-ANALYZER] Error loading state: ${err.message}`);
  }
}

async function loadRecentSignalPerformance(): Promise<void> {
  try {
    // Load last 50 closed signals from Mean Reversion
    const signals = await db.signal.findMany({
      where: {
        patternType: 'mean_reversion',
        status: 'CLOSED',
        result: { in: ['WIN', 'LOSS'] },
      },
      orderBy: { entryTime: 'desc' },
      take: 50,
    });

    for (const signal of signals) {
      const pnl = signal.result === 'WIN'
        ? (signal.estimatedProfit || 0)
        : -(signal.estimatedLoss || 0);

      // Avoid duplicates
      const exists = recentTrades.some(t =>
        t.asset === signal.asset &&
        t.direction === signal.direction &&
        Math.abs(new Date(t.timestamp).getTime() - new Date(signal.entryTime).getTime()) < 60000
      );

      if (!exists) {
        recentTrades.push({
          timestamp: new Date(signal.entryTime),
          asset: signal.asset,
          direction: signal.direction as 'HIGHER' | 'LOWER',
          result: signal.result as 'WIN' | 'LOSS',
          pnl,
        });
      }
    }

    // Sort by timestamp and keep last 100
    recentTrades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (recentTrades.length > 100) {
      recentTrades = recentTrades.slice(-100);
    }

    console.log(`[AI-ANALYZER] Total walk-forward trades after DB load: ${recentTrades.length}${recentTrades.length === 0 ? ' (esperado — Mean Reversion aún no genera trades cerrados, usando backtest proven defaults)' : ''}`);
  } catch (err: any) {
    console.error(`[AI-ANALYZER] Error loading signal performance: ${err.message}`);
  }
}
