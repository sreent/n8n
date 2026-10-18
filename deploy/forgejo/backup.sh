#!/usr/bin/env bash
# Backs up Forgejo. Stops Forgejo for a few seconds, packs its whole data volume (the
# repositories, the database and app.ini with the secret key) into
# backups/forgejo-<time>.tar.gz, and starts Forgejo again. A stopped Forgejo gives a consistent
# copy of its database. Deletes local backups that are older than KEEP_DAYS (default 14).
#
# When BACKUP_BUCKET in .env names a bucket, the script also copies the backup to Cloud Storage
# with the service account of the VM. See README.md.
set -euo pipefail
cd "$(dirname "$0")"
# cron gives a short PATH. The Google Cloud CLI of Ubuntu images is in /snap/bin.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
umask 077
. ./lib.sh
require_env_file

KEEP_DAYS=${KEEP_DAYS:-14}
bucket=$(env_value BACKUP_BUCKET)
mkdir -p backups
name="forgejo-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"

trap 'rm -f "backups/$name.partial"; docker compose start forgejo >/dev/null' EXIT
docker compose stop forgejo >/dev/null
# The backup has the secret key of Forgejo, so only root can read it.
docker compose run --rm --no-deps --user 0:0 --entrypoint sh -v "$PWD/backups:/backups" \
	forgejo -c 'umask 077 && tar czf "$1" -C /var/lib/gitea .' sh "/backups/$name.partial" </dev/null
mv "backups/$name.partial" "backups/$name"
docker compose start forgejo >/dev/null
trap - EXIT

if [ -n "$bucket" ]; then
	bucket=gs://${bucket#gs://}
	# The VM cannot delete objects in the bucket, so the upload must not use temporary parts.
	CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False \
		gcloud storage cp --quiet "backups/$name" "${bucket%/}/$name"
	echo "Copied to ${bucket%/}/$name"
fi

find backups -name 'forgejo-*.tar.gz' -type f -mtime "+$KEEP_DAYS" -delete
echo "Backup: backups/$name"
