/// <reference types="vite/client" />
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const acquireLease = makeFunctionReference<
  "mutation",
  Record<never, never>,
  { remaining: number; resetsAt: number }
>("specImports:acquireLease");

describe("spec import rate lease", () => {
  it("requires authenticated org membership", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(acquireLease, {})).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      t
        .withIdentity({ subject: "user_without_org" })
        .mutation(acquireLease, {}),
    ).rejects.toThrow(/Select an organization/);
  });

  it("atomically caps each org member at ten imports per minute", async () => {
    const t = convexTest(schema, modules);
    const member = t.withIdentity({
      subject: "user_importer",
      org_id: "org_importer",
      org_role: "org:member",
    });

    for (let count = 0; count < 10; count += 1) {
      const lease = await member.mutation(acquireLease, {});
      expect(lease.remaining).toBe(9 - count);
      expect(lease.resetsAt).toBeGreaterThan(Date.now());
    }
    await expect(member.mutation(acquireLease, {})).rejects.toThrow(
      /rate limit exceeded/i,
    );
  });

  it("keeps separate members on separate leases", async () => {
    const t = convexTest(schema, modules);
    const identity = {
      org_id: "org_shared",
      org_role: "org:member",
    };
    const first = await t
      .withIdentity({ ...identity, subject: "first" })
      .mutation(acquireLease, {});
    const second = await t
      .withIdentity({ ...identity, subject: "second" })
      .mutation(acquireLease, {});
    expect(first.remaining).toBe(9);
    expect(second.remaining).toBe(9);
  });
});
