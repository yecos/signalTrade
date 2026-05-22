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
    TWELVEDATA_API_KEY: process.env.TWELVEDATA_API_KEY ? "SET (hidden)" : "NOT SET",
    NODE_ENV: process.env.NODE_ENV || "undefined",
    VERCEL: process.env.VERCEL || "not on Vercel",
    VERCEL_REGION: process.env.VERCEL_REGION || "N/A",
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
      diagnostics.tursoTables = tables.rows.map((r) => (r as Record<string, unknown>).name);

      // Check Signal count
      try {
        const countResult = await libsql.execute("SELECT COUNT(*) as count FROM Signal");
        diagnostics.tursoSignalCount = (countResult.rows[0] as Record<string, unknown>).count;
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

  // 3. Test the db module (what the app actually uses - uses static imports)
  // NOTE: We do NOT test PrismaLibSQL via dynamic import because Vercel's
  // Turbopack minification breaks dynamic imports of this package.
  // The db module uses static imports which work correctly.
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

  // 4. Test Market Engine (getEngineStatus now auto-health-checks)
  try {
    const { getEngineStatus } = await import("@/lib/market-engine");
    diagnostics.marketEngine = await getEngineStatus();
  } catch (engineErr: unknown) {
    diagnostics.marketEngineError = engineErr instanceof Error ? engineErr.message : String(engineErr);
  }

  // 5. Test real price fetch
  try {
    const { getLatestPrice } = await import("@/lib/market-engine");
    const btcPrice = await getLatestPrice("BTC/USD");
    diagnostics.livePrice = { asset: "BTC/USD", ...btcPrice };
  } catch (priceErr: unknown) {
    diagnostics.livePriceError = priceErr instanceof Error ? priceErr.message : String(priceErr);
  }

  diagnostics.totalTime = `${Date.now() - startTime}ms`;
  diagnostics.timestamp = new Date().toISOString();

  return NextResponse.json(diagnostics, { status: 200 });
}
