#!/usr/bin/env bash
# tests/m2/eicar-publish.sh
#
# WARNING: this writes a real EICAR antivirus test file to a temp directory (via tests/make-eicar.sh).
# On a laptop with endpoint antivirus (Microsoft Defender, CrowdStrike, etc.) that file WILL be
# quarantined or deleted the instant it is written, and some agents flag the whole temp directory.
# Run this from the cluster test job / a CI runner, or a machine whose AV you can tolerate -- never on
# a machine you care about keeping clean. This is why the EICAR string is not in tests/corpus/
# (tests/README.md says so explicitly).
#
# Assembles a static bundle (manifest.json + index.html + the EICAR string as eicar.txt -- .txt is an
# allowlisted extension so it passes intake rule IN-005; the malware stage is Defender for Storage,
# which scans every file inside the uploaded zip regardless of extension), publishes it with
# artifactctl, and asserts state == rejected with rule MAL-001 (contracts/findings.md). Prints the
# Defender for Cloud alert query for a human to confirm the alert fired -- Defender's alert can lag the
# scan result by minutes (DESIGN.md §9 "Defender scan latency varies").
#
# Usage:
#   ARTIFACTS_API_URL=http://localhost:18080 ARTIFACTS_DEV_OID=m2-eicar-probe tests/m2/eicar-publish.sh
#
# Environment (same shape as tests/negative.sh, see tests/README.md and cli/README.md):
#   ARTIFACTS_API_URL    Intake base URL. Default (artifactctl's own default): http://localhost:8080
#   ARTIFACTS_TOKEN       Bearer. Not needed when ARTIFACTS_DEV_OID is set.
#   ARTIFACTS_DEV_OID     Required for a direct (non-APIM) connection in production mode: intake-api
#                          requires the X-Publisher-Oid/-Upn headers to be present on beginPublish, and
#                          this is what makes artifactctl send them. Run tests/m2/cluster-negative.sh
#                          first in the same shell to export a real decoded oid, or set your own.
#   STORAGE_ACCOUNT       Used only to print the alert-query hint below. Default: <storage-account>
#   ARTIFACTCTL            Command to run instead of `node <repo>/cli/dist/artifactctl.js` (optional).
#
# Needs: node (artifactctl), python3. No secrets: the EICAR string is assembled at run time, never
# committed, and no credential is read or printed by this script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
case "${1:-}" in -h|--help) usage ;; esac

echo "WARNING: writing a real EICAR test file to a temp directory. Endpoint antivirus on this machine" >&2
echo "may quarantine it immediately. Run on a machine/CI runner whose AV you can tolerate." >&2

if [ -n "${ARTIFACTCTL:-}" ]; then
  read -r -a CLI <<< "$ARTIFACTCTL"
elif [ -f "$ROOT/cli/dist/artifactctl.js" ]; then
  CLI=(node "$ROOT/cli/dist/artifactctl.js")
elif command -v artifactctl >/dev/null 2>&1; then
  CLI=(artifactctl)
else
  echo "artifactctl not found: run 'npm --prefix $ROOT/cli ci && npm --prefix $ROOT/cli run build' or set ARTIFACTCTL" >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

BUNDLE="$(mktemp -d "${TMPDIR:-/tmp}/eicar-bundle.XXXXXX")"
cleanup() { rm -rf "$BUNDLE"; }
trap cleanup EXIT

cat > "$BUNDLE/manifest.json" <<'JSON'
{
  "schemaVersion": 2,
  "name": "m2-eicar-probe",
  "tier": "static",
  "runtime": null,
  "entrypoint": "index.html",
  "externalScripts": [],
  "ttlDays": 1,
  "generatedBy": { "tool": "artifactctl", "model": "m2-runbook", "session": "eicar-publish" }
}
JSON

cat > "$BUNDLE/index.html" <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>M2 EICAR probe</title></head>
<body><p>This bundle exists only to carry an EICAR test file past intake and into the Defender scan.</p></body></html>
HTML

"$ROOT/tests/make-eicar.sh" > "$BUNDLE/eicar.txt"

echo "publishing $BUNDLE" >&2
set +e
OUT="$("${CLI[@]}" publish --wait --json "$BUNDLE")"
PUBLISH_RC=$?
set -e
[ -n "$OUT" ] || { echo "EICAR: FAIL -- artifactctl produced no output (exit $PUBLISH_RC)" >&2; exit 1; }
echo "$OUT"

set +e
python3 -c '
import json, sys
got = json.loads(sys.argv[1])
state = got.get("state")
rules = sorted({f.get("rule") for f in got.get("findings", []) if isinstance(f, dict) and f.get("rule")})
print(f"state={state} rules={rules}")
ok = state == "rejected" and "MAL-001" in rules
print("EICAR: PASS" if ok else "EICAR: FAIL -- expected state=rejected with MAL-001")
sys.exit(0 if ok else 1)
' "$OUT"
ASSERT_RC=$?
set -e

STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-<storage-account>}"
cat <<EOF

Human confirmation (Defender's alert can lag the scan result by minutes -- DESIGN.md §9):
  az security alert list --query "[?contains(alertDisplayName, 'Malware')]" -o table
  Portal path: Microsoft Defender for Cloud > Security alerts, filter resource = $STORAGE_ACCOUNT
EOF

exit $ASSERT_RC
