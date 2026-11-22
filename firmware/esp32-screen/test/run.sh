#!/usr/bin/env bash
# Builds test_proto.c with main/ks_proto.c against ESP-IDF's mbedTLS, on the host
# architecture, inside the firmware's Docker image, and runs it.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
IMAGE="kiosko-esp32-idf:$(sha256sum Dockerfile | cut -c1-12)"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build --network host -t "$IMAGE" .
tar c main/ks_proto.c main/ks_proto.h test/test_proto.c test/vectors.h |
  docker run --rm -i --entrypoint "" "$IMAGE" sh -c '
    set -e; mkdir -p /t && cd /t && tar x
    M=$IDF_PATH/components/mbedtls/mbedtls
    gcc -O1 -I$M/include -I$M/library -o test_proto test/test_proto.c main/ks_proto.c $M/library/*.c
    ./test_proto'
