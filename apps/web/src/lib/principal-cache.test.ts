import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createPrincipalCache } from "./principal-cache";

function makeCache() {
  let client: QueryClient;
  const principal = createPrincipalCache(() => client);
  client = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: (key) =>
          `${principal.currentKey}:${JSON.stringify(key)}`,
      },
    },
  });
  return { client, principal };
}

describe("principal cache hydration", () => {
  it("retains SSR queries in the signed-in namespace on the first render", async () => {
    const server = makeCache();
    await server.principal.transition("user_1", "org_1");
    server.client.setQueryData(["projects"], ["Organization one project"]);
    const snapshot = server.principal.snapshot;
    const queries = dehydrate(server.client);

    const browser = makeCache();
    await browser.principal.transition(snapshot.userId, snapshot.orgId);
    hydrate(browser.client, queries);

    expect(browser.client.getQueryData(["projects"])).toEqual([
      "Organization one project",
    ]);
    await browser.principal.transition("user_1", "org_1");
    expect(browser.client.getQueryData(["projects"])).toBeDefined();
    expect(browser.principal.currentKey).toBe(server.principal.currentKey);
  });

  it("clears hydrated queries and mutation state on org switch and sign-out", async () => {
    const { client, principal } = makeCache();
    await principal.transition("user_1", "org_1");
    client.setQueryData(["wallet"], { balance: 20 });
    client.getMutationCache().build(client, { mutationKey: ["top-up"] });

    await principal.transition("user_1", "org_2");
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    client.setQueryData(["wallet"], { balance: 0 });

    await principal.transition(null, null);
    expect(client.getQueryData(["wallet"])).toBeUndefined();
    expect(principal.snapshot).toEqual({ userId: null, orgId: null });
  });
});
