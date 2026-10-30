#!/bin/bash
# Daily backup: consistent SQLite snapshot + uploads tarball to S3.
# Run by perfumes-backup.timer; also safe to run by hand as root.
set -euo pipefail

if [ -f /etc/perfumes/backup.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/perfumes/backup.env
  set +a
fi

BUCKET="${PTP_BACKUP_BUCKET:?PTP_BACKUP_BUCKET not set}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="/var/data/backups"

if ! docker inspect -f '{{.State.Running}}' perfumes 2>/dev/null | grep -q true; then
  echo "FATAL: perfumes container is not running" >&2
  exit 1
fi

mkdir -p "$DIR"

# VACUUM INTO produces a single consistent file even while the app is writing.
docker exec perfumes node --no-warnings scripts/backup-db.js "/var/data/backups/ptp-$TS.db"
chown 1000:1000 "$DIR/ptp-$TS.db"

aws s3 cp "$DIR/ptp-$TS.db" "s3://$BUCKET/backups/ptp-$TS.db" --only-show-errors --region "${AWS_REGION:-us-east-1}"
echo "uploaded s3://$BUCKET/backups/ptp-$TS.db"

if [ -d /var/data/uploads ] && [ -n "$(ls -A /var/data/uploads 2>/dev/null)" ]; then
  tar -czf "/tmp/uploads-$TS.tar.gz" -C /var/data/uploads .
  aws s3 cp "/tmp/uploads-$TS.tar.gz" "s3://$BUCKET/backups/uploads-$TS.tar.gz" --only-show-errors --region "${AWS_REGION:-us-east-1}"
  rm -f "/tmp/uploads-$TS.tar.gz"
  echo "uploaded s3://$BUCKET/backups/uploads-$TS.tar.gz"
fi

# Keep a week on disk; S3 lifecycle handles the long-term retention.
find "$DIR" -maxdepth 1 -type f -name 'ptp-*.db' -mtime +7 -delete
