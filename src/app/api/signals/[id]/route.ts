import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const signal = await db.signal.findUnique({ where: { id } });
    if (!signal) {
      return NextResponse.json(
        { error: "Señal no encontrada" },
        { status: 404 }
      );
    }
    return NextResponse.json(signal);
  } catch (error) {
    console.error("Error fetching signal:", error);
    return NextResponse.json(
      { error: "Error al obtener señal" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const existingSignal = await db.signal.findUnique({ where: { id } });
    if (!existingSignal) {
      return NextResponse.json(
        { error: "Señal no encontrada" },
        { status: 404 }
      );
    }

    const updateData: Record<string, unknown> = {};

    if (body.exitPrice !== undefined) updateData.exitPrice = parseFloat(body.exitPrice);
    if (body.result !== undefined) updateData.result = body.result;
    if (body.priceDifference !== undefined) updateData.priceDifference = parseFloat(body.priceDifference);
    if (body.estimatedProfit !== undefined) updateData.estimatedProfit = parseFloat(body.estimatedProfit);
    if (body.estimatedLoss !== undefined) updateData.estimatedLoss = parseFloat(body.estimatedLoss);
    if (body.status !== undefined) updateData.status = body.status;
    if (body.aiReason !== undefined) updateData.aiReason = body.aiReason;
    if (body.confidence !== undefined) updateData.confidence = parseFloat(body.confidence);

    const signal = await db.signal.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json(signal);
  } catch (error) {
    console.error("Error updating signal:", error);
    return NextResponse.json(
      { error: "Error al actualizar señal" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const existingSignal = await db.signal.findUnique({ where: { id } });
    if (!existingSignal) {
      return NextResponse.json(
        { error: "Señal no encontrada" },
        { status: 404 }
      );
    }

    const signal = await db.signal.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return NextResponse.json(signal);
  } catch (error) {
    console.error("Error cancelling signal:", error);
    return NextResponse.json(
      { error: "Error al cancelar señal" },
      { status: 500 }
    );
  }
}
