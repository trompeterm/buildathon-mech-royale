#!/usr/bin/env bash
# Build the bot image and run the official conformance check under scorer limits.
# Run from WSL/Linux/macOS: ./check.sh   (uses docker.exe automatically under WSL)
set -euo pipefail
cd "$(dirname "$0")"
DOCKER=docker; ARENA="$PWD/kit/arena"
if grep -qi microsoft /proc/version 2>/dev/null; then DOCKER=docker.exe; ARENA="$(wslpath -w "$PWD/kit/arena")"; fi
$DOCKER build --platform linux/amd64 -t my-bot .
python3 kit/check/check.py --map-dir /arena -- $DOCKER run --rm -i --platform linux/amd64 --network none --cpus 1 --memory 512m \
  --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$ARENA:/arena:ro" my-bot
