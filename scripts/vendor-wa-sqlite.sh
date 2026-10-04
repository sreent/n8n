#!/usr/bin/env bash
# Store a wa-sqlite package in vendor/, and install wa-sqlite from it.
#
# Upstream n8n installs wa-sqlite from a commit of rhashimoto/wa-sqlite on GitHub. A Claude Code
# cloud session can download a GitHub archive only for a repository that is attached to the
# session. So the fork installs wa-sqlite from a package file in vendor/. This script fetches the
# commit with Git and packs it with `npm pack`, which gives the files that pnpm installs from the
# GitHub archive. The same commit and npm version give the same file, so a run that changes
# nothing in `git status` confirms the stored file.
#
# Usage: scripts/vendor-wa-sqlite.sh [commit]
#   commit  The full commit ID in rhashimoto/wa-sqlite. Default: the commit in the wa-sqlite
#           entry of the editor app's package.json. After an upstream update, that entry names
#           the new upstream commit.
set -euo pipefail

REPO_URL=https://github.com/rhashimoto/wa-sqlite.git
EDITOR_PACKAGE=packages/frontend/editor-ui/package.json

cd "$(git rev-parse --show-toplevel)"
# The repository needs Node 24. In a cloud session, this installs it when it is missing.
. scripts/cloud-node.sh

spec=$(sed -n 's/.*"wa-sqlite": "\([^"]*\)".*/\1/p' "$EDITOR_PACKAGE")
commit=${1:-$(echo "$spec" | grep -oE '[0-9a-f]{40}' || true)}
if ! [[ $commit =~ ^[0-9a-f]{40}$ ]]; then
	echo "error: give the full commit ID in rhashimoto/wa-sqlite" >&2
	exit 1
fi
file=vendor/wa-sqlite-$commit.tgz

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git init -q "$tmp/src"
git -C "$tmp/src" fetch -q --depth=1 "$REPO_URL" "$commit"
git -C "$tmp/src" checkout -q FETCH_HEAD
mkdir "$tmp/out"
(cd "$tmp/src" && npm pack --ignore-scripts --silent --pack-destination "$tmp/out" >/dev/null)

mkdir -p vendor
find vendor -maxdepth 1 -name 'wa-sqlite-*.tgz' ! -name "${file#vendor/}" -delete
mv "$tmp"/out/*.tgz "$file"
sed -i.bak -E "s#(\"wa-sqlite\": )\"[^\"]*\"#\1\"file:../../../$file\"#" "$EDITOR_PACKAGE"
rm "$EDITOR_PACKAGE.bak"
pnpm install --lockfile-only >/dev/null

echo "Stored $file. Run scripts/cloud-install.sh to install it."
