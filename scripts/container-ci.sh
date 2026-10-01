#!/bin/bash
# Container CI for the sreent/n8n fork.
#
# GitHub Actions is off in this fork, so cloud sessions run these checks instead. They
# follow the upstream "CI: Pull Requests" workflow for the packages that changed since
# the base branch. The end-to-end and database tests are not part of it yet.
#
# Usage: scripts/container-ci.sh [base-ref]    (default base: origin/master)
#
# The script writes one log for each step, and summary.txt, to
# $CONTAINER_CI_OUT/<commit> (default /tmp/container-ci). It exits non-zero when a
# step fails.
set -u

BASE=${1:-origin/master}
cd "$(git rev-parse --show-toplevel)" || exit 1
# The repository needs Node 24. The cloud environment setup script installs it here.
[ -d /opt/node24/bin ] && export PATH="/opt/node24/bin:$PATH"

SHA=$(git rev-parse --short HEAD)
OUT=${CONTAINER_CI_OUT:-/tmp/container-ci}/$SHA
rm -rf "$OUT" && mkdir -p "$OUT"
TURBO=./node_modules/.bin/turbo
CHANGED=(--filter="[$BASE]")
FAILED=0

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

echo "commit $SHA base $BASE" | tee "$OUT/summary.txt"

# Fork rule: no change to enterprise (.ee.) files.
step clean-room bash -c "! git diff --name-only '$BASE'...HEAD | grep -E '\.ee(\.|/)'"
step install pnpm install --frozen-lockfile
# The editor app and its type check use up to 8 GB of memory, so they run one at a time.
step build "$TURBO" run build --filter='n8n...' --concurrency=1
step format "$TURBO" run format:check "${CHANGED[@]}" --only --continue
step typecheck "$TURBO" run typecheck "${CHANGED[@]}" --only --continue --concurrency=1
step lint "$TURBO" run lint "${CHANGED[@]}" --only --continue --concurrency=2
step lint-styles "$TURBO" run lint:styles "${CHANGED[@]}" --only --continue --concurrency=2
step unit-tests "$TURBO" run test "${CHANGED[@]}" --only --continue --concurrency=1
# Integration tests of the fork modules. They use SQLite and a local Git repository.
step integration-tests bash -c \
	"cd packages/cli && pnpm test:integration src/modules/git-sync src/modules/send-copy"

if [ "$FAILED" -eq 0 ]; then
	echo "result PASS" | tee -a "$OUT/summary.txt"
else
	echo "result FAIL (logs: $OUT)" | tee -a "$OUT/summary.txt"
fi
exit "$FAILED"
