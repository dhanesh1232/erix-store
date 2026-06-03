#!/bin/bash
# ─── Deploy erix-store to Google Cloud Run ────────────────────────────────────
# One-command deploy: builds locally via Cloud Build and deploys to Cloud Run.
#
# Prerequisites:
#   - gcloud CLI authenticated
#   - Project set: gcloud config set project project-e1433182-358c-4bdd-a34
#
# Usage:
#   chmod +x deploy-cloudrun.sh
#   ./deploy-cloudrun.sh
# ──────────────────────────────────────────────────────────────────────────────

set -e

PROJECT_ID="project-e1433182-358c-4bdd-a34"
SERVICE_NAME="erix-store"
REGION="us-central1"
PORT="6399"

# ─── Environment variables for the service ────────────────────────────────────
DATABASE_URL="postgresql://postgres.bnchmgyybdsklxrumcnd:gZn79UnIYxAKBFys@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres"

echo "🚀 Deploying erix-store to Cloud Run"
echo "   Project:  $PROJECT_ID"
echo "   Service:  $SERVICE_NAME"
echo "   Region:   $REGION"
echo ""

# ─── Step 1: Build and push via Cloud Build ───────────────────────────────────
echo "📦 Building container image via Cloud Build..."
gcloud builds submit \
  --project "$PROJECT_ID" \
  --tag "gcr.io/$PROJECT_ID/$SERVICE_NAME:latest" \
  .

echo ""
echo "✅ Image built and pushed"

# ─── Step 2: Deploy to Cloud Run ─────────────────────────────────────────────
echo ""
echo "🌐 Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "gcr.io/$PROJECT_ID/$SERVICE_NAME:latest" \
  --platform managed \
  --memory 1Gi \
  --cpu 1 \
  --timeout 300 \
  --concurrency 80 \
  --max-instances 1 \
  --min-instances 1 \
  --port "$PORT" \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --set-env-vars "NODE_ENV=production,DATABASE_URL=$DATABASE_URL"

echo ""
echo "✅ erix-store deployed to Cloud Run!"
echo ""

# ─── Step 3: Get the service URL ─────────────────────────────────────────────
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format="value(status.url)")

echo "🔗 Service URL: $SERVICE_URL"
echo ""

# ─── Step 4: Health check ────────────────────────────────────────────────────
echo "🏥 Running health check..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$SERVICE_URL/health")
if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Health check passed (HTTP $HTTP_CODE)"
else
  echo "⚠️  Health check returned HTTP $HTTP_CODE (may need a moment to start)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Map your custom domain (api.erix.ecodrix.com):"
echo "   gcloud run domain-mappings create \\"
echo "     --service $SERVICE_NAME \\"
echo "     --domain api.erix.ecodrix.com \\"
echo "     --region $REGION \\"
echo "     --project $PROJECT_ID"
echo ""
echo "2. OR update ecodrix-api to use the Cloud Run URL directly:"
echo "   gcloud run services update ecodrix-api \\"
echo "     --region $REGION \\"
echo "     --project $PROJECT_ID \\"
echo "     --update-env-vars \"ERIX_STORE_URL=$SERVICE_URL\""
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
