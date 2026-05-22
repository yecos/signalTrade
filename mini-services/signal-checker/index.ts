// Signal Checker + Auto-Trader Mini Service
// Runs every 10 seconds:
// 1. Checks and closes expired signals
// 2. Runs auto-trader cycle if enabled

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const CHECK_INTERVAL = 10000; // 10 seconds
const AUTO_TRADER_INTERVAL = 300000; // 5 minutes (300 seconds)

let lastAutoTraderRun = 0;

async function checkPendingSignals() {
  try {
    const response = await fetch(`${API_BASE}/api/signals/check-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    if (data.closed > 0) {
      console.log(`[${new Date().toISOString()}] ✅ Closed ${data.closed} expired signals`);
    }
    return data;
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] ❌ Error checking signals:`, error.message);
    return null;
  }
}

async function runAutoTraderCycle() {
  try {
    // First check if auto-trader is enabled
    const statusResponse = await fetch(`${API_BASE}/api/auto-trader`);
    const statusData = await statusResponse.json();
    
    if (!statusData.state?.isRunning) {
      return null;
    }
    
    const response = await fetch(`${API_BASE}/api/auto-trader`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'run-cycle' }),
    });
    const data = await response.json();
    
    if (data.signalsGenerated > 0) {
      console.log(`[${new Date().toISOString()}] 🤖 Auto-trader: ${data.signalsGenerated} signals generated, ${data.signalsSkipped} skipped (NO_OPERAR)`);
    }
    
    return data;
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] ❌ Auto-trader error:`, error.message);
    return null;
  }
}

async function mainLoop() {
  console.log('🚀 Signal Checker + Auto-Trader Service started');
  console.log(`📡 API Base: ${API_BASE}`);
  console.log(`⏱️  Check interval: ${CHECK_INTERVAL}ms`);
  console.log(`🤖 Auto-trader interval: ${AUTO_TRADER_INTERVAL}ms`);
  console.log('');
  
  // Initial check
  await checkPendingSignals();
  
  setInterval(async () => {
    // 1. Always check pending signals
    await checkPendingSignals();
    
    // 2. Run auto-trader cycle if enough time has passed
    const now = Date.now();
    if (now - lastAutoTraderRun >= AUTO_TRADER_INTERVAL) {
      await runAutoTraderCycle();
      lastAutoTraderRun = now;
    }
  }, CHECK_INTERVAL);
}

mainLoop();
