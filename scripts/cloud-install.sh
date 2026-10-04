#!/usr/bin/env bash
# Install the dependencies of the repository, also in a Claude Code cloud session.
#
# In a cloud session, `pnpm install` fails on @vscode/ripgrep. Its install script asks the GitHub
# API for the release of the ripgrep binary, and the session lets only attached repositories use
# the GitHub API. The release file itself downloads without the API, and the install script uses
# a cached file first. So this script installs without the install scripts, puts the release file
# in that cache, and then runs the install scripts.
#
# Usage: scripts/cloud-install.sh   (use it instead of `pnpm install --frozen-lockfile`)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
# The repository needs Node 24. In a cloud session, this installs it when it is missing.
. scripts/cloud-node.sh

# The lockfile installs some packages, such as wa-sqlite, from the archive of a GitHub
# repository. A cloud session can download that archive only when the repository is attached to
# the session. Name the missing repositories before pnpm fails with a less clear error.
if [ "${CLAUDE_CODE_REMOTE:-}" = true ]; then
	missing=
	for url in $(grep -o 'tarball: https://codeload\.github\.com/[^,}]*' pnpm-lock.yaml |
		cut -d' ' -f2 | sort -u); do
		curl -fsI -o /dev/null "$url" || missing="$missing $(echo "$url" | cut -d/ -f4,5)"
	done
	if [ -n "$missing" ]; then
		echo "error: attach these repositories to the session:$missing" >&2
		exit 1
	fi
fi

pnpm install --frozen-lockfile --ignore-scripts

case "$(uname -s)-$(uname -m)" in
	Linux-x86_64) target=x86_64-unknown-linux-musl ;;
	Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl ;;
	*) target= ;;
esac

tmp=$(node -p 'require("os").tmpdir()')
for dir in node_modules/.pnpm/@vscode+ripgrep@*/node_modules/@vscode/ripgrep; do
	[ -n "$target" ] && [ -d "$dir" ] && [ ! -x "$dir/bin/rg" ] || continue
	# A failed install leaves an empty bin/ folder, and the install script then does nothing.
	[ -d "$dir/bin" ] && rmdir "$dir/bin" 2>/dev/null
	package_version=$(node -p "require('./$dir/package.json').version")
	version=$(sed -n "s/^const VERSION = '\(.*\)';$/\1/p" "$dir/lib/postinstall.js")
	[ -n "$version" ] || continue
	asset="ripgrep-$version-$target.tar.gz"
	echo "Downloading $asset for @vscode/ripgrep $package_version..."
	curl -fsSL -o "$tmp/$asset.partial" \
		"https://github.com/microsoft/ripgrep-prebuilt/releases/download/$version/$asset"
	# The install script looks in the cache below the temporary folder. pnpm gives each install
	# script its own temporary folder (node_modules/.tmp in the package), other tools use the
	# temporary folder of the system. Fill both.
	for cache in "$dir/node_modules/.tmp/vscode-ripgrep-cache-$package_version" \
		"$tmp/vscode-ripgrep-cache-$package_version"; do
		mkdir -p "$cache"
		cp "$tmp/$asset.partial" "$cache/$asset"
	done
	rm -f "$tmp/$asset.partial"
done

# Run the install scripts of the dependencies that the first step skipped, then the install
# scripts of the repository itself (for example, the Git hooks).
pnpm rebuild --pending
pnpm install --frozen-lockfile
