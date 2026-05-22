import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateStats } from "@/lib/signals";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { asset, timeframe } = body;

    // Get historical stats for AI context
    const signals = await db.signal.findMany({
      orderBy: { entryTime: "desc" },
    });

    const stats = calculateStats(signals as Parameters<typeof calculateStats>[0]);

    // Build context for AI
    const assetWinRate = asset && stats.winRateByAsset[asset]
      ? `${stats.winRateByAsset[asset].rate.toFixed(1)}%`
      : "Sin datos";
    const tfWinRate = timeframe && stats.winRateByTimeframe[timeframe]
      ? `${stats.winRateByTimeframe[timeframe].rate.toFixed(1)}%`
      : "Sin datos";

    const recentResults = signals
      .filter((s) => s.status === "CLOSED" && s.result)
      .slice(0, 10)
      .map((s) => s.result === "WIN" ? "W" : s.result === "LOSS" ? "L" : "D")
      .join("/");

    const context = {
      historical_performance: {
        total_signals: stats.totalSignals,
        general_winrate: `${stats.winRate.toFixed(1)}%`,
        asset_winrate: assetWinRate,
        timeframe_winrate: tfWinRate,
        last_10_signals: recentResults || "Sin datos",
        best_asset: stats.bestAsset || "Sin datos",
        worst_asset: stats.worstAsset || "Sin datos",
        best_timeframe: stats.bestTimeframe || "Sin datos",
        confidence_threshold_recommended: stats.recommendedConfidenceThreshold,
        current_consecutive_losses: stats.currentConsecutiveLosses,
        profit_factor: stats.profitFactor,
      },
      requested_asset: asset || "No especificado",
      requested_timeframe: timeframe || "No especificado",
    };

    // Use z-ai-web-dev-sdk for AI signal generation
    let aiResponse: { signal: Record<string, unknown> };
    try {
      const { chat } = await import("z-ai-web-dev-sdk");
      const completion = await chat.completions.create({
        model: "deepseek-v3-0324",
        messages: [
          {
            role: "system",
            content: `Eres un analista de trading experto en opciones binarias. Analiza los datos históricos y genera una señal de trading.

CONTEXTO HISTÓRICO:
${JSON.stringify(context, null, 2)}

INSTRUCCIONES:
1. Analiza el rendimiento histórico del activo y temporalidad solicitados
2. Genera una señal con dirección HIGHER, LOWER o NO_OPERAR
3. La confianza debe ser entre 0-100 basada en la consistencia histórica
4. Si el rendimiento histórico es malo o hay pérdidas consecutivas, considera NO_OPERAR
5. Explica tu razonamiento en detalle

RESPONDE ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "signal": {
    "asset": "EUR/USD",
    "timeframe": "M5",
    "direction": "HIGHER",
    "confidence": 75,
    "expirationMinutes": 5,
    "aiReason": "Razonamiento detallado del análisis",
    "entryPrice": 1.0850,
    "technicalJson": "{\"trend\":\"bullish\",\"rsi\":55,\"macd\":\"positive\"}",
    "patternsJson": "{\"pattern\":\"engulfing\",\"reliability\":\"high\"}",
    "volumeJson": "{\"volume\":\"above_average\",\"trend\":\"increasing\"}",
    "newsJson": "{\"impact\":\"low\",\"sentiment\":\"neutral\"}",
    "sentimentJson": "{\"overall\":\"bullish\",\"score\":0.65}",
    "macroJson": "{\"event\":\"none\",\"impact\":\"low\"}",
    "estimatedProfit": 85,
    "estimatedLoss": 100
  }
}

Los activos disponibles son: EUR/USD, GBP/USD, USD/JPY, AUD/USD, EUR/GBP, BTC/USD, ETH/USD
Las temporalidades disponibles son: M1, M5, M15, M30, H1
Los expirationMinutes deben coincidir con la temporalidad: M1=1, M5=5, M15=15, M30=30, H1=60`,
          },
          {
            role: "user",
            content: `Genera una señal de trading para ${asset || "cualquier activo"} en temporalidad ${timeframe || "cualquiera"}. Considera el contexto histórico proporcionado.`,
          },
        ],
        temperature: 0.7,
      });

      const content = completion.choices[0]?.message?.content || "";
      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No se pudo extraer JSON de la respuesta IA");
      }
      aiResponse = JSON.parse(jsonMatch[0]);
    } catch (aiError) {
      console.error("AI generation error, using fallback:", aiError);
      // Fallback: generate a reasonable signal
      const assets = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "EUR/GBP"];
      const timeframes = ["M1", "M5", "M15", "M30", "H1"];
      const directions: Array<"HIGHER" | "LOWER" | "NO_OPERAR"> = ["HIGHER", "LOWER", "NO_OPERAR"];
      const selectedAsset = asset || assets[Math.floor(Math.random() * assets.length)];
      const selectedTf = timeframe || timeframes[Math.floor(Math.random() * timeframes.length)];
      const basePrices: Record<string, number> = {
        "EUR/USD": 1.085,
        "GBP/USD": 1.265,
        "USD/JPY": 149.5,
        "AUD/USD": 0.655,
        "EUR/GBP": 0.857,
        "BTC/USD": 67500,
        "ETH/USD": 3450,
      };
      const entryPrice = basePrices[selectedAsset] || 1.0;
      const expMinutes: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
      const confidence = 50 + Math.floor(Math.random() * 35);
      const dirIdx = confidence < 60 ? 2 : Math.floor(Math.random() * 2);

      aiResponse = {
        signal: {
          asset: selectedAsset,
          timeframe: selectedTf,
          direction: directions[dirIdx],
          confidence,
          expirationMinutes: expMinutes[selectedTf] || 5,
          aiReason: `Señal generada en modo fallback. Análisis basado en datos históricos limitados. Tasa de victoria general: ${stats.winRate.toFixed(1)}%. ${stats.currentConsecutiveLosses >= 3 ? "ADVERTENCIA: Pérdidas consecutivas detectadas." : ""}`,
          entryPrice,
          technicalJson: JSON.stringify({ trend: directions[dirIdx] === "HIGHER" ? "bullish" : "bearish", rsi: 40 + Math.floor(Math.random() * 30), macd: "neutral" }),
          patternsJson: JSON.stringify({ pattern: "fallback", reliability: "medium" }),
          volumeJson: JSON.stringify({ volume: "average", trend: "stable" }),
          newsJson: JSON.stringify({ impact: "low", sentiment: "neutral" }),
          sentimentJson: JSON.stringify({ overall: "neutral", score: 0.5 }),
          macroJson: JSON.stringify({ event: "none", impact: "low" }),
          estimatedProfit: 85,
          estimatedLoss: 100,
        },
      };
    }

    // Save the generated signal to the database
    const signalData = aiResponse.signal;
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
        status: "PENDING",
      },
    });

    return NextResponse.json({ signal, aiContext: context }, { status: 201 });
  } catch (error) {
    console.error("Error generating signal:", error);
    return NextResponse.json(
      { error: "Error al generar señal con IA" },
      { status: 500 }
    );
  }
}
