#!/usr/bin/env bash
# tests/handoff-check.sh
#
# Run this HERE, before transferring the repo (docs/HANDOFF.md §2), to prove the clone you are about to
# hand off is self-contained: every unit suite passes offline, there is nothing that only works on this
# machine, and the tree is clean. It checks only this worktree -- a dirty tree from the parallel Helm
# agents' STATUS.md edits in OTHER worktrees never shows up here (docs/HANDOFF.md's task brief).
#
# Checks, in order:
#   1. npm test in intake-api, scanner, static-gateway, viewer-shell, cli
#   2. skill/tests/*.sh
#   3. tests/lib/selftest.sh
#   4. ./deploy/validate.sh, if present
#   5. helm lint on every chart under charts/, if any exist
#   6. no absolute paths from this machine (/Users/, /private/tmp/) in tracked files
#   7. no credential-shaped strings in tracked files (allowlists the intentional fake key under
#      tests/corpus/static-secret/ by path -- that bundle exists specifically to trip this class of rule)
#   8. .gitignore covers .local/, node_modules/, dist/, .worktrees/
#   9. git status --porcelain is empty
#
# Prints one line per check (ok/FAIL) and a final one-line verdict. Exits 0 only if every check passed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

FAIL=0
ok()   { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAIL=1; }

run_suite() {
  # run_suite <label> <dir> <npm-script...>
  local label="$1" dir="$2"; shift 2
  if [ ! -d "$ROOT/$dir" ]; then fail "$label: directory $dir not found"; return; fi
  if (cd "$ROOT/$dir" && "$@") >/tmp/handoff-check.$$ 2>&1; then
    ok "$label"
  else
    fail "$label (see output below)"
    sed 's/^/     | /' /tmp/handoff-check.$$
  fi
  rm -f /tmp/handoff-check.$$
}

echo "== unit suites =="
# Install every directory's dependencies up front, before running any test: intake-api's tsconfig
# compiles ../scanner/src alongside its own, so its test needs scanner/node_modules present even though
# scanner is a separate package -- installing per-directory right before each test (the obvious order)
# fails on a from-scratch clone for that reason alone.
for d in intake-api scanner static-gateway viewer-shell cli; do
  if [ ! -d "$ROOT/$d/node_modules" ]; then
    if ! (cd "$ROOT/$d" && npm ci --silent) >/tmp/handoff-check.$$ 2>&1; then
      fail "npm ci in $d (see output below)"
      sed 's/^/     | /' /tmp/handoff-check.$$
    fi
    rm -f /tmp/handoff-check.$$
  fi
done
run_suite "intake-api: npm test"     intake-api     npm test
run_suite "scanner: npm test"        scanner        npm test
run_suite "static-gateway: npm test" static-gateway npm test
run_suite "viewer-shell: npm test"   viewer-shell   npm test
run_suite "cli: npm test"            cli            npm test

echo "== skill test scripts =="
if [ -d "$ROOT/skill/tests" ]; then
  shopt -s nullglob
  found=0
  for t in "$ROOT"/skill/tests/*.sh; do
    found=1
    if "$t" >/tmp/handoff-check.$$ 2>&1; then
      ok "skill/tests/$(basename "$t")"
    else
      fail "skill/tests/$(basename "$t") (see output below)"
      sed 's/^/     | /' /tmp/handoff-check.$$
    fi
    rm -f /tmp/handoff-check.$$
  done
  shopt -u nullglob
  [ "$found" -eq 1 ] || fail "skill/tests/*.sh: no test scripts found"
else
  fail "skill/tests/: directory not found"
fi

echo "== tests/lib/selftest.sh =="
if [ -x "$ROOT/tests/lib/selftest.sh" ]; then
  if "$ROOT/tests/lib/selftest.sh" >/tmp/handoff-check.$$ 2>&1; then
    ok "tests/lib/selftest.sh"
  else
    fail "tests/lib/selftest.sh (see output below)"
    sed 's/^/     | /' /tmp/handoff-check.$$
  fi
  rm -f /tmp/handoff-check.$$
else
  fail "tests/lib/selftest.sh: not found or not executable"
fi

echo "== deploy/validate.sh =="
if [ -x "$ROOT/deploy/validate.sh" ]; then
  if "$ROOT/deploy/validate.sh" >/tmp/handoff-check.$$ 2>&1; then
    ok "deploy/validate.sh"
  else
    fail "deploy/validate.sh (see output below)"
    sed 's/^/     | /' /tmp/handoff-check.$$
  fi
  rm -f /tmp/handoff-check.$$
else
  ok "deploy/validate.sh: not present, skipped"
fi

echo "== helm lint on charts/ =="
if [ -d "$ROOT/charts" ]; then
  if ! command -v helm >/dev/null 2>&1; then
    fail "charts/ exists but helm is not installed -- cannot lint"
  else
    shopt -s nullglob
    charts=("$ROOT"/charts/*/)
    shopt -u nullglob
    if [ "${#charts[@]}" -eq 0 ]; then
      ok "charts/: directory exists but is empty, nothing to lint"
    else
      for c in "${charts[@]}"; do
        name="$(basename "$c")"
        if helm lint "$c" >/tmp/handoff-check.$$ 2>&1; then
          ok "helm lint charts/$name"
        else
          fail "helm lint charts/$name (see output below)"
          sed 's/^/     | /' /tmp/handoff-check.$$
        fi
        rm -f /tmp/handoff-check.$$
      done
    fi
  fi
else
  ok "charts/: not present yet (M7 not landed here), skipped"
fi

echo "== no absolute paths from this machine =="
# Tracked files only; excludes this script and HANDOFF.md itself, which legitimately document/implement
# the check and may need to print the pattern as an example.
hits=$(git grep -n -E '/Users/|/private/tmp/' -- \
  ':!tests/handoff-check.sh' ':!docs/HANDOFF.md' 2>/dev/null || true)
if [ -z "$hits" ]; then
  ok "no /Users/ or /private/tmp/ in tracked files"
else
  fail "absolute local paths found in tracked files:"
  printf '%s\n' "$hits" | sed 's/^/     | /'
fi

echo "== no credential-shaped strings =="
# Same patterns as skill/publish-to-aks/scripts/preflight.sh's SEC-001 check. The tests/corpus/static-secret/
# bundle contains a deliberate fake AWS-shaped key to exercise that rule in the scanner/preflight test suites
# -- allowlisted here by path, not by pattern, so a real leaked credential anywhere else still fails this.
SECRET_PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'AccountKey=[A-Za-z0-9+/]{86}=='
  '[?&]sig=[A-Za-z0-9%+/]{40,}'
  'ghp_[A-Za-z0-9]{36}'
  'github_pat_[A-Za-z0-9_]{22,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
)
secret_hits=""
for pat in "${SECRET_PATTERNS[@]}"; do
  h=$(git grep -n -I -E "$pat" -- ':!tests/corpus/static-secret/*' ':!tests/handoff-check.sh' 2>/dev/null || true)
  [ -n "$h" ] && secret_hits="$secret_hits
$h"
done
if [ -z "$secret_hits" ]; then
  ok "no credential-shaped strings outside tests/corpus/static-secret/"
else
  fail "credential-shaped strings found:"
  printf '%s\n' "$secret_hits" | sed '/^$/d; s/^/     | /'
fi

echo "== .gitignore coverage =="
missing=""
for pat in '.local/' 'node_modules/' 'dist/' '.worktrees/'; do
  grep -qxF "$pat" .gitignore 2>/dev/null || missing="$missing $pat"
done
if [ -z "$missing" ]; then
  ok ".gitignore covers .local/, node_modules/, dist/, .worktrees/"
else
  fail ".gitignore missing:$missing"
fi

echo "== git status =="
porcelain=$(git status --porcelain)
if [ -z "$porcelain" ]; then
  ok "git status --porcelain is empty"
else
  fail "working tree is not clean:"
  printf '%s\n' "$porcelain" | sed 's/^/     | /'
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "HANDOFF-CHECK: PASS"
  exit 0
else
  echo "HANDOFF-CHECK: FAIL"
  exit 1
fi
