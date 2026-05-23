import { createClient } from '@libsql/client'

const TURSO_URL = process.env.TURSO_DATABASE_URL!
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN!

async function main() {
  const db = createClient({
    url: TURSO_URL,
    authToken: TURSO_TOKEN,
  })

  console.log('🔌 Connecting to Turso:', TURSO_URL)

  // Test connection
  const testResult = await db.execute('SELECT 1 as connected')
  console.log('✅ Connected:', testResult.rows[0])

  // Create Signal table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS Signal (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
      asset TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      direction TEXT NOT NULL,
      entryPrice REAL NOT NULL,
      entryTime DATETIME NOT NULL,
      expirationMinutes INTEGER NOT NULL,
      expirationTime DATETIME NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      aiReason TEXT,
      technicalJson TEXT,
      patternsJson TEXT,
      volumeJson TEXT,
      newsJson TEXT,
      sentimentJson TEXT,
      macroJson TEXT,
      fullAnalysisJson TEXT,
      exitPrice REAL,
      result TEXT,
      priceDifference REAL,
      estimatedProfit REAL,
      estimatedLoss REAL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      analysisMode TEXT NOT NULL DEFAULT 'FALLBACK',
      dataAvailability TEXT,
      statisticalReliability TEXT,
      historicalSampleSize INTEGER,
      screenshotUrl TEXT,
      patternType TEXT,
      sessionType TEXT,
      setupScore REAL,
      indicatorsJson TEXT,
      source TEXT NOT NULL DEFAULT 'MANUAL',
      noOperarReason TEXT,
      verificationMethod TEXT,
      marketRegime TEXT,
      featuresJson TEXT,
      expectancy REAL,
      riskReward REAL,
      adjustedWinRate REAL,
      confidenceInterval TEXT,
      pValue REAL,
      sampleVariance REAL,
      qualityScore REAL,
      qualityFlags TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('✅ Signal table created')

  // Create MarketCandle table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS MarketCandle (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
      asset TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('✅ MarketCandle table created')

  // Create unique index for MarketCandle
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS MarketCandle_asset_timeframe_timestamp_key ON MarketCandle(asset, timeframe, timestamp)
  `)
  await db.execute(`
    CREATE INDEX IF NOT EXISTS MarketCandle_asset_timeframe_timestamp_idx ON MarketCandle(asset, timeframe, timestamp)
  `)
  console.log('✅ MarketCandle indexes created')

  // Create SetupStats table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS SetupStats (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
      patternType TEXT NOT NULL,
      asset TEXT,
      session TEXT,
      timeframe TEXT,
      totalSignals INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      noOperarCount INTEGER NOT NULL DEFAULT 0,
      winRate REAL NOT NULL DEFAULT 0,
      avgConfidence REAL NOT NULL DEFAULT 0,
      avgSetupScore REAL NOT NULL DEFAULT 0,
      bayesianWinRate REAL NOT NULL DEFAULT 0,
      confidenceIntervalLower REAL NOT NULL DEFAULT 0,
      confidenceIntervalUpper REAL NOT NULL DEFAULT 0,
      pValue REAL NOT NULL DEFAULT 1,
      sampleVariance REAL NOT NULL DEFAULT 0,
      avgExpectancy REAL NOT NULL DEFAULT 0,
      avgRiskReward REAL NOT NULL DEFAULT 0,
      avgQualityScore REAL NOT NULL DEFAULT 0,
      lastUpdated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('✅ SetupStats table created')

  // Create unique index for SetupStats
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS SetupStats_patternType_asset_session_timeframe_key ON SetupStats(patternType, asset, session, timeframe)
  `)
  console.log('✅ SetupStats unique index created')

  // Create Alert table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS Alert (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      isActive INTEGER NOT NULL DEFAULT 1,
      dismissedAt DATETIME,
      signalId TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('✅ Alert table created')

  // Create AppSettings table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS AppSettings (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      description TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('✅ AppSettings table created')

  // Verify all tables
  const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  console.log('\n📋 Tables in Turso DB:')
  for (const row of tables.rows) {
    console.log('  -', row.name)
  }

  console.log('\n🎉 Turso database setup complete!')
}

main().catch(err => {
  console.error('❌ Error:', err)
  process.exit(1)
})
