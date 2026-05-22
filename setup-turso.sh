#!/bin/bash
# ============================================
# SignalTrader Pro - Turso Database Setup
# ============================================
# Run this script to create your Turso database
# and configure the connection.
#
# Prerequisites:
#   1. Install Turso CLI: curl -sSfL https://get.tur.so/install.sh | bash
#   2. Login: turso auth login
#
# Usage:
#   chmod +x setup-turso.sh
#   ./setup-turso.sh
# ============================================

set -e

DB_NAME="signaltrader-pro"

echo "🔧 SignalTrader Pro - Turso Setup"
echo "=================================="
echo ""

# Check if turso CLI is installed
if ! command -v turso &> /dev/null; then
    echo "❌ Turso CLI not found. Install it first:"
    echo "   curl -sSfL https://get.tur.so/install.sh | bash"
    exit 1
fi

# Check if logged in
if ! turso auth whoami &> /dev/null; then
    echo "❌ Not logged in to Turso. Run: turso auth login"
    exit 1
fi

echo "📦 Creating Turso database: $DB_NAME"
turso db create "$DB_NAME" --enable-wal

echo ""
echo "📋 Getting connection info..."
DB_URL=$(turso db show "$DB_NAME" --url)
echo "   URL: $DB_URL"

echo ""
echo "🔑 Creating auth token..."
AUTH_TOKEN=$(turso db tokens create "$DB_NAME")
echo "   Token: ${AUTH_TOKEN:0:20}..."

echo ""
echo "📊 Pushing schema to Turso..."
# Use the Turso URL for schema push
TURSO_DATABASE_URL="$DB_URL" TURSO_AUTH_TOKEN="$AUTH_TOKEN" npx prisma db push

echo ""
echo "✅ Turso setup complete!"
echo ""
echo "Add these to your .env file:"
echo "  TURSO_DATABASE_URL=$DB_URL"
echo "  TURSO_AUTH_TOKEN=$AUTH_TOKEN"
echo ""
echo "And for Vercel, add these as environment variables:"
echo "  vercel env add TURSO_DATABASE_URL"
echo "  vercel env add TURSO_AUTH_TOKEN"
echo "  vercel env add DATABASE_URL (set to file:./db/custom.db for build)"
