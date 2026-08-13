import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

export const CONVEX_DEPLOY_RECEIPT_SCHEMA =
  "zevium.convex-deploy-receipt/v1" as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

function runtimeUrl(name: "CONVEX_CLOUD_URL" | "CONVEX_SITE_URL"): string {
  const raw = process.env[name];
  if (raw === undefined) throw new Error(`${name} is unavailable`);
  const url = new URL(raw);
  const expectedSuffix =
    name === "CONVEX_CLOUD_URL" ? ".convex.cloud" : ".convex.site";
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(expectedSuffix)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return url.origin;
}

function publicReceipt(receipt: {
  _id: string;
  schema: typeof CONVEX_DEPLOY_RECEIPT_SCHEMA;
  gitSha: string;
  sourceRunId: string;
  cloudUrl: string;
  siteUrl: string;
  activatedAt: string;
}) {
  return {
    schema: receipt.schema,
    receiptId: receipt._id,
    gitSha: receipt.gitSha,
    sourceRunId: receipt.sourceRunId,
    cloudUrl: receipt.cloudUrl,
    siteUrl: receipt.siteUrl,
    activatedAt: receipt.activatedAt,
  } as const;
}

/**
 * Admin-only post-deploy attestation. `convex run` uses deploy-key admin auth,
 * while browser clients cannot invoke internal functions.
 */
export const record = internalMutation({
  args: { gitSha: v.string(), sourceRunId: v.string() },
  handler: async (ctx, args) => {
    if (!SHA_PATTERN.test(args.gitSha)) throw new Error("gitSha is invalid");
    if (!RUN_ID_PATTERN.test(args.sourceRunId))
      throw new Error("sourceRunId is invalid");

    const existing = await ctx.db
      .query("deploymentReceipts")
      .withIndex("by_source_run", (q) =>
        q.eq("sourceRunId", args.sourceRunId).eq("gitSha", args.gitSha),
      )
      .unique();
    if (existing !== null) return publicReceipt(existing);

    const cloudUrl = runtimeUrl("CONVEX_CLOUD_URL");
    const siteUrl = runtimeUrl("CONVEX_SITE_URL");
    if (
      new URL(cloudUrl).hostname.replace(/\.convex\.cloud$/, "") !==
      new URL(siteUrl).hostname.replace(/\.convex\.site$/, "")
    ) {
      throw new Error("Convex runtime URLs identify different deployments");
    }
    const activatedAt = new Date(Date.now()).toISOString();
    const receiptId = await ctx.db.insert("deploymentReceipts", {
      schema: CONVEX_DEPLOY_RECEIPT_SCHEMA,
      gitSha: args.gitSha,
      sourceRunId: args.sourceRunId,
      cloudUrl,
      siteUrl,
      activatedAt,
    });
    const receipt = await ctx.db.get(receiptId);
    if (receipt === null) throw new Error("Deployment receipt insert vanished");
    return publicReceipt(receipt);
  },
});

/** Public, non-secret readback used to bind acceptance to live Convex state. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const receipt = await ctx.db
      .query("deploymentReceipts")
      .order("desc")
      .first();
    return receipt === null ? null : publicReceipt(receipt);
  },
});
