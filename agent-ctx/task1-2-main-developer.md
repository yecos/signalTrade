# Task 1+2: Fix Hydration Error & Build Real Market Data Engine

## Agent: Main Developer
## Date: 2026-05-22

## Changes Made

### Task 1: Fix React Hydration Error #418

**File: `src/app/page.tsx`**

1. **`formatTime()` function** (line ~306): Replaced `toLocaleString("es-ES", ...)` with UTC-based formatting using `getUTCDate()`, `getUTCMonth()`, `getUTCHours()`, `getUTCMinutes()`. This eliminates the server/client timezone difference that caused hydration mismatch.

2. **Mounted guard**: Added `if (!mounted)` check before the main return statement that shows a loading spinner until the client-side React mount completes. This ensures server and client initial renders match (both show loading spinner).

### Task 2: Build Real Market Data Engine

**File: `src/lib/market-engine.ts`** (NEW)

- Multi-source market data engine with 3 tiers:
  - **Binance API** (primary for crypto: BTC/USD, ETH/USD) - public, no key needed
  - **TwelveData API** (primary for forex: EUR/USD, GBP/USD, USD/JPY) - requires API key
  - **GBM Fallback** - simulated data when no APIs available
- Exports: `getCandles()`, `getLatestPrice()`, `getAllPrices()`, `getEngineStatus()`, `getAnalysisMode()`, `checkApiHealth()`, `setTwelveDataApiKey()`
- Tracks connection status, latency, data quality per asset
- Graceful fallback chain

**File: `src/app/api/market-data/route.ts`** (UPDATED)

- GET endpoints:
  - `/api/market-data?mode=status` → engine status
  - `/api/market-data?mode=prices` → all latest prices
  - `/api/market-data?asset=BTC/USD&timeframe=M5` → real candles
- POST endpoints:
  - `check-health` → API health check
  - `set-api-key` → set TwelveData API key
  - `get-price` → get latest price for asset
  - `generate` / `seed` → legacy operations preserved

**File: `src/app/api/auto-trader/route.ts`** (UPDATED)

- GET now includes `marketStatus` and `analysisModes` per asset from market engine
- Preserved all existing functionality

**File: `src/app/page.tsx`** (UPDATED)

- Added `MarketEngineStatusPanel` interface
- Added `marketEngineStatus`, `twelveDataApiKey`, `apiKeyLoading` state
- Added `fetchMarketEngineStatus()`, `handleSetApiKey()`, `handleCheckHealth()` handlers
- Added Market Status Panel in "Motor Estadístico" tab showing:
  - Data quality badge (HIGH/MEDIUM/LOW/OFFLINE)
  - Binance & TwelveData connection status
  - Per-asset source indicator (BIN/12D/SIM/OFF) with price and latency
  - TwelveData API key input field
  - Error display
- Auto-refresh includes market engine status updates
- New imports: `Key`, `Server`, `Signal` from lucide-react

## Verification

- ESLint: ✅ No errors
- TypeScript: ✅ No errors in modified files
- Dev server: ✅ All API endpoints returning 200
