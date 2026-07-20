#!/usr/bin/env sh
set -eu
cd /opt/dashbv
docker compose pull db caddy
docker compose build --pull api worker
docker compose up -d
docker compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
curl --fail --retry 10 --retry-delay 3 "https://${PUBLIC_API_HOST}/api/health"

