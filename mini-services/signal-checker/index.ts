const CHECK_INTERVAL = 10000; // 10 seconds

async function checkPendingSignals() {
  try {
    const response = await fetch('http://localhost:3000/api/signals/check-pending', {
      method: 'POST',
    });
    const data = await response.json();
    console.log(`[${new Date().toISOString()}] Checked signals: ${data.checked} checked, ${data.closed} closed`);
  } catch (error) {
    console.error('Error checking signals:', error);
  }
}

setInterval(checkPendingSignals, CHECK_INTERVAL);
console.log('Signal checker started - checking every 10 seconds');

// Run initial check
checkPendingSignals();
