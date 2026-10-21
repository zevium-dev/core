# CI split into parallel slices; turbo cache on PRs only

> Date: 2026-10-21 · Status: accepted (built) · Decided by: owner

The serial `ci` job took ~8–12 min and ran twice per merge (PR, then the `develop` push that gates production). The owner asked for faster PR feedback without weakening the production gate.

- `ci.yml` runs `pnpm ci:pr` as parallel slices; an aggregate `ci` job fails unless every slice passed. No check was dropped and no test changed.
- Pull requests restore and save the turbo cache. Every other event, including the `develop` push that `deploy-production.yml` waits on, runs with `TURBO_FORCE` (writes cache, never reads it).
- The 10,001-bucket reconciliation is the critical path and runs on an 8 vCPU runner; it gains ~25% there and nothing more at 16 vCPU. Its fixed pacing sleeps are product throughput limits and stay.

Shape and timings: [testing](../architecture/testing.md#ci).
