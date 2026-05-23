import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateStats } from "@/lib/signals";

// ─── Data Availability Tracking ──────────────────────────────────────────────

interface DataAvailability {
  technical: boolean;
  volume: boolean;
  patterns: boolean;
  sentiment: boolean;
  news: boolean;
  macro: boolean;
  historical: boolean;
  aiModel: boolean;
}

function determineAnalysisMode(availability: DataAvailability): string {
  const available = Object.values(availability).filter(Boolean).length;
  const total = Object.values(availability).length;

  if (available === total) return "FULL";
  if (available >= total * 0.5) return "PARTIAL";
  return "FALLBACK";
}

function determineStatisticalReliability(sampleSize: number): string {
  if (sampleSize >= 500) return "HIGH";
  if (sampleSize >= 100) return "MEDIUM";
  if (sampleSize >= 30) return "LOW";
  return "INSUFFICIENT";
}

// ─── Base prices for reference ───────────────────────────────────────────────

const BASE_PRICES: Record<string, number> = {
  "EUR/USD": 1.085,
  "GBP/USD": 1.265,
  "USD/JPY": 149.5,
  "AUD/USD": 0.655,
  "EUR/GBP": 0.857,
  "BTC/USD": 67500,
  "ETH/USD": 3450,
};

const EXP_MAP: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { asset, timeframe } = body;

    // Get historical stats for AI context
    const signals = await db.signal.findMany({
      orderBy: { entryTime: "desc" },
    });

    const stats = calculateStats(signals as Parameters<typeof calculateStats>[0]);
    const closedSignals = signals.filter((s) => s.status === "CLOSED" && s.result);
    const historicalSampleSize = closedSignals.length;

    // ─── Step 1: Determine data availability ──────────────────────────────────

    const dataAvailability: DataAvailability = {
      technical: false,
      volume: false,
      patterns: false,
      sentiment: false,
      news: false,
      macro: false,
      historical: historicalSampleSize >= 30,
      aiModel: false,
    };

    // ─── Step 2: Check if we have MINIMUM conditions to operate ───────────────

    const minimumConditionsMet = historicalSampleSize >= 10;

    if (!minimumConditionsMet) {
      // NOT ENOUGH DATA - Must say NO_OPERAR, never invent a signal
      const noOperarReason = buildNoOperarReason(dataAvailability, historicalSampleSize, stats);

      const entryTime = new Date();
      const selectedTf = timeframe || "M5";
      const selectedAsset = asset || "EUR/USD";

      const signal = await db.signal.create({
        data: {
          asset: selectedAsset,
          timeframe: selectedTf,
          direction: "NO_OPERAR",
          entryPrice: BASE_PRICES[selectedAsset] || 1.0,
          entryTime,
          expirationMinutes: EXP_MAP[selectedTf] || 5,
          expirationTime: new Date(entryTime.getTime() + (EXP_MAP[selectedTf] || 5) * 60000),
          confidence: 0,
          aiReason: noOperarReason,
          technicalJson: null,
          patternsJson: null,
          volumeJson: null,
          newsJson: null,
          sentimentJson: null,
          macroJson: null,
          estimatedProfit: null,
          estimatedLoss: null,
          status: "CLOSED",
          result: "NO_OPERAR",
          analysisMode: "FALLBACK",
          dataAvailability: JSON.stringify(dataAvailability),
          statisticalReliability: determineStatisticalReliability(historicalSampleSize),
          historicalSampleSize,
        },
      });

      return NextResponse.json({
        signal,
        warning: "DATOS INSUFICIENTES: No se generó señal de operación. Se registró NO_OPERAR.",
        dataAvailability,
        statisticalReliability: determineStatisticalReliability(historicalSampleSize),
        historicalSampleSize,
        minimumRequired: 30,
      }, { status: 201 });
    }

    // ─── Step 3: Try AI full analysis ─────────────────────────────────────────

    let aiResponse: Record<string, unknown> | null = null;
    let aiSucceeded = false;

    try {
      const ZAI = (await import("z-ai-web-dev-sdk")).default;
      const zai = await ZAI.create();

      // Build rich context for AI
      const assetWinRate = asset && stats.winRateByAsset[asset]
        ? `${stats.winRateByAsset[asset].rate.toFixed(1)}% (${stats.winRateByAsset[asset].total} señales)`
        : "Sin datos suficientes";
      const tfWinRate = timeframe && stats.winRateByTimeframe[timeframe]
        ? `${stats.winRateByTimeframe[timeframe].rate.toFixed(1)}% (${stats.winRateByTimeframe[timeframe].total} señales)`
        : "Sin datos suficientes";

      const recentResults = closedSignals
        .slice(0, 10)
        .map((s) => s.result === "WIN" ? "W" : s.result === "LOSS" ? "L" : "D")
        .join("/");

      const context = {
        historical_performance: {
          total_signals: stats.totalSignals,
          closed_signals: historicalSampleSize,
          general_winrate: `${stats.winRate.toFixed(1)}%`,
          asset_winrate: assetWinRate,
          timeframe_winrate: tfWinRate,
          last_10_signals: recentResults || "Sin datos",
          best_asset: stats.bestAsset || "Sin datos",
          worst_asset: stats.worstAsset || "Sin datos",
          best_timeframe: stats.bestTimeframe || "Sin datos",
          worst_timeframe: stats.worstTimeframe || "Sin datos",
          confidence_threshold_recommended: stats.recommendedConfidenceThreshold,
          current_consecutive_losses: stats.currentConsecutiveLosses,
          current_consecutive_wins: stats.currentConsecutiveWins,
          profit_factor: stats.profitFactor,
          statistical_reliability: determineStatisticalReliability(historicalSampleSize),
        },
        requested_asset: asset || "No especificado",
        requested_timeframe: timeframe || "No especificado",
      };

      const completion = await zai.chat.completions.create({
        messages: [
          {
            role: "system",
            content: `Eres un analista de trading experto en opciones binarias. Tu trabajo es analizar datos y generar señales de trading con TRANSPARENCIA TOTAL.

REGLA CRÍTICA - NUNCA INVENTES DATOS:
- Si no tienes datos de noticias, NO inventes análisis de noticias
- Si no tienes datos de volumen, NO inventes análisis de volumen
- Si no tienes datos de sentimiento, NO inventes análisis de sentimiento
- Si no tienes suficientes datos históricos, la dirección DEBE ser NO_OPERAR
- Si hay contradicciones entre indicadores, considera NO_OPERAR
- Si el historial del activo es malo, considera NO_OPERAR
- Si hay pérdidas consecutivas (3+), considera NO_OPERAR
- Si la confianza es baja (<60%), la dirección debe ser NO_OPERAR

REGLA DE ORO:
Es MUCHO más profesional decir "No tengo suficiente información" que inventar una entrada.

CONTEXTO HISTÓRICO:
${JSON.stringify(context, null, 2)}

INSTRUCCIONES:
1. Analiza el rendimiento histórico del activo y temporalidad solicitados
2. Evalúa la CONFIABILIDAD de los datos disponibles
3. Genera una señal con dirección HIGHER, LOWER o NO_OPERAR
4. La confianza debe ser entre 0-100 basada en la CONSISTENCIA de los datos
5. Si los datos son insuficientes o contradictorios, dirección = NO_OPERAR
6. Explica DETALLADAMENTE tu razonamiento, incluyendo qué datos faltan
7. Indica exactamente qué fuentes de datos estaban disponibles y cuáles no

RESPONDE ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "signal": {
    "asset": "EUR/USD",
    "timeframe": "M5",
    "direction": "HIGHER",
    "confidence": 75,
    "expirationMinutes": 5,
    "aiReason": "Razonamiento detallado explicando qué datos se usaron y cuáles faltan",
    "entryPrice": 1.0850,
    "technicalJson": "{\"trend\":\"bullish\",\"rsi\":55,\"macd\":\"positive\"}",
    "patternsJson": "{\"pattern\":\"engulfing\",\"reliability\":\"high\"}",
    "volumeJson": "{\"volume\":\"above_average\",\"trend\":\"increasing\"}",
    "newsJson": "{\"impact\":\"low\",\"sentiment\":\"neutral\"}",
    "sentimentJson": "{\"overall\":\"bullish\",\"score\":0.65}",
    "macroJson": "{\"event\":\"none\",\"impact\":\"low\"}",
    "estimatedProfit": 85,
    "estimatedLoss": 100,
    "dataAvailable": {
      "technical": true,
      "volume": true,
      "patterns": true,
      "sentiment": false,
      "news": false,
      "macro": false
    }
  }
}

Los activos disponibles son: EUR/USD, GBP/USD, USD/JPY, AUD/USD, EUR/GBP, BTC/USD, ETH/USD
Las temporalidades disponibles son: M1, M5, M15, M30, H1
Los expirationMinutes deben coincidir con la temporalidad: M1=1, M5=5, M15=15, M30=30, H1=60`,
          },
          {
            role: "user",
            content: `Genera una señal de trading para ${asset || "cualquier activo"} en temporalidad ${timeframe || "cualquiera"}. Considera el contexto histórico proporcionado. Sé HONESTO sobre la calidad de los datos.`,
          },
        ],
        temperature: 0.7,
      });

      const content = completion.choices[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No se pudo extraer JSON de la respuesta IA");
      }
      aiResponse = JSON.parse(jsonMatch[0]);
      aiSucceeded = true;
      dataAvailability.aiModel = true;
    } catch (aiError) {
      console.error("AI generation failed:", aiError);
      // AI failed - we do NOT invent a signal. We create NO_OPERAR.
    }

    // ─── Step 4: Process AI response or generate honest NO_OPERAR ─────────────

    if (aiSucceeded && aiResponse) {
      const signalData = aiResponse.signal as Record<string, unknown>;

      // Track what data the AI actually had
      const aiDataAvail = signalData.dataAvailable as DataAvailability | undefined;
      if (aiDataAvail) {
        dataAvailability.technical = aiDataAvail.technical || false;
        dataAvailability.volume = aiDataAvail.volume || false;
        dataAvailability.patterns = aiDataAvail.patterns || false;
        dataAvailability.sentiment = aiDataAvail.sentiment || false;
        dataAvailability.news = aiDataAvail.news || false;
        dataAvailability.macro = aiDataAvail.macro || false;
      } else {
        // If AI didn't report availability, mark what we can infer
        dataAvailability.technical = !!signalData.technicalJson;
        dataAvailability.volume = !!signalData.volumeJson;
        dataAvailability.patterns = !!signalData.patternsJson;
        dataAvailability.sentiment = !!signalData.sentimentJson;
        dataAvailability.news = !!signalData.newsJson;
        dataAvailability.macro = !!signalData.macroJson;
      }

      const analysisMode = determineAnalysisMode(dataAvailability);
      const statReliability = determineStatisticalReliability(historicalSampleSize);

      const entryTime = new Date();
      const expirationTime = new Date(
        entryTime.getTime() + (signalData.expirationMinutes as number) * 60000
      );

      const signal = await db.signal.create({
        data: {
          asset: signalData.asset as string,
          timeframe: signalData.timeframe as string,
          direction: signalData.direction as string,
          entryPrice: signalData.entryPrice as number,
          entryTime,
          expirationMinutes: signalData.expirationMinutes as number,
          expirationTime,
          confidence: signalData.confidence as number,
          aiReason: signalData.aiReason as string,
          technicalJson: signalData.technicalJson as string | null,
          patternsJson: signalData.patternsJson as string | null,
          volumeJson: signalData.volumeJson as string | null,
          newsJson: signalData.newsJson as string | null,
          sentimentJson: signalData.sentimentJson as string | null,
          macroJson: signalData.macroJson as string | null,
          estimatedProfit: signalData.estimatedProfit as number | null,
          estimatedLoss: signalData.estimatedLoss as number | null,
          status: signalData.direction === "NO_OPERAR" ? "CLOSED" : "PENDING",
          result: signalData.direction === "NO_OPERAR" ? "NO_OPERAR" : null,
          analysisMode,
          dataAvailability: JSON.stringify(dataAvailability),
          statisticalReliability: statReliability,
          historicalSampleSize,
        },
      });

      return NextResponse.json({
        signal,
        dataAvailability,
        statisticalReliability: statReliability,
        historicalSampleSize,
        analysisMode,
      }, { status: 201 });
    }

    // ─── Step 5: AI FAILED - Honest NO_OPERAR ─────────────────────────────────

    // We do NOT invent a signal when the AI fails.
    // We record an honest NO_OPERAR with full transparency.

    const selectedAsset = asset || "EUR/USD";
    const selectedTf = timeframe || "M5";
    const entryTime = new Date();
    const expMinutes = EXP_MAP[selectedTf] || 5;

    const noOperarReason = [
      "NO_OPERAR AUTOMÁTICO: El modelo de IA no está disponible.",
      "",
      "DATOS DISPONIBLES:",
      `  ✘ IA Principal: CAÍDA`,
      `  ✘ Indicadores Técnicos: No disponibles sin IA`,
      `  ✘ Volumen: No disponible`,
      `  ✘ Patrones: No disponible`,
      `  ✘ Noticias: No disponible`,
      `  ✘ Sentimiento: No disponible`,
      `  ✘ Macro: No disponible`,
      `  ${dataAvailability.historical ? "✔" : "✘"} Historial: ${historicalSampleSize} señales`,
      "",
      "RAZÓN: Sin acceso al modelo de IA, no es posible realizar un análisis confiable.",
      "Operar sin análisis completo es irresponsable. Esperar a que el sistema se recupere.",
      "",
      `MODO DE ANÁLISIS: FALLBACK`,
      `CONFIABILIDAD ESTADÍSTICA: ${determineStatisticalReliability(historicalSampleSize)}`,
    ].join("\n");

    const signal = await db.signal.create({
      data: {
        asset: selectedAsset,
        timeframe: selectedTf,
        direction: "NO_OPERAR",
        entryPrice: BASE_PRICES[selectedAsset] || 1.0,
        entryTime,
        expirationMinutes: expMinutes,
        expirationTime: new Date(entryTime.getTime() + expMinutes * 60000),
        confidence: 0,
        aiReason: noOperarReason,
        technicalJson: null,
        patternsJson: null,
        volumeJson: null,
        newsJson: null,
        sentimentJson: null,
        macroJson: null,
        estimatedProfit: null,
        estimatedLoss: null,
        status: "CLOSED",
        result: "NO_OPERAR",
        analysisMode: "FALLBACK",
        dataAvailability: JSON.stringify(dataAvailability),
        statisticalReliability: determineStatisticalReliability(historicalSampleSize),
        historicalSampleSize,
      },
    });

    return NextResponse.json({
      signal,
      warning: "IA NO DISPONIBLE: Se registró NO_OPERAR automático. No se inventaron datos.",
      dataAvailability,
      statisticalReliability: determineStatisticalReliability(historicalSampleSize),
      historicalSampleSize,
      analysisMode: "FALLBACK",
    }, { status: 201 });

  } catch (error) {
    console.error("Error generating signal:", error);
    return NextResponse.json(
      { error: "Error al generar señal con IA" },
      { status: 500 }
    );
  }
}

// ─── Helper: Build NO_OPERAR reason when data is insufficient ────────────────

function buildNoOperarReason(
  availability: DataAvailability,
  sampleSize: number,
  stats: ReturnType<typeof calculateStats>
): string {
  const lines: string[] = [
    "NO_OPERAR AUTOMÁTICO: Datos insuficientes para generar una señal confiable.",
    "",
    "DATOS DISPONIBLES:",
  ];

  const items: [string, boolean][] = [
    ["Indicadores Técnicos", availability.technical],
    ["Volumen", availability.volume],
    ["Patrones", availability.patterns],
    ["Sentimiento", availability.sentiment],
    ["Noticias", availability.news],
    ["Macro", availability.macro],
    ["Historial", availability.historical],
    ["IA Principal", availability.aiModel],
  ];

  items.forEach(([label, available]) => {
    lines.push(`  ${available ? "✔" : "✘"} ${label}: ${available ? "Disponible" : "No disponible"}`);
  });

  lines.push("");
  lines.push(`HISTORIAL: ${sampleSize} señales cerradas (mínimo recomendado: 30)`);
  lines.push(`WIN RATE ACTUAL: ${stats.winRate.toFixed(1)}%`);
  lines.push(`PÉRDIDAS CONSECUTIVAS: ${stats.currentConsecutiveLosses}`);
  lines.push("");
  lines.push("RAZÓN: No se puede generar una señal confiable sin datos suficientes.");
  lines.push("Inventar una entrada sin evidencia es irresponsable y peligroso.");
  lines.push("El sistema necesita más datos históricos antes de operar.");
  lines.push("");
  lines.push(`MODO DE ANÁLISIS: FALLBACK`);
  lines.push(`CONFIABILIDAD ESTADÍSTICA: ${determineStatisticalReliability(sampleSize)}`);

  return lines.join("\n");
}
