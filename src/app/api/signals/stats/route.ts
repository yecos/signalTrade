import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateStats } from "@/lib/signals";

export async function GET() {
  try {
    const signals = await db.signal.findMany({
      orderBy: { entryTime: "desc" },
    });

    const stats = calculateStats(signals as Parameters<typeof calculateStats>[0]);

    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching stats:", error);
    return NextResponse.json(
      { error: "Error al obtener estadísticas" },
      { status: 500 }
    );
  }
}
