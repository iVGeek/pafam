#!/bin/bash
# Refresh /opt/perfumes/.env from the SSM SecureString.
#
# Runs as systemd ExecStartPre on every app start and on every deploy, so a
# secret rotation only needs `aws ssm put-parameter --overwrite` followed by a
# restart. If SSM is temporarily unreachable an existing .env is kept.
set -euo pipefail

if [ -f /etc/perfumes/app.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/perfumes/app.env
  set +a
fi

PARAM="${PTP_ENV_PARAM:-/perfumes/env}"
DEST="/opt/perfumes/.env"

if ! command -v aws >/dev/null 2>&1; then
  if [ -s "$DEST" ]; then echo "aws CLI missing; keeping existing $DEST"; exit 0; fi
  echo "FATAL: aws CLI missing and no existing $DEST" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if aws ssm get-parameter --name "$PARAM" --with-decryption \
     --region "${AWS_REGION:-us-east-1}" \
     --query Parameter.Value --output text >"$TMP" 2>/dev/null; then
  if [ ! -s "$TMP" ]; then
    echo "FATAL: SSM parameter $PARAM is empty" >&2
    exit 1
  fi
  grep -q '^PORT=' "$TMP"               || printf 'PORT=8080\n' >> "$TMP"
  grep -q '^PTP_DATA_DIR=' "$TMP"       || printf 'PTP_DATA_DIR=/var/data\n' >> "$TMP"
  grep -q '^PTP_SECURE_COOKIES=' "$TMP" || printf 'PTP_SECURE_COOKIES=1\n' >> "$TMP"
  install -m 600 "$TMP" "$DEST"
  echo "env refreshed from $PARAM"
elif [ -s "$DEST" ]; then
  echo "WARN: could not read $PARAM; keeping existing $DEST" >&2
else
  echo "FATAL: cannot read $PARAM and no existing $DEST" >&2
  exit 1
fi
