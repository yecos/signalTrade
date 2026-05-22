import { NextResponse } from "next/server";

export async function GET() {
  const diagnostics: Record<string, unknown> = {};
  const startTime = Date.now();

  // 1. Check ALL environment variables
  diagnostics.env = {
    DATABASE_URL: process.env.DATABASE_URL ? "SET (hidden)" : "NOT SET",
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL
      ? `SET (${process.env.TURSO_DATABASE_URL.substring(0, 40)}...)`
      : "NOT SET",
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN
      ? `SET (${process.env.TURSO_AUTH_TOKEN.substring(0, 10)}...)`
      : "NOT SET",
    NODE_ENV: process.env.NODE_ENV || "undefined",
    VERCEL: process.env.VERCEL || "not set",
    VERCEL_REGION: process.env.VERCEL_REGION || "not set",
  };

  // 2. Test raw Turso connection via @libsql/client
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (tursoUrl && tursoToken) {
    try {
      const { createClient } = await import("@libsql/client");
      const libsql = createClient({ url: tursoUrl, authToken: tursoToken });

      const testStart = Date.now();
      const testResult = await libsql.execute("SELECT 1 as test");
      const rawLatency = Date.now() - testStart;

      diagnostics.tursoRawConnection = {
        ok: true,
        result: testResult.rows[0],
        latency: `${rawLatency}ms`,
      };

      // Check tables
      const tables = await libsql.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      );
      diagnostics.tursoTables = tables.rows.map((r) => r.name);

      // Check Signal count
      try {
        const countResult = await libsql.execute(
          "SELECT COUNT(*) as count FROM Signal"
        );
        diagnostics.tursoSignalCount = countResult.rows[0].count;
      } catch {
        diagnostics.tursoSignalCount = "ERROR (table may not exist)";
      }

      await libsql.close();
    } catch (rawErr: unknown) {
      diagnostics.tursoRawConnection = {
        ok: false,
        error: rawErr instanceof Error ? rawErr.message : String(rawErr),
      };
    }
  } else {
    diagnostics.tursoRawConnection = "SKIPPED (no Turso credentials)";
  }

  // 3. Test Prisma Client with PrismaLibSQL adapter
  if (tursoUrl && tursoToken) {
    try {
      const { PrismaClient } = await import("@prisma/client");
      const { PrismaLibSQL } = await import("@prisma/adapter-libsql");

      const adapter = new PrismaLibSQL({
        url: tursoUrl,
        authToken: tursoToken,
      });
      const prisma = new PrismaClient({ adapter });

      const prismaStart = Date.now();
      const signalCount = await prisma.signal.count();
      const prismaLatency = Date.now() - prismaStart;

      diagnostics.prismaWithAdapter = {
        ok: true,
        signalCount,
        latency: `${prismaLatency}ms`,
      };

      await prisma.$disconnect();
    } catch (adapterErr: unknown) {
      diagnostics.prismaWithAdapter = {
        ok: false,
        error: adapterErr instanceof Error ? adapterErr.message : String(adapterErr),
        stack: adapterErr instanceof Error ? adapterErr.stack : undefined,
      };
    }
  } else {
    diagnostics.prismaWithAdapter = "SKIPPED (no Turso credentials)";
  }

  // 4. Test the db module (what the app actually uses)
  try {
    const { db, getDbMode, testConnection } = await import("@/lib/db");
    diagnostics.dbMode = getDbMode();
    diagnostics.dbTest = await testConnection();
  } catch (dbErr: unknown) {
    diagnostics.dbModuleError = {
      error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      stack: dbErr instanceof Error ? dbErr.stack : undefined,
    };
  }

  // 5. Test Market Engine
  try {
    const { getEngineStatus, checkApiHealth } = await import("@/lib/market-engine");
    diagnostics.marketEngine = getEngineStatus();

    // Quick health check (with timeout)
    const healthPromise = checkApiHealth();
    const timeoutPromise = new Promise<{ timeout: true }>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 5000)
    );
    const healthResult = await Promise.race([healthPromise, timeoutPromise]);
    diagnostics.marketHealth = healthResult;
  } catch (engineErr: unknown) {
    diagnostics.marketEngineError = engineErr instanceof Error ? engineErr.message : String(engineErr);
  }

  diagnostics.totalTime = `${Date.now() - startTime}ms`;
  diagnostics.timestamp = new Date().toISOString();

  return NextResponse.json(diagnostics, { status: 200 });
}
