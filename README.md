# Mech Royale bot

Bot for the Builders Mech Royale track. The `Dockerfile` at the top level builds the submitted image.

- `src/bot.ts` is the bot (Bun/TypeScript). `src/world.ts` builds the map model: heights, line of sight, A* navigation with climb edges. `src/mechfight.ts` is the kit wrapper.
- `protocol.md` has the rules and the mechfight/1 protocol.
- `kit/` holds the conformance check, JSON schema, map, and TS starter. It's left out of the image by `.dockerignore`.

## Test

From WSL/Linux: `./check.sh` builds the image and runs `kit/check/check.py` with the scorer's limits (no network, 1 CPU, 512 MB, read-only root, uid 65534).

Simulator: `bun tools/sim.ts` (local approximation of the rules, for testing behavior).
