#!/bin/bash
# Container CI for the sreent/n8n fork.
#
# GitHub Actions is off in this fork, so cloud sessions run these checks instead. They
# follow the upstream "CI: Pull Requests" workflow for the packages that changed since
# the base branch, and they select tests the way upstream CI does: n8n's
# `janitor test-scoped` runner runs only the tests whose imports reach a changed file
# (`vitest related`), and runs a full suite when a config file or package.json changed.
#
# Modes:
#   (default)  Test the packages that the change touches. Quick enough for every push.
#   --full     Also test the packages that depend on them, as upstream CI does. Use it
#              before a merge.
#   --fork     Test all the fork's own changes: everything that differs from the upstream
#              commit in scripts/sync-upstream.base. Use it after scripts/sync-upstream.sh.
#              Upstream CI has already tested the upstream changes.
#   --plan     Print the packages and the test scope of each step. Run nothing.
#
# Usage: scripts/container-ci.sh [--full | --fork | --plan] [base-ref]   (default base: origin/master)
#
# The script writes one log for each step, and summary.txt, to
# $CONTAINER_CI_OUT/<commit> (default /tmp/container-ci). It exits non-zero when a
# step fails. The end-to-end and database tests are not part of it yet.
set -u

MODE=quick
case "${1:-}" in
	--full | --fork | --plan)
		MODE=${1#--}
		shift
		;;
esac
BASE=${1:-origin/master}
UPSTREAM_URL=https://github.com/n8n-io/n8n.git

cd "$(git rev-parse --show-toplevel)" || exit 1
# The repository needs Node 24. In a cloud session, this installs it when it is missing.
. scripts/cloud-node.sh || exit 1
# In a cloud session, NODE_EXTRA_CA_CERTS holds the CA of the egress gateway. Turbo runs tasks in
# strict environment mode and drops that variable, but it passes NODE_OPTIONS, and the system
# store has the same CA. Without the CA, each start of an n8n command in the tests waits about 3
# seconds for its TLS connection to PostHog, and the command tests time out.
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && node --use-system-ca -e '' 2>/dev/null; then
	export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-system-ca"
fi
TURBO=./node_modules/.bin/turbo
JANITOR=packages/cli/node_modules/.bin/janitor
# The change analysis below needs turbo and the janitor runner. A plain `pnpm install` fails in a
# new cloud session, so install with scripts/cloud-install.sh.
[ -x "$TURBO" ] && [ -x "$JANITOR" ] || scripts/cloud-install.sh >/dev/null || exit 1

# ── What changed ─────────────────────────────────────────────────────────────

# The upstream commit that the fork matches. The fork mode and the clean-room check
# compare with it, so fetch it when it is missing. One commit is enough.
UPSTREAM_BASE=$(tr -d '[:space:]' <scripts/sync-upstream.base)
git cat-file -e "$UPSTREAM_BASE^{commit}" 2>/dev/null ||
	git fetch --quiet --no-tags --depth=1 "$UPSTREAM_URL" "$UPSTREAM_BASE" || exit 1

# Turbo reads the lockfile to find the packages whose dependencies changed.
packages_for() {
	"$TURBO" ls ${1:+--filter="$1"} --output=json 2>/dev/null |
		jq -r '.packages.items[] | "\(.name) \(.path)"'
}

if [ "$MODE" = fork ]; then
	# The fork shares no history with upstream, so compare the two trees. A file belongs
	# to the package with the longest path that contains it.
	FORK_FILES=$(git diff --name-only "$UPSTREAM_BASE" HEAD)
	CHANGED_PACKAGES=$(
		packages_for | awk '{ print length($2), $0 }' | sort -rn | cut -d' ' -f2- |
			awk 'NR == FNR { files[$0] = 1; next }
				{ hit = 0; for (f in files) if (files[f] && index(f, $2 "/") == 1) { files[f] = 0; hit = 1 } }
				hit { print }' <(printf '%s\n' "$FORK_FILES") -
	)
	TESTED_PACKAGES=$CHANGED_PACKAGES
	CHANGED_FILES=$(grep -vx 'pnpm-lock.yaml' <<<"$FORK_FILES")
else
	CHANGED_PACKAGES=$(packages_for "[$BASE]")
	if [ -z "$CHANGED_PACKAGES" ] && git diff --name-only "$BASE"...HEAD | grep -q '^packages/'; then
		echo "error: packages changed, but turbo reports none. Is $BASE fetched?" >&2
		exit 1
	fi
	if [ "$MODE" = full ]; then
		TESTED_PACKAGES=$(packages_for "...[$BASE]")
	else
		TESTED_PACKAGES=$CHANGED_PACKAGES
	fi

	# The test runner reads CHANGED_FILES. For it, a lockfile change means "run every
	# suite". Turbo already knows which packages the lockfile change touches, so name
	# their package.json instead. That makes the runner run the full suite of those
	# packages only.
	CHANGED_FILES=$(git diff --name-only "$BASE"...HEAD | grep -vx 'pnpm-lock.yaml')
	if git diff --name-only "$BASE"...HEAD | grep -qx 'pnpm-lock.yaml'; then
		while read -r _ path; do
			[ -n "$path" ] || continue
			awk -v prefix="$path/" 'index($0, prefix) == 1 { found = 1 } END { exit !found }' \
				<<<"$CHANGED_FILES" || CHANGED_FILES+=$'\n'"$path/package.json"
		done <<<"$CHANGED_PACKAGES"
	fi
fi
export CHANGED_FILES

tested() { grep -q "^$1 " <<<"$TESTED_PACKAGES"; }
# Filter flags for the tested packages that match a path pattern (an extended regex).
filters_for_paths() {
	awk -v pattern="$1" '$2 ~ pattern { printf "--filter=%s\n", $1 }' <<<"$TESTED_PACKAGES"
}
FRONTEND_PATHS='^packages/(frontend/|modules/[^/]+/frontend$)'
mapfile -t FRONTEND_FILTERS < <(filters_for_paths "$FRONTEND_PATHS")
# Other backend packages are small, so they run their full unit suites.
mapfile -t BACKEND_FILTERS < <(
	awk -v pattern="$FRONTEND_PATHS" 'NF && $2 !~ pattern' <<<"$TESTED_PACKAGES" |
		grep -vE '^(n8n|n8n-nodes-base) ' | awk '{ printf "--filter=%s\n", $1 }'
)
mapfile -t TESTED_FILTERS < <(awk 'NF { printf "--filter=%s\n", $1 }' <<<"$TESTED_PACKAGES")
# The module registry loads a backend module by name, so the import graph cannot link
# a module's files to its integration tests. A changed module runs all of them.
mapfile -t CHANGED_MODULES < <(
	grep -oE '^packages/cli/src/modules/[^/]+/' <<<"$CHANGED_FILES" | sort -u | sed 's#^packages/cli/##'
)
# Test files that the CI leaves out, for example enterprise tests that the owner chose not to run
# on the fork code. They become vitest --exclude paths of packages/cli, the only package that the
# list supports for now.
SKIPPED_TESTS_FILE=scripts/container-ci-skipped-tests.txt
mapfile -t SKIPPED_TESTS < <(grep -vE '^[[:space:]]*(#|$)' "$SKIPPED_TESTS_FILE")
CLI_SKIP_ARGS=()
for path in "${SKIPPED_TESTS[@]}"; do
	case "$path" in
		packages/cli/*) CLI_SKIP_ARGS+=("--exclude=${path#packages/cli/}") ;;
		*)
			echo "error: $SKIPPED_TESTS_FILE: only packages/cli files are supported: $path" >&2
			exit 1
			;;
	esac
done
# The integration tests run with 2 workers. With more, a large selection times out on the
# 4 CPUs of a cloud session.
INTEGRATION_ARGS=(--maxWorkers=2 "${CLI_SKIP_ARGS[@]}")

if [ "$MODE" = plan ]; then
	echo "Mode: quick (default). Base: $BASE"
	echo "Changed packages:"
	awk 'NF { print "  " $1 }' <<<"$CHANGED_PACKAGES"
	echo "Unit tests:"
	while read -r name path; do
		[ -n "$path" ] || continue
		if jq -e '.scripts["test:changed"] // .scripts["test:unit:changed"]' "$path/package.json" >/dev/null; then
			scope=$(cd "$path" && "$OLDPWD/$JANITOR" scope 2>/dev/null)
			case "$scope" in
				RUN_FULL) scope="full suite" ;;
				SKIP) scope="no tests" ;;
				*) scope="tests that import the $(wc -w <<<"$scope") changed files" ;;
			esac
			echo "  $name: $scope"
		elif jq -e '.scripts["test:unit"]' "$path/package.json" >/dev/null; then
			echo "  $name: full unit suite (small package)"
		else
			echo "  $name: no tests"
		fi
	done <<<"$CHANGED_PACKAGES"
	echo "Backend modules with all their tests: ${CHANGED_MODULES[*]:-none}"
	grep -q '^deploy/' <<<"$CHANGED_FILES" && echo "The Node.js tests of deploy/"
	echo "Integration tests: 2 workers"
	echo "Skipped test files ($SKIPPED_TESTS_FILE):"
	printf '  %s\n' "${SKIPPED_TESTS[@]:-none}"
	echo "Steps: unit-backend ${BACKEND_FILTERS[*]#--filter=}"
	echo "       unit-frontend ${FRONTEND_FILTERS[*]#--filter=}"
	echo "With --full, these packages are tested too:"
	packages_for "...[$BASE]" | awk '{ print $1 }' | grep -vxF -f <(awk '{ print $1 }' <<<"$CHANGED_PACKAGES") |
		sed 's/^/  /'
	exit 0
fi

# ── Checks ───────────────────────────────────────────────────────────────────

SHA=$(git rev-parse --short HEAD)
OUT=${CONTAINER_CI_OUT:-/tmp/container-ci}/$SHA
rm -rf "$OUT" && mkdir -p "$OUT"
FAILED=0
# The test setup of the CLI makes a folder with a database in n8n-tests for each test file, and
# nothing removes it. In one cloud session, repeated runs fill the disk, so remove the old folders.
rm -rf "${TMPDIR:-/tmp}/n8n-tests"

step() {
	local name=$1
	shift
	local start
	start=$(date +%s)
	"$@" >"$OUT/$name.log" 2>&1
	local code=$?
	[ "$code" -ne 0 ] && FAILED=1
	echo "$name exit=$code time=$(($(date +%s) - start))s" | tee -a "$OUT/summary.txt"
}

if [ "$MODE" = fork ]; then
	COMPARED="upstream ${UPSTREAM_BASE:0:10}"
else
	COMPARED=$BASE
fi
echo "commit $SHA base $COMPARED mode $MODE" | tee "$OUT/summary.txt"

# Fork rule: the fork adds and changes no enterprise (.ee.) file. It only deletes the areas that
# scripts/removed-enterprise-paths.txt lists. Compare the whole fork with the upstream commit
# that it matches, so that an upstream update still passes.
step clean-room scripts/removed-enterprise.sh check "$UPSTREAM_BASE"
# The permission data of @n8n/permissions must be what scripts/permission-snapshot.mjs makes from
# the recorded snapshot of a running n8n.
step permission-data node scripts/permission-snapshot.mjs generate \
	packages/@n8n/permissions/permission-snapshot.json --check
step install scripts/cloud-install.sh
# The editor app and its type check use up to 8 GB of memory, so they run one at a time.
step build "$TURBO" run build --filter='n8n...' --concurrency=1
# Without a filter, turbo would check every package, so skip the checks when none changed.
if [ "${#TESTED_FILTERS[@]}" -gt 0 ]; then
	step format "$TURBO" run format:check "${TESTED_FILTERS[@]}" --only --continue
	# With --only, turbo leaves the dependency tasks out of the task hash. A cached result can then
	# come from a run with other code in a dependency. So the steps that read the code of other
	# packages use --force, which does not read the cache.
	step typecheck "$TURBO" run typecheck "${TESTED_FILTERS[@]}" --only --force --continue --concurrency=1
	# One lint at a time: the type-aware lints of cli and of the editor need about 11 GB and 8 GB,
	# and together they run out of the memory of a cloud session.
	step lint "$TURBO" run lint "${TESTED_FILTERS[@]}" --only --force --continue --concurrency=1
	step lint-styles "$TURBO" run lint:styles "${TESTED_FILTERS[@]}" --only --continue --concurrency=2
fi

if [ "${#BACKEND_FILTERS[@]}" -gt 0 ]; then
	step unit-backend "$TURBO" run test:unit "${BACKEND_FILTERS[@]}" --only --force --continue --concurrency=2
fi
if tested n8n; then
	step unit-cli "$TURBO" run test:unit:changed --filter=n8n --only -- "${CLI_SKIP_ARGS[@]}"
	step integration-cli "$TURBO" run test:integration:changed --filter=n8n --only -- "${INTEGRATION_ARGS[@]}"
fi
if [ "${#CHANGED_MODULES[@]}" -gt 0 ]; then
	step module-tests bash -c "cd packages/cli && pnpm test:integration ${CHANGED_MODULES[*]} --passWithNoTests ${INTEGRATION_ARGS[*]}"
fi
if tested n8n-nodes-base; then
	step unit-nodes "$TURBO" run test:changed --filter=n8n-nodes-base --only
fi
if [ "${#FRONTEND_FILTERS[@]}" -gt 0 ]; then
	step unit-frontend "$TURBO" run test:changed "${FRONTEND_FILTERS[@]}" --only --continue --concurrency=1
fi
# deploy/ is not a package of the workspace. Its tests need only Node.js. The tests of the Helm chart
# skip without helm, and the Terraform tests run by hand (see the READMEs of deploy/).
if grep -q '^deploy/' <<<"$CHANGED_FILES"; then
	step deploy node --test deploy/*.test.mjs deploy/*/*.test.mjs
fi

if [ "$FAILED" -eq 0 ]; then
	echo "result PASS" | tee -a "$OUT/summary.txt"
else
	echo "result FAIL (logs: $OUT)" | tee -a "$OUT/summary.txt"
fi
exit "$FAILED"
