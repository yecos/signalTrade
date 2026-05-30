#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// BACKTEST v8 — Validación de nuevas estrategias (Funding Arb, Mean Reversion)
// ══════════════════════════════════════════════════════════════════════════════
// Este backtest valida:
//   1. Funding Rate Arbitrage: Usa historial de funding rates para calcular ganancia
//   2. Mean Reversion: Simula señales BB+RSI+ADX en velas históricas
//   3. Grid Trading: Simula grid sobre velas históricas
//
// NOTA: Funding Arb y Grid no requieren "predecir dirección" — es edge estructural.
//       Mean Reversion sí predice reversión, pero con filtros estrictos.
// ══════════════════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
config({ path: '../.env' });
config({ path: '.env' });

import { computeAllIndicators } from '../src/lib/indicators';
import { detectRegime } from '../src/lib/regime-engine';
import { detectSession } from '../src/lib/sessions';

// === TYPES ===

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BacktestTrade {
  asset: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPct: number;
  result: 'WIN' | 'LOSS';
  holdingHours: number;
  reason: string;
  // Mean reversion specific
  rsi?: number;
  adx?: number;
  bbPosition?: string;
  // Funding specific
  fundingRate?: number;
  fundingCollected?: number;
}

interface StrategyResult {
  strategy: string;
  asset: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalPnlPct: number;
  avgPnlPerTrade: number;
  avgWinPnl: number;
  avgLossPnl: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgHoldingHours: number;
  trades: BacktestTrade[];
}

// === FETCH CANDLES FROM BINANCE ===

async function fetchCandles(symbol: string, interval: string, limit: number = 1000): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    return data.map((k: any[]) => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (err: any) {
    console.error(`Error fetching ${symbol} ${interval}: ${err.message}`);
    return [];
  }
}

// === FETCH FUNDING RATE HISTORY ===

async function fetchFundingHistory(symbol: string, limit: number = 500): Promise<Array<{
  fundingRate: number;
  fundingTime: number;
  markPrice: number;
}>> {
  // Bybit public API for funding history
  const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=${limit}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (data.retCode !== 0 || !data.result?.list) return [];
    return data.result.list.map((item: any) => ({
      fundingRate: parseFloat(item.fundingRate),
      fundingTime: parseInt(item.fundingRateTimestamp) * 1000,
      markPrice: parseFloat(item.fundingRateTimestamp), // Not available in this endpoint
    }));
  } catch (err: any) {
    console.error(`Error fetching funding history: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY 1: FUNDING RATE ARBITRAGE BACKTEST
// ═══════════════════════════════════════════════════════════════════════════

async function backtestFundingArb(symbol: string, initialBalance: number = 10000): Promise<StrategyResult> {
  console.log(`\n📊 Backtesting Funding Rate Arbitrage for ${symbol}...`);

  const fundingHistory = await fetchFundingHistory(symbol, 200);
  if (fundingHistory.length < 10) {
    console.log(`  ⚠️ Insufficient funding history (${fundingHistory.length} periods)`);
    return emptyResult('funding_arb', symbol);
  }

  const trades: BacktestTrade[] = [];
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdown = 0;
  const minFundingPct = 0.01; // 0.01% minimum
  const positionSizeUsd = 1000; // $1000 per position
  const baseRiskPct = 0.1; // 0.1% max basis risk per period
  const makerFeePct = 0.02; // 0.02% maker fee per side

  for (const funding of fundingHistory) {
    const absFundingPct = Math.abs(funding.fundingRate) * 100;

    if (absFundingPct >= minFundingPct) {
      // Enter position: collect funding
      // Cost: 2x maker fee (open + close) + basis risk
      const entryFee = positionSizeUsd * (makerFeePct / 100);
      const exitFee = positionSizeUsd * (makerFeePct / 100);
      const basisCost = positionSizeUsd * (baseRiskPct / 100); // Estimated basis risk
      const totalCost = entryFee + exitFee + basisCost;

      // Revenue: funding rate * position size
      const fundingRevenue = positionSizeUsd * absFundingPct / 100;

      const netPnl = fundingRevenue - totalCost;
      const netPnlPct = (netPnl / positionSizeUsd) * 100;

      balance += netPnl;

      const result: BacktestTrade = {
        asset: symbol,
        strategy: 'funding_arb',
        direction: funding.fundingRate > 0 ? 'SHORT' : 'LONG',
        entryPrice: 0, // Not relevant for arb
        exitPrice: 0,
        entryTime: funding.fundingTime,
        exitTime: funding.fundingTime + 8 * 3600 * 1000, // 8 hours later
        pnl: netPnl,
        pnlPct: netPnlPct,
        result: netPnl > 0 ? 'WIN' : 'LOSS',
        holdingHours: 8,
        reason: `Funding ${absFundingPct.toFixed(4)}%, revenue $${fundingRevenue.toFixed(2)}, cost $${totalCost.toFixed(2)}`,
        fundingRate: funding.fundingRate,
        fundingCollected: fundingRevenue,
      };

      trades.push(result);

      // Track drawdown
      peakBalance = Math.max(peakBalance, balance);
      const drawdown = ((peakBalance - balance) / peakBalance) * 100;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
  }

  return computeStrategyStats('funding_arb', symbol, trades, initialBalance, maxDrawdown);
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY 2: MEAN REVERSION BACKTEST
// ═══════════════════════════════════════════════════════════════════════════

async function backtestMeanReversion(symbol: string, interval: string = '15m', initialBalance: number = 10000): Promise<StrategyResult> {
  console.log(`\n📊 Backtesting Mean Reversion for ${symbol} ${interval}...`);

  const candles = await fetchCandles(symbol, interval, 1000);
  if (candles.length < 100) {
    console.log(`  ⚠️ Insufficient candles (${candles.length})`);
    return emptyResult('mean_reversion', symbol);
  }

  const trades: BacktestTrade[] = [];
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdown = 0;
  const positionSizeUsd = 500;
  const feePct = 0.04; // 0.04% round trip (maker)
  const slMultiplier = 1.5; // SL = 1.5x ATR
  const tpTarget = 'BB_MIDDLE'; // TP at BB middle

  // Iterate through candles (need at least 50 for indicators)
  for (let i = 50; i < candles.length - 1; i++) {
    const windowCandles = candles.slice(i - 50, i);
    const currentCandle = candles[i];
    const nextCandle = candles[i + 1]; // For entry price

    // Compute indicators
    const indicators = computeAllIndicators(windowCandles as any);
    const price = currentCandle.close;

    const rsi = indicators.rsi14 || 50;
    const stochK = indicators.stochK || 50;
    const stochD = indicators.stochD || 50;
    const adx = indicators.adx14 || 25;
    const atr = indicators.atr14 || price * 0.01;
    const bbUpper = indicators.bbUpper || price * 1.02;
    const bbLower = indicators.bbLower || price * 0.98;
    const bbMiddle = (bbUpper + bbLower) / 2;
    const relVol = indicators.volumeAnalysis?.relativeVolume || 1;

    // Detect session
    const hour = new Date(currentCandle.timestamp).getUTCHours();
    const isAsiaSession = hour >= 0 && hour < 8;
    const isOverlapSession = hour >= 8 && hour < 12;
    const isLondonSession = hour >= 8 && hour < 16;
    const isGoodSession = isAsiaSession || isOverlapSession || isLondonSession;

    // Detect regime
    const regimeResult = detectRegime(windowCandles as any, indicators);
    const isRanging = regimeResult.regime === 'RANGING' || regimeResult.regime === 'LOW_VOL';

    // === FILTERS ===
    if (!isGoodSession) continue;
    if (!isRanging && adx > 25) continue; // Skip trending markets
    if (adx > 25) continue; // Must be ranging

    // === LONG SIGNAL (oversold) ===
    const longRSI = rsi < 30;
    const longStoch = stochK < 20 && stochK < stochD;
    const longBB = price <= bbLower * 1.002; // Price at or below lower BB
    const longVol = relVol >= 1.2;

    const longScore = [longRSI, longStoch, longBB, longVol].filter(Boolean).length;

    if (longScore >= 3) {
      const entryPrice = nextCandle.open;
      const stopLoss = entryPrice - atr * slMultiplier;
      const takeProfit = bbMiddle;
      const risk = entryPrice - stopLoss;
      const reward = takeProfit - entryPrice;

      if (risk <= 0 || reward <= 0) continue;

      // Simulate trade
      let exitPrice = entryPrice;
      let exitTime = nextCandle.timestamp;
      let result: 'WIN' | 'LOSS' = 'LOSS';
      let holdingHours = 0;

      // Look ahead for exit
      for (let j = i + 1; j < Math.min(i + 50, candles.length); j++) {
        const candle = candles[j];

        // Check SL hit
        if (candle.low <= stopLoss) {
          exitPrice = stopLoss;
          exitTime = candle.timestamp;
          result = 'LOSS';
          holdingHours = (candle.timestamp - currentCandle.timestamp) / (3600 * 1000);
          break;
        }

        // Check TP hit
        if (candle.high >= takeProfit) {
          exitPrice = takeProfit;
          exitTime = candle.timestamp;
          result = 'WIN';
          holdingHours = (candle.timestamp - currentCandle.timestamp) / (3600 * 1000);
          break;
        }

        // Max hold: 24 candles (6 hours for 15m)
        if (j - i >= 24) {
          exitPrice = candle.close;
          exitTime = candle.timestamp;
          result = exitPrice > entryPrice ? 'WIN' : 'LOSS';
          holdingHours = (candle.timestamp - currentCandle.timestamp) / (3600 * 1000);
          break;
        }
      }

      const pnl = (exitPrice - entryPrice) * (positionSizeUsd / entryPrice);
      const fee = positionSizeUsd * (feePct / 100);
      const netPnl = pnl - fee;
      const netPnlPct = (netPnl / positionSizeUsd) * 100;

      balance += netPnl;
      peakBalance = Math.max(peakBalance, balance);
      const drawdown = ((peakBalance - balance) / peakBalance) * 100;
      maxDrawdown = Math.max(maxDrawdown, drawdown);

      trades.push({
        asset: symbol,
        strategy: 'mean_reversion',
        direction: 'LONG',
        entryPrice,
        exitPrice,
        entryTime: currentCandle.timestamp,
        exitTime,
        pnl: netPnl,
        pnlPct: netPnlPct,
        result,
        holdingHours,
        reason: `LONG RSI:${rsi.toFixed(0)} Stoch:${stochK.toFixed(0)} ADX:${adx.toFixed(0)} Score:${longScore}/4`,
        rsi,
        adx,
        bbPosition: longBB ? 'AT_LOWER' : 'MIDDLE',
      });
      continue; // Only one trade per candle
    }

    // === SHORT SIGNAL (overbought) ===
    const shortRSI = rsi > 70;
    const shortStoch = stochK > 80 && stochK > stochD;
    const shortBB = price >= bbUpper * 0.998;
    const shortVol = relVol >= 1.2;

    const shortScore = [shortRSI, shortStoch, shortBB, shortVol].filter(Boolean).length;

    if (shortScore >= 3) {
      const entryPrice = nextCandle.open;
      const stopLoss = entryPrice + atr * slMultiplier;
      const takeProfit = bbMiddle;
      const risk = stopLoss - entryPrice;
      const reward = entryPrice - takeProfit;

      if (risk <= 0 || reward <= 0) continue;

      let exitPrice = entryPrice;
      let exitTime = nextCandle.timestamp;
      let result: 'WIN' | 'LOSS' = 'LOSS';
      let holdingHours = 0;

      for (let j = i + 1; j < Math.min(i + 50, candles.length); j++) {
        const candle = candles[j];
        if (candle.high >= stopLoss) {
          exitPrice = stopLoss;
          exitTime = candle.timestamp;
          result = 'LOSS';
          holdingHours = (candle.timestamp - currentCandle.timestamp) / (3600 * 1000);
          break;
        }
        if (candle.low <= takeProfit) {
          exitPrice = takeProfit;
          exitTime = candle.timestamp;
          result = 'WIN';
          holdingHours = (candle.timestamp - currentCandle.timestamp) / (3600 * 1000);
          break;
        }
        if (j - i >= 24) {
          exitPrice = candle.close;
          exitTime = candle.timestamp;
          result = exitPrice < entryPrice ? 'WIN' : 'LOSS';
          holdingHours = (candle.timestamp - currentCandle.timestamp) / (3600 * 1000);
          break;
        }
      }

      const pnl = (entryPrice - exitPrice) * (positionSizeUsd / entryPrice);
      const fee = positionSizeUsd * (feePct / 100);
      const netPnl = pnl - fee;
      const netPnlPct = (netPnl / positionSizeUsd) * 100;

      balance += netPnl;
      peakBalance = Math.max(peakBalance, balance);
      const drawdown = ((peakBalance - balance) / peakBalance) * 100;
      maxDrawdown = Math.max(maxDrawdown, drawdown);

      trades.push({
        asset: symbol,
        strategy: 'mean_reversion',
        direction: 'SHORT',
        entryPrice,
        exitPrice,
        entryTime: currentCandle.timestamp,
        exitTime,
        pnl: netPnl,
        pnlPct: netPnlPct,
        result,
        holdingHours,
        reason: `SHORT RSI:${rsi.toFixed(0)} Stoch:${stochK.toFixed(0)} ADX:${adx.toFixed(0)} Score:${shortScore}/4`,
        rsi,
        adx,
        bbPosition: shortBB ? 'AT_UPPER' : 'MIDDLE',
      });
    }
  }

  return computeStrategyStats('mean_reversion', symbol, trades, initialBalance, maxDrawdown);
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY 3: GRID TRADING BACKTEST
// ═══════════════════════════════════════════════════════════════════════════

async function backtestGridTrading(symbol: string, interval: string = '15m', initialBalance: number = 10000): Promise<StrategyResult> {
  console.log(`\n📊 Backtesting Grid Trading for ${symbol} ${interval}...`);

  const candles = await fetchCandles(symbol, interval, 1000);
  if (candles.length < 100) {
    console.log(`  ⚠️ Insufficient candles (${candles.length})`);
    return emptyResult('grid_trading', symbol);
  }

  const trades: BacktestTrade[] = [];
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdown = 0;

  // Grid parameters
  const gridSpacingPct = 0.4; // 0.4% between levels
  const takeProfitPct = 0.4;  // 0.4% TP per level
  const gridLevels = 10;
  const levelSizeUsd = 200;
  const feePct = 0.04; // 0.04% round trip maker

  // Detect initial range
  const first50 = candles.slice(0, 50);
  const indicators = computeAllIndicators(first50 as any);
  const initialPrice = first50[first50.length - 1].close;
  const atr = indicators.atr14 || initialPrice * 0.015;

  const rangeHigh = initialPrice + atr * 2;
  const rangeLow = initialPrice - atr * 2;
  const priceStep = initialPrice * (gridSpacingPct / 100);

  // Create grid levels
  const buyLevels: number[] = [];
  const sellLevels: number[] = [];

  for (let i = 1; i <= gridLevels; i++) {
    buyLevels.push(Math.max(rangeLow, initialPrice - priceStep * i));
    sellLevels.push(Math.min(rangeHigh, initialPrice + priceStep * i));
  }

  // Simulate grid
  const activeBuys = new Map<number, { entryPrice: number; quantity: number }>();
  const activeSells = new Map<number, { entryPrice: number; quantity: number }>();

  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];

    // Check buy level fills (price dropped to level)
    for (const level of buyLevels) {
      if (candle.low <= level && !activeBuys.has(level)) {
        activeBuys.set(level, { entryPrice: level, quantity: levelSizeUsd / level });
      }

      // Check if buy level hit TP (price rose to entry + TP)
      const buy = activeBuys.get(level);
      if (buy && candle.high >= buy.entryPrice * (1 + takeProfitPct / 100)) {
        const exitPrice = buy.entryPrice * (1 + takeProfitPct / 100);
        const pnl = (exitPrice - buy.entryPrice) * buy.quantity;
        const fee = levelSizeUsd * (feePct / 100);
        const netPnl = pnl - fee;

        balance += netPnl;
        peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, ((peakBalance - balance) / peakBalance) * 100);

        trades.push({
          asset: symbol,
          strategy: 'grid_trading',
          direction: 'LONG',
          entryPrice: buy.entryPrice,
          exitPrice,
          entryTime: candles[i - 1]?.timestamp || candle.timestamp,
          exitTime: candle.timestamp,
          pnl: netPnl,
          pnlPct: (netPnl / levelSizeUsd) * 100,
          result: netPnl > 0 ? 'WIN' : 'LOSS',
          holdingHours: 0,
          reason: `Grid BUY @ ${buy.entryPrice.toFixed(2)} → TP ${exitPrice.toFixed(2)}`,
        });

        activeBuys.delete(level); // Reset for next cycle
      }
    }

    // Check sell level fills
    for (const level of sellLevels) {
      if (candle.high >= level && !activeSells.has(level)) {
        activeSells.set(level, { entryPrice: level, quantity: levelSizeUsd / level });
      }

      const sell = activeSells.get(level);
      if (sell && candle.low <= sell.entryPrice * (1 - takeProfitPct / 100)) {
        const exitPrice = sell.entryPrice * (1 - takeProfitPct / 100);
        const pnl = (sell.entryPrice - exitPrice) * sell.quantity;
        const fee = levelSizeUsd * (feePct / 100);
        const netPnl = pnl - fee;

        balance += netPnl;
        peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, ((peakBalance - balance) / peakBalance) * 100);

        trades.push({
          asset: symbol,
          strategy: 'grid_trading',
          direction: 'SHORT',
          entryPrice: sell.entryPrice,
          exitPrice,
          entryTime: candles[i - 1]?.timestamp || candle.timestamp,
          exitTime: candle.timestamp,
          pnl: netPnl,
          pnlPct: (netPnl / levelSizeUsd) * 100,
          result: netPnl > 0 ? 'WIN' : 'LOSS',
          holdingHours: 0,
          reason: `Grid SELL @ ${sell.entryPrice.toFixed(2)} → TP ${exitPrice.toFixed(2)}`,
        });

        activeSells.delete(level);
      }
    }
  }

  return computeStrategyStats('grid_trading', symbol, trades, initialBalance, maxDrawdown);
}

// === HELPER: Compute strategy stats ===

function computeStrategyStats(strategy: string, asset: string, trades: BacktestTrade[], initialBalance: number, maxDrawdown: number): StrategyResult {
  const wins = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalPnlPct = (totalPnl / initialBalance) * 100;
  const avgPnlPerTrade = trades.length > 0 ? totalPnl / trades.length : 0;
  const avgWinPnl = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLossPnl = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgHoldingHours = trades.length > 0 ? trades.reduce((s, t) => s + t.holdingHours, 0) / trades.length : 0;

  // Sharpe ratio (simplified)
  const returns = trades.map(t => t.pnlPct);
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
    : 1;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  return {
    strategy,
    asset,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnl,
    totalPnlPct,
    avgPnlPerTrade,
    avgWinPnl,
    avgLossPnl,
    profitFactor,
    maxDrawdownPct: maxDrawdown,
    sharpeRatio,
    avgHoldingHours,
    trades,
  };
}

function emptyResult(strategy: string, asset: string): StrategyResult {
  return {
    strategy, asset, totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    totalPnl: 0, totalPnlPct: 0, avgPnlPerTrade: 0, avgWinPnl: 0, avgLossPnl: 0,
    profitFactor: 0, maxDrawdownPct: 0, sharpeRatio: 0, avgHoldingHours: 0, trades: [],
  };
}

// === PRINT RESULTS ===

function printResult(result: StrategyResult): void {
  const emoji = result.profitFactor > 1.5 ? '🟢' : result.profitFactor > 1.0 ? '🟡' : '🔴';
  console.log(`\n${emoji} ═══ ${result.strategy.toUpperCase()} — ${result.asset} ═══`);
  console.log(`  Trades: ${result.totalTrades} (${result.wins}W / ${result.losses}L)`);
  console.log(`  Win Rate: ${result.winRate.toFixed(1)}%`);
  console.log(`  Total P&L: $${result.totalPnl.toFixed(2)} (${result.totalPnlPct.toFixed(2)}%)`);
  console.log(`  Avg P&L/Trade: $${result.avgPnlPerTrade.toFixed(2)}`);
  console.log(`  Avg Win: $${result.avgWinPnl.toFixed(2)} | Avg Loss: $${result.avgLossPnl.toFixed(2)}`);
  console.log(`  Profit Factor: ${result.profitFactor.toFixed(2)}`);
  console.log(`  Max Drawdown: ${result.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
  console.log(`  Avg Hold: ${result.avgHoldingHours.toFixed(1)}h`);

  // Print sample trades
  if (result.trades.length > 0) {
    console.log(`\n  📋 Sample trades (last 5):`);
    for (const trade of result.trades.slice(-5)) {
      const emoji = trade.result === 'WIN' ? '✅' : '❌';
      console.log(`    ${emoji} ${trade.direction} @ $${trade.entryPrice.toFixed(2)} → $${trade.exitPrice.toFixed(2)} | P&L: $${trade.pnl.toFixed(2)} | ${trade.reason}`);
    }
  }
}

// === MAIN ===

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  📊 BACKTEST v8 — Nuevas Estrategias');
  console.log('  1. Funding Rate Arbitrage');
  console.log('  2. Mean Reversion (BB + RSI + ADX)');
  console.log('  3. Grid Trading Adaptativo');
  console.log('═══════════════════════════════════════════════════════════');

  const allResults: StrategyResult[] = [];

  // === FUNDING ARB ===
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    const result = await backtestFundingArb(symbol);
    allResults.push(result);
    printResult(result);
  }

  // === MEAN REVERSION ===
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    for (const interval of ['15m', '1h']) {
      const result = await backtestMeanReversion(symbol, interval);
      allResults.push(result);
      printResult(result);
    }
  }

  // === GRID TRADING ===
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    const result = await backtestGridTrading(symbol, '15m');
    allResults.push(result);
    printResult(result);
  }

  // === SUMMARY ===
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  📋 RESUMEN COMPARATIVO');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`${'Strategy'.padEnd(20)} ${'Asset'.padEnd(10)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'P&L$'.padEnd(10)} ${'PF'.padEnd(8)} ${'Sharpe'.padEnd(8)} ${'DD%'.padEnd(8)}`);
  console.log('─'.repeat(80));

  for (const r of allResults) {
    const emoji = r.profitFactor > 1.5 ? '🟢' : r.profitFactor > 1.0 ? '🟡' : '🔴';
    console.log(`${emoji} ${r.strategy.padEnd(18)} ${r.asset.padEnd(10)} ${String(r.totalTrades).padEnd(8)} ${r.winRate.toFixed(1).padEnd(8)} ${r.totalPnl.toFixed(2).padEnd(10)} ${r.profitFactor.toFixed(2).padEnd(8)} ${r.sharpeRatio.toFixed(2).padEnd(8)} ${r.maxDrawdownPct.toFixed(2).padEnd(8)}`);
  }

  // Best strategy
  const profitable = allResults.filter(r => r.profitFactor > 1.0);
  if (profitable.length > 0) {
    const best = profitable.sort((a, b) => b.profitFactor - a.profitFactor)[0];
    console.log(`\n🏆 BEST STRATEGY: ${best.strategy} on ${best.asset} — PF ${best.profitFactor.toFixed(2)}, WR ${best.winRate.toFixed(1)}%, P&L $${best.totalPnl.toFixed(2)}`);
  } else {
    console.log(`\n⚠️ Ninguna estrategia es rentable en este período. Necesitas más datos o ajustar parámetros.`);
  }

  // Comparison with v7
  console.log(`\n📊 COMPARACIÓN CON v7 (auto-trader de patrones):`);
  console.log(`  v7 mejor resultado: PF 0.96 (breakeven, ETH 4H longs)`);
  console.log(`  v8 mejor resultado: PF ${allResults.sort((a, b) => b.profitFactor - a.profitFactor)[0].profitFactor.toFixed(2)}`);
  const v8Best = allResults.sort((a, b) => b.profitFactor - a.profitFactor)[0];
  if (v8Best.profitFactor > 0.96) {
    console.log(`  ✅ v8 MEJORA sobre v7 — ${v8Best.strategy} tiene edge positivo`);
  } else {
    console.log(`  ❌ v8 NO mejora sobre v7 — seguir iterando`);
  }
}

main().catch(err => console.error('Fatal error:', err));
