#!/usr/bin/env bash
# CycleGen non-regression runner (Layers A + C; optional D).
# Usage:
#   ./scripts/test_nonreg.sh
#   PLAYWRIGHT=1 ./scripts/test_nonreg.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
PY="${BACKEND}/.venv/bin/python"
FAILED=0

section() {
  echo ""
  echo "=== $* ==="
}

fail() {
  echo "FAIL: $*" >&2
  FAILED=1
}

section "Layer A — backend unittest"
if [[ ! -x "$PY" ]]; then
  fail "missing backend venv at $PY"
else
  if ! (cd "$BACKEND" && "$PY" -m unittest discover -s tests -v); then
    fail "backend unittest"
  fi
fi

section "Layer C — frontend typecheck + URL check"
if [[ ! -d "$FRONTEND/node_modules" ]]; then
  fail "frontend/node_modules missing — run npm install in frontend/"
else
  if ! (cd "$FRONTEND" && npm run typecheck); then
    fail "frontend typecheck"
  fi
  if ! (cd "$FRONTEND" && npm run test:unit-url); then
    fail "frontend check-api-url"
  fi
  if ! (cd "$FRONTEND" && npm run test:unit-bench); then
    fail "frontend check-export-bench"
  fi
fi

if [[ "${PLAYWRIGHT:-0}" == "1" ]]; then
  section "Layer D — Playwright E2E"
  echo "Note: Next may be started by Playwright webServer; API on 8000/8001 is separate."
  if ! (cd "$FRONTEND" && npm run test:e2e); then
    fail "playwright e2e"
  fi
else
  section "Layer D — skipped (set PLAYWRIGHT=1 to enable)"
fi

echo ""
if [[ "$FAILED" -ne 0 ]]; then
  echo "test_nonreg: FAILED"
  exit 1
fi
echo "test_nonreg: OK"
exit 0
