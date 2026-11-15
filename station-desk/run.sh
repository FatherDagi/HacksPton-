#!/bin/sh
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Create the virtualenv first: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8787
