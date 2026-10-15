#!/usr/bin/env bash
# preflight.sh <dist-dir>
# Fast feedback before publishing. NOT a security control: the pipeline re-checks everything.
# Prints one line per finding:  RULE file:line message   (rule ids from contracts/findings.md)
# Exit 1 if any deny-level rule fired, 0 otherwise. Needs bash, grep, sed, find; python3 improves accuracy.
set -u

usage() { echo "usage: preflight.sh <dist-dir>" >&2; exit 1; }
[ $# -eq 1 ] || usage
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIST=${1%/}
[ -d "$DIST" ] || { echo "IN-006 manifest.json:0 directory not found: $DIST"; exit 1; }
cd "$DIST" || exit 1
LIBS_MD="$HERE/../references/python-1-libraries.md"
CDN_RE='^https://(cdnjs\.cloudflare\.com/ajax/libs/|cdn\.jsdelivr\.net/npm/)[^[:space:]"'"'"'<>]+$'
ALLOWED_EXT='html css js json svg png jpg jpeg webp woff2 txt md csv py'
NODE_TIER_EXTRA_EXT='jsx ts tsx mjs cjs ico map'
SEV=$(mktemp "${TMPDIR:-/tmp}/preflight.XXXXXX")
trap 'rm -f "$SEV"' EXIT
PY=""
command -v python3 >/dev/null 2>&1 && PY=python3

# finding RULE SEVERITY FILE LINE MESSAGE
finding() {
  printf '%s %s:%s %s\n' "$1" "$3" "$4" "$5"
  printf '%s\n' "$2" >> "$SEV"
}

# grep_each PATTERN FILE -> prints "line:match" per hit (case-insensitive extended regex)
grep_each() { grep -noiE "$1" "$2" 2>/dev/null || true; }

# flag_lines RULE SEV FILE PATTERN MESSAGE: one finding per matching line (case-sensitive)
# flag_lines_i: same, case-insensitive (HTML tags and attributes)
flag_lines() {
  local rule=$1 sev=$2 file=$3 pat=$4 msg=$5 hit
  grep -nE "$pat" "$file" 2>/dev/null | while IFS= read -r hit; do
    finding "$rule" "$sev" "$file" "${hit%%:*}" "$msg"
  done
}
flag_lines_i() {
  local rule=$1 sev=$2 file=$3 pat=$4 msg=$5 hit
  grep -niE "$pat" "$file" 2>/dev/null | while IFS= read -r hit; do
    finding "$rule" "$sev" "$file" "${hit%%:*}" "$msg"
  done
}

list_files() { find . -mindepth 1 \( -type f -o -type l \) | sed 's#^\./##' | LC_ALL=C sort; }

# ---------- manifest (IN-006) ----------
TIER=""; ENTRY=""; EXT_SCRIPTS=""
check_manifest() {
  if [ ! -f manifest.json ]; then
    finding IN-006 deny manifest.json 0 "manifest.json missing"; return
  fi
  if [ -n "$PY" ]; then
    local out
    out=$($PY "$HERE/preflight-manifest.py" manifest.json 2>&1) || true
    printf '%s\n' "$out" | sed -n 's/^error: //p' | while IFS= read -r line; do
      finding IN-006 deny manifest.json 0 "$line"
    done
    TIER=$(printf '%s\n' "$out" | sed -n 's/^tier=//p')
    ENTRY=$(printf '%s\n' "$out" | sed -n 's/^entrypoint=//p')
    EXT_SCRIPTS=$(printf '%s\n' "$out" | sed -n 's/^externalScript=//p')
  else
    grep -qE '"schemaVersion"[[:space:]]*:[[:space:]]*2([^0-9]|$)' manifest.json \
      || finding IN-006 deny manifest.json 0 "schemaVersion must be 2"
    TIER=$(grep -oE '"tier"[[:space:]]*:[[:space:]]*"[a-z]+"' manifest.json | sed 's/.*"\([a-z]*\)"$/\1/')
    ENTRY=$(grep -oE '"entrypoint"[[:space:]]*:[[:space:]]*"[a-z.]+"' manifest.json | sed 's/.*"\([a-z.]*\)"$/\1/')
    EXT_SCRIPTS=$(grep -oE 'https://[^"[:space:]]+' manifest.json || true)
    [ -n "$TIER" ] || finding IN-006 deny manifest.json 0 "tier missing (static, python or node)"
    [ -n "$ENTRY" ] || finding IN-006 deny manifest.json 0 "entrypoint missing (index.html, app.py or package.json)"
  fi
}

# ---------- files (IN-004, IN-005, IN-007, IN-008; JS-003/JS-004 for prototype) ----------
check_files() {
  local f ext has_py=0 has_html=0 allowed_ext="$ALLOWED_EXT"
  [ "$TIER" = node ] && allowed_ext="$ALLOWED_EXT $NODE_TIER_EXTRA_EXT"
  while IFS= read -r f; do
    if [ -L "$f" ]; then finding IN-004 deny "$f" 0 "symlink or special file in the bundle"; continue; fi
    if [ "$TIER" = node ]; then
      case "$f" in
        node_modules|node_modules/*) finding JS-003 deny "$f" 0 "node_modules/ must not ship in the bundle; the pipeline installs dependencies with npm ci"; continue ;;
        .env|.env.*) finding JS-004 deny "$f" 0 ".env files must not ship in the bundle" ; continue ;;
        .npmrc) finding JS-004 deny "$f" 0 ".npmrc must not ship in the bundle" ; continue ;;
      esac
    fi
    ext=${f##*.}; [ "$ext" = "$f" ] && ext=""
    case " $allowed_ext " in
      *" $ext "*) ;;
      *) finding IN-005 deny "$f" 0 "file type .$ext is outside the allowlist ($allowed_ext)" ;;
    esac
    [ "$ext" = py ] && has_py=1
    [ "$ext" = html ] && has_html=1
  done <<EOT
$(list_files)
EOT
  if [ -n "$ENTRY" ] && [ ! -f "$ENTRY" ]; then
    finding IN-008 deny "$ENTRY" 0 "entrypoint file missing"
  fi
  if [ "$TIER" = static ] && [ $has_py = 1 ]; then
    finding IN-007 deny manifest.json 0 "tier is static but the bundle contains .py files"
  fi
  if [ "$TIER" = python ] && { [ $has_html = 1 ] || [ ! -f app.py ]; }; then
    finding IN-007 deny manifest.json 0 "tier is python but the bundle has .html files or no app.py"
  fi
}

# ---------- HTML / JS rules ----------
check_script_src() {
  local file=$1 hit line src ok
  grep_each '<script[^>]*[[:space:]]src[[:space:]]*=[[:space:]]*["'"'"'][^"'"'"']*' "$file" | while IFS= read -r hit; do
    line=${hit%%:*}
    src=$(printf '%s' "$hit" | sed 's/.*src[[:space:]]*=[[:space:]]*["'"'"']//')
    case "$src" in
      http://*|https://*|//*) ;;
      *) continue ;;   # local file served from the artifact origin ('self')
    esac
    ok=0
    if printf '%s' "$src" | grep -qE "$CDN_RE"; then
      printf '%s\n' "$EXT_SCRIPTS" | grep -qxF "$src" && ok=1
    fi
    [ $ok = 1 ] || finding HTML-001 deny "$file" "$line" "<script src> must be on cdnjs.cloudflare.com/ajax/libs/ or cdn.jsdelivr.net/npm/ and listed in manifest externalScripts: $src"
  done
}

check_blobs() {
  local file=$1 hit line blob
  grep -noE '[A-Za-z0-9+/=]{255}[A-Za-z0-9+/=]*' "$file" 2>/dev/null | while IFS= read -r hit; do
    line=${hit%%:*}; blob=${hit#*:}
    [ ${#blob} -gt 65536 ] && finding HTML-007 deny "$file" "$line" "base64/hex blob of ${#blob} bytes (limit 64 KiB)"
  done
}

check_html_file() {
  local f=$1
  check_script_src "$f"
  flag_lines_i HTML-002 deny "$f" '<form[^>]*[[:space:]]action[[:space:]]*=' "<form action> is not allowed (form-action 'none' at serve time)"
  flag_lines_i HTML-003 deny "$f" '<(iframe|frame|embed|object)[[:space:]>/]' "<iframe>/<frame>/<embed>/<object> is not allowed"
  flag_lines_i HTML-004 deny "$f" '<meta[^>]*http-equiv[[:space:]]*=[[:space:]]*["'"'"']?refresh|<link[^>]*rel[[:space:]]*=[[:space:]]*["'"'"']?import' "<meta http-equiv=refresh> / <link rel=import> is not allowed"
  flag_lines_i HTML-005 deny "$f" '<input[^>]*type[[:space:]]*=[[:space:]]*["'"'"']?password' "<input type=\"password\"> is not allowed; artifacts never collect credentials"
  flag_lines HTML-006 deny "$f" '(^|[^A-Za-z0-9_.$])eval[[:space:]]*\(|new[[:space:]]+Function[[:space:]]*\(|document\.write[[:space:]]*\([[:space:]]*[^"'"'"'`[:space:])]' "eval(, new Function( or document.write( with a non-literal argument"
  check_blobs "$f"
  flag_lines_i HTML-008 warn "$f" '<a[^>]*[[:space:]]href[[:space:]]*=[[:space:]]*["'"'"']?https?://' "(warn) link to an external host will not open inside the sandbox"
  flag_lines HTML-009 info "$f" '(^|[^A-Za-z0-9_.])fetch[[:space:]]*\(|XMLHttpRequest|WebSocket[[:space:]]*\(' "(info) fetch/XMLHttpRequest/WebSocket are blocked at serve time by connect-src 'none'"
}

# ---------- secrets (SEC-001) ----------
check_secrets() {
  local f=$1
  flag_lines SEC-001 deny "$f" 'AKIA[0-9A-Z]{16}' "looks like an AWS access key id"
  flag_lines SEC-001 deny "$f" 'AccountKey=[A-Za-z0-9+/]{86}==' "looks like an Azure storage account key"
  flag_lines SEC-001 deny "$f" '[?&]sig=[A-Za-z0-9%+/]{40,}' "looks like an Azure SAS signature"
  flag_lines SEC-001 deny "$f" 'ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}' "looks like a GitHub token"
  flag_lines SEC-001 deny "$f" '-----BEGIN [A-Z ]*PRIVATE KEY-----' "private key material"
  flag_lines SEC-001 deny "$f" 'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}' "looks like a JWT"
}

# ---------- run ----------
check_manifest
check_files
. "$HERE/preflight-python.sh"
. "$HERE/preflight-node.sh"
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if [ "$TIER" = node ]; then
    case "$f" in
      *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs) check_prototype_js_file "$f"; check_secrets "$f" ;;
      *.css|*.json|*.txt|*.md|*.csv|*.svg|*.html) check_secrets "$f" ;;
    esac
    continue
  fi
  case "$f" in
    *.html|*.js|*.svg) check_html_file "$f"; check_secrets "$f" ;;
    *.css|*.json|*.txt|*.md|*.csv) check_secrets "$f" ;;
    *.py) check_python_file "$f"; check_secrets "$f" ;;
  esac
done <<EOT
$(list_files)
EOT
[ "$TIER" = python ] && check_python_bundle
[ "$TIER" = node ] && check_prototype_bundle
grep -q '^deny$' "$SEV" && exit 1
exit 0
