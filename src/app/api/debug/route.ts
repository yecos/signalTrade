import { NextResponse } from "next/server";

export async function GET() {
  const diagnostics: Record<string, unknown> = {};

  // 1. Check environment variables
  diagnostics.env = {
    DATABASE_URL: process.env.DATABASE_URL ? "SET (hidden)" : "NOT SET",
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL ? "SET (hidden)" : "NOT SET",
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN ? "SET (hidden)" : "NOT SET",
    NODE_ENV: process.env.NODE_ENV,
  };

  // 2. Test Prisma client creation
  try {
    const { PrismaClient } = await import("@prisma/client");
    diagnostics.prismaImport = "OK";
    
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;
    
    if (tursoUrl && tursoToken) {
      try {
        const { PrismaLibSql } = await import("@prisma/adapter-libsql");
        const { createClient } = await import("@libsql/client");
        
        const libsql = createClient({
          url: tursoUrl,
          authToken: tursoToken,
        });
        
        // Test raw connection
        const testResult = await libsql.execute("SELECT 1 as test");
        diagnostics.tursoRawConnection = { ok: true, result: testResult.rows[0] };
        
        // Test Prisma with adapter
        const adapter = new PrismaLibSql(libsql);
        const prisma = new PrismaClient({ adapter });
        
        const signalCount = await prisma.signal.count();
        diagnostics.prismaWithAdapter = { ok: true, signalCount };
        
        await prisma.$disconnect();
      } catch (adapterErr: unknown) {
        diagnostics.tursoAdapterError = adapterErr instanceof Error ? adapterErr.message : String(adapterErr);
        diagnostics.tursoAdapterStack = adapterErr instanceof Error ? adapterErr.stack : undefined;
      }
    } else {
      try {
        const prisma = new PrismaClient();
        const signalCount = await prisma.signal.count();
        diagnostics.prismaWithoutAdapter = { ok: true, signalCount };
        await prisma.$disconnect();
      } catch (prismaErr: unknown) {
        diagnostics.prismaError = prismaErr instanceof Error ? prismaErr.message : String(prismaErr);
      }
    }
  } catch (importErr: unknown) {
    diagnostics.prismaImportError = importErr instanceof Error ? importErr.message : String(importErr);
  }

  // 3. Test the db module
  try {
    const { db, getDbMode } = await import("@/lib/db");
    diagnostics.dbMode = getDbMode();
    
    const signalCount = await db.signal.count();
    diagnostics.dbModule = { ok: true, signalCount };
  } catch (dbErr: unknown) {
    diagnostics.dbModuleError = dbErr instanceof Error ? dbErr.message : String(dbErr);
    diagnostics.dbModuleStack = dbErr instanceof Error ? dbErr.stack : undefined;
  }

  return NextResponse.json(diagnostics, { status: 200 });
}
