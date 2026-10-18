# Helpers of the scripts in this folder. The scripts source this file. Do not run it.

fail() {
	echo "$*" >&2
	exit 1
}

# A value of .env. The script reads the file as text and does not run it.
env_value() {
	local value
	value=$(sed -n "s/^$1=//p" .env | tail -n 1)
	value=${value%\"}
	value=${value#\"}
	printf '%s' "$value"
}

require_env_file() {
	[ -f .env ] || fail "Copy .env.example to .env and set the values first."
}

# Runs a command in the container of a service, with no input. Without </dev/null, docker
# compose exec reads the input of the script, and a prompt after it gets nothing.
in_service() {
	docker compose exec -T "$@" </dev/null
}

# Waits until Forgejo answers its health check, for up to two minutes.
wait_for_forgejo() {
	local attempt
	for attempt in $(seq 1 60); do
		if in_service forgejo curl -fsS http://localhost:3000/api/healthz >/dev/null 2>&1; then
			return 0
		fi
		sleep 2
	done
	fail "Forgejo did not start. See: docker compose logs forgejo"
}

# The names of the users of Forgejo, one on each line. --admin gives only the admin users.
forgejo_users() {
	in_service forgejo forgejo admin user list "$@" | awk 'NR > 1 { print $2 }'
}

# A value in double quotes for a curl configuration file.
curl_quote() {
	local value=$1
	value=${value//\\/\\\\}
	value=${value//\"/\\\"}
	printf '"%s"' "$value"
}

# Calls the API of Forgejo in the container as the admin user (ADMIN_USER, ADMIN_PASSWORD and
# ADMIN_OTP). curl reads the password and the body from standard input, so they are not on a
# command line. Sets API_STATUS and API_BODY. Call it directly, not in $(...), which would lose
# them. With a fourth argument, the call acts as that user (the Sudo header of the API).
forgejo_api() {
	local method=$1 path=$2 body=${3:-} sudo_user=${4:-} answer
	answer=$(
		{
			printf 'user = %s\n' "$(curl_quote "$ADMIN_USER:$ADMIN_PASSWORD")"
			if [ -n "${ADMIN_OTP:-}" ]; then
				printf 'header = %s\n' "$(curl_quote "X-Forgejo-OTP: $ADMIN_OTP")"
			fi
			if [ -n "$sudo_user" ]; then
				printf 'header = %s\n' "$(curl_quote "Sudo: $sudo_user")"
			fi
			if [ -n "$body" ]; then
				printf 'header = "Content-Type: application/json"\n'
				printf 'data = %s\n' "$(curl_quote "$body")"
			fi
		} | docker compose exec -T forgejo curl -sS --config - -X "$method" -w '\n%{http_code}' \
			"http://localhost:3000/api/v1$path"
	)
	API_STATUS=${answer##*$'\n'}
	API_BODY=${answer%$'\n'*}
}

# Reads the password and the two-factor code of the admin user at the prompt. FORGEJO_ADMIN_PASSWORD
# and FORGEJO_ADMIN_OTP in the environment replace the prompt.
read_admin_credentials() {
	ADMIN_USER=$(env_value FORGEJO_ADMIN_USERNAME)
	if [ -n "${FORGEJO_ADMIN_PASSWORD:-}" ]; then
		ADMIN_PASSWORD=$FORGEJO_ADMIN_PASSWORD
		ADMIN_OTP=${FORGEJO_ADMIN_OTP:-}
		return
	fi
	read -rsp "Password of the Forgejo user $ADMIN_USER: " ADMIN_PASSWORD ||
		fail "Could not read the password."
	echo
	read -rp "Two-factor code of $ADMIN_USER (empty if it has none): " ADMIN_OTP || true
}

# A field of the JSON object on standard input.
json_field() {
	python3 -I -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

# A field of each object in the JSON list on standard input, one on each line.
json_list_field() {
	python3 -I -c 'import json, sys; [print(item[sys.argv[1]]) for item in json.load(sys.stdin)]' "$1"
}
