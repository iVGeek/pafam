#!/bin/sh
# Drop root privileges for the app while still supporting platform-mounted
# volumes: make PTP_DATA_DIR writable by the unprivileged "node" user, then
# hand off. If the container is already started as non-root, just exec.
set -e

DATA_DIR="${PTP_DATA_DIR:-/var/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec gosu node "$@"
fi

exec "$@"
