#!/usr/bin/env bash
# Sourced by preflight.sh: Python-tier checks (PY-001 .. PY-005). Not a security control.
# Expects: finding, flag_lines, LIBS_MD, PY, TIER from the caller.

# Fallback stdlib list for hosts without python3 (python3 gives the exact sys.stdlib_module_names).
STDLIB_FALLBACK='abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar cmath codecs
collections colorsys concurrent configparser contextlib contextvars copy csv dataclasses datetime decimal
difflib dis email enum errno fnmatch fractions functools gc getpass gettext glob graphlib gzip hashlib
heapq hmac html http inspect io ipaddress itertools json keyword linecache locale logging lzma math
mimetypes numbers operator os pathlib pprint queue random re secrets select selectors shlex shutil
signal sqlite3 statistics string stringprep struct sys sysconfig tempfile textwrap threading time
timeit tokenize tomllib traceback types typing unicodedata unittest urllib uuid warnings weakref
xml zipfile zlib zoneinfo __future__'

allowed_modules() {
  if [ -n "$PY" ]; then
    $PY -c 'import sys; print("\n".join(sorted(sys.stdlib_module_names)))'
  else
    printf '%s\n' $STDLIB_FALLBACK
  fi
  [ -f "$LIBS_MD" ] && sed -n 's/^- `\([A-Za-z0-9_]*\)`$/\1/p' "$LIBS_MD"
}

# check_imports FILE: PY-001 for any top-level import outside stdlib ∪ runtime list ∪ bundle-local modules
check_imports() {
  local f=$1 allowed hit line mods m
  allowed=$(allowed_modules)
  grep -nE '^[[:space:]]*(import[[:space:]]+[A-Za-z0-9_.]+([[:space:]]*,[[:space:]]*[A-Za-z0-9_.]+)*|from[[:space:]]+[A-Za-z0-9_.]+[[:space:]]+import)' "$f" 2>/dev/null \
  | while IFS= read -r hit; do
    line=${hit%%:*}
    mods=$(printf '%s' "${hit#*:}" | sed -E 's/^[[:space:]]*from[[:space:]]+([A-Za-z0-9_.]+)[[:space:]]+import.*/\1/; s/^[[:space:]]*import[[:space:]]+//; s/[[:space:]]+as[[:space:]]+[A-Za-z0-9_]+//g; s/,/ /g')
    for m in $mods; do
      m=${m%%.*}
      [ -z "$m" ] && continue                       # relative import: from . import x
      [ -f "$m.py" ] && continue                    # module shipped inside the bundle
      printf '%s\n' "$allowed" | grep -qx "$m" && continue
      finding PY-001 deny "$f" "$line" "import '$m' is outside the standard library and the python-1 runtime (see references/python-1-libraries.md)"
    done
  done
}

check_python_file() {
  local f=$1
  check_imports "$f"
  flag_lines PY-002 deny "$f" '^[[:space:]]*(import|from)[[:space:]]+(subprocess|socket|ctypes|pickle|marshal|importlib)([[:space:].,]|$)' "forbidden module: subprocess, socket, ctypes, pickle, marshal and importlib are not allowed"
  flag_lines PY-002 deny "$f" '(^|[^A-Za-z0-9_.])(subprocess|socket|ctypes|pickle|marshal|importlib)\.' "forbidden module use: subprocess, socket, ctypes, pickle, marshal and importlib are not allowed"
  flag_lines PY-002 deny "$f" '(^|[^A-Za-z0-9_])os\.(system|exec[a-z]*|fork|spawn[a-z]*|popen)[[:space:]]*\(' "forbidden call: os.system/os.exec*/os.fork/os.spawn*/os.popen"
  flag_lines PY-002 deny "$f" '(^|[^A-Za-z0-9_.])(eval|exec|compile|__import__)[[:space:]]*\(' "forbidden call: eval(, exec(, compile(, __import__("
  grep -nE 'open\([[:space:]]*["'"'"'][^"'"'"']*["'"'"'][[:space:]]*,[[:space:]]*["'"'"'][rbt]*[wax+]|\.write_(text|bytes)[[:space:]]*\(' "$f" 2>/dev/null \
  | grep -vE 'open\([[:space:]]*["'"'"']/tmp(/|["'"'"'])|/tmp/' \
  | while IFS= read -r hit; do
    finding PY-003 deny "$f" "${hit%%:*}" "file writes are only allowed under /tmp"
  done
  flag_lines PY-005 warn "$f" '^[[:space:]]*(import|from)[[:space:]]+(threading|asyncio|concurrent)([[:space:].,]|$)' "(warn) threading/asyncio use is allowed but noted for the approver"
}

check_python_bundle() {
  local f
  for f in requirements.txt pyproject.toml setup.py; do
    [ -f "$f" ] && finding PY-004 deny "$f" 0 "dependency files are not allowed; the python-1 runtime fixes the libraries (see references/python-1-libraries.md)"
  done
  find . -type f \( -name '*.whl' -o -name '*.tar.gz' \) | sed 's#^\./##' | while IFS= read -r f; do
    finding PY-004 deny "$f" 0 "package archives are not allowed in the bundle"
  done
  return 0
}
