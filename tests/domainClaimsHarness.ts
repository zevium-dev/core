import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction, internalMutation } from "../convex/_generated/server";
import { claimSignupOrganization } from "../convex/lib/identity";
import { insertKey } from "../convex/lib/keys";
import { reservePublicRoute } from "../convex/lib/publicRoutes";
import { organization, projectFields } from "./fixtures";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "@zevium/shared";
// Test-only entry points call the actual PR 2 domain helpers on a real OCC backend.
export const seed = internalMutation({
  args: { run: v.string() },
  handler: async (ctx, { run }) => {
    const org = await ctx.db.insert("organizations", organization(run));
    const other = await ctx.db.insert(
      "organizations",
      organization(`${run}-other`),
    );
    const project = await ctx.db.insert("projects", {
      ...projectFields,
      organizationId: org,
    });
    return { org, other, project };
  },
});
export const contend = internalMutation({
  args: {
    org: v.id("organizations"),
    project: v.id("projects"),
    run: v.string(),
    claimant: v.number(),
    kind: v.union(v.literal("signup"), v.literal("slot"), v.literal("route")),
  },
  handler: async (ctx, args) => {
    const org = (await ctx.db.get(args.org))!;
    if (args.kind === "signup") {
      if (!(await claimSignupOrganization(ctx, org, `user_${args.run}`)))
        return "not-eligible";
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_owner", (q) => q.eq("ownerKey", `org:${org.clerkOrgId}`))
        .unique();
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk", (q) => q.eq("clerkUserId", `user_${args.run}`))
        .unique();
      if (
        wallet?.balance !== 10_000 ||
        wallet.promoCredits !== 10_000 ||
        wallet.sequence !== 1 ||
        user?.signupGrant?.organizationId !== org._id
      )
        throw new Error("Signup money and identity did not commit atomically");
      return org._id;
    }
    if (args.kind === "route")
      return (
        await reservePublicRoute(ctx, org, (await ctx.db.get(args.project))!)
      )._id;
    return (
      await insertKey(
        ctx,
        org,
        {
          clerkKeyId: `key_${args.run}_${args.claimant}`,
          clerkOrgId: org.clerkOrgId,
          ownerUserId: `user_${args.run}`,
          subjectUserId: `user_${args.run}`,
          secretSha256: await sha256Hex(`${args.run}:${args.claimant}`),
          budgetId: `budget_${args.run}`,
          budgetRevision: 1,
          lifecycle: "active",
          monthlyCapCredits: 100,
          graceUntil: null,
          expiresAt: null,
          scopes: ["gateway:execute"],
        },
        Date.now(),
      )
    )._id;
  },
});
export const races = internalAction({
  args: {},
  handler: async (ctx) => {
    const run = `domain_${crypto.randomUUID()}`;
    const seedRef = makeFunctionReference<
      "mutation",
      { run: string },
      {
        org: Id<"organizations">;
        other: Id<"organizations">;
        project: Id<"projects">;
      }
    >("domainClaims:seed");
    const { org, other, project } = await ctx.runMutation(seedRef, { run });
    const contend = makeFunctionReference<
      "mutation",
      {
        org: Id<"organizations">;
        project: Id<"projects">;
        run: string;
        claimant: number;
        kind: "signup" | "slot" | "route";
      },
      string
    >("domainClaims:contend");
    for (const kind of ["signup", "slot", "route"] as const) {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, claimant) =>
          ctx.runMutation(contend, {
            org: kind === "signup" && claimant % 2 ? other : org,
            project,
            run,
            kind,
            claimant,
          }),
        ),
      );
      const successes = results.filter(
        (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
      );
      if (
        kind === "slot"
          ? successes.length !== 1
          : successes.length !== 8 ||
            new Set(
              successes
                .map((r) => r.value)
                .filter((value) => value !== "not-eligible"),
            ).size !== 1
      )
        throw new Error(`${kind} domain race failed`);
      if (kind === "signup") {
        const winner = successes.find(
          (result) => result.value !== "not-eligible",
        )!.value;
        const duplicate = await ctx.runMutation(contend, {
          org: winner === org ? other : org,
          project,
          run,
          kind,
          claimant: 0,
        });
        if (duplicate !== "not-eligible")
          throw new Error("Second signup organization accepted");
      }
    }
    return {
      passed: ["signup identity", "member key slot", "route reservation"],
      concurrentClaimants: 8,
    };
  },
});
