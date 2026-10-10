Task: notifications bell + webhooks UI + deprecation UI. Write scope: apps/web/src/components/ (new), apps/web/src/components/app-header.tsx, apps/web/src/components/spec-editor/spec-rail.tsx (versions card only), apps/web/src/components/project-settings-panel.tsx, apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx (banner only), apps/web/src/lib/ helpers+tests. Do NOT touch admin routes, billing, settings.

Read first: AGENTS.md, DESIGN.md, convex/notifications.ts, convex/webhooks.ts, convex/specs.ts (deprecateVersion/undeprecateVersion, deprecation metadata on getPublishedForGateway/getPublicDetail), convex/catalogue.ts — bind EXACT function names/args from those files.

BUILD:

1. Notification bell in app header: unread count badge (realtime convex query), popover list (kind icon, title, body, relative time), mark-read on open item, "Mark all read". Empty state. Motion tokens, reduced-motion.
2. Webhooks card in project Settings tab (project-settings-panel.tsx): endpoint URL + secret (generate random hex client-side, show-once copy), active toggle, save via upsert mutation; recent deliveries list (status badge ok/failed/pending, attempts, time, error truncated).
3. Deprecation: versions card rows (spec-rail) get overflow menu → "Deprecate…" dialog (optional sunset date + message) / "Undeprecate"; deprecated rows get muted badge. Catalogue API detail: banner when served version deprecated ("Deprecated — sunset <date>: <message>") semantic warning tokens.
   TESTS: pure helpers (relative-time, secret gen, delivery status mapping) in lib with vitest.
   VERIFY: pnpm --filter web typecheck && test && build green.
   Output: CHANGED list, VERIFY results, DONE or BLOCKED.
