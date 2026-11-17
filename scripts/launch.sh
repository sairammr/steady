#!/usr/bin/env bash
# Launch STEADY as its own macOS app so macOS attributes camera access to Electron.app.
# Started from a terminal multiplexer (tmux etc.) the camera can silently deliver no frames.
# Usage: scripts/launch.sh [app|spike]
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-app}"
npm run -s build
mkdir -p logs
LOG="logs/$MODE-$(date +%Y%m%d-%H%M%S).log"
open -n -W -a "$PWD/node_modules/electron/dist/Electron.app" \
  --stdout "$PWD/$LOG" --stderr "$PWD/$LOG" \
  --env STEADY_MODE="$MODE" --env SMARTSPECTRA_DIAGNOSTICS="${SMARTSPECTRA_DIAGNOSTICS:-0}" \
  --args "$PWD"
echo "log: $LOG"
