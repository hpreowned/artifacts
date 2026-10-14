#!/usr/bin/env bash
# build.sh [plugin|skill] [output.zip]
# plugin (default): publish-to-aks.plugin.zip for skills repos that accept plugins (DESIGN §6.3):
#     .claude-plugin/plugin.json   .mcp.json   skills/publish-to-aks/{SKILL.md,reference/,scripts/}
# skill:            publish-to-aks.skill.zip for repos that accept only skills:
#     publish-to-aks/{SKILL.md,reference/,scripts/}
# Never includes skill/tests, skill/tools or a top-level bin/. Deterministic: sorted entries, fixed timestamps.
# Needs bash, find, sed, sort and python3 (preferred) or zip.
set -eu
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKILL="$HERE/../publish-to-aks"
KIND=${1:-plugin}
case "$KIND" in
  plugin) OUT=${2:-$HERE/publish-to-aks.plugin.zip}; PREFIX="skills/publish-to-aks" ;;
  skill) OUT=${2:-$HERE/publish-to-aks.skill.zip}; PREFIX="publish-to-aks" ;;
  *) echo "usage: build.sh [plugin|skill] [output.zip]" >&2; exit 1 ;;
esac
[ -f "$SKILL/SKILL.md" ] || { echo "skill not found at $SKILL" >&2; exit 1; }
grep -q '^name: publish-to-aks$' "$SKILL/SKILL.md" || { echo "SKILL.md name must equal the folder name publish-to-aks" >&2; exit 1; }

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/plugin-build.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$PREFIX"
cp -R "$SKILL/." "$STAGE/$PREFIX/"
if [ "$KIND" = plugin ]; then
  mkdir -p "$STAGE/.claude-plugin"
  cp "$HERE/.claude-plugin/plugin.json" "$STAGE/.claude-plugin/plugin.json"
  cp "$HERE/.mcp.json" "$STAGE/.mcp.json"
fi
find "$STAGE" -name '.DS_Store' -delete
if [ -n "$(find "$STAGE" -type l | head -1)" ]; then echo "symlinks are not allowed in the package" >&2; exit 1; fi

rm -f "$OUT"
mkdir -p "$(dirname "$OUT")"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$STAGE" "$OUT" <<'PY'
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
names = sorted(os.path.relpath(os.path.join(d, f), src) for d, _, fs in os.walk(src) for f in fs)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names:
        zi = zipfile.ZipInfo(n, date_time=(1980, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = (0o755 if n.endswith(".sh") else 0o644) << 16
        with open(os.path.join(src, n), "rb") as fh:
            z.writestr(zi, fh.read())
PY
elif command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | zip -X -q "$OUT" -@ )
else
  echo "need python3 or zip" >&2; exit 1
fi
echo "$OUT"
