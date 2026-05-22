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
