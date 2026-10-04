#!/usr/bin/env bash
# The enterprise code that the fork removed, as scripts/removed-enterprise-paths.txt lists it.
#
# Usage:
#   scripts/removed-enterprise.sh match           Read paths on stdin, and print the paths that
#                                                 are in a removed area.
#   scripts/removed-enterprise.sh check <commit>  The clean-room check. <commit> is the upstream
#                                                 commit that the fork matches.
#
# The check fails when:
#   - the fork adds or changes an enterprise file (a name with .ee. or a folder that ends in .ee),
#   - the fork deletes an enterprise file outside the removed areas (an upstream update would
#     bring it back without a note),
#   - a file of a removed area is in the tree.
# The check reads only file names. It never opens an enterprise file.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
LIST=scripts/removed-enterprise-paths.txt

match() {
	awk -v list="$LIST" '
		# A glob: ** matches any characters, * matches any characters except /.
		function glob_to_regex(glob, re) {
			re = glob
			gsub(/[.+?()|^$\[\]{}]/, "\\\\&", re)
			gsub(/\*\*\//, "\001", re)
			gsub(/\*\*/, "\002", re)
			gsub(/\*/, "[^/]*", re)
			gsub(/\001/, "(.*/)?", re)
			gsub(/\002/, ".*", re)
			return "^" re "$"
		}
		BEGIN {
			while ((getline line < list) > 0) {
				if (line ~ /^(#|[[:space:]]*$)/) continue
				paths[++n] = line
				if (index(line, "*")) regexes[n] = glob_to_regex(line)
			}
		}
		{
			for (i = 1; i <= n; i++) {
				p = paths[i]
				if (i in regexes) {
					if ($0 ~ regexes[i]) {
						print
						next
					}
				} else if ($0 == p || (substr(p, length(p)) == "/" && index($0, p) == 1)) {
					print
					next
				}
			}
		}'
}

check() {
	local base=$1 failed=0 changed outside present
	# --no-renames: a moved enterprise file shows as a deletion and an addition.
	changed=$(git diff --name-status --no-renames "$base" HEAD | awk -F'\t' '
		$2 ~ /\.ee(\.|\/)/ && $1 != "D" { print $1 "\t" $2 }')
	if [ -n "$changed" ]; then
		echo "The fork adds or changes enterprise files:"
		echo "$changed"
		failed=1
	fi
	outside=$(git diff --name-only --no-renames --diff-filter=D "$base" HEAD |
		grep -E '\.ee(\.|/)' | grep -vxF -f <(git diff --name-only --no-renames --diff-filter=D "$base" HEAD | match) || true)
	if [ -n "$outside" ]; then
		echo "The fork deletes enterprise files that $LIST does not list:"
		echo "$outside"
		failed=1
	fi
	present=$(git ls-files | match)
	if [ -n "$present" ]; then
		echo "These files are in areas that $LIST lists as removed:"
		echo "$present"
		failed=1
	fi
	return "$failed"
}

case "${1:-}" in
	match) match ;;
	check)
		[ -n "${2:-}" ] || {
			echo "Usage: $0 check <commit>" >&2
			exit 2
		}
		check "$2"
		;;
	*)
		echo "Usage: $0 match | check <commit>" >&2
		exit 2
		;;
esac
