# Put Node 24 first on the PATH. The fork's scripts source this file from the repository root.
#
# The repository needs Node 24 and the pnpm version in package.json. A Claude Code cloud session
# starts with an older Node, so in a cloud session this file installs both in /opt/node24 when
# they are missing. Other computers keep their own Node: this file only uses /opt/node24 when it
# exists.
#
# Usage: . scripts/cloud-node.sh

NODE24_DIR=/opt/node24

# The steps use && because a caller can source this file where Bash ignores `set -e`.
install_node24() (
	case "$(uname -m)" in
		x86_64) arch=x64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*)
			echo "error: no Node 24 build for $(uname -m)" >&2
			exit 1
			;;
	esac
	url=https://nodejs.org/dist/latest-v24.x
	line=$(curl -fsSL "$url/SHASUMS256.txt" | grep " node-v24\.[0-9.]*-linux-$arch\.tar\.gz$") ||
		exit 1
	file=${line##* }
	echo "Installing ${file%.tar.gz} in $NODE24_DIR..."
	# Prepare a folder next to the target, then rename it. A failed install leaves no
	# $NODE24_DIR, so the next run tries again.
	stage=$(mktemp -d "$NODE24_DIR.XXXXXX") || exit 1
	if curl -fsSL -o "$stage/$file" "$url/$file" &&
		echo "${line%% *}  $stage/$file" | sha256sum --check --quiet &&
		tar -xzf "$stage/$file" -C "$stage" --strip-components=1 &&
		rm "$stage/$file" &&
		pnpm=$("$stage/bin/node" -p 'require("./package.json").packageManager') &&
		PATH="$stage/bin:$PATH" npm install --global --prefix "$stage" --no-fund --no-audit \
			--allow-scripts=pnpm "$pnpm" >/dev/null &&
		chmod 755 "$stage" &&
		mv -T "$stage" "$NODE24_DIR"; then
		exit 0
	fi
	rm -rf "$stage"
	echo "error: could not install Node 24 in $NODE24_DIR" >&2
	exit 1
)

if [ ! -d "$NODE24_DIR/bin" ] && [ "${CLAUDE_CODE_REMOTE:-}" = true ] &&
	[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 24 ]; then
	install_node24 || return 1
fi
if [ -d "$NODE24_DIR/bin" ]; then
	export PATH="$NODE24_DIR/bin:$PATH"
fi
