#!/usr/bin/env bash
# Build the Docker images of the fork. With --push, also push them to the registry.
#
# The script builds the two images that deploy/ runs, from this checkout:
#   - n8n, from docker/images/n8n/Dockerfile
#   - the task runners, from docker/images/runners/Dockerfile
# It uses the upstream Dockerfiles without changes. Each image gets two tags: the n8n version
# and the commit (for example 2.42.0-fb1b129d21), and latest. The upstream smoke test then checks
# the images.
#
# In a Claude Code cloud session, the script does two more things:
#   - The build steps download through the session proxy, and the proxy uses its own
#     certificate authority (CA). So the script builds from copies of the Dockerfiles that trust
#     this CA. The builder stages get the CA as a file. Each step of the last stage reads it from
#     a mount, so no layer of the image holds it.
#   - Docker Hub limits the pulls of anonymous users. When Docker Hub refuses a base image, the
#     script gets the same image from mirror.gcr.io, the Docker Hub mirror of Google.
#
# Usage: scripts/build-images.sh [--push]
#   --push  Log in with REGISTRY_USERNAME and REGISTRY_PASSWORD, then push the images.
#
# Environment:
#   IMAGE             the n8n image name (default ghcr.io/sreent/n8n)
#   RUNNERS_IMAGE     the runners image name (default ghcr.io/sreent/n8n-runners)
#   SESSION_CA        the CA bundle of a cloud session (default /root/.ccr/ca-bundle.crt)
#   BUILD_IMAGES_OUT  the folder for the logs (default /tmp/build-images)
set -euo pipefail

PUSH=
case "${1:-}" in
	--push) PUSH=1 ;;
	'') ;;
	*)
		echo "Usage: scripts/build-images.sh [--push]" >&2
		exit 2
		;;
esac

cd "$(git rev-parse --show-toplevel)"
# The repository needs Node 24. The cloud environment setup script installs it here.
[ -d /opt/node24/bin ] && export PATH="/opt/node24/bin:$PATH"

IMAGE=${IMAGE:-ghcr.io/sreent/n8n}
RUNNERS_IMAGE=${RUNNERS_IMAGE:-ghcr.io/sreent/n8n-runners}
# GitHub Container Registry links a package to the repository in this label.
SOURCE_URL=https://github.com/sreent/n8n
SESSION_CA=${SESSION_CA:-/root/.ccr/ca-bundle.crt}

COMMIT=$(git rev-parse --short=10 HEAD)
TAG=$(node -p "require('./packages/cli/package.json').version")-$COMMIT
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	# The tag names a commit, so a push needs a clean checkout.
	if [ -n "$PUSH" ]; then
		echo "error: commit or stash the changes before a push" >&2
		exit 1
	fi
	TAG=$TAG-dirty
fi
if [ -n "$PUSH" ] && { [ -z "${REGISTRY_USERNAME:-}" ] || [ -z "${REGISTRY_PASSWORD:-}" ]; }; then
	echo "error: --push needs REGISTRY_USERNAME and REGISTRY_PASSWORD in the environment" >&2
	exit 1
fi
if [ "${IMAGE%%/*}" != "${RUNNERS_IMAGE%%/*}" ]; then
	echo "error: IMAGE and RUNNERS_IMAGE must use the same registry" >&2
	exit 1
fi
if ! docker info >/dev/null 2>&1; then
	echo "error: Docker does not run. Start the Docker daemon first." >&2
	exit 1
fi

OUT=${BUILD_IMAGES_OUT:-/tmp/build-images}/$COMMIT
rm -rf "${OUT:?}" && mkdir -p "$OUT"

# Run a step with its output in $OUT/<name>.log. Stop with the end of the log when it fails.
# The step runs in a subshell with -e. Bash ignores -e in a function that runs as the condition
# of an if, so a command that fails in the middle of the function would go unnoticed.
step() {
	local name=$1 start=$SECONDS status
	shift
	echo "$name..."
	set +e
	(
		set -e
		"$@"
	) >"$OUT/$name.log" 2>&1
	status=$?
	set -e
	if [ "$status" -ne 0 ]; then
		echo "error: $name failed. The end of $OUT/$name.log:" >&2
		tail -n 40 "$OUT/$name.log" >&2
		exit 1
	fi
	echo "$name: done in $((SECONDS - start))s"
}

# ── Cloud session ────────────────────────────────────────────────────────────

SESSION=
BUILD_FLAGS=()
if [ -f "$SESSION_CA" ] && [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ]; then
	SESSION=1
	# A named build context with only the CA, so that the build sees no other session file.
	mkdir -p "$OUT/session-ca"
	cp "$SESSION_CA" "$OUT/session-ca/ca.crt"
	# The proxy listens on the loopback address of the host.
	BUILD_FLAGS+=(--network host --build-context session-ca="$OUT/session-ca")
	export HTTPS_PROXY=${HTTPS_PROXY:-$https_proxy} https_proxy=${https_proxy:-$HTTPS_PROXY}
	for name in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do
		# Without a value, docker build takes the value from the environment.
		if [ -n "${!name:-}" ]; then
			BUILD_FLAGS+=(--build-arg "$name")
		fi
	done
fi

# Write a copy of a Dockerfile that trusts the session CA (see the top of this file).
session_dockerfile() {
	awk '
		NR == FNR {
			if ($1 == "FROM") {
				total++
				for (i = 2; i < NF; i++) if (toupper($i) == "AS") stage[$(i + 1)] = 1
			}
			next
		}
		$1 == "FROM" {
			print
			if (++n < total) {
				print "COPY --from=session-ca ca.crt /usr/local/share/session-ca.crt"
				print "COPY --from=session-ca ca.crt /etc/ssl/certs/ca-certificates.crt"
				print "ENV SSL_CERT_FILE=/usr/local/share/session-ca.crt" \
					" NODE_EXTRA_CA_CERTS=/usr/local/share/session-ca.crt" \
					" PIP_CERT=/usr/local/share/session-ca.crt UV_NATIVE_TLS=1"
				next
			}
			for (i = 2; $i ~ /^--/; i++) {}
			if ($i in stage) {
				print "error: the last stage builds on the stage " $i ". It would get the CA." > "/dev/stderr"
				exit 1
			}
			last = 1
			next
		}
		last && $1 == "RUN" {
			if ($2 ~ /^(\[|--|<<)/) {
				print "error: unknown RUN form in the last stage: " $0 > "/dev/stderr"
				exit 1
			}
			sub(/^RUN[ \t]+/, "RUN --mount=type=bind,from=session-ca,source=ca.crt,target=/run/session-ca.crt" \
				" export SSL_CERT_FILE=/run/session-ca.crt NODE_EXTRA_CA_CERTS=/run/session-ca.crt" \
				" PIP_CERT=/run/session-ca.crt UV_NATIVE_TLS=1; ")
		}
		{ print }
	' "$1" "$1" >"$2"
}

# The base images of a Dockerfile, with the default values of the global ARGs.
base_images() {
	awk '
		$1 == "ARG" && !from && index($2, "=") {
			name = substr($2, 1, index($2, "=") - 1)
			value[name] = substr($2, index($2, "=") + 1)
		}
		$1 == "FROM" {
			from = 1
			for (i = 2; $i ~ /^--/; i++) {}
			image = $i
			for (name in value) gsub("\\$\\{" name "\\}", value[name], image)
			if (!(image in stage)) print image
			for (j = i + 1; j < NF; j++) if (toupper($j) == "AS") stage[$(j + 1)] = 1
		}
	' "$1"
}

# Docker Hub limits the pulls of anonymous users. When it refuses an image, get the same image
# from the Docker Hub mirror of Google, and give it the Docker Hub name. The build then uses
# the local image. A digest in the reference makes sure that it is the same image.
ensure_image() {
	local ref=$1 path name
	docker image inspect "$ref" >/dev/null 2>&1 && return 0
	docker pull --quiet "$ref" >/dev/null 2>&1 && return 0
	if [[ $ref == */* ]]; then
		case "${ref%%/*}" in
			*.* | *:* | localhost)
				echo "error: cannot pull $ref" >&2
				return 1
				;;
		esac
		path=$ref
	else
		path=library/$ref
	fi
	echo "Docker Hub refused $ref. Getting it from mirror.gcr.io."
	docker pull --quiet "mirror.gcr.io/$path" >/dev/null
	name=${ref%@*}
	[[ ${name##*/} == *:* ]] || name+=:mirror
	docker tag "mirror.gcr.io/$path" "$name"
}

# ── Build ────────────────────────────────────────────────────────────────────

N8N_DOCKERFILE=docker/images/n8n/Dockerfile
RUNNERS_DOCKERFILE=docker/images/runners/Dockerfile
echo "Building $IMAGE:$TAG and $RUNNERS_IMAGE:$TAG${SESSION:+ (cloud session)}. Logs: $OUT"

pull_base_images() {
	local ref
	for ref in $({ base_images "$N8N_DOCKERFILE" && base_images "$RUNNERS_DOCKERFILE"; } | sort -u); do
		ensure_image "$ref"
	done
}

build_image() {
	local dockerfile=$1 name=$2
	if [ -n "$SESSION" ]; then
		session_dockerfile "$dockerfile" "$OUT/$(basename "$(dirname "$dockerfile")").Dockerfile"
		dockerfile=$OUT/$(basename "$(dirname "$dockerfile")").Dockerfile
	fi
	# "stable" gives the normal n8n logo. Upstream builds that are not releases show a grey one.
	docker build --progress=plain "${BUILD_FLAGS[@]}" \
		--build-arg N8N_VERSION="$TAG" --build-arg N8N_RELEASE_TYPE=stable \
		--label org.opencontainers.image.source="$SOURCE_URL" \
		--label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
		-f "$dockerfile" -t "$name:$TAG" -t "$name:latest" .
}

# The images copy the app from compiled/ and dist/. A plain `pnpm install` fails in a cloud
# session, so install with scripts/cloud-install.sh first.
step install scripts/cloud-install.sh
step build-app pnpm build:n8n
step base-images pull_base_images
step build-n8n build_image "$N8N_DOCKERFILE" "$IMAGE"
step build-runners build_image "$RUNNERS_DOCKERFILE" "$RUNNERS_IMAGE"

# ── Check ────────────────────────────────────────────────────────────────────

SMOKE_RUNNERS=$RUNNERS_IMAGE:$TAG
if [ -n "$SESSION" ]; then
	# A smoke test adds a package to the runners image, and that download needs the session CA.
	# So it tests a copy of the image that also trusts the CA.
	SMOKE_RUNNERS=build-images-smoke/runners:$COMMIT
	step smoke-image docker build --progress=plain -t "$SMOKE_RUNNERS" \
		--build-context session-ca="$OUT/session-ca" - <<EOF
FROM $RUNNERS_IMAGE:$TAG
COPY --from=session-ca ca.crt /usr/local/share/session-ca.crt
ENV SSL_CERT_FILE=/usr/local/share/session-ca.crt
EOF
fi
# The cloud part of the smoke test reads the deployment of n8n Cloud. The fork has no access.
step smoke-test env SMOKE_IMAGE="$IMAGE:$TAG" SMOKE_RUNNERS_IMAGES="$SMOKE_RUNNERS" \
	SMOKE_SKIP_CLOUD=true node scripts/smoke-n8n-image.mjs
[ -z "$SESSION" ] || docker rmi "$SMOKE_RUNNERS" >/dev/null

# ── Push ─────────────────────────────────────────────────────────────────────

push_images() {
	local registry=${IMAGE%%/*} name
	printf '%s' "$REGISTRY_PASSWORD" |
		docker login "$registry" --username "$REGISTRY_USERNAME" --password-stdin
	# Remove the stored login also when a push fails.
	trap "docker logout '$registry'" EXIT
	for name in "$IMAGE" "$RUNNERS_IMAGE"; do
		docker push "$name:$TAG"
		docker push "$name:latest"
	done
}
[ -z "$PUSH" ] || step push push_images

echo
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' "$IMAGE:$TAG"
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' "$RUNNERS_IMAGE:$TAG"
echo "To run this version, set these values in the .env file of deploy/:"
echo "N8N_IMAGE=$IMAGE:$TAG"
echo "N8N_RUNNERS_IMAGE=$RUNNERS_IMAGE:$TAG"
if [ -z "$PUSH" ]; then
	echo "The images are only local. Run with --push to push them."
fi
