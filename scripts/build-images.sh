#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

echo "[build] tp/back-client:latest"
docker build -t tp/back-client:latest apps/back-client

echo "[build] tp/back-admin:latest"
docker build -t tp/back-admin:latest apps/back-admin

echo "[build] tp/front:latest"
docker build -t tp/front:latest apps/front

echo "Build termine."
