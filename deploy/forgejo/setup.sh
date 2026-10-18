#!/usr/bin/env bash
# The first start of Forgejo. Starts the containers, makes the admin user with a random password,
# the organisation and the private repository for the workflows of n8n, and writes the root
# certificate of Caddy to forgejo-root.crt. You can run it again: it skips what exists, and asks
# for the admin password when the admin user exists. See README.md.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
require_env_file

DOMAIN=$(env_value FORGEJO_DOMAIN)
ADMIN_EMAIL=$(env_value FORGEJO_ADMIN_EMAIL)
ORG=$(env_value FORGEJO_ORG)
REPO=$(env_value FORGEJO_REPO)
ADMIN_USER=$(env_value FORGEJO_ADMIN_USERNAME)

docker compose up -d
wait_for_forgejo

new_password=""
if forgejo_users --admin | grep -x "$ADMIN_USER" >/dev/null; then
	echo "The admin user $ADMIN_USER exists."
	read_admin_credentials
else
	output=$(in_service forgejo forgejo admin user create --admin \
		--username "$ADMIN_USER" --email "$ADMIN_EMAIL" \
		--random-password --random-password-length 24 --must-change-password=false)
	new_password=$(printf '%s\n' "$output" | sed -n "s/^generated random password is '\(.*\)'$/\1/p")
	[ -n "$new_password" ] || fail "Could not read the password of the new admin user."
	ADMIN_PASSWORD=$new_password
	ADMIN_OTP=""
	echo "Made the admin user $ADMIN_USER."
fi

forgejo_api GET "/orgs/$ORG"
case $API_STATUS in
200) echo "The organisation $ORG exists." ;;
404)
	forgejo_api POST /orgs "{\"username\":\"$ORG\",\"visibility\":\"private\"}"
	[ "$API_STATUS" = 201 ] || fail "Could not make the organisation $ORG (HTTP $API_STATUS)."
	echo "Made the organisation $ORG."
	;;
401) fail "The password or the two-factor code of $ADMIN_USER is not correct." ;;
*) fail "Could not read the organisation $ORG (HTTP $API_STATUS)." ;;
esac

forgejo_api GET "/repos/$ORG/$REPO"
case $API_STATUS in
200) echo "The repository $ORG/$REPO exists." ;;
404)
	# The first commit makes the branch main, which the Git connections of n8n use as the base.
	forgejo_api POST "/orgs/$ORG/repos" \
		"{\"name\":\"$REPO\",\"private\":true,\"auto_init\":true,\"default_branch\":\"main\",\"description\":\"The workflows of n8n\"}"
	[ "$API_STATUS" = 201 ] || fail "Could not make the repository $ORG/$REPO (HTTP $API_STATUS)."
	echo "Made the repository $ORG/$REPO."
	;;
*) fail "Could not read the repository $ORG/$REPO (HTTP $API_STATUS)." ;;
esac

# Caddy makes its certificate authority when it issues the first certificate.
root=/data/caddy/pki/authorities/local/root.crt
for attempt in $(seq 1 30); do
	in_service caddy test -f "$root" && break
	sleep 2
done
in_service caddy cat "$root" >forgejo-root.crt ||
	fail "Caddy has no root certificate yet. See: docker compose logs caddy"

echo
echo "Forgejo is ready: https://$DOMAIN/"
echo "Repository: https://$DOMAIN/$ORG/$REPO.git"
echo "Root certificate for the n8n instances: $(pwd)/forgejo-root.crt"
if [ -n "$new_password" ]; then
	echo
	echo "Admin user: $ADMIN_USER"
	echo "Password:   $new_password"
	echo "The password shows only now. Save it in a password manager, then sign in and turn on"
	echo "two-factor authentication (see README.md)."
fi
echo
echo "Next: run ./add-n8n-instance.sh for each n8n instance."
