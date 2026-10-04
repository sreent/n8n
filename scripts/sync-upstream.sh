#!/usr/bin/env bash
# Update the sreent/n8n fork to a newer version of n8n-io/n8n.
#
# The fork does not share Git history with n8n-io/n8n. It started as a copy of one upstream
# commit, and scripts/sync-upstream.base holds the upstream commit that the fork matches now.
# This script merges the upstream changes since that commit into the current branch. It is a
# three-way merge with the recorded commit as the merge base, so the fork keeps its own
# changes. The fork gets no upstream history, and the base file changes in the same commit.
#
# Usage:
#   scripts/sync-upstream.sh [--no-commit] [upstream-ref]   Start an update (default ref: master)
#   scripts/sync-upstream.sh --continue                     Commit after you resolve conflicts
#   scripts/sync-upstream.sh --abort                        Cancel the update and discard its changes
#
#   upstream-ref   A branch, a tag such as n8n@2.43.0, or a commit ID of n8n-io/n8n.
#   --no-commit    Stage the result, but do not commit it.
#
# The target must contain the current base, so the script does not go back in history.
# Without conflicts, the script makes one commit. With conflicts, it stops as `git merge` does:
# resolve the files that `git status` shows, add them, then run the script with --continue.
# After the commit, run scripts/container-ci.sh --fork, and open a pull request.
set -euo pipefail

UPSTREAM_URL=${UPSTREAM_URL:-https://github.com/n8n-io/n8n.git}
BASE_FILE=scripts/sync-upstream.base
LOCKFILE=pnpm-lock.yaml
EDITOR_PACKAGE=packages/frontend/editor-ui/package.json

ACTION=start
COMMIT=true
case "${1:-}" in
	--continue | --abort)
		ACTION=${1#--}
		shift
		;;
	--no-commit)
		COMMIT=false
		shift
		;;
esac
REF=${1:-master}

fail() {
	echo "error: $*" >&2
	exit 1
}

# macOS has Bash 3 in /bin/bash. Install a newer Bash, for example with Homebrew.
[ "${BASH_VERSINFO[0]}" -ge 4 ] || fail "Bash 4 or later is necessary."
cd "$(git rev-parse --show-toplevel)"
# The repository needs Node 24. In a cloud session, this installs it when it is missing.
. scripts/cloud-node.sh
MSG_FILE="$(git rev-parse --git-dir)/SYNC_UPSTREAM_MSG"

# pnpm writes the lockfile. Let it add the fork's packages to the merged lockfile.
refresh_lockfile() {
	echo "Updating $LOCKFILE..."
	pnpm install --lockfile-only >/dev/null
	git add "$LOCKFILE"
}

# The pre-commit hooks that lefthook.yml skips on a merge, as a comma-separated list.
merge_skipped_hooks() {
	awk '/^[^[:space:]#][^:]*:/ { inside = ($0 ~ /^pre-commit:/) }
		inside && /^    [A-Za-z0-9_-]+:[[:space:]]*$/ { hook = $1; sub(/:$/, "", hook) }
		inside && hook != "" && /^[[:space:]]+- merge[[:space:]]*$/ { print hook }' lefthook.yml |
		sort -u | paste -sd, -
}

commit_sync() {
	# This commit merges upstream work, so commit it as lefthook treats a merge: skip the hooks
	# that lefthook.yml skips on a merge. Upstream CI has already checked these files, and some
	# of these hooks need tools or packages that are not installed yet (actionlint, tbls or
	# Docker, packages that upstream moved).
	local skipped
	skipped=$(merge_skipped_hooks)
	export LEFTHOOK_EXCLUDE="${LEFTHOOK_EXCLUDE:+$LEFTHOOK_EXCLUDE,}$skipped"
	git commit --quiet -F "$MSG_FILE"
	rm -f "$MSG_FILE"
	echo "Committed: $(git log --oneline -1)"
	echo "Next: run scripts/container-ci.sh --fork, which installs the new dependencies first."
	echo "Then push and open a pull request."
}

if [ "$ACTION" = continue ]; then
	[ -f "$MSG_FILE" ] || fail "No upstream update is in progress."
	[ -z "$(git diff --name-only --diff-filter=U)" ] || fail "Resolve and add all files with conflicts first."
	refresh_lockfile
	commit_sync
	exit 0
fi
if [ "$ACTION" = abort ]; then
	[ -f "$MSG_FILE" ] || fail "No upstream update is in progress."
	# The update started from a clean work tree, so this discards only the update.
	git reset --quiet --hard HEAD
	rm -f "$MSG_FILE"
	echo "The upstream update is canceled."
	exit 0
fi

# `git merge-tree --merge-base` needs Git 2.40 or later.
version=$(git version | grep -oE '[0-9]+\.[0-9]+' | head -1)
[ "$(printf '%s\n' 2.40 "$version" | sort -V | head -1)" = 2.40 ] ||
	fail "Git 2.40 or later is necessary. This is Git $version."
git symbolic-ref -q HEAD >/dev/null || fail "Check out a branch first."
[ -z "$(git status --porcelain)" ] || fail "The work tree has changes. Commit or stash them first."

OLD=$(tr -d '[:space:]' <"$BASE_FILE")
[[ $OLD =~ ^[0-9a-f]{40}$ ]] || fail "$BASE_FILE must hold one full commit ID."

echo "Fetching the base ${OLD:0:10} and $REF from $UPSTREAM_URL..."
git fetch --quiet --no-tags --depth=1 "$UPSTREAM_URL" "$OLD"
git fetch --quiet --no-tags --depth=1 "$UPSTREAM_URL" "$REF"
NEW=$(git rev-parse 'FETCH_HEAD^{commit}')
if [ "$NEW" = "$OLD" ]; then
	echo "The fork already matches $REF (${NEW:0:10})."
	exit 0
fi

# A target that does not contain the base would revert upstream changes. Fetch the upstream
# history since a week before the base, so that Git can do this check. Git reads a number of
# this size as seconds since 1970.
since=$(($(git show -s --format=%ct "$OLD") - 7 * 24 * 3600))
git fetch --quiet --no-tags --shallow-since="$since" "$UPSTREAM_URL" "$NEW"
git merge-base --is-ancestor "$OLD" "$NEW" ||
	fail "$REF (${NEW:0:10}) does not contain the current base ${OLD:0:10}. Use a newer upstream version."

echo "Merging the upstream changes from ${OLD:0:10} to ${NEW:0:10}..."
result=$(mktemp)
trap 'rm -f "$result"' EXIT
status=0
git merge-tree --write-tree -z --no-messages --merge-base="$OLD" HEAD "$NEW" >"$result" || status=$?
[ "$status" -le 1 ] || fail "git merge-tree failed."

# The output is the merged tree, then one "<mode> <object> <stage>\t<path>" entry for each side
# of each conflict. A NUL character ends each field.
tree=
conflicts=()
while IFS= read -r -d '' field; do
	if [ -z "$tree" ]; then
		tree=$field
	elif [ -n "$field" ]; then
		conflicts+=("$field")
	fi
done <"$result"

# Move the index and the work tree to the merged tree. HEAD does not move.
git read-tree -m -u HEAD "$tree"
printf '%s\n' "$NEW" >"$BASE_FILE"
git add "$BASE_FILE"

# Name the branch or tag in the title. For a commit ID, the short ID is enough.
if [[ $REF =~ ^[0-9a-f]{7,40}$ ]]; then
	target=${NEW:0:10}
else
	target="$REF (${NEW:0:10})"
fi
cat >"$MSG_FILE" <<EOF
chore: Update n8n to $target

Merge the n8n-io/n8n changes from ${OLD:0:10} to ${NEW:0:10} into the fork.
scripts/sync-upstream.sh prepared this commit.

Upstream changes: ${UPSTREAM_URL%.git}/compare/$OLD...$NEW
EOF

paths=()
if [ "${#conflicts[@]}" -gt 0 ]; then
	mapfile -t paths < <(printf '%s\n' "${conflicts[@]}" | cut -f2- | sort -u)
	# Put the conflicts in the index as `git merge` does: remove the merged entry, then add one
	# entry for each side (stage 1 is the base, 2 is the fork, 3 is upstream).
	{
		for path in "${paths[@]}"; do
			printf '0 0000000000000000000000000000000000000000\t%s\0' "$path"
		done
		printf '%s\0' "${conflicts[@]}"
	} | git update-index -z --index-info
fi

# Whether a path with conflicts matches the extended regex $1.
conflicted() {
	local path
	for path in "${paths[@]}"; do
		[[ $path =~ ^($1)$ ]] && return 0
	done
	return 1
}

# pnpm writes the lockfile, and a text merge can keep stale entries: for example, a link to a
# workspace package that upstream moved. So always start from the upstream lockfile, and let
# pnpm add the fork's packages, now or after the package.json conflicts (--continue).
git show "$NEW:$LOCKFILE" >"$LOCKFILE"
git add "$LOCKFILE"
if conflicted 'pnpm-lock\.yaml'; then
	mapfile -t paths < <(printf '%s\n' "${paths[@]}" | grep -vxF "$LOCKFILE")
fi
conflicted '(.*/)?package\.json' || refresh_lockfile

if grep -q 'github:rhashimoto/wa-sqlite' "$EDITOR_PACKAGE" 2>/dev/null; then
	echo "note: upstream changed the wa-sqlite commit in $EDITOR_PACKAGE. Keep the"
	echo "      upstream line, then run scripts/vendor-wa-sqlite.sh to store that commit in vendor/."
fi

if [ "${#paths[@]}" -gt 0 ]; then
	echo
	echo "These files have conflicts:"
	printf '  %s\n' "${paths[@]}"
	echo "Resolve them and add them, then run: scripts/sync-upstream.sh --continue"
	exit 1
fi

if $COMMIT; then
	commit_sync
else
	echo "The result is staged. To commit it, run: scripts/sync-upstream.sh --continue"
fi
