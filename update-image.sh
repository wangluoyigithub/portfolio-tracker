#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

docker compose exec -T portfolio python /app/backup.py
docker compose pull portfolio backup
docker compose up -d portfolio
docker compose ps
