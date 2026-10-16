# Perfumes — production container image.
# Build:  docker build -t perfumes .
# Run:    docker run -p 8080:8080 -v perfumes-data:/var/data perfumes
#
# The whole SQLite database plus uploads live under PTP_DATA_DIR (/var/data),
# so mount a volume there to keep data across restarts.
# See 04-hosting-hardening.md for the full hosting/security runbook.

FROM node:24-bookworm-slim

# Production defaults. The platform may override PORT; keep PTP_DATA_DIR in
# step with wherever the volume is mounted.
ENV NODE_ENV=production \
    PORT=8080 \
    PTP_DATA_DIR=/var/data \
    PTP_SECURE_COOKIES=1 \
    NPM_CONFIG_PRODUCTION=false

WORKDIR /app

# Dependencies first, from the lockfile only. No dev deps, and the deprecated
# "production" npm config is turned off so npm prints no deprecation warning.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source (node_modules/.git/data/output are excluded — see
# .dockerignore). The sample supplier files under samples/ are kept: they are
# what the first boot imports when the database is empty.
COPY . .

# Data directory for the SQLite file and uploads. Run as root so a bind-mounted
# volume at /var/data is writable on any platform; for a hardened non-root
# deploy, uncomment the USER line and chown the volume to uid/gid 1000.
RUN mkdir -p /var/data
VOLUME ["/var/data"]
# USER node

EXPOSE 8080

# Liveness: /api/auth/me is public and cheap. The start period is generous
# because the very first boot seeds the sample supplier lists (~10-15s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/auth/me').then((r)=>process.exit(r.ok?0:1)).catch(() => process.exit(1))"

# Run node directly (not via npm) so startup is quiet and signal-friendly.
CMD ["node", "--no-warnings", "server/index.js"]
