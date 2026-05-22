import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const alerts = await db.alert.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(alerts);
  } catch (error) {
    console.error("Error fetching alerts:", error);
    return NextResponse.json(
      { error: "Error al obtener alertas" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, message, severity } = body;

    if (!type || !message) {
      return NextResponse.json(
        { error: "Faltan campos obligatorios: type, message" },
        { status: 400 }
      );
    }

    const alert = await db.alert.create({
      data: {
        type,
        message,
        severity: severity || "warning",
        isActive: true,
      },
    });

    return NextResponse.json(alert, { status: 201 });
  } catch (error) {
    console.error("Error creating alert:", error);
    return NextResponse.json(
      { error: "Error al crear alerta" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json(
        { error: "ID de alerta requerido" },
        { status: 400 }
      );
    }

    const alert = await db.alert.update({
      where: { id },
      data: {
        isActive: false,
        dismissedAt: new Date(),
      },
    });

    return NextResponse.json(alert);
  } catch (error) {
    console.error("Error dismissing alert:", error);
    return NextResponse.json(
      { error: "Error al descartar alerta" },
      { status: 500 }
    );
  }
}
