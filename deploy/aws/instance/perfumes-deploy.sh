#!/bin/bash
# Deploy the current main branch on the instance: fetch, rebuild, restart.
# Invoked over SSM by deploy/aws/update.js (or by hand as root).
set -euo pipefail

BRANCH="${1:-main}"
APP_DIR="/opt/perfumes"

cd "$APP_DIR"

git fetch --depth 1 origin "$BRANCH"
git reset --hard FETCH_HEAD

install -m 755 deploy/aws/instance/perfumes-refresh-env.sh /usr/local/bin/perfumes-refresh-env.sh
install -m 755 deploy/aws/instance/perfumes-deploy.sh      /usr/local/bin/perfumes-deploy.sh
install -m 755 deploy/aws/instance/perfumes-backup.sh      /usr/local/bin/perfumes-backup.sh
install -m 644 deploy/aws/instance/perfumes.service        /etc/systemd/system/perfumes.service
install -m 644 deploy/aws/instance/perfumes-backup.service /etc/systemd/system/perfumes-backup.service
install -m 644 deploy/aws/instance/perfumes-backup.timer   /etc/systemd/system/perfumes-backup.timer
systemctl daemon-reload

/usr/local/bin/perfumes-refresh-env.sh

echo "building image from $(git rev-parse --short HEAD)"
docker build -t perfumes:latest .

systemctl restart perfumes.service
docker image prune -f >/dev/null 2>&1 || true

for i in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1/api/auth/me >/dev/null 2>&1; then
    echo "app healthy after deploy ($(git rev-parse --short HEAD))"
    exit 0
  fi
  sleep 2
done

echo "FATAL: app did not become healthy; last container logs:" >&2
docker logs --tail 80 perfumes >&2 || true
exit 1
