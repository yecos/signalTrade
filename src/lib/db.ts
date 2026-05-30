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
        // Only log errors (queries/info are too noisy)
        log: [
          {
            emit: 'stdout',
            level: 'error',
          },
        ],
      })

      console.log('[DB] ✅ PrismaClient with Turso adapter created successfully')

      // ═══ SUPPRESS Prisma's transient error logging ═══
      // Prisma logs "prisma:error fetch failed" BEFORE our withRetry() catches them.
      // We intercept the specific format to reduce noise. withRetry() handles the actual retries.
      const origStdoutWrite = process.stdout.write.bind(process.stdout)
      let suppressTransient = true
      process.stdout.write = function(this: any, ...args: any[]) {
        const data = typeof args[0] === 'string' ? args[0] : ''
        if (suppressTransient && data && (
          data.includes('prisma:error fetch failed') ||
          data.includes('prisma:error ECONNRESET') ||
          data.includes('prisma:error ETIMEDOUT')
        )) {
          // Suppress — withRetry() handles these
          return true
        }
        return origStdoutWrite.apply(this, args)
      }

      return client
    } catch (err) {
      console.error('[DB] ❌ Failed to create PrismaClient with Turso adapter:', err)
      throw new Error(`Turso adapter initialization failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Fallback: local SQLite for development
  console.log('[DB] Using local SQLite fallback (no Turso credentials found)')
  return new PrismaClient({
    log: ['error'],
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

// ─── RETRY UTILITY ──────────────────────────────────────────────────────────
// Turso HTTP connections are flaky — this wraps any async DB operation with
// exponential-backoff retries so transient "fetch failed" errors don't crash cycles.

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  label: string = 'DB'
): Promise<T> {
  let lastError: any
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Acquire DB concurrency slot before executing
      await acquireDbSlot()
      return await fn()
    } catch (err: any) {
      lastError = err
      const msg = err?.message || String(err)

      // Don't retry on schema/argument errors — only retry on transient failures
      const isTransient =
        msg.includes('fetch failed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('socket hang up') ||
        msg.includes('network') ||
        msg.includes('Connection refused') ||
        msg.includes('503') ||
        msg.includes('502') ||
        msg.includes('500') ||
        msg.includes('rate limit') ||
        msg.includes('too many connections') ||
        msg.includes('timeout') ||
        msg.includes('abort')

      if (!isTransient || attempt === maxRetries) {
        break
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500
      console.log(`[DB-RETRY] ${label} attempt ${attempt}/${maxRetries} failed: ${msg.substring(0, 80)}. Retrying in ${Math.round(delay)}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    } finally {
      releaseDbSlot()
    }
  }
  throw lastError
}

// ─── DB CONCURRENCY LIMITER ──────────────────────────────────────────────────
// Turso HTTP connections are limited — too many concurrent requests cause
// "fetch failed" errors. This semaphore limits concurrent DB operations.

const MAX_DB_CONCURRENCY = 4
let activeDbOps = 0
let dbWaitQueue: Array<{ resolve: () => void }> = []

function acquireDbSlot(): Promise<void> {
  if (activeDbOps < MAX_DB_CONCURRENCY) {
    activeDbOps++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    dbWaitQueue.push({ resolve })
  })
}

function releaseDbSlot(): void {
  activeDbOps--
  const next = dbWaitQueue.shift()
  if (next) {
    activeDbOps++
    next.resolve()
  }
}

// ─── DB KEEPALIVE ────────────────────────────────────────────────────────────
// Periodically pings Turso to keep the HTTP connection warm.
// Without this, idle connections go stale and the next query fails.

let keepaliveTimer: ReturnType<typeof setInterval> | null = null

export function startDbKeepalive(intervalMs: number = 120_000): void {
  if (keepaliveTimer) return // Already running
  keepaliveTimer = setInterval(async () => {
    try {
      await withRetry(() => db.signal.count(), 1, 500, 'keepalive')
    } catch {
      // Ignore — keepalive is best-effort
    }
  }, intervalMs)
  console.log(`[DB-KEEPALIVE] Started (every ${intervalMs / 1000}s)`)
}

export function stopDbKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
    console.log('[DB-KEEPALIVE] Stopped')
  }
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
    const signalCount = await withRetry(() => db.signal.count(), 2, 500, 'testConnection')
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
    const result = await withRetry(
      () => db.$queryRaw<Array<{ name: string }>>`PRAGMA table_info(Signal)`,
      2, 500, 'PRAGMA'
    )
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
      await withRetry(
        () => db.$executeRawUnsafe(migration.sql),
        2, 500, `migrate-${migration.column}`
      )
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

  // ═══ Phase 8: Execution Engine Tables ═══
  await runTableMigrations()

  return { applied, skipped, errors }
}

// ─── TABLE-LEVEL MIGRATIONS (Phase 8: Execution Engine) ──────────────────────
// Creates Trade, Position, Account tables if they don't exist.
// These are whole tables (not just columns), so we use CREATE TABLE IF NOT EXISTS.

const TABLE_CREATION_SQL = [
  // Trade table
  `CREATE TABLE IF NOT EXISTS Trade (
    id TEXT PRIMARY KEY,
    signalId TEXT,
    asset TEXT NOT NULL,
    direction TEXT NOT NULL,
    orderType TEXT NOT NULL DEFAULT 'MARKET',
    orderSide TEXT NOT NULL,
    quantity REAL NOT NULL,
    leverage REAL NOT NULL DEFAULT 1,
    signalPrice REAL NOT NULL,
    entryPrice REAL,
    exitPrice REAL,
    stopLoss REAL,
    takeProfit REAL,
    brokerOrderId TEXT,
    brokerExecId TEXT,
    slippage REAL,
    commission REAL NOT NULL DEFAULT 0,
    fillTime DATETIME,
    realizedPnl REAL,
    realizedPnlPct REAL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    rejectReason TEXT,
    riskPercent REAL,
    positionValueUsd REAL,
    executionMode TEXT NOT NULL DEFAULT 'PAPER',
    journalNotes TEXT,
    metadataJson TEXT,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closedAt DATETIME
  )`,
  // Position table
  `CREATE TABLE IF NOT EXISTS Position (
    id TEXT PRIMARY KEY,
    tradeId TEXT,
    asset TEXT NOT NULL,
    direction TEXT NOT NULL,
    quantity REAL NOT NULL,
    leverage REAL NOT NULL DEFAULT 1,
    entryPrice REAL NOT NULL,
    stopLoss REAL,
    takeProfit REAL,
    currentPrice REAL,
    unrealizedPnl REAL,
    unrealizedPnlPct REAL,
    brokerPositionId TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    maxFavorable REAL,
    maxAdverse REAL,
    executionMode TEXT NOT NULL DEFAULT 'PAPER',
    metadataJson TEXT,
    openedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closedAt DATETIME
  )`,
  // Account table
  `CREATE TABLE IF NOT EXISTS Account (
    id TEXT PRIMARY KEY,
    broker TEXT NOT NULL DEFAULT 'BYBIT',
    accountId TEXT,
    balance REAL NOT NULL DEFAULT 0,
    equity REAL NOT NULL DEFAULT 0,
    unrealizedPnl REAL NOT NULL DEFAULT 0,
    dailyPnl REAL NOT NULL DEFAULT 0,
    dailyTrades INTEGER NOT NULL DEFAULT 0,
    maxDrawdown REAL NOT NULL DEFAULT 0,
    peakEquity REAL NOT NULL DEFAULT 0,
    isLive BOOLEAN NOT NULL DEFAULT 0,
    riskPerTrade REAL NOT NULL DEFAULT 1,
    maxDailyLoss REAL NOT NULL DEFAULT 3,
    maxOpenPositions INTEGER NOT NULL DEFAULT 3,
    maxDrawdownPct REAL NOT NULL DEFAULT 10,
    apiKey TEXT,
    apiSecret TEXT,
    isActive BOOLEAN NOT NULL DEFAULT 1,
    isCircuitBreaker BOOLEAN NOT NULL DEFAULT 0,
    circuitBreakerReason TEXT,
    lastSyncAt DATETIME,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
]

async function runTableMigrations(): Promise<void> {
  for (const sql of TABLE_CREATION_SQL) {
    try {
      await withRetry(
        () => db.$executeRawUnsafe(sql),
        2, 500, 'table-migration'
      )
      const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || 'unknown'
      console.log(`[DB-MIGRATE] ✅ Table ensured: ${tableName}`)
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes('already exists')) {
        // Table already exists — fine
        const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || 'unknown'
        console.log(`[DB-MIGRATE] ⏭️ Table already exists: ${tableName}`)
      } else {
        console.error(`[DB-MIGRATE] ❌ Error creating table: ${msg}`)
      }
    }
  }
}
