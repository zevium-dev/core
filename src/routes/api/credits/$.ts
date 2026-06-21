import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { db, schema } from "~/db";
import { serverEnv } from "~/env/server";
import { kv } from "~/lib/server/kv";
import { CreditsRedisKey } from "~/lib/shared/credits-keys";

function getAuthOk(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const token = header.slice("bearer ".length).trim();
  return Boolean(token) && token === serverEnv.CREDITS_FLUSH_SECRET;
}

function nextStreamIdInclusive(streamId: string): string {
  // Redis Stream IDs are formatted as: <millisecondsTime>-<sequenceNumber>
  // `XTRIM ... MINID <id>` keeps entries with IDs >= <id>.
  // To delete entries up to and including `streamId`, trim using the next possible id.
  const idx = streamId.indexOf("-");
  if (idx < 0) return streamId;
  const ms = streamId.slice(0, idx);
  const seqRaw = streamId.slice(idx + 1);
  try {
    const seq = BigInt(seqRaw);
    return `${ms}-${seq + 1n}`;
  } catch {
    return streamId;
  }
}

const CursorSchema = z.string().min(1);

const CreditLedgerTypeSchema = z.enum(["topup", "deduct", "adjust"]);

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

        const rawLimit = url.searchParams.get("limit");
        const flushAll = rawLimit === null;
        const batchSize = (() => {
          if (flushAll) return 2000;
          const n = rawLimit ? Number(rawLimit) : 500;
          if (!Number.isFinite(n)) return 500;
          return Math.max(1, Math.min(2000, Math.floor(n)));
        })();

        const streamKey = CreditsRedisKey.ledgerStream();
        const cursorKey = CreditsRedisKey.ledgerStreamCursor();

        const rawCursor = await kv.get<unknown>(cursorKey);
        const cursor = CursorSchema.safeParse(rawCursor).success ? String(rawCursor) : "0-0";

        let currentCursor = cursor;
        let flushedTotal = 0;
        let skippedTotal = 0;
        let trimmedTotal = 0;
        let trimError: null | string = null;
        let batches = 0;

        // Safety net: avoid infinite flush loops if new entries are being appended continuously.
        const maxBatches = flushAll ? 1000 : 1;

        for (let i = 0; i < maxBatches; i++) {
          const startExclusive = currentCursor === "0-0" ? "0-0" : `(${currentCursor}`;
          const events = await kv.xrange(streamKey, startExclusive, "+", batchSize);
          const ids = Object.keys(events);
          if (ids.length === 0) {
            // Cleanup pass: if a previous flush advanced the cursor but trimming failed,
            // there may still be old entries <= cursor sitting in the stream.
            const trimThreshold = nextStreamIdInclusive(currentCursor);
            try {
              trimmedTotal += await kv.xtrim(streamKey, {
                exactness: "=",
                strategy: "MINID",
                threshold: trimThreshold,
              });
            } catch (err) {
              trimError = err instanceof Error ? err.message : String(err);
            }
            break;
          }

          batches += 1;

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
              const createdAt = Number.isFinite(createdAtRaw) ? new Date(createdAtRaw) : null;
              const description = typeof e.description === "string" && e.description.length > 0 ? e.description : null;
              const reference = typeof e.reference === "string" && e.reference.length > 0 ? e.reference : null;

              if (!id || !userId || !type || amountCents === null || !createdAt) return null;
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

          const lastId = sortedIds.at(-1) ?? currentCursor;
          const skippedInBatch = sortedIds.length - rows.length;
          skippedTotal += skippedInBatch;

          if (rows.length > 0) {
            await db.insert(schema.creditLedger).values(rows).onConflictDoNothing({ target: schema.creditLedger.id });
            flushedTotal += rows.length;
          }

          // Advance cursor so we never re-process already persisted events.
          currentCursor = lastId;
          await kv.set(cursorKey, currentCursor);

          // Best-effort cleanup: remove flushed (and any skipped/malformed) entries from the stream.
          const trimThreshold = nextStreamIdInclusive(lastId);
          try {
            trimmedTotal += await kv.xtrim(streamKey, { exactness: "=", strategy: "MINID", threshold: trimThreshold });
          } catch (err) {
            trimError = err instanceof Error ? err.message : String(err);
            try {
              trimmedTotal += await kv.xdel(streamKey, sortedIds);
            } catch (err2) {
              trimError = `${trimError}; xdel: ${err2 instanceof Error ? err2.message : String(err2)}`;
            }
          }

          if (!flushAll) break;
        }

        return Response.json({
          batches,
          flushed: flushedTotal,
          lastId: currentCursor,
          skipped: skippedTotal,
          trimError,
          trimmed: trimmedTotal,
        });
      },
    },
  },
});
