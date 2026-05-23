import { NextResponse } from "next/server";

export async function GET() {
  const startTime = Date.now();

  try {
    const { testConnection, getDbMode, runAutoMigration } = await import("@/lib/db");
    
    // Run auto-migration first to ensure all columns exist
    let migrationResult = null;
    try {
      migrationResult = await runAutoMigration();
    } catch (migrateErr) {
      console.error('[HEALTH] Migration error:', migrateErr);
    }
    
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
        migration: migrationResult ? {
          applied: migrationResult.applied,
          skipped: migrationResult.skipped,
          errors: migrationResult.errors,
        } : undefined,
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
