#!/usr/bin/env bash
# Lightweight SUMO toolchain healthcheck (image / container).
set -euo pipefail

missing=0

check() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "MISSING: $bin"
    missing=1
  else
    echo "OK: $bin -> $(command -v "$bin")"
  fi
}

check sumo
check netconvert
check python3

if [[ -z "${SUMO_HOME:-}" ]]; then
  echo "WARN: SUMO_HOME unset (expected /usr/share/sumo in Docker)"
elif [[ ! -d "$SUMO_HOME" ]]; then
  echo "MISSING: SUMO_HOME directory $SUMO_HOME"
  missing=1
else
  echo "OK: SUMO_HOME=$SUMO_HOME"
fi

if [[ "$missing" -ne 0 ]]; then
  echo "SUMO healthcheck FAILED"
  exit 1
fi

echo "SUMO healthcheck PASSED"
exit 0
