import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  exampleTodos: defineTable({
    status: v.union(v.literal("complete"), v.literal("incomplete")),
    title: v.string(),
  }),
});
