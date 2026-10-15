#!/usr/bin/env bash
# Builds both packages with skill/plugin/build.sh and checks the zip layouts (python3 zipfile for the listing).
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
BUILD="$ROOT/skill/plugin/build.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/plugin-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
FAIL=0
check() { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3: expected [$2] got [$1]"; FAIL=1; fi; }
listing() { python3 -c 'import sys,zipfile; print("\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))' "$1"; }
has() { printf '%s\n' "$1" | grep -qx "$2"; }

OUT=$(bash "$BUILD" plugin "$WORK/p.zip"); RC=$?
check "$RC" 0 "plugin build exits 0"
check "$OUT" "$WORK/p.zip" "plugin build prints the output path"
L=$(listing "$WORK/p.zip")
for want in .claude-plugin/plugin.json .mcp.json skills/publish-to-aks/SKILL.md skills/publish-to-aks/references/manifest-schema.json \
            skills/publish-to-aks/references/python-1-libraries.md skills/publish-to-aks/scripts/preflight.sh \
            skills/publish-to-aks/scripts/preflight-manifest.py skills/publish-to-aks/scripts/preflight-python.sh skills/publish-to-aks/scripts/upload.sh; do
  has "$L" "$want" && echo "ok   plugin zip has $want" || { echo "FAIL plugin zip missing $want"; FAIL=1; }
done
check "$(printf '%s\n' "$L" | grep -cE '^(bin/|tests/|tools/|skills/publish-to-aks/tests/)')" 0 "plugin zip has no top-level bin/, tests/ or tools/"
check "$(printf '%s\n' "$L" | grep -c '/$')" 0 "plugin zip has no directory entries"
check "$(printf '%s\n' "$L" | LC_ALL=C sort | diff - <(printf '%s\n' "$L") | wc -l | tr -d ' ')" 0 "plugin zip entries are sorted"
META=$(python3 -c 'import sys,zipfile,json; z=zipfile.ZipFile(sys.argv[1]); p=json.loads(z.read(".claude-plugin/plugin.json")); m=json.loads(z.read(".mcp.json")); print(p["name"], p["version"], len(p["description"])>0, m["mcpServers"]["artifacts"]["type"], m["mcpServers"]["artifacts"]["url"])' "$WORK/p.zip")
check "$META" "publish-to-aks 0.1.0 True http https://mcp.corp.com/artifacts-mcp/mcp" "plugin.json and .mcp.json carry the required fields"
check "$(python3 -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read("skills/publish-to-aks/SKILL.md")==open(sys.argv[2],"rb").read())' "$WORK/p.zip" "$ROOT/skill/publish-to-aks/SKILL.md")" True "SKILL.md in the zip is byte-identical to the source"

bash "$BUILD" plugin "$WORK/p2.zip" >/dev/null
check "$(cmp -s "$WORK/p.zip" "$WORK/p2.zip" && echo same || echo differ)" same "plugin build is deterministic"

OUT=$(bash "$BUILD" skill "$WORK/s.zip"); RC=$?
check "$RC" 0 "skill-only build exits 0"
L=$(listing "$WORK/s.zip")
has "$L" "publish-to-aks/SKILL.md" && echo "ok   skill zip has publish-to-aks/SKILL.md at the top" || { echo "FAIL skill zip layout"; FAIL=1; }
check "$(printf '%s\n' "$L" | grep -cE '^(\.claude-plugin/|\.mcp\.json|bin/|skills/)')" 0 "skill zip has no plugin files, bin/ or skills/ wrapper"

bash "$BUILD" bogus "$WORK/x.zip" >/dev/null 2>&1; check "$?" 1 "unknown kind is a usage error"
echo "plugin.test.sh: $( [ $FAIL = 0 ] && echo PASS || echo FAIL )"
exit $FAIL
