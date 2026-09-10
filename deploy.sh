#!/bin/bash
# ─── Build + push the erix-store image to GCR ─────────────────────────────────
# erix-store runs on the ECODrIx infra VM (docker-compose), NOT Cloud Run.
# This script only builds the image and pushes it to GCR as :latest (+ a
# timestamp tag). The VM then pulls it:
#
#   1. ./deploy.sh                       # here — build + push :latest to GCR
#   2. cd ../infra/vps && bash deploy.sh # on the VM — docker compose pull + up -d
#
# Prerequisites:
#   - gcloud CLI authenticated
#   - Docker running (Cloud Build submits the Dockerfile build remotely)
#
# NOTE: no secrets live here. The VM injects DATABASE_URL et al via
# infra/vps/jobs.env (which points at the cloudsql-proxy sidecar).
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_ID="project-e1433182-358c-4bdd-a34"
SERVICE_NAME="erix-store"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
TAG="$(date +%Y%m%d-%H%M%S)"

echo "🚀 Building ${SERVICE_NAME} image"
echo "   Project: ${PROJECT_ID}"
echo "   Tags:    ${IMAGE}:latest, ${IMAGE}:${TAG}"
echo ""

# ─── Build + push via Cloud Build (uses the local Dockerfile) ─────────────────
# Tag both :latest (what infra/vps/docker-compose.yml pulls) and an immutable
# timestamp tag (so a bad :latest can be rolled back to a known-good image).
gcloud builds submit \
  --project "${PROJECT_ID}" \
  --tag "${IMAGE}:latest" \
  .

# Cloud Build's --tag form pushes a single tag. Add the immutable timestamp
# tag on top of the image we just pushed, so rollbacks have a target.
gcloud container images add-tag --quiet \
  "${IMAGE}:latest" "${IMAGE}:${TAG}"

echo ""
echo "✅ Pushed ${IMAGE}:latest (also tagged ${TAG})"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Next: deploy to the infra VM"
echo "  cd ../infra/vps && bash deploy.sh"
echo ""
echo "Then verify:"
echo "  curl https://store.ecodrix.com/health"
echo ""
echo "Rollback (if needed): repoint :latest at a previous timestamp tag, e.g."
echo "  gcloud container images add-tag ${IMAGE}:<older-tag> ${IMAGE}:latest"
echo "  then re-run infra/vps/deploy.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
