#!/usr/bin/env bash
# Regenerates the README screenshots (docs/img/*.jpg) inside the official
# Playwright container: it clones this repo and the official plugins as
# committed, starts Kiosko with the showcase config in demo mode (sample
# data, nothing read from your machine) and takes the shots. Nothing is
# installed on the host.
#
#   scripts/screenshots-docker.sh [out dir]      (default: docs/img)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
plugins="$(cd "$root/../kiosko-plugins" 2>/dev/null && pwd || true)"
out="$(mkdir -p "${1:-$root/docs/img}" && cd "${1:-$root/docs/img}" && pwd)"
image=mcr.microsoft.com/playwright:v1.55.0-noble

docker run --rm \
  -v "$root:/src/kiosko:ro" \
  ${plugins:+-v "$plugins:/src/plugins:ro"} \
  -v "$out:/out" \
  "$image" bash -euo pipefail -c '
    # The editor asks for Inter; without it each machine falls back to its own font.
    apt-get update -qq >/dev/null && apt-get install -y -qq fonts-inter >/dev/null
    git config --global --add safe.directory "*"
    mkdir -p /w/kiosko-plugins && cd /w
    git clone -q /src/kiosko kiosko
    cp /src/kiosko/scripts/screenshots.mjs kiosko/scripts/
    for d in /src/plugins/kiosko-plugin-*/; do [ -d "$d/.git" ] && git clone -q "$d" "kiosko-plugins/$(basename "$d")"; done
    cd kiosko
    npm install --no-audit --no-fund >/tmp/install.log 2>&1 || { tail -30 /tmp/install.log; exit 1; }
    npm run dev:link >/dev/null
    npm run web:build >/dev/null
    export KIOSKO_HOME=/tmp/kiosko-home
    node --conditions=source packages/server/src/cli.ts start --config examples/showcase.json --demo --port 7420 >/tmp/server.log 2>&1 &
    for i in $(seq 60); do curl -sf http://127.0.0.1:7420/api/state >/dev/null && break; sleep 1; done
    mkdir -p /tmp/pw && cd /tmp/pw && npm install --no-audit --no-fund playwright@1.55.0 >/dev/null 2>&1
    node /w/kiosko/scripts/screenshots.mjs http://127.0.0.1:7420 /out || { tail -30 /tmp/server.log; exit 1; }
  '
