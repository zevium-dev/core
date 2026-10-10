WAVE 4 — ANALYTICS + DASHBOARD LANE. Project: /home/tnfssc/Code/zevium. Read AGENTS.md, FLOW.md §2.1/§4.7, DESIGN.md, PRODUCT.md. Edit ONLY: convex/analytics.ts (new), apps/web/src/routes/app/index.tsx (dashboard), apps/web/src/routes/app/projects/$projectSlug analytics tab/components. Do not touch billing/keys/catalogue routes.

1. convex/analytics.ts: queries over usageEvents —
   - orgOverview(orgSlug): calls + credits today/this cycle, recent 20 events
   - projectAnalytics(orgSlug, projectSlug, rangeDays default 7): per-endpoint totals (calls, credits, errors by class 4xx/5xx, latency p50/p95/p99 computed from events — fine to compute in query over indexed range; cap event scan sensibly and note limits)
2. Dashboard /app/index per FLOW.md 2.1: wallet balance card (live), calls this cycle, projected spend (linear projection from cycle-to-date), recent calls table, quick actions (Top up → /app/billing, Keys → /app/settings/keys, Browse → /catalogue). Onboarding checklist card when org has 0 keys/0 calls (static checks fine).
3. Project Analytics tab: stat tiles (calls, credits, success %, p95), per-endpoint table (method, path, calls, credits, errors, p95), simple latency/time sparkline optional (skip heavy chart libs — CSS bars fine per DESIGN.md dataviz restraint; NO raw colors).
4. Everything realtime via useQuery (no polling). Skeletons layout-stable. Build + typecheck + convex push green.

End with `DONE:` or `BLOCKED:`.
