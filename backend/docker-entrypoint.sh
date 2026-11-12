#!/bin/sh
# Render / Railway inject PORT; local Docker defaults to 8000.
set -eu
PORT="${PORT:-8000}"
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
