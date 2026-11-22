#!/usr/bin/env bash
# Regenerates main/font.h in Docker (Pillow and DejaVu fonts in a throwaway container).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
docker run --rm -i --network host -e DEBIAN_FRONTEND=noninteractive python:3.12-slim sh -c \
  '(apt-get -qq update && apt-get -qq install -y fonts-dejavu-core) </dev/null >/dev/null 2>&1 && pip -q install pillow >/dev/null 2>&1 && python -I /dev/stdin' \
  < tools/gen_font.py > main/font.h.new
mv main/font.h.new main/font.h
