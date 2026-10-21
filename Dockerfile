# Production image for Render (NovaTest API + test worker).
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# ffmpeg compresses the run recordings; xvfb gives headful/stealth mode a virtual display (headless ignores it).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend-node dependencies
COPY backend-node/package*.json ./
RUN npm ci

# Copy backend-node source and build
COPY backend-node/ .
RUN npm run build

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
# Render injects PORT (default 10000); the app reads it. 8080 is only the local default.
EXPOSE 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
