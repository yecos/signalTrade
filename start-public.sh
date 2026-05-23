#!/bin/bash
# ============================================
# SignalTrader Pro - Start with Tunnel
# ============================================
# Starts the local server + Cloudflare Tunnel
# Gives you a PUBLIC URL accessible from anywhere
# 
# Install cloudflared first:
#   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
# ============================================

set -e

echo "🌐 SignalTrader Pro - Public Server"
echo "===================================="
echo ""

cd "$(dirname "$0")"

# Start Next.js in background
echo "🚀 Starting Next.js server..."
NODE_ENV=production bun .next/standalone/server.js &
SERVER_PID=$!

# Wait for server to be ready
echo "⏳ Waiting for server..."
sleep 3

# Check if cloudflared is installed
if command -v cloudflared &> /dev/null; then
  echo "🌐 Starting Cloudflare Tunnel..."
  echo "   Your public URL will appear below:"
  echo ""
  cloudflared tunnel --url http://localhost:3000
else
  echo "⚠️  cloudflared not found. Running local only."
  echo "   Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo ""
  echo "   Local access: http://localhost:3000"
  # Just keep the server running
  wait $SERVER_PID
fi

# Cleanup
kill $SERVER_PID 2>/dev/null
