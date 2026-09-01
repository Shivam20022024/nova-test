FROM node:22-slim

WORKDIR /app

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Install Node dependencies
RUN npm install

# Install Playwright browsers. `chrome` channel is pulled too so anti-bot
# "stealth" mode can use the real Chrome build instead of bundled Chromium.
RUN npx playwright install --with-deps chromium firefox webkit \
    && (npx playwright install chrome || echo "chrome channel unavailable on this base image - stealth mode will fall back to Chromium")

COPY . .

# Generate Prisma Client
RUN npx prisma generate

EXPOSE 3000
EXPOSE 5000
EXPOSE 8080

# xvfb-run provides a virtual display so anti-bot "headful"/"stealth" mode works
# in a container. Headless runs ignore it (negligible overhead).
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", "npx", "ts-node", "--transpile-only", "src/index.ts"]
