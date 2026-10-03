#!/usr/bin/env bash
# Restore a backup from backup.sh. This replaces all n8n data on this server.
#
# Usage: ./restore.sh [--yes] <backup file>
#
# .env must hold the N8N_ENCRYPTION_KEY of the server that made the backup. With a different
# key, n8n cannot read the credentials.
set -euo pipefail
cd "$(dirname "$0")"

confirm=true
if [ "${1:-}" = --yes ]; then
	confirm=false
	shift
fi
file=${1:?Usage: ./restore.sh [--yes] <backup file>}
[ -f "$file" ] || {
	echo "error: $file does not exist." >&2
	exit 1
}

if $confirm; then
	read -r -p "This replaces all n8n data on this server with $file. Type yes to continue: " answer
	[ "$answer" = yes ] || {
		echo "Canceled."
		exit 1
	}
fi

# Stop n8n, so that nothing writes to the database during the restore.
docker compose stop n8n
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore --username=n8n --dbname=n8n --clean --if-exists --no-owner <"$file"
docker compose up -d
echo "Restored $file. n8n is starting."
