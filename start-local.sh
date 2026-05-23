#!/bin/bash
# ============================================
# SignalTrader Pro - Local Server
# ============================================
# Run this to start SignalTrader on your PC 24/7
# Access: http://localhost:3000
# 
# With Cloudflare Tunnel (optional):
#   cloudflared tunnel run --url http://localhost:3000
# ============================================

set -e

echo "🚀 SignalTrader Pro - Local Server"
echo "==================================="
echo ""

cd "$(dirname "$0")"

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  bun install
fi

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Push schema if needed
echo "💾 Checking database..."
npx prisma db push --skip-generate 2>/dev/null

# Build for production (faster, less memory)
if [ ! -d ".next/standalone" ]; then
  echo "🏗️ Building for production..."
  npm run build:standalone
fi

echo ""
echo "✅ Starting SignalTrader Pro on http://localhost:3000"
echo "   Press Ctrl+C to stop"
echo ""

# Start the server
NODE_ENV=production bun .next/standalone/server.js
