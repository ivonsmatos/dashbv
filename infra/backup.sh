#!/usr/bin/env sh
set -eu
cd /opt/dashbv
set -a
. ./.env
set +a
backup_dir=/opt/dashbv/backups
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
target="$backup_dir/dashbv-$(date +%Y%m%d-%H%M%S).dump"
docker compose -f compose.yaml -f compose.server.yaml exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "$target"
chmod 600 "$target"
find "$backup_dir" -type f -name 'dashbv-*.dump' -mtime +14 -delete
echo "$target"
