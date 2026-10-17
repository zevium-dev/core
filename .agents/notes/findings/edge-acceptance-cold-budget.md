---
name: edge-acceptance-cold-budget
description: Paired edge acceptance outran the per-isolate cold refresh budget; each seeded tenant now starts from a full burst
---

# Edge acceptance vs cold refresh budget

`apps/gateway/scripts/next-acceptance.mjs` failed intermittently in CI at the
scoped-lock step: a freshly seeded org got 503 `gateway_unavailable` about
120 ms into its first call.

Cause: the shared per-isolate `coldRefreshBudget` (20 burst, 5/s; see the
[2026-10-11 cold fill decision](../decisions/2026-10-11-edge-cold-fill-and-clock-skew.md))
was empty. In local workerd, every snapshot, wallet and OAuth DO shares one
isolate, so one budget. A tenant's first call cold-fills about five scopes
(key, consumer org, route, publisher org, wallet). The suite seeds a tenant
every few hundred milliseconds, which is about 15 permits/s. Locally only
~5 permits remained at the scoped step. On a fast CI run there were fewer, so
the publisher-org fill was refused and the route lookup failed closed. The
whole failure is timing. It lined up with CI runs where the test-spawned
`convex dev` push finished mid-test, and a docs-only branch with code that
passed on 2026-10-14 failed on 2026-10-17 on the same Convex backend binary.

Repro: shrink the burst from 20 to 15 in `cold-refresh.ts`. The scoped step
then fails every time with the CI body.

Fix (test only, no product change): the fixture worker exposes
`/test/cold-budget`, and the suite's `seed()` helper calls it after every
seeded tenant. The budget's own behavior is covered by unit tests
(`test/next-oauth.test.ts`). The acceptance suite tests tenant scenarios, not
throttling.

Product note, not decided: because a first call costs about five permits, one
isolate's burst covers only about four brand-new consumers before falling back
to about one per second. Retune this only through a new decision.
