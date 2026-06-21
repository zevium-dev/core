import defaultServerEntry from "@tanstack/react-start/server-entry";

import { serverEnv } from "~/env/server";

// Extend TanStack Start's server entry with a `scheduled` handler (Cloudflare cron).
export default {
  fetch: (request: Request, _env: unknown, _ctx: ExecutionContext) => defaultServerEntry.fetch(request),
  scheduled: (_controller: ScheduledController, _env: unknown, ctx: ExecutionContext) => {
    ctx.waitUntil(
      (async () => {
        const maxBatches = 10;
        for (let i = 0; i < maxBatches; i++) {
          const req = new Request("https://internal/api/credits/flush?limit=2000", {
            headers: {
              authorization: `Bearer ${serverEnv.CREDITS_FLUSH_SECRET}`,
            },
            method: "POST",
          });

          const res = await defaultServerEntry.fetch(req);
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`credits flush failed: ${res.status} ${text}`);
          }

          const json: unknown = await res.json().catch(() => null);
          const flushed =
            typeof json === "object" &&
            json &&
            "flushed" in json &&
            typeof (json as { flushed?: unknown }).flushed === "number"
              ? (json as { flushed: number }).flushed
              : 0;
          const skipped =
            typeof json === "object" &&
            json &&
            "skipped" in json &&
            typeof (json as { skipped?: unknown }).skipped === "number"
              ? (json as { skipped: number }).skipped
              : 0;
          const processed = flushed + skipped;

          if (processed <= 0) break;
        }
      })(),
    );
  },
} satisfies ExportedHandler;
