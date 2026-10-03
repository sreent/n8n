#!/usr/bin/env bash
# Back up the n8n database to backups/. The database holds all n8n data: workflows,
# credentials, executions, and the files from workflows.
#
# Run it every night from cron, for example:  0 3 * * * /opt/n8n/backup.sh
# Then copy the backups to storage outside this server.
set -euo pipefail
cd "$(dirname "$0")"

KEEP_DAYS=${KEEP_DAYS:-14}
mkdir -p backups
file="backups/n8n-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f "$file.partial"' EXIT

# The custom format is compressed, and restore.sh reads it.
docker compose exec -T postgres pg_dump --username=n8n --dbname=n8n --format=custom >"$file.partial"
mv "$file.partial" "$file"

find backups -name 'n8n-*.dump' -type f -mtime "+$KEEP_DAYS" -delete
echo "Backup: $file"
