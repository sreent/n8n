#!/usr/bin/env bash
# The map of the fork, as scripts/fork-map.txt lists it. FORK-MAP.md describes the map.
#
# Usage:
#   scripts/fork-map.sh area            Read paths on stdin, and print each path with the area,
#                                       the layer and the document of the map that hold it.
#                                       A path outside the map gets "-".
#   scripts/fork-map.sh check <commit>  The map check. <commit> is the upstream commit that the
#                                       fork matches.
#
# The check fails when:
#   - a line of the map has a wrong form, or an area or a path is in the map twice,
#   - a path is in a folder that is also a path of the map,
#   - a file that the fork adds (a file that is not in <commit>) is in no path,
#   - a path holds a file of <commit>, or holds no file,
#   - the document of an area is missing, or FORK-MAP.md does not name the area.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
MAP=scripts/fork-map.txt
LAYERS='rebuilt switch fork core operations'

# The paths of the map, one for each line: <path> TAB <area> TAB <layer> TAB <document>.
# A line with a wrong form gives a message on stderr and exit code 1.
entries() {
	awk -v layers="$LAYERS" '
		function bad(message) {
			printf "%s:%d: %s\n", FILENAME, FNR, message > "/dev/stderr"
			failed = 1
		}
		BEGIN {
			n = split(layers, list, " ")
			for (i = 1; i <= n; i++) known[list[i]] = 1
		}
		/^[[:space:]]*(#|$)/ { next }
		$1 == "area" {
			if (NF != 4 || $2 !~ /^[a-z0-9]+(-[a-z0-9]+)*$/ || !($3 in known)) {
				bad("an area line is: area <name> <layer> <document>, with a layer of: " layers)
				area = ""
				next
			}
			if ($2 in count) bad("the area " $2 " is in the map twice")
			area = $2
			layer = $3
			doc = $4
			count[area] = 0
			order[++areas] = area
			next
		}
		{
			if (area == "") {
				bad("a path needs an area line before it")
				next
			}
			if (NF != 1 || $1 ~ /^\// || $1 ~ /(^|\/)\.\.?(\/|$)/) {
				bad("a path line holds one path, relative to the repository root")
				next
			}
			if ($1 in seen) bad("the path " $1 " is in the map twice")
			seen[$1] = 1
			count[area]++
			print $1 "\t" area "\t" layer "\t" doc
		}
		END {
			for (i = 1; i <= areas; i++) {
				if (!count[order[i]]) {
					printf "%s: the area %s has no paths\n", FILENAME, order[i] > "/dev/stderr"
					failed = 1
				}
			}
			exit failed
		}' "$MAP"
}

# Print the entry of the path of the map that holds each line of stdin, or "-".
area() {
	local list
	list=$(mktemp)
	trap 'rm -f "$list"' RETURN
	entries >"$list"
	awk -F'\t' -v list="$list" '
		BEGIN {
			while ((getline line < list) > 0) {
				split(line, f, "\t")
				entry[f[1]] = line
			}
		}
		{
			if ($0 in entry) {
				print entry[$0]
				next
			}
			# The folders that hold the path, from the shortest to the longest.
			found = ""
			for (i = 1; i <= length($0); i++) {
				if (substr($0, i, 1) == "/" && (substr($0, 1, i) in entry)) {
					found = entry[substr($0, 1, i)]
					break
				}
			}
			if (found == "") print $0 "\t-\t-\t-"
			else {
				split(found, f, "\t")
				print $0 "\t" f[2] "\t" f[3] "\t" f[4]
			}
		}'
}

check() {
	local base=$1 dir failed=0
	dir=$(mktemp -d)
	trap 'rm -rf "$dir"' RETURN
	entries >"$dir/entries" || failed=1
	# Without quotePath, Git writes the names with characters outside ASCII in quotes.
	git -c core.quotePath=false ls-tree -r --name-only "$base" >"$dir/upstream"
	git -c core.quotePath=false ls-files >"$dir/tracked"
	awk -F'\t' \
		-v entries="$dir/entries" -v upstream="$dir/upstream" -v tracked="$dir/tracked" \
		-v map="$MAP" -v doc=FORK-MAP.md '
		function report(kind, text) {
			if (!(kind in problems)) kinds[++nkinds] = kind
			problems[kind] = problems[kind] "\n  " text
		}
		BEGIN {
			while ((getline line < entries) > 0) {
				split(line, f, "\t")
				paths[++npaths] = f[1]
				entry[f[1]] = 1
				if (!(f[2] in areaDoc)) areaNames[++nareas] = f[2]
				areaDoc[f[2]] = f[4]
			}
			while ((getline line < upstream) > 0) inUpstream[line] = 1
			while ((getline line < tracked) > 0) {
				files[++nfiles] = line
				isTracked[line] = 1
			}
			while ((getline line < doc) > 0) text = text "\n" line

			for (p = 1; p <= npaths; p++) {
				path = paths[p]
				for (i = 1; i < length(path); i++) {
					if (substr(path, i, 1) == "/" && (substr(path, 1, i) in entry)) {
						report("inside", path " is in " substr(path, 1, i))
						break
					}
				}
			}

			for (n = 1; n <= nfiles; n++) {
				file = files[n]
				owner = ""
				if (file in entry) owner = file
				else {
					for (i = 1; i <= length(file); i++) {
						if (substr(file, i, 1) == "/" && (substr(file, 1, i) in entry)) {
							owner = substr(file, 1, i)
							break
						}
					}
				}
				if (owner != "") {
					held[owner]++
					if (file in inUpstream && ++fromUpstream[owner] <= 3) {
						examples[owner] = examples[owner] (fromUpstream[owner] > 1 ? ", " : "") file
					}
				} else if (!(file in inUpstream)) {
					report("unmapped", file)
				}
			}
			for (p = 1; p <= npaths; p++) {
				path = paths[p]
				if (!held[path]) report("empty", path)
				if (fromUpstream[path]) {
					report("upstream", path ": " fromUpstream[path] " files, for example " examples[path])
				}
			}

			for (a = 1; a <= nareas; a++) {
				name = areaNames[a]
				if (!(areaDoc[name] in isTracked)) report("nodoc", name ": " areaDoc[name])
				if (!index(text, "`" name "`")) report("unnamed", name)
			}

			heading["unmapped"] = "These files that the fork adds are in no path of " map ":"
			heading["upstream"] = "These paths of " map " hold files of the upstream commit. Map only fork files:"
			heading["empty"] = "These paths of " map " hold no file:"
			heading["inside"] = "These paths of " map " are in a folder that is also a path of the map:"
			heading["nodoc"] = "The documents of these areas of " map " are not in the repository:"
			heading["unnamed"] = doc " does not name these areas of " map ":"
			for (k = 1; k <= nkinds; k++) print heading[kinds[k]] problems[kinds[k]]
			if (nkinds) {
				print "Each file that the fork adds goes in an area of " map ". See " doc "."
				exit 1
			}
		}' || failed=1
	return "$failed"
}

case "${1:-}" in
	area) area ;;
	check)
		[ -n "${2:-}" ] || {
			echo "Usage: $0 check <commit>" >&2
			exit 2
		}
		check "$2"
		;;
	*)
		echo "Usage: $0 area | check <commit>" >&2
		exit 2
		;;
esac
