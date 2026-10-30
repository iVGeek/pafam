#!/bin/bash
# One-time host preparation for the Perfumes EC2 origin.
#
# Invoked by CloudFormation user data after the repo is cloned to /opt/perfumes.
# It is safe to re-run: the data volume is found by its ext4 label, swap is only
# created once, and the systemd units are overwritten from the repo each time.
#
# Inputs (environment):
#   PTP_ENV_PARAM      SSM SecureString name with the container env file
#   PTP_BACKUP_BUCKET  S3 bucket for off-instance backups
#   PTP_DATA_MOUNT     mount point of the data volume (default /var/data)
set -euo pipefail

ENV_PARAM="${PTP_ENV_PARAM:-/perfumes/env}"
BACKUP_BUCKET="${PTP_BACKUP_BUCKET:-}"
DATA_MOUNT="${PTP_DATA_MOUNT:-/var/data}"
AWS_REGION_NAME="${AWS_REGION:-us-east-1}"
APP_DIR="/opt/perfumes"
LOG="/var/log/perfumes-bootstrap.log"

[ -n "$BACKUP_BUCKET" ] || { echo "FATAL: PTP_BACKUP_BUCKET is empty"; exit 1; }

mkdir -p /etc/perfumes
exec > >(tee -a "$LOG") 2>&1
echo "== perfumes bootstrap $(date -u +%Y-%m-%dT%H:%M:%SZ) =="

# --- AWS CLI (SSM parameter + S3 uploads) -----------------------------------
if ! command -v aws >/dev/null 2>&1; then
  dnf install -y awscli-2
fi

# --- SSM agent (preinstalled on AL2023, but do not rely on it) --------------
if ! systemctl is-enabled amazon-ssm-agent >/dev/null 2>&1; then
  dnf install -y amazon-ssm-agent
  systemctl enable --now amazon-ssm-agent
fi

# --- 2 GB swap: the t3.micro has 1 GB RAM and must run a docker build -------
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- find, format (once) and mount the data volume --------------------------
DEV="$(blkid -L perfumes-data || true)"
if [ -z "$DEV" ]; then
  ROOT_SRC="$(findmnt -no SOURCE /)"
  ROOT_DISK="$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null | head -n 1 || true)"
  [ -n "$ROOT_DISK" ] || ROOT_DISK="$(basename "$ROOT_SRC")"
  for candidate in /dev/nvme1n1 /dev/xvdf /dev/sdf /dev/nvme2n1; do
    [ -b "$candidate" ] || continue
    [ "$(basename "$candidate")" = "$ROOT_DISK" ] && continue
    if ! blkid "$candidate" >/dev/null 2>&1; then
      DEV="$candidate"
      echo "formatting $DEV as ext4 label perfumes-data"
      mkfs.ext4 -L perfumes-data -m 0 "$DEV"
      break
    fi
  done
fi
[ -n "$DEV" ] || { echo "FATAL: no blank data volume found"; exit 1; }

mkdir -p "$DATA_MOUNT"
grep -q 'LABEL=perfumes-data' /etc/fstab || \
  echo "LABEL=perfumes-data $DATA_MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q "$DATA_MOUNT" || mount "$DATA_MOUNT"
chown 1000:1000 "$DATA_MOUNT"
mkdir -p "$DATA_MOUNT/backups" "$DATA_MOUNT/uploads"
chown 1000:1000 "$DATA_MOUNT/backups" "$DATA_MOUNT/uploads"
echo "data volume $DEV mounted at $DATA_MOUNT"

# --- install host scripts and systemd units from the repo -------------------
install -m 755 "$APP_DIR/deploy/aws/instance/perfumes-refresh-env.sh" /usr/local/bin/perfumes-refresh-env.sh
install -m 755 "$APP_DIR/deploy/aws/instance/perfumes-deploy.sh"      /usr/local/bin/perfumes-deploy.sh
install -m 755 "$APP_DIR/deploy/aws/instance/perfumes-backup.sh"      /usr/local/bin/perfumes-backup.sh
install -m 644 "$APP_DIR/deploy/aws/instance/perfumes.service"              /etc/systemd/system/perfumes.service
install -m 644 "$APP_DIR/deploy/aws/instance/perfumes-backup.service"       /etc/systemd/system/perfumes-backup.service
install -m 644 "$APP_DIR/deploy/aws/instance/perfumes-backup.timer"         /etc/systemd/system/perfumes-backup.timer

cat > /etc/perfumes/app.env <<EOF
PTP_ENV_PARAM=$ENV_PARAM
PTP_DATA_MOUNT=$DATA_MOUNT
AWS_REGION=$AWS_REGION_NAME
EOF

cat > /etc/perfumes/backup.env <<EOF
PTP_BACKUP_BUCKET=$BACKUP_BUCKET
AWS_REGION=$AWS_REGION_NAME
EOF
chmod 600 /etc/perfumes/app.env /etc/perfumes/backup.env

systemctl daemon-reload

# --- runtime env from SSM, then build and start -----------------------------
/usr/local/bin/perfumes-refresh-env.sh

cd "$APP_DIR"
docker build -t perfumes:latest .

systemctl enable perfumes.service
systemctl restart perfumes.service
systemctl enable --now perfumes-backup.timer

echo "== bootstrap complete =="
