import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { EdgeOAuthDO, plausibleOAuthToken } from "../src/next/oauth";
import { ColdRefreshBudget } from "../src/next/cold-refresh";
import type { NextEnv } from "../src/next/snapshots";

it("rejects malformed bearers and bounds random-scope cold starts per isolate", () => {
  for (const token of [
    "oat_",
    "oat_!invalid",
    "oat_short",
    "abc.def.ghi",
    "x".repeat(20_000),
  ])
    expect(plausibleOAuthToken(token)).toBe(false);
  const budget = new ColdRefreshBudget(),
    now = Date.now();
  expect(
    Array.from({ length: 100 }, () => budget.take(now)).filter(Boolean),
  ).toHaveLength(20);
  expect(budget.take(now + 200)).toBe(true);
  expect(budget.take(now + 200)).toBe(false);
});
it("caches invalid opaque tokens without token identity storage or provider polling", async () => {
  const bindings = env as unknown as NextEnv;
  const stub = bindings.EDGE_OAUTH!.get(
    bindings.EDGE_OAUTH!.idFromName(crypto.randomUUID()),
  );
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 400 }));
  try {
    await runInDurableObject(stub, async (_instance, ctx) => {
      const coordinator = new EdgeOAuthDO(ctx, {
        ...bindings,
        CLERK_SECRET_KEY: "test-secret",
        MCP_OAUTH_ISSUER: "https://clerk.invalid",
        MCP_OAUTH_RESOURCE: "https://gateway.test/mcp",
        NEXT_CONVEX_SITE_URL: "https://next.invalid",
      });
      const token = `oat_${"a".repeat(32)}`;
      expect(await coordinator.read("oat_short")).toEqual({
        status: "invalid",
      });
      expect(network).not.toHaveBeenCalled();
      expect(
        await Promise.all([coordinator.read(token), coordinator.read(token)]),
      ).toEqual([{ status: "invalid" }, { status: "invalid" }]);
      expect(network).toHaveBeenCalledTimes(1);
      expect(network.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
      expect(await coordinator.read(token)).toEqual({ status: "invalid" });
      expect([...(await ctx.storage.list()).keys()]).toEqual(["authority"]);
      await coordinator.alarm();
      expect((await ctx.storage.list()).size).toBe(0);
      expect(await ctx.storage.getAlarm()).toBeNull();
      expect(network).toHaveBeenCalledTimes(1);
    });
  } finally {
    network.mockRestore();
  }
});
