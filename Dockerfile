# Perfumes — production container image (runs unprivileged).
# Build:  docker build -t perfumes .
# Run:    docker run -p 8080:8080 -v perfumes-data:/var/data \
#           -e PTP_ADMIN_PASS=changeme perfumes
#
# The whole SQLite database plus uploads live under PTP_DATA_DIR (/var/data),
# so mount a volume there to keep data across restarts. The container opens as
# root only long enough to make that volume writable by the "node" user, then
# drops to it (docker-entrypoint.sh).
# See 04-hosting-hardening.md for the full hosting/security runbook.

FROM node:24-bookworm-slim

# Production defaults. The platform may override PORT; keep PTP_DATA_DIR in
# step with wherever the volume is mounted.
ENV NODE_ENV=production \
    PORT=8080 \
    PTP_DATA_DIR=/var/data \
    PTP_SECURE_COOKIES=1 \
    NPM_CONFIG_PRODUCTION=false

# gosu lets the entrypoint drop root -> node after fixing volume ownership.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, from the lockfile only. No dev deps, and the deprecated
# "production" npm config is turned off so npm prints no deprecation warning.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source (node_modules/.git/data/output are excluded — see
# .dockerignore). The sample supplier files under samples/ are kept: they are
# what the first boot imports when the database is empty.
COPY . .

# Fix ownership of the data dir and drop to the unprivileged "node" user.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /var/data

# Persistent storage is provided by the platform, not the image: mount a volume
# at /var/data (Railway rejects a Dockerfile VOLUME and uses Railway Volumes; on
# other hosts a bind mount or named volume works). Without one, PTP_DATA_DIR is
# ephemeral and the app re-seeds each start.
EXPOSE 8080

# Liveness: /api/auth/me is public and cheap. The start period is generous
# because the very first boot seeds the sample supplier lists (~10-15s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/auth/me').then((r)=>process.exit(r.ok?0:1)).catch(() => process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings", "server/index.js"]
