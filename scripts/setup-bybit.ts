#!/usr/bin/env npx tsx
// ══════════════════════════════════════════════════════════════════════════════
// SignalTrader Pro — Bybit Setup Script
// Configures Bybit API keys in the database and tests the connection
// ══════════════════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
config({ path: '../.env' });
config({ path: '.env' });

import { db, runAutoMigration } from '../src/lib/db';
import { getOrCreateAccount } from '../src/lib/risk-manager';
import { BybitClient } from '../src/lib/broker-client';

// ─── Configuration ──────────────────────────────────────────────────────────
const API_KEY = process.env.BYBIT_API_KEY || 'SB8K7d9JHCx6FLRiRO';
const API_SECRET = process.env.BYBIT_API_SECRET || 'aaEnInpaLWVIkqDEBWSrRmULUpDVZWNvLNuO';
const TESTNET = process.env.BYBIT_TESTNET !== 'false'; // Default to testnet for safety

async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🔑 SignalTrader Pro — Bybit Setup');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Step 1: Run migrations
  console.log('📋 Step 1: Running database migrations...');
  try {
    const migrationResult = await runAutoMigration();
    if (migrationResult.applied.length > 0) {
      console.log(`  ✅ Migration applied: ${migrationResult.applied.join(', ')}`);
    } else {
      console.log('  ✅ Database schema up to date');
    }
  } catch (err: any) {
    console.log(`  ⚠️ Migration warning: ${err.message}`);
  }

  // Step 2: Get or create account
  console.log('\n📋 Step 2: Setting up account...');
  const account = await getOrCreateAccount();
  console.log(`  ✅ Account found: ${account.id}`);
  console.log(`  Current broker: ${account.broker}`);
  console.log(`  Current balance: $${account.balance.toFixed(2)}`);

  // Step 3: Update account with Bybit credentials
  console.log('\n📋 Step 3: Configuring Bybit API keys...');
  console.log(`  API Key: ${API_KEY.substring(0, 6)}...${API_KEY.substring(API_KEY.length - 4)}`);
  console.log(`  Mode: ${TESTNET ? 'TESTNET (Paper/Demo)' : 'MAINNET (Real Money)'}`);

  await db.account.update({
    where: { id: account.id },
    data: {
      broker: 'BYBIT',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      isLive: !TESTNET,
    },
  });
  console.log('  ✅ API keys saved to database');

  // Step 4: Test connection
  console.log('\n📋 Step 4: Testing Bybit connection...');
  const client = new BybitClient({
    broker: 'BYBIT',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    testnet: TESTNET,
  });

  // Test connection
  const connCheck = await client.checkConnection();
  if (connCheck.ok) {
    console.log(`  ✅ Connection OK (latency: ${connCheck.latency}ms)`);
  } else {
    console.log('  ❌ Connection failed — check API keys and network');
  }

  // Test authenticated endpoint
  console.log('\n📋 Step 5: Testing authenticated endpoints...');
  try {
    const accountInfo = await client.getAccountInfo();
    if (accountInfo) {
      console.log(`  ✅ Account info retrieved:`);
      console.log(`     Balance: $${accountInfo.balance.toFixed(2)}`);
      console.log(`     Equity: $${accountInfo.equity.toFixed(2)}`);
      console.log(`     Available: $${accountInfo.availableBalance.toFixed(2)}`);

      // Update local account with real balance
      await db.account.update({
        where: { id: account.id },
        data: {
          balance: accountInfo.balance,
          equity: accountInfo.equity,
          peakEquity: Math.max(account.peakEquity, accountInfo.equity),
        },
      });
      console.log('  ✅ Local account balance synced with Bybit');
    } else {
      console.log('  ⚠️ Could not fetch account info — API keys may need correct permissions');
    }
  } catch (err: any) {
    console.log(`  ⚠️ Auth test failed: ${err.message}`);
    console.log('     This is normal for testnet or if keys lack account read permission');
  }

  // Test market data
  console.log('\n📋 Step 6: Testing market data...');
  try {
    const ticker = await client.getTicker('BTCUSDT');
    if (ticker) {
      console.log(`  ✅ BTC/USD price: $${ticker.lastPrice.toFixed(2)}`);
      console.log(`     Spread: $${ticker.spread.toFixed(2)}`);
      console.log(`     24h Volume: ${ticker.volume24h.toFixed(0)}`);
    }
  } catch (err: any) {
    console.log(`  ⚠️ Market data test failed: ${err.message}`);
  }

  // Step 7: Enable auto-execution in PAPER mode
  console.log('\n📋 Step 7: Enabling auto-execution...');
  await db.appSettings.upsert({
    where: { key: 'autoExecution' },
    create: {
      key: 'autoExecution',
      value: JSON.stringify({ enabled: true, mode: 'PAPER' }),
      description: 'Auto-execution setting',
    },
    update: {
      value: JSON.stringify({ enabled: true, mode: 'PAPER' }),
    },
  });
  console.log('  ✅ Auto-execution enabled (PAPER mode)');

  // Step 8: Enable auto-trader
  console.log('\n📋 Step 8: Enabling auto-trader...');
  await db.appSettings.upsert({
    where: { key: 'autoTraderRunning' },
    create: {
      key: 'autoTraderRunning',
      value: 'true',
      description: 'Auto-trader running',
    },
    update: { value: 'true' },
  });
  console.log('  ✅ Auto-trader enabled');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✅ Setup Complete!');
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Start the worker: cd scripts && npx tsx worker.ts --auto');
  console.log('  2. Visit dashboard: https://signal-trade-seven.vercel.app');
  console.log('  3. Check trading tab to see positions');
  console.log('');
  console.log('  ⚠️ IMPORTANT: You are in PAPER mode. To switch to LIVE:');
  console.log('     - Set BYBIT_TESTNET=false in .env');
  console.log('     - Re-run this script');
  console.log('     - Or use the Trading tab in the dashboard');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
