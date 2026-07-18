WAVE 2 — GATEWAY LANE. Project: /home/tnfssc/Code/zevium. Read AGENTS.md, TECH.md, .project/PLAN.md, current apps/gateway code, and convex/specs.ts + convex/wallets.ts (getPublishedForGateway, recordUsage — the real control-plane functions). Edit ONLY apps/gateway/ and packages/shared/.

GOAL: gateway integrated with real control plane.

1. ConvexSpecSource: implement against real convex function (ConvexHttpClient from "convex/browser", env CONVEX_URL, api reference via convex/_generated import path from repo root — if cross-package import is awkward, call by function name string "specs:getPublishedForGateway"). TTL cache 30s.
2. Usage flush: replace console UsageSink with ConvexUsageSink batching to wallets.recordUsage (function name string ok), driven from wallet DO flush loop (alarm-based: DO alarm every ~5s when pending non-empty) with the ack protocol already in wallet.ts. Wire grant sync endpoint: internal route POST /internal/grant {clerkOrgId, amount, refId} guarded by shared secret env GATEWAY_INTERNAL_SECRET → forwards to org wallet DO grant.
3. Wallet DO id derivation: idFromName(clerkOrgId). Spec source returns clerkOrgId.
4. Free tier: parse x-zevium-free-tier — per-key per-day counter inside wallet DO (or separate DO storage key), free calls skip reserve/settle but still emit usage events with credits 0.
5. Extend workerd tests: fixture spec source + fake convex sink; test free-tier path, flush batching with ack, grant endpoint auth.
6. `pnpm --filter @zevium/gateway test` + typecheck green.

End with `DONE:` or `BLOCKED:`.
