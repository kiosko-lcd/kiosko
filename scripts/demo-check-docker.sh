#!/usr/bin/env bash
# End-to-end check of the static browser demo (https://kioskolcd.dev/demo/)
# inside the official Playwright container: it clones this repo and the
# official plugins, puts your working-tree changes on top (uncommitted and
# new files too), builds the demo as the Pages workflow does, serves it under
# /demo/ and runs scripts/demo-check.mjs: Chromium gets every check, Firefox
# and WebKit a smoke test. Screenshots land in the out dir. Nothing is
# installed on the host.
#
#   scripts/demo-check-docker.sh [out dir] [demo-check.mjs options]
#     out dir       default: tmp/demo-check
#     --browsers    default: chromium,firefox,webkit
#     --measure     also compare main-thread long tasks, worker vs page
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
plugins="$(cd "$root/../kiosko-plugins" 2>/dev/null && pwd || true)"
dir="${1:-$root/tmp/demo-check}"
[ $# -gt 0 ] && shift
out="$(mkdir -p "$dir" && cd "$dir" && pwd)"
args=("$@")
[[ " ${args[*]-} " == *" --browsers "* ]] || args+=(--browsers chromium,firefox,webkit)
image=mcr.microsoft.com/playwright:v1.55.0-noble

docker run --rm \
  -v "$root:/src/kiosko:ro" \
  ${plugins:+-v "$plugins:/src/plugins:ro"} \
  -v "$out:/out" \
  "$image" bash -euo pipefail -c '
    # The editor asks for Inter; without it each machine falls back to its own font.
    apt-get update -qq >/dev/null && apt-get install -y -qq fonts-inter >/dev/null
    git config --global --add safe.directory "*"
    # A committed repo, then its working tree on top (tracked and untracked, not ignored).
    take() {
      git clone -q "$1" "$2"
      (cd "$1" && git ls-files -z -co --exclude-standard | tar --null --ignore-failed-read -cf - -T - 2>/dev/null) | tar -xf - -C "$2"
    }
    mkdir -p /w/kiosko-plugins && cd /w
    take /src/kiosko kiosko
    for d in /src/plugins/kiosko-plugin-*/; do [ -d "$d/.git" ] && take "$d" "kiosko-plugins/$(basename "$d")"; done
    cd kiosko
    npm install --no-audit --no-fund >/tmp/install.log 2>&1 || { tail -30 /tmp/install.log; exit 1; }
    npm run dev:link >/dev/null
    node packages/web/build.mjs --demo --out /w/site/demo
    mkdir -p /tmp/pw && cd /tmp/pw && npm install --no-audit --no-fund playwright@1.55.0 >/dev/null 2>&1
    node /w/kiosko/scripts/demo-check.mjs /w/site /out "$@"
  ' bash "${args[@]}"
