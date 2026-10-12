#!/usr/bin/env bash
# Pull the latest code from GitHub and restart without downtime. Run on the VPS as the app user:
#   bash /opt/sec-wms/deploy/update.sh
set -euo pipefail
cd "${APP_DIR:-/opt/sec-wms}"
git fetch --prune origin
git reset --hard "origin/${BRANCH:-main}"
npm ci --omit=dev
npm run backup
pm2 reload ecosystem.config.cjs --update-env
pm2 save
echo "Updated to $(git rev-parse --short HEAD)"
