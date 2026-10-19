#!/usr/bin/env bash
# upload.sh <dist-dir> <uploadUrl> <uploadToken>
# Zips dist/ (files at the zip root, sorted, no symlinks), computes its SHA-256, PUTs it to uploadUrl with the
# one-time bearer token, then POSTs {sha256} to the finalize URL (uploadUrl with /upload replaced by /finalize).
# Output / exit codes:
#   UPLOADED <jobId> <sha256>   exit 0   upload and finalize accepted; poll getPublishStatus next
#   NETWORK_BLOCKED             exit 2   egress to the API host is blocked (curl 6/7/28/35 or an HTTP 403 from a proxy):
#                                        stop; the Cowork egress allowlist needs the APIM host. Never inline the bytes.
#   anything else               exit 1   usage or API error; the message says what to fix
# Needs bash, curl, find, sed, sort and either zip or python3; shasum, sha256sum or openssl for the hash.
set -u
umask 077

die() { echo "ERROR: $*" >&2; exit 1; }
[ $# -eq 3 ] || die "usage: upload.sh <dist-dir> <uploadUrl> <uploadToken>"
DIST=${1%/}; URL=$2; TOKEN=$3
[ -d "$DIST" ] || die "not a directory: $DIST"
[ -f "$DIST/manifest.json" ] || die "$DIST/manifest.json missing; run preflight.sh first"
BASE=${URL%%\?*}
case "$BASE" in */upload) ;; *) die "uploadUrl must end with /upload: $URL" ;; esac
JOB=${BASE%/upload}; JOB=${JOB##*/}
FINALIZE="${BASE%/upload}/finalize"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/upload.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
ZIP="$WORK/bundle.zip"; HDR="$WORK/headers"; BODY="$WORK/body"
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HDR"   # header file keeps the token out of `ps`

# ---------- zip: files only, at the root, deterministic order ----------
if [ -n "$(find "$DIST" -type l | head -1)" ]; then die "symlinks are not allowed in the bundle: $(find "$DIST" -type l | head -3 | tr '\n' ' ')"; fi
if command -v zip >/dev/null 2>&1; then
  ( cd "$DIST" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | zip -X -D -q "$ZIP" -@ ) || die "zip failed"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$DIST" "$ZIP" <<'PY' || die "python3 zip failed"
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
names = sorted(os.path.relpath(os.path.join(d, f), src) for d, _, fs in os.walk(src) for f in fs)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names:
        zi = zipfile.ZipInfo(n, date_time=(1980, 1, 1, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
        with open(os.path.join(src, n), "rb") as fh: z.writestr(zi, fh.read())
PY
else
  die "need zip or python3 to build the bundle"
fi

if command -v shasum >/dev/null 2>&1; then SHA=$(shasum -a 256 "$ZIP" | cut -c1-64)
elif command -v sha256sum >/dev/null 2>&1; then SHA=$(sha256sum "$ZIP" | cut -c1-64)
elif command -v openssl >/dev/null 2>&1; then SHA=$(openssl dgst -sha256 "$ZIP" | sed 's/.*= //')
else die "need shasum, sha256sum or openssl"; fi
case "$SHA" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;; *) die "could not compute sha256" ;; esac

# ---------- HTTP ----------
# request METHOD URL [curl args...] -> sets CODE and RC; prints NETWORK_BLOCKED and exits 2 on blocked egress
request() {
  local method=$1 url=$2; shift 2
  CODE=$(curl -sS --connect-timeout 15 --max-time 300 -o "$BODY" -w '%{http_code}' -X "$method" -H @"$HDR" "$@" "$url" 2>"$WORK/err")
  RC=$?
  case "$RC" in
    6|7|28|35) echo "NETWORK_BLOCKED"; echo "curl exit $RC reaching $url: $(cat "$WORK/err")" >&2; exit 2 ;;
    0) ;;
    *) die "curl exit $RC: $(cat "$WORK/err")" ;;
  esac
  if [ "$CODE" = 403 ]; then echo "NETWORK_BLOCKED"; echo "HTTP 403 from a proxy or WAF in front of $url" >&2; exit 2; fi
}

request PUT "$URL" -H 'Content-Type: application/zip' --data-binary @"$ZIP"
case "$CODE" in
  201) ;;
  401) die "upload token rejected (bad, expired or already used); call beginPublish again" ;;
  413) die "bundle larger than maxBytes; shrink dist/ (inline images, remove unused assets)" ;;
  409) die "job is not awaiting upload (already uploaded, expired or finalized)" ;;
  *) die "upload returned HTTP $CODE: $(head -c 300 "$BODY")" ;;
esac

request POST "$FINALIZE" -H 'Content-Type: application/json' --data "{\"sha256\":\"$SHA\"}"
case "$CODE" in
  202) ;;
  401) die "finalize token rejected; call beginPublish again" ;;
  409) if grep -q '"duplicateOf"' "$BODY" 2>/dev/null; then
         die "DUPLICATE: this exact bundle is already in flight — $(head -c 300 "$BODY")"
       fi
       die "finalize rejected (hash mismatch or wrong state): $(head -c 300 "$BODY")" ;;
  *) die "finalize returned HTTP $CODE: $(head -c 300 "$BODY")" ;;
esac
echo "UPLOADED $JOB $SHA"
