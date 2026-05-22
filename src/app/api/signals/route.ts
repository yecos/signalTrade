import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const direction = searchParams.get("direction");
    const asset = searchParams.get("asset");
    const timeframe = searchParams.get("timeframe");
    const dateFrom = searchParams.get("dateFrom");
    const dateTo = searchParams.get("dateTo");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const sortBy = searchParams.get("sortBy") || "createdAt";
    const sortOrder = searchParams.get("sortOrder") || "desc";

    const where: Record<string, unknown> = {};

    if (status) where.status = status;
    if (direction) where.direction = direction;
    if (asset) where.asset = asset;
    if (timeframe) where.timeframe = timeframe;
    if (dateFrom || dateTo) {
      where.entryTime = {};
      if (dateFrom) (where.entryTime as Record<string, unknown>).gte = new Date(dateFrom);
      if (dateTo) (where.entryTime as Record<string, unknown>).lte = new Date(dateTo);
    }

    const [signals, total] = await Promise.all([
      db.signal.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.signal.count({ where }),
    ]);

    return NextResponse.json({
      signals,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching signals:", error);
    return NextResponse.json(
      { error: "Error al obtener señales" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      asset,
      timeframe,
      direction,
      entryPrice,
      entryTime,
      expirationMinutes,
      confidence,
      aiReason,
      technicalJson,
      patternsJson,
      volumeJson,
      newsJson,
      sentimentJson,
      macroJson,
      fullAnalysisJson,
      estimatedProfit,
      estimatedLoss,
    } = body;

    if (!asset || !timeframe || !direction || !entryPrice || !entryTime || !expirationMinutes) {
      return NextResponse.json(
        { error: "Faltan campos obligatorios: asset, timeframe, direction, entryPrice, entryTime, expirationMinutes" },
        { status: 400 }
      );
    }

    const entryTimeDate = new Date(entryTime);
    const expirationTime = new Date(
      entryTimeDate.getTime() + expirationMinutes * 60000
    );

    // Determine analysis mode and data availability for manual signals
    const dataAvail: Record<string, boolean> = {
      technical: !!technicalJson,
      volume: !!volumeJson,
      patterns: !!patternsJson,
      sentiment: !!sentimentJson,
      news: !!newsJson,
      macro: !!macroJson,
      historical: false, // manual signals don't check historical automatically
      aiModel: false, // manual entry
    };
    const availCount = Object.values(dataAvail).filter(Boolean).length;
    const analysisMode = availCount >= 6 ? "FULL" : availCount >= 3 ? "PARTIAL" : "FALLBACK";

    const signal = await db.signal.create({
      data: {
        asset,
        timeframe,
        direction,
        entryPrice: parseFloat(entryPrice),
        entryTime: entryTimeDate,
        expirationMinutes: parseInt(expirationMinutes),
        expirationTime,
        confidence: confidence ? parseFloat(confidence) : 50,
        aiReason: aiReason || null,
        technicalJson: technicalJson || null,
        patternsJson: patternsJson || null,
        volumeJson: volumeJson || null,
        newsJson: newsJson || null,
        sentimentJson: sentimentJson || null,
        macroJson: macroJson || null,
        fullAnalysisJson: fullAnalysisJson || null,
        estimatedProfit: estimatedProfit ? parseFloat(estimatedProfit) : null,
        estimatedLoss: estimatedLoss ? parseFloat(estimatedLoss) : null,
        status: direction === "NO_OPERAR" ? "CLOSED" : "PENDING",
        result: direction === "NO_OPERAR" ? "NO_OPERAR" : null,
        analysisMode,
        dataAvailability: JSON.stringify(dataAvail),
        statisticalReliability: "MANUAL",
        historicalSampleSize: 0,
      },
    });

    return NextResponse.json(signal, { status: 201 });
  } catch (error) {
    console.error("Error creating signal:", error);
    return NextResponse.json(
      { error: "Error al crear señal" },
      { status: 500 }
    );
  }
}
