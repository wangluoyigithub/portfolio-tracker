#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

docker compose run --rm backup
git pull --ff-only
docker compose up -d --build
docker compose ps
