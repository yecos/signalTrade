import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'

// ─── Singleton Pattern for Serverless (Vercel) ──────────────────────────────
// In serverless, each cold start creates a new module instance.
// We use globalThis to cache the PrismaClient across hot-reloads in dev,
// but in serverless each invocation gets a fresh instance.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const tursoUrl = process.env.TURSO_DATABASE_URL
  const tursoToken = process.env.TURSO_AUTH_TOKEN

  console.log(`[DB] Initializing PrismaClient...`)
  console.log(`[DB] TURSO_DATABASE_URL: ${tursoUrl ? 'SET (' + tursoUrl.substring(0, 30) + '...)' : 'NOT SET'}`)
  console.log(`[DB] TURSO_AUTH_TOKEN: ${tursoToken ? 'SET (' + tursoToken.substring(0, 10) + '...)' : 'NOT SET'}`)

  // If Turso credentials are provided, use remote Turso DB via Prisma adapter
  if (tursoUrl && tursoToken) {
    try {
      console.log('[DB] Creating PrismaLibSQL adapter for Turso...')

      // PrismaLibSQL in v6.x takes a config object { url, authToken }
      // It creates the @libsql/client internally
      const adapter = new PrismaLibSQL({
        url: tursoUrl,
        authToken: tursoToken,
      })

      const client = new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
      })

      console.log('[DB] ✅ PrismaClient with Turso adapter created successfully')
      return client
    } catch (err) {
      console.error('[DB] ❌ Failed to create PrismaClient with Turso adapter:', err)
      throw new Error(`Turso adapter initialization failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Fallback: local SQLite for development
  console.log('[DB] Using local SQLite fallback (no Turso credentials found)')
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })
}

// Use cached client in development to prevent hot-reload issues
export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}

// Helper to check which DB mode is active
export function getDbMode(): 'turso' | 'local' {
  return process.env.TURSO_DATABASE_URL ? 'turso' : 'local'
}

// Test database connectivity
export async function testConnection(): Promise<{
  ok: boolean
  mode: 'turso' | 'local'
  signalCount: number
  error?: string
  latency?: number
}> {
  const start = Date.now()
  try {
    const mode = getDbMode()
    const signalCount = await db.signal.count()
    const latency = Date.now() - start
    return { ok: true, mode, signalCount, latency }
  } catch (err) {
    return {
      ok: false,
      mode: getDbMode(),
      signalCount: -1,
      error: err instanceof Error ? err.message : String(err),
      latency: Date.now() - start,
    }
  }
}

// ─── AUTO-MIGRATION ──────────────────────────────────────────────────────────
// Adds missing columns to Signal table for MTF (Phase 5) and other new fields.
// Safe to run multiple times — ignores "duplicate column" errors.

const MTF_MIGRATIONS: Array<{ column: string; sql: string }> = [
  { column: 'mtfConfluence', sql: 'ALTER TABLE Signal ADD COLUMN mtfConfluence REAL' },
  { column: 'mtfDirection',  sql: 'ALTER TABLE Signal ADD COLUMN mtfDirection TEXT' },
  { column: 'h1Filter',      sql: 'ALTER TABLE Signal ADD COLUMN h1Filter TEXT' },
  { column: 'h4Filter',      sql: 'ALTER TABLE Signal ADD COLUMN h4Filter TEXT' },
  { column: 'entryQuality',  sql: 'ALTER TABLE Signal ADD COLUMN entryQuality TEXT' },
  { column: 'mtfJson',       sql: 'ALTER TABLE Signal ADD COLUMN mtfJson TEXT' },
  // Phase 7: Proven Edge fields
  { column: 'provenEdgeTier',     sql: 'ALTER TABLE Signal ADD COLUMN provenEdgeTier TEXT' },
  { column: 'provenEdgeAllowed',  sql: 'ALTER TABLE Signal ADD COLUMN provenEdgeAllowed BOOLEAN' },
  { column: 'edgeClassification', sql: 'ALTER TABLE Signal ADD COLUMN edgeClassification TEXT' },
]

export async function runAutoMigration(): Promise<{ applied: string[]; skipped: string[]; errors: string[] }> {
  const applied: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  // First, check which columns already exist
  let existingColumns: Set<string> = new Set()
  try {
    const result = await db.$queryRaw<Array<{ name: string }>>`PRAGMA table_info(Signal)`
    existingColumns = new Set(result.map(r => r.name))
  } catch (err) {
    // If PRAGMA fails (e.g., Turso HTTP doesn't support PRAGMA), try a different approach
    // We'll try each ALTER TABLE and catch "duplicate column" errors
    console.log('[DB-MIGRATE] PRAGMA not available, will try each migration individually')
  }

  for (const migration of MTF_MIGRATIONS) {
    if (existingColumns.has(migration.column)) {
      skipped.push(migration.column)
      continue
    }

    try {
      await db.$executeRawUnsafe(migration.sql)
      applied.push(migration.column)
      console.log(`[DB-MIGRATE] ✅ Added column: ${migration.column}`)
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes('duplicate column') || msg.includes('already exists')) {
        skipped.push(migration.column)
      } else {
        errors.push(`${migration.column}: ${msg}`)
        console.error(`[DB-MIGRATE] ❌ Error adding ${migration.column}: ${msg}`)
      }
    }
  }

  if (applied.length > 0) {
    console.log(`[DB-MIGRATE] ✅ ${applied.length} columns added: ${applied.join(', ')}`)
  }
  if (skipped.length > 0) {
    console.log(`[DB-MIGRATE] ⏭️ ${skipped.length} columns already exist: ${skipped.join(', ')}`)
  }
  if (errors.length > 0) {
    console.error(`[DB-MIGRATE] ❌ ${errors.length} errors: ${errors.join('; ')}`)
  }

  return { applied, skipped, errors }
}
