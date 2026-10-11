import { internalAction } from "../convex/_generated/server";
import { internal } from "../convex/_generated/api";
/** Run against the real local vector-indexed schema, not convex-test. */
export const queryCache = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ pending: boolean; cachedDimensions: number }> => {
    const query = `local-vector-cache-${crypto.randomUUID()}`;
    const args = { query, trustedAnonymousKey: crypto.randomUUID() };
    const first = await ctx.runMutation(
      internal.search.prepareQueryEmbedding,
      args,
    );
    if (first.status !== "admitted") throw new Error("Query claim failed");
    const pending = await ctx.runMutation(
      internal.search.prepareQueryEmbedding,
      args,
    );
    if (pending.status !== "pending") throw new Error("Query lease not fenced");
    await ctx.runMutation(internal.search.finishQueryEmbedding, {
      id: first.id,
      leaseToken: first.leaseToken,
      embedding: Array(768).fill(0.1),
    });
    const cached = await ctx.runMutation(
      internal.search.prepareQueryEmbedding,
      args,
    );
    if (cached.status !== "cached" || cached.embedding.length !== 768)
      throw new Error("Real backend cache roundtrip failed");
    return { pending: true, cachedDimensions: cached.embedding.length };
  },
});
