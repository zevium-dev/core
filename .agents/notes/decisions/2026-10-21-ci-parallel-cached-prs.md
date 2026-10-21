# CI split into parallel slices; turbo cache on PRs only

> Date: 2026-10-21 · Status: accepted (built) · Decided by: owner

The serial `ci` job took ~7–12 min and ran twice per merge (PR, then the `develop` push that gates production). The owner asked for faster PR feedback without weakening the production gate, then allowed deleting checks that don't earn their cost.

- `ci.yml` runs `pnpm ci:pr` as four parallel slices on 2 vCPU runners; an aggregate `ci` job fails unless every slice passed. Shape: [testing](../architecture/testing.md#ci).
- Pull requests restore and save the turbo cache. Every other event, including the `develop` push that `deploy-production.yml` waits on, runs with `TURBO_FORCE` (writes cache, never reads it).
- **Deleted the real-backend 10,001-bucket reconciliation proof.** It was ~5 of the ~10 min, mostly serial mutations plus fixed 100–200 ms pacing sleeps. What it uniquely caught: reconciliation page cost growing with bucket count on the real backend. Kept instead: `tests/finance.test.ts` asserts the same per-page limits and conservation at ~257 buckets, and oversize pages roll back atomically, so a miss strands a refund in review rather than losing money. Zero users at decision time.
- Bigger runners were measured and rejected: the scale proof took 7m30s on 2 vCPU, 6m59s on 4, 5m42s on 8, 5m49s on 16 (run 39644198207). With it gone, nothing left is CPU-bound enough to pay for.

Timings (Blacksmith, wall clock per run, first job queued to `ci` done):

| Event                                    | Before (serial, last 30 runs) | After                     |
| ---------------------------------------- | ----------------------------- | ------------------------- |
| Pull request, turbo cache miss           | 7.1–11.7 min                  | 2.4 min (run 39648311836) |
| `develop` push gate (uncached, dispatch) | 7.3–9.9 min                   | 3.1 min (run 39647767234) |

Slowest slice is now `control-plane` or `test` at ~2 min each; setup is ~20 s per job.
