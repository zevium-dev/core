---
name: convex-dev-reset-data
description: Reset/wipe all data on a Convex dev deployment when a schema push fails validation against existing non-conforming rows and you have no dashboard access or delete mutation.
---

# Reset data on a Convex dev deployment (no dashboard, no delete mutation)

## When to use
`npx convex dev --once` fails with:
```
✖ Schema validation failed.
Document with ID "..." in table "threads" does not match the schema:
Value does not match validator. Path: .anchor ...
```
Existing rows in the dev deployment don't conform to a new/leaner schema, and the push fails **before deploying any function** — so you can't deploy a clear-all mutation the normal way.

This is a data reset, not a schema-only fix. Use it when the existing dev data is disposable (test garbage) and you want the new schema to push clean.

## The workaround (the "loosen → wipe → restore" dance)

### 1. Temporarily loosen the schema so all existing docs pass validation
Replace `convex/schema.ts` so every table is `defineTable(v.any())` with **no field validators and no indexes**. Keep any validators other files import (e.g. `anchorValidator`) exported as `v.any()` so function files still compile:

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export const anchorValidator = v.any();
export default defineSchema({
  threads: defineTable(v.any()),
  replies: defineTable(v.any()),
});
```

Why this works: `v.any()` accepts every existing document regardless of its fields, so validation passes and the push proceeds. Dropping indexes (by omitting `.index(...)`) is non-destructive to rows.

### 2. Add a one-shot clear mutation
Create `convex/_clear.ts` as a **regular `mutation`** (not `internalMutation`), so `convex dev --run` can invoke it:

```ts
import { mutation } from "./_generated/server";
export const all = mutation({
  args: {},
  handler: async (ctx) => {
    const threads = await ctx.db.query("threads").collect();
    const replies = await ctx.db.query("replies").collect();
    for (const t of threads) await ctx.db.delete(t._id);
    for (const r of replies) await ctx.db.delete(r._id);
    return { threads: threads.length, replies: replies.length };
  },
});
```
`.collect()` without `.withIndex(...)` works because the loose schema has no indexes to reference.

### 3. Push + run the wipe in one shot
```
npx convex dev --once --typecheck disable --run _clear:all
```
- `--once` runs the first 3 steps (prepare → push → run) and exits.
- `--typecheck disable` prevents the temporary loose schema from breaking the typecheck gate.
- `--run _clear:all` runs `convex/_clear.ts`'s `all` export **after** a successful push.

It prints the counts deleted, e.g. `{ "replies": 0, "threads": 52 }`.

### 4. Restore the real schema + delete the clear mutation
- Delete `convex/_clear.ts`.
- Restore `convex/schema.ts` to the intended schema (fields, validators, indexes).

### 5. Push the real schema
```
npx convex dev --once
```
Now data is empty, so validation passes and indexes rebuild (`[+] threads.by_org_file ...`). This also regenerates `convex/_generated/`.

## Gotchas
- **Don't leave `_clear.ts` or the loose schema in the repo** — they're scaffolding for this dance only.
- `--run` takes `dir/file:export`, e.g. `_clear:all` for `convex/_clear.ts`'s `all` export.
- Removing **optional** fields and removing **indexes/search indexes** does not by itself force a reset; the reset is forced when existing rows carry fields/types the new schema rejects. If you only add fields or drop indexes, a normal `convex dev --once` succeeds without this dance.
- This wipes ALL rows in the listed tables across all orgs/files — only use on a disposable dev deployment.

## Alternative (if acceptable)
Provision a brand-new dev deployment by removing `CONVEX_DEPLOYMENT` from `.env.local` and running `npx convex dev`. This avoids the dance but orphans the old deployment on your Convex account and changes the deployment URL (update `CONVEX_URL` + host config everywhere).
