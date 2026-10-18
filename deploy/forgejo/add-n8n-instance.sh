#!/usr/bin/env bash
# Gives one n8n instance access to the repository of the workflows, and prints a new access token
# for it.
#
#   ./add-n8n-instance.sh <user name> <read|write>
#
# A development instance pushes to the repository, so it needs write. A production instance only
# pulls, so it needs read. The script makes a restricted user for the instance, which never signs
# in to the web interface. Run the script again to replace the token: it deletes the old tokens of
# the user. It asks for the password of the admin user. See README.md.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
require_env_file

[ $# -eq 2 ] || fail "Usage: $0 <user name> <read|write>"
NAME=$1
ACCESS=$2
[[ $NAME =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] ||
	fail "The user name must have 3 to 40 lowercase letters, digits and hyphens, for example n8n-prod."
case $ACCESS in
read | write) ;;
*) fail "Usage: $0 <user name> <read|write>" ;;
esac

DOMAIN=$(env_value FORGEJO_DOMAIN)
ORG=$(env_value FORGEJO_ORG)
REPO=$(env_value FORGEJO_REPO)

wait_for_forgejo
read_admin_credentials

forgejo_api GET "/repos/$ORG/$REPO"
case $API_STATUS in
200) ;;
401) fail "The password or the two-factor code of $ADMIN_USER is not correct." ;;
404) fail "The repository $ORG/$REPO does not exist. Run ./setup.sh first." ;;
*) fail "Could not read the repository $ORG/$REPO (HTTP $API_STATUS)." ;;
esac

if forgejo_users | grep -x "$NAME" >/dev/null; then
	# The script deletes the tokens of the user, so it changes only the users that it made.
	forgejo_api GET "/users/$NAME"
	[ "$API_STATUS" = 200 ] || fail "Could not read the user $NAME (HTTP $API_STATUS)."
	[ "$(printf '%s' "$API_BODY" | json_field restricted)" = True ] ||
		fail "The user $NAME is not a restricted user of an n8n instance. Use another name."
	echo "The user $NAME exists."
else
	# The random password is not shown: the user signs in with its token only.
	in_service forgejo forgejo admin user create --username "$NAME" \
		--email "$NAME@users.forgejo.invalid" --random-password --random-password-length 32 \
		--must-change-password=false --restricted >/dev/null
	echo "Made the user $NAME."
fi

forgejo_api PUT "/repos/$ORG/$REPO/collaborators/$NAME" "{\"permission\":\"$ACCESS\"}"
[ "$API_STATUS" = 204 ] || fail "Could not give $NAME $ACCESS access to $ORG/$REPO (HTTP $API_STATUS)."
echo "$NAME has $ACCESS access to $ORG/$REPO."

forgejo_api GET "/users/$NAME/tokens" "" "$NAME"
[ "$API_STATUS" = 200 ] || fail "Could not read the tokens of $NAME (HTTP $API_STATUS)."
for id in $(printf '%s' "$API_BODY" | json_list_field id); do
	forgejo_api DELETE "/users/$NAME/tokens/$id" "" "$NAME"
	[ "$API_STATUS" = 204 ] || fail "Could not delete an old token of $NAME (HTTP $API_STATUS)."
	echo "Deleted an old token of $NAME."
done

forgejo_api POST "/users/$NAME/tokens" \
	"{\"name\":\"n8n-$(date -u +%Y%m%dT%H%M%SZ)\",\"scopes\":[\"$ACCESS:repository\"]}" "$NAME"
[ "$API_STATUS" = 201 ] || fail "Could not make a token for $NAME (HTTP $API_STATUS)."
token=$(printf '%s' "$API_BODY" | json_field sha1)

echo
echo "Enter these values in n8n (see \"Connect n8n\" in README.md):"
echo "  Repository URL: https://$DOMAIN/$ORG/$REPO.git"
echo "  User name:      $NAME"
echo "  Token:          $token"
echo "The token shows only now. It can $ACCESS the repository $ORG/$REPO and nothing else."
