#!/bin/bash

# ERIX-Store Restart Script
# Rebuilds and restarts the ERIX-Store server

echo "🔄 Restarting ERIX-Store..."
echo ""

# Step 1: Build
echo "📦 Building TypeScript..."
npm run build

if [ $? -ne 0 ]; then
  echo "❌ Build failed!"
  exit 1
fi

echo "✅ Build successful!"
echo ""

# Step 2: Kill existing process (if running)
echo "🛑 Stopping existing server..."
pkill -f "node dist/index.js" || echo "   No existing server found"
echo ""

# Step 3: Start server
echo "🚀 Starting ERIX-Store server..."
npm start &

echo ""
echo "✅ ERIX-Store restarted!"
echo "   Check logs above for any errors"
echo "   Server should be running at http://localhost:6399"
