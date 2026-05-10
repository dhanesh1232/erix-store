#!/bin/bash

# ERIX-Store Production Deployment Script
# Prepares and deploys ERIX-Store to Render

set -e  # Exit on any error

echo "🚀 ERIX-Store Production Deployment"
echo "=================================="
echo ""

# Step 1: Generate API Key
echo "📝 Step 1: Generate API Key"
echo "----------------------------"
API_KEY=$(node -e "console.log('erix_' + require('crypto').randomBytes(32).toString('hex'))")
echo "Generated API Key: $API_KEY"
echo ""
echo "⚠️  SAVE THIS KEY! You'll need it for:"
echo "   - Render environment variables"
echo "   - Server .env configuration"
echo ""

# Step 2: Check Git Status
echo "📋 Step 2: Check Git Status"
echo "----------------------------"
if [ -d ".git" ]; then
    echo "✅ Git repository found"
    
    # Check for uncommitted changes
    if [ -n "$(git status --porcelain)" ]; then
        echo "⚠️  Uncommitted changes found:"
        git status --short
        echo ""
        read -p "Commit changes now? (y/n): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git add .
            git commit -m "feat: production deployment ready - $(date)"
            echo "✅ Changes committed"
        else
            echo "⚠️  Proceeding with uncommitted changes"
        fi
    else
        echo "✅ Working directory clean"
    fi
else
    echo "❌ No git repository found. Initialize git first:"
    echo "   git init"
    echo "   git add ."
    echo "   git commit -m 'initial commit'"
    exit 1
fi

# Step 3: Check Dependencies
echo ""
echo "🔧 Step 3: Check Dependencies"
echo "-----------------------------"
if [ -f "package.json" ]; then
    echo "✅ package.json found"
else
    echo "❌ package.json not found"
    exit 1
fi

if [ -f "Dockerfile" ]; then
    echo "✅ Dockerfile found"
else
    echo "❌ Dockerfile not found"
    exit 1
fi

if [ -f "render.yaml" ]; then
    echo "✅ render.yaml found"
else
    echo "❌ render.yaml not found"
    exit 1
fi

# Step 4: Test Local Build
echo ""
echo "🏗️  Step 4: Test Local Build"
echo "-----------------------------"
echo "Testing TypeScript compilation..."
if npm run build; then
    echo "✅ Build successful"
else
    echo "❌ Build failed. Fix errors before deploying."
    exit 1
fi

# Step 5: Push to GitHub
echo ""
echo "📤 Step 5: Push to GitHub"
echo "-------------------------"
CURRENT_BRANCH=$(git branch --show-current)
echo "Current branch: $CURRENT_BRANCH"

read -p "Push to GitHub now? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    git push origin $CURRENT_BRANCH
    echo "✅ Pushed to GitHub"
else
    echo "⚠️  Skipped GitHub push"
fi

# Step 6: Deployment Instructions
echo ""
echo "🎯 Step 6: Deploy on Render"
echo "----------------------------"
echo "1. Go to: https://render.com/blueprints"
echo "2. Click 'New Blueprint Instance'"
echo "3. Connect your GitHub repository"
echo "4. Select the ECOD/erix-store directory"
echo "5. Set these environment variables:"
echo ""
echo "   DATABASE_URL=postgresql://postgres.bnchmgyybdsklxrumcnd:gZn79UnIYxAKBFys@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres"
echo "   ERIX_API_KEY=$API_KEY"
echo "   NODE_ENV=production"
echo "   PORT=6399"
echo ""

# Step 7: Server Configuration
echo "🔧 Step 7: Update Server Configuration"
echo "--------------------------------------"
echo "After deployment, update your server's .env file:"
echo ""
echo "   cd ../server"
echo "   # Edit .env file:"
echo "   ERIX_STORE_URL=https://your-erix-store.onrender.com"
echo "   ERIX_API_KEY=$API_KEY"
echo "   ERIX_TENANT_ID=laie"
echo ""

# Step 8: Testing
echo "🧪 Step 8: Test Production Integration"
echo "--------------------------------------"
echo "After updating server config, test the integration:"
echo ""
echo "   cd ../server"
echo "   pnpm run test:session:quick"
echo ""

# Summary
echo "📋 Deployment Summary"
echo "====================="
echo "✅ API Key Generated: $API_KEY"
echo "✅ Build Tested: Successful"
echo "✅ Git Status: Ready"
echo ""
echo "🔗 Next Steps:"
echo "1. Deploy on Render (follow instructions above)"
echo "2. Update server .env with production URL"
echo "3. Test integration with production ERIX-Store"
echo ""
echo "📚 Documentation:"
echo "- Full guide: ./DEPLOY_TO_RENDER.md"
echo "- Production usage: ./PRODUCTION.md"
echo ""
echo "🎉 Ready for production deployment!"