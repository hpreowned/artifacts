#!/usr/bin/env bash
# Assembles the EICAR antivirus test file at run time. Do not commit the assembled file.
# Usage: ./make-eicar.sh > eicar.com   (then zip it with a manifest and publish; expected: rejected, MAL-001)
set -euo pipefail
a='X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE'
b='!$H+H*'
printf '%s%s' "$a" "$b"
