Task: in-app /docs. Write scope: apps/web/src/routes/docs/ (new), apps/web/src/components/docs-* (new), apps/web/src/components/public-header.tsx (add Docs link), apps/web/src/routes/index.tsx (footer Docs link only). Nothing else.

Read first: AGENTS.md, PRODUCT.md, FLOW.md, TECH.md, DESIGN.md, apps/web/src/routes/catalogue (public page pattern), packages/shared (x-zevium-* extensions), apps/gateway/src (gateway/MCP surfaces for accuracy).

BUILD /docs with public-header + sidebar nav (docs sections) + prose content (Tailwind typography plugin is installed — use prose classes with semantic tokens). Pages (content written from the source docs, accurate, terse, code blocks with copy buttons):

1. /docs — Getting started: what Zevium is, credits model ($1=10,000, 95/5), quickstart for consumers (sign up → org → top up → key → first call curl).
2. /docs/publishing — Publisher guide: project → spec (x-zevium-cost, x-zevium-free-tier examples) → validate → publish semver → make public; immutability; deprecation; webhooks (events + HMAC signature verification snippet).
3. /docs/consuming — Consumer guide: keys (org-scoped, spend caps, rotation), calling through gateway (URL shape /gateway/{org}/{project}/{path}), headers returned (x-zevium-cost, request-id, Deprecation), zero-balance behavior, refunds on upstream failure.
4. /docs/agents — Agent guide: MCP endpoint config (env-driven host pattern from lib/landing.ts), /discovery, tool list (search_apis, get_api_docs, call_api), mock mode note (coming), 402 responses.
   Static content in TSX/MDX-lite (plain TSX with a small DocsPage layout component is fine — no new deps). Every code block real and correct. Docs link added to public header nav + landing footer Product column.
   RULES: semantic tokens, motion minimal, reduced-motion, mobile-responsive sidebar (collapsible).
   TESTS: none needed for static content — state so.
   VERIFY: pnpm --filter web typecheck && test && build green.
   Output: CHANGED list, VERIFY results, DONE or BLOCKED.
