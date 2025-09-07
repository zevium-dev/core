import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

export const getList = query({
  args: {
    paginationOpts: v.object({
      cursor: v.union(v.string(), v.null()),
      numItems: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("exampleTodos")
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: args.paginationOpts.numItems ?? 10,
      });

    const { continueCursor, isDone, page } = result;
    return { items: page, nextCursor: isDone ? undefined : continueCursor };
  },
});

export const create = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    const document = await ctx.db.insert("exampleTodos", { status: "incomplete", title: args.title });
    return document;
  },
});

export const toggleStatus = mutation({
  args: { id: v.id("exampleTodos") },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);
    if (!document) throw new Error("Todo not found");
    const updatedDocument = await ctx.db.patch(args.id, {
      status: document.status === "complete" ? "incomplete" : "complete",
    });
    return updatedDocument;
  },
});
