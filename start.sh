#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"

cd "$DIR"

# Create venv on first run
if [ ! -d "$VENV/lib" ]; then
  echo "Creating venv and installing dependencies..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r requirements.txt
fi

source "$VENV/bin/activate"
export $(grep -v '^#' .env | xargs) 2>/dev/null || true
python3 app.py
