import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { ConvexError } from "convex/values";
import { expect, it } from "vitest";

import { shouldDehydrateQuery } from "./ssr-query";

const walletKey = ["convexQuery", "wallets:getMyWallet", { orgSlug: "acme" }];
const overviewKey = [
  "convexQuery",
  "analytics:orgOverview",
  { orgSlug: "acme" },
];

async function serverCacheBeforeMirror() {
  const server = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // First visit: the org row is not mirrored yet, so the org-scoped query throws.
  await server.prefetchQuery({
    queryKey: walletKey,
    queryFn: () => Promise.reject(new ConvexError("Organization not found")),
  });
  await server.prefetchQuery({
    queryKey: overviewKey,
    queryFn: () => Promise.resolve({ callsToday: 0 }),
  });
  return server;
}

it("does not hand a first-load 'Organization not found' to the browser cache", async () => {
  const server = await serverCacheBeforeMirror();
  const browser = new QueryClient();
  hydrate(browser, dehydrate(server, { shouldDehydrateQuery }));

  expect(browser.getQueryState(walletKey)).toBeUndefined();
  expect(browser.getQueryData(overviewKey)).toEqual({ callsToday: 0 });
});

it("router-ssr-query's dehydrate-everything default would replay the error", async () => {
  const server = await serverCacheBeforeMirror();
  const browser = new QueryClient();
  hydrate(browser, dehydrate(server, { shouldDehydrateQuery: () => true }));

  expect(browser.getQueryState(walletKey)?.status).toBe("error");
});
