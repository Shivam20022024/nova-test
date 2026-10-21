#!/bin/bash
set -e

echo "=================================================="
echo "Starting NovaTest Backend Service"
echo "PORT: ${PORT:-8080}"
echo "NODE_ENV: ${NODE_ENV:-production}"
echo "=================================================="

# Start Xvfb in the background if installed
if command -v Xvfb >/dev/null 2>&1; then
    echo "Starting virtual display Xvfb on :99..."
    Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
    export DISPLAY=:99
fi

echo "Executing: node dist/src/index.js"
exec node dist/src/index.js
