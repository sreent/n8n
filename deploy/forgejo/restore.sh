#!/usr/bin/env bash
# Restores a backup of backup.sh. It replaces all data of Forgejo with the backup: the
# repositories, the users, the tokens and app.ini with the secret key.
#
#   ./restore.sh backups/forgejo-<time>.tar.gz
#   ./restore.sh gs://my-backups/forgejo/forgejo-<time>.tar.gz
#
# See README.md.
set -euo pipefail
cd "$(dirname "$0")"
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
umask 077
. ./lib.sh
require_env_file

[ $# -eq 1 ] || fail "Usage: $0 <backup file or gs:// URL>"
file=$1
if [[ $file == gs://* ]]; then
	mkdir -p backups
	gcloud storage cp --quiet "$file" "backups/$(basename "$file")"
	file="backups/$(basename "$file")"
fi
[ -f "$file" ] || fail "There is no file $file."
tar -tzf "$file" ./custom/conf/app.ini >/dev/null 2>&1 || fail "$file is not a backup of backup.sh."

read -rp "This replaces all data of Forgejo with $file. Type yes to continue: " answer
[ "$answer" = yes ] || fail "Nothing changed."

archive="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
docker compose stop forgejo >/dev/null
docker compose run --rm --no-deps --user 0:0 --entrypoint sh -v "$archive:/restore.tar.gz:ro" \
	forgejo -c 'find /var/lib/gitea -mindepth 1 -delete &&
		tar -xzf /restore.tar.gz -C /var/lib/gitea &&
		chown -R 1000:1000 /var/lib/gitea' </dev/null ||
	fail "The restore failed and Forgejo is stopped. Correct the error, then run the script again."
docker compose up -d >/dev/null
wait_for_forgejo
echo "Restored $file."
