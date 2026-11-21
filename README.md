# Mech Royale bot

Bot for the Builders Mech Royale track. The `Dockerfile` at the top level builds the submitted image.

- `example_bot.py` is the bot (currently the kit's starter, baseline 1.15). `mechfight.py` is the kit's wrapper.
- `protocol.md` has the rules and the mechfight/1 protocol.
- `kit/` holds the conformance check, JSON schema, map, and TS starter. It's left out of the image by `.dockerignore`.

## Test

From WSL/Linux: `./check.sh` builds the image and runs `kit/check/check.py` with the scorer's limits (no network, 1 CPU, 512 MB, read-only root, uid 65534).

Quick check without Docker: `python3 kit/check/check.py -- python3 -u example_bot.py`
