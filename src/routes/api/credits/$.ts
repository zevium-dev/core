import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { db, schema } from "~/db";
import { serverEnv } from "~/env/server";
import { kv } from "~/lib/server/kv";
import { CreditsRedisKey } from "~/lib/shared/credits-keys";

const CursorSchema = z.string().min(1);

const CreditLedgerTypeSchema = z.enum(["topup", "deduct", "adjust"]);

function getAuthOk(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const token = header.slice("bearer ".length).trim();
  return Boolean(token) && token === serverEnv.CREDITS_FLUSH_SECRET;
}

export const Route = createFileRoute("/api/credits/$")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/flush")) {
          return new Response("Not Found", { status: 404 });
        }

        if (!getAuthOk(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const limit = (() => {
          const raw = url.searchParams.get("limit");
          const n = raw ? Number(raw) : 500;
          if (!Number.isFinite(n)) return 500;
          return Math.max(1, Math.min(2000, Math.floor(n)));
        })();

        const streamKey = CreditsRedisKey.ledgerStream();
        const cursorKey = CreditsRedisKey.ledgerStreamCursor();

        const rawCursor = await kv.get<unknown>(cursorKey);
        const cursor = CursorSchema.safeParse(rawCursor).success ? String(rawCursor) : "0-0";

        const startExclusive = cursor === "0-0" ? "0-0" : `(${cursor}`;
        const events = await kv.xrange(streamKey, startExclusive, "+", limit);
        const ids = Object.keys(events);
        if (ids.length === 0) {
          return Response.json({
            flushed: 0,
            lastId: cursor,
          });
        }

        // Insert events in ID order, skipping any duplicates.
        const sortedIds = ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const rows = sortedIds
          .map((streamId) => {
            const e = events[streamId] ?? {};
            const id = typeof e.id === "string" && e.id ? e.id : null;
            const userId = typeof e.userId === "string" && e.userId ? e.userId : null;
            const type = CreditLedgerTypeSchema.safeParse(e.type).success
              ? (e.type as z.infer<typeof CreditLedgerTypeSchema>)
              : null;
            const amountCentsRaw = typeof e.amountCents === "number" ? e.amountCents : Number(e.amountCents);
            const amountCents = Number.isFinite(amountCentsRaw) ? Math.trunc(amountCentsRaw) : null;
            const createdAtRaw = typeof e.createdAt === "number" ? e.createdAt : Number(e.createdAt);
            const createdAt = Number.isFinite(createdAtRaw) ? new Date(createdAtRaw) : new Date();
            const description = typeof e.description === "string" && e.description.length > 0 ? e.description : null;
            const reference = typeof e.reference === "string" && e.reference.length > 0 ? e.reference : null;

            if (!id || !userId || !type || amountCents === null) return null;
            return {
              amountCents,
              createdAt,
              description,
              id,
              reference,
              type,
              userId,
            };
          })
          .filter((r): r is NonNullable<typeof r> => Boolean(r));

        if (rows.length === 0) {
          // All events were malformed; advance cursor so we don't spin forever.
          const lastId = sortedIds.at(-1) ?? cursor;
          await kv.set(cursorKey, lastId);
          return Response.json({
            flushed: 0,
            lastId,
            skipped: sortedIds.length,
          });
        }

        await db.insert(schema.creditLedger).values(rows).onConflictDoNothing({ target: schema.creditLedger.id });

        // Advance cursor first so we never trim data that hasn't been acknowledged.
        const lastId = sortedIds.at(-1) ?? cursor;
        await kv.set(cursorKey, lastId);

        // Best-effort cleanup: trim old stream entries once persisted.
        // (This keeps the stream from growing unbounded even with MAXLEN ~ trim.)
        await kv.xtrim(streamKey, { exactness: "~", strategy: "MINID", threshold: lastId }).catch(() => undefined);

        return Response.json({
          flushed: rows.length,
          lastId,
        });
      },
    },
  },
});
