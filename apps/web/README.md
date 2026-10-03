# Zevium web app

The public catalogue, API reference, mock playground, and organization dashboard
live here. Publishers use the dashboard to edit specs, publish versions, and
manage earnings. Consumers use it to fund their wallet, create keys, and inspect
calls.

See [PRODUCT.md](../../PRODUCT.md) for product behavior,
[FLOW.md](../../FLOW.md) for screen flows, [DESIGN.md](../../DESIGN.md) for UI
rules, and [TECH.md](../../TECH.md) for architecture. The
[root README](../../README.md) covers repository setup and build requirements.

Run these commands from the repository root:

```bash
pnpm install
pnpm dev                          # web, Convex, and gateway
pnpm --filter web test             # web tests
pnpm --filter web typecheck        # web TypeScript checks
pnpm build                        # production workspace build
```

Routes live in `src/routes`. After adding or moving a route, regenerate the route
map with `pnpm --filter web generate-routes`. Keep public copy about what users
can do; put implementation details in [TECH.md](../../TECH.md).

The production build targets Cloudflare Workers. Supply the environment values
listed in the root README, or use the ignored `.env.production.local` file in
this directory. Build output must not contain `dist/server/.dev.vars`.
