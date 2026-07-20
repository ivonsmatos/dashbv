#!/usr/bin/env sh
set -eu
cd /opt/dashbv
docker compose -f compose.yaml -f compose.server.yaml pull db
docker compose -f compose.yaml -f compose.server.yaml build --pull api worker
docker compose -f compose.yaml -f compose.server.yaml up -d db api worker
docker compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
curl --fail --retry 10 --retry-delay 3 "http://127.0.0.1:3006/api/health"
