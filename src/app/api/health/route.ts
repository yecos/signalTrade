import { NextResponse } from "next/server";

export async function GET() {
  const startTime = Date.now();

  try {
    const { testConnection, getDbMode } = await import("@/lib/db");
    const dbTest = await testConnection();

    const status = dbTest.ok ? "healthy" : "unhealthy";
    const httpStatus = dbTest.ok ? 200 : 503;

    return NextResponse.json(
      {
        status,
        database: {
          mode: getDbMode(),
          connected: dbTest.ok,
          latency: dbTest.latency ? `${dbTest.latency}ms` : undefined,
          signalCount: dbTest.signalCount,
          error: dbTest.error,
        },
        timestamp: new Date().toISOString(),
        responseTime: `${Date.now() - startTime}ms`,
      },
      { status: httpStatus }
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
        responseTime: `${Date.now() - startTime}ms`,
      },
      { status: 500 }
    );
  }
}
