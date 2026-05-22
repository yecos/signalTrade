#!/bin/bash
# SignalTrader Pro — Worker Launcher
# Runs the worker in an infinite loop, restarting if it crashes
# Usage: ./scripts/start-worker.sh

echo "═══════════════════════════════════════════════════════════"
echo "  🤖 SignalTrader Pro — Worker Launcher"
echo "  Auto-restarts if the worker crashes"
echo "  Press Ctrl+C to stop"
echo "═══════════════════════════════════════════════════════════"
echo ""

cd "$(dirname "$0")/.."

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting worker..."
  npx tsx scripts/worker.ts
  EXIT_CODE=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Worker exited with code $EXIT_CODE. Restarting in 10s..."
  sleep 10
done
