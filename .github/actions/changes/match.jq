# Input: the file names, one on each line. $paths and $ignore: the patterns, one on each line.
# Output: "true" when a file is in $paths (the last pattern that matches it decides) and not in $ignore.

# A pattern of on.pull_request.paths as a regular expression that matches the whole path.
def regex:
  gsub("(?<c>[.+^$(){}|\\[\\]\\\\])"; "\\\(.c)")
  | gsub("\\*\\*/"; "\u0001")
  | gsub("\\*\\*"; "\u0002")
  | gsub("\\*"; "[^/]*")
  | gsub("\\?"; "[^/]")
  | gsub("\u0001"; "(.*/)?")
  | gsub("\u0002"; ".*")
  | "^" + . + "$";

def patterns: split("\n") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != "" and (startswith("#") | not)));

# true, false or null (no pattern matches the file).
def decide($file; $list):
  reduce $list[] as $p (null;
    if ($p | startswith("!")) then (if ($file | test($p[1:] | regex)) then false else . end)
    else (if ($file | test($p | regex)) then true else . end) end);

($paths | patterns) as $in
| ($ignore | patterns) as $out
| [split("\n")[] | select(. != "") | select(decide(.; $in) == true and decide(.; $out) != true)]
| (length > 0 | tostring)
